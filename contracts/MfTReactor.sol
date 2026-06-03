// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Reactor Prime V1 — MfT burn/buyback/LP engine with fuel intake
///
/// The primary MfT reactor. Burns MfT, deepens LP, and accepts fuel from
/// secondary reactors. Secondary reactors send their xToken cut directly
/// — no USDC conversion needed. If a matching MfT/xToken pool exists,
/// fuel() swaps half to MfT and deposits both sides as deeper LP.
///
///   1. NFT ownership validation   — addPool verifies ownership
///   2. Per-pool try/catch         — one failing pool cannot brick the system
///   3. depositLiquidity           — anyone can deepen any pool (permissionless)
///   4. fuel(xToken, amount)       — one-way intake from secondary reactors
///   5. Multi-fee tier             — any V3 fee tier accepted
///   6. Impact burn                — MfT burned to trackable impact address
///   7. Trustless                  — pools cannot be removed, LP locked forever
///
///   Positions are locked forever — no withdraw or remove function exists.
///   Anyone can call execute() after the 2-hour cooldown.

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }
    struct IncreaseLiquidityParams {
        uint256 tokenId;
        uint256 amount0Desired;
        uint256 amount1Desired;
        uint256 amount0Min;
        uint256 amount1Min;
        uint256 deadline;
    }
    function collect(CollectParams calldata) external payable returns (uint256, uint256);
    function increaseLiquidity(IncreaseLiquidityParams calldata) external payable returns (uint128, uint256, uint256);
    function positions(uint256 tokenId) external view returns (
        uint96, address, address, address, uint24, int24, int24, uint128,
        uint256, uint256, uint128, uint128
    );
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @dev SwapRouter02 on Base — no deadline field
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24  fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }
    function exactInputSingle(ExactInputSingleParams calldata) external payable returns (uint256);
}

interface IUniswapV3Factory {
    function getPool(address, address, uint24) external view returns (address);
}

contract ReactorPrime {

    address private constant BURN = 0xfd780B0aE569e15e514B819ecFDF46f804953a4B;

    // Immutables
    address                      public immutable token;
    INonfungiblePositionManager  public immutable pm;
    ISwapRouter02                public immutable router;
    IUniswapV3Factory            public immutable factory;

    // State
    uint256 public lastExecute;
    uint256 public constant COOLDOWN = 2 hours;

    struct Pool {
        uint256 tokenId;
        address xToken;
        uint24  fee;
        bool    tokenIsToken0;
    }
    Pool[] public pools;

    address public admin;

    // Events
    event Executed(uint256 burned, uint256 deposited, uint256 timestamp, address caller);
    event PoolAdded(uint256 indexed tokenId, address xToken, uint24 fee);
    event PoolSkipped(uint256 indexed poolIndex, uint256 tokenId);
    event LiquidityDeposited(uint256 indexed poolIndex, uint256 amount0, uint256 amount1);
    event Fueled(uint256 indexed poolIndex, address xToken, uint256 xIn, uint256 mftDeposited, uint256 xDeposited);

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlySelf() {
        require(msg.sender == address(this), "internal only");
        _;
    }

    constructor(
        address _token,
        address _pm,
        address _router,
        address _factory
    ) {
        token   = _token;
        pm      = INonfungiblePositionManager(_pm);
        router  = ISwapRouter02(_router);
        factory = IUniswapV3Factory(_factory);
        admin   = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Pool Management (admin only)
    // ═══════════════════════════════════════════════════════════════════

    function addPool(uint256 tokenId) external onlyAdmin {
        require(pm.ownerOf(tokenId) == address(this), "NFT not owned by reactor");

        (, , address token0, address token1, uint24 fee, , , , , , ,) = pm.positions(tokenId);

        bool is0 = (token0 == token);
        bool is1 = (token1 == token);
        require(is0 || is1, "token not in pair");

        address xToken = is0 ? token1 : token0;
        require(factory.getPool(token0, token1, fee) != address(0), "pool not found");

        pools.push(Pool({
            tokenId:       tokenId,
            xToken:        xToken,
            fee:           fee,
            tokenIsToken0: is0
        }));

        emit PoolAdded(tokenId, xToken, fee);
    }

    function transferAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }

    function renounceAdmin() external onlyAdmin {
        admin = address(0);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Fuel Intake (permissionless)
    // ═══════════════════════════════════════════════════════════════════

    /// @notice Deepen an existing pool with raw tokens. Caller must approve both.
    function depositLiquidity(uint256 poolIndex, uint256 tokenAmount, uint256 xAmount) external {
        require(poolIndex < pools.length, "invalid index");
        Pool memory pool = pools[poolIndex];

        if (tokenAmount > 0) {
            IERC20(token).transferFrom(msg.sender, address(this), tokenAmount);
            IERC20(token).approve(address(pm), tokenAmount);
        }
        if (xAmount > 0) {
            IERC20(pool.xToken).transferFrom(msg.sender, address(this), xAmount);
            IERC20(pool.xToken).approve(address(pm), xAmount);
        }

        uint256 a0d = pool.tokenIsToken0 ? tokenAmount : xAmount;
        uint256 a1d = pool.tokenIsToken0 ? xAmount : tokenAmount;

        pm.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId:        pool.tokenId,
                amount0Desired: a0d,
                amount1Desired: a1d,
                amount0Min:     0,
                amount1Min:     0,
                deadline:       block.timestamp
            })
        );

        emit LiquidityDeposited(poolIndex, a0d, a1d);
    }

    /// @notice One-way fuel from secondary reactors. Sends xToken that matches
    ///         a pool in this reactor. Swaps half to MfT, deposits both as LP.
    ///         Reverts if no MfT pool exists for the given xToken.
    function fuel(address xToken, uint256 amount) external {
        require(amount > 0, "zero amount");

        // Find matching pool
        uint256 poolIndex = _findPool(xToken);
        require(poolIndex < type(uint256).max, "no pool for token");

        Pool memory pool = pools[poolIndex];

        // Pull xToken from caller
        IERC20(xToken).transferFrom(msg.sender, address(this), amount);

        // Swap half xToken → MfT using pool's own fee tier
        uint256 halfX    = amount / 2;
        uint256 xForLP   = amount - halfX;

        IERC20(xToken).approve(address(router), halfX);
        uint256 mftAmount = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           xToken,
                tokenOut:          token,
                fee:               pool.fee,
                recipient:         address(this),
                amountIn:          halfX,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );

        // Deposit both sides as LP
        IERC20(token).approve(address(pm), mftAmount);
        IERC20(xToken).approve(address(pm), xForLP);

        uint256 a0d = pool.tokenIsToken0 ? mftAmount : xForLP;
        uint256 a1d = pool.tokenIsToken0 ? xForLP : mftAmount;

        pm.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId:        pool.tokenId,
                amount0Desired: a0d,
                amount1Desired: a1d,
                amount0Min:     0,
                amount1Min:     0,
                deadline:       block.timestamp
            })
        );

        emit Fueled(poolIndex, xToken, amount, mftAmount, xForLP);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Execute — anyone can call after cooldown
    // ═══════════════════════════════════════════════════════════════════

    function execute() external {
        require(block.timestamp >= lastExecute + COOLDOWN, "cooldown");
        lastExecute = block.timestamp;

        uint256 totalBurned;
        uint256 totalDeposited;
        uint256 len = pools.length;

        for (uint256 i; i < len; ++i) {
            try this.processPool(i) returns (uint256 burned, uint256 bought) {
                totalBurned += burned;
                totalDeposited += bought;
            } catch {
                emit PoolSkipped(i, pools[i].tokenId);
            }
        }

        emit Executed(totalBurned, totalDeposited, block.timestamp, msg.sender);
    }

    function processPool(uint256 poolIndex) external onlySelf returns (uint256 burned, uint256 bought) {
        Pool memory pool = pools[poolIndex];

        // 1. Collect fees
        (uint256 a0, uint256 a1) = pm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId:    pool.tokenId,
                recipient:  address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        uint256 tokenFees = pool.tokenIsToken0 ? a0 : a1;
        uint256 xFees     = pool.tokenIsToken0 ? a1 : a0;

        if (tokenFees == 0 && xFees == 0) return (0, 0);

        // 2. Burn MfT side to impact address
        if (tokenFees > 0) {
            IERC20(token).transfer(BURN, tokenFees);
            burned = tokenFees;
        }

        if (xFees == 0) return (burned, 0);

        // 3. Split X fees: half buys MfT, half stays for LP
        uint256 xForBuy = xFees / 2;
        uint256 xForLP  = xFees - xForBuy;

        // 4. Swap half-X for MfT (no price limit — MEV is net positive)
        IERC20(pool.xToken).approve(address(router), xForBuy);
        bought = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           pool.xToken,
                tokenOut:          token,
                fee:               pool.fee,
                recipient:         address(this),
                amountIn:          xForBuy,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: 0
            })
        );

        // 5. Deposit bought MfT + remaining X as deeper LP
        if (bought > 0 && xForLP > 0) {
            IERC20(token).approve(address(pm), bought);
            IERC20(pool.xToken).approve(address(pm), xForLP);

            uint256 a0d = pool.tokenIsToken0 ? bought : xForLP;
            uint256 a1d = pool.tokenIsToken0 ? xForLP : bought;

            pm.increaseLiquidity(
                INonfungiblePositionManager.IncreaseLiquidityParams({
                    tokenId:        pool.tokenId,
                    amount0Desired: a0d,
                    amount1Desired: a1d,
                    amount0Min:     0,
                    amount1Min:     0,
                    deadline:       block.timestamp
                })
            );
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Find first pool matching xToken. Returns type(uint256).max if not found.
    function _findPool(address xToken) internal view returns (uint256) {
        uint256 len = pools.length;
        for (uint256 i; i < len; ++i) {
            if (pools[i].xToken == xToken) return i;
        }
        return type(uint256).max;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════════════

    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    function timeUntilExecute() external view returns (uint256) {
        if (block.timestamp >= lastExecute + COOLDOWN) return 0;
        return (lastExecute + COOLDOWN) - block.timestamp;
    }

    /// @notice Check if fuel() would work for a given xToken
    function canFuel(address xToken) external view returns (bool) {
        return _findPool(xToken) < type(uint256).max;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  NFT receiver
    // ═══════════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
