// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Chain Reactor V3 — secondary reactor with MEV/slippage protection
///
/// Same burn/buy/back cycle as ChainReactor, but with:
///   1. Slippage protection — slot0-derived sqrtPriceLimitX96 caps price impact at 3%
///   2. Pool unlock check   — verifies V3 pool isn't mid-reentrancy before swap
///   3. MIN_PROCESS threshold — skips pools with dust-level fees, saves gas
///
/// 10% of each X-token's fees are diverted to Reactor Prime via fuel().
/// Positions are locked forever — no withdraw or remove function exists.
/// Anyone can call execute() after the 2-hour cooldown.

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

interface IUniswapV3Pool {
    function slot0() external view returns (
        uint160 sqrtPriceX96,
        int24 tick,
        uint16 observationIndex,
        uint16 observationCardinality,
        uint16 observationCardinalityNext,
        uint8 feeProtocol,
        bool unlocked
    );
}

interface IReactorPrime {
    function fuel(address xToken, uint256 amount) external;
    function canFuel(address xToken) external view returns (bool);
}

contract ChainReactorV3 {

    // ── Constants ──────────────────────────────────────────────────────────
    address private constant BURN = 0xfd780B0aE569e15e514B819ecFDF46f804953a4B;
    uint256 private constant FUEL_BPS = 1000; // 10% to Reactor Prime
    uint256 public  constant MIN_PROCESS = 1000; // skip pools with < this xToken balance
    uint256 public  constant MAX_PRICE_IMPACT_BPS = 300; // 3% max slippage per swap

    // UniswapV3 TickMath bounds
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // Immutables
    address                      public immutable token;     // this reactor's native token
    address                      public immutable mft;       // MfT address (for fuel line)
    INonfungiblePositionManager  public immutable pm;
    ISwapRouter02                public immutable router;
    IUniswapV3Factory            public immutable factory;
    IReactorPrime                public immutable reactorPrime;

    // State
    uint256 public lastExecute;
    uint256 public constant COOLDOWN = 2 hours;

    struct Pool {
        uint256 tokenId;
        address xToken;
        uint24  fee;
        bool    tokenIsToken0;
        address poolAddress;    // V3: stored for slot0 lookup
    }
    Pool[] public pools;
    mapping(uint256 => bool) public registeredTokenId;

    address public admin;

    // Events
    event Executed(uint256 burned, uint256 deposited, uint256 fueled, uint256 timestamp, address caller);
    event PoolAdded(uint256 indexed tokenId, address xToken, uint24 fee);
    event PoolSkipped(uint256 indexed poolIndex, uint256 tokenId);
    event FuelSent(address indexed xToken, uint256 amount);
    event LiquidityDeposited(uint256 indexed poolIndex, uint256 amount0, uint256 amount1);
    event Fueled(uint256 indexed poolIndex, address xToken, uint256 xIn, uint256 tokenDeposited, uint256 xDeposited);
    event DustBurned(uint256 amount);

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
        address _mft,
        address _pm,
        address _router,
        address _factory,
        address _reactorPrime
    ) {
        token        = _token;
        mft          = _mft;
        pm           = INonfungiblePositionManager(_pm);
        router       = ISwapRouter02(_router);
        factory      = IUniswapV3Factory(_factory);
        reactorPrime = IReactorPrime(_reactorPrime);
        admin        = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Pool Management (admin only)
    // ═══════════════════════════════════════════════════════════════════

    function addPool(uint256 tokenId) external onlyAdmin {
        require(pools.length < 20, "max 20 pools");
        require(!registeredTokenId[tokenId], "already registered");
        require(pm.ownerOf(tokenId) == address(this), "NFT not owned by reactor");

        (, , address token0, address token1, uint24 fee, , , , , , ,) = pm.positions(tokenId);

        bool is0 = (token0 == token);
        bool is1 = (token1 == token);
        require(is0 || is1, "token not in pair");

        address xToken = is0 ? token1 : token0;
        address poolAddr = factory.getPool(token0, token1, fee);
        require(poolAddr != address(0), "pool not found");

        pools.push(Pool({
            tokenId:       tokenId,
            xToken:        xToken,
            fee:           fee,
            tokenIsToken0: is0,
            poolAddress:   poolAddr
        }));
        registeredTokenId[tokenId] = true;

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
            _safeTransferFrom(token, msg.sender, address(this), tokenAmount);
            _safeApprove(token, address(pm), tokenAmount);
        }
        if (xAmount > 0) {
            _safeTransferFrom(pool.xToken, msg.sender, address(this), xAmount);
            _safeApprove(pool.xToken, address(pm), xAmount);
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

    /// @notice One-way fuel from other reactors. Sends xToken that matches
    ///         a pool in this reactor. Swaps half to native token, deposits both as LP.
    function fuel(address xToken, uint256 amount) external {
        require(amount > 0, "zero amount");

        uint256 poolIndex = _findPool(xToken);
        require(poolIndex < type(uint256).max, "no pool for token");

        Pool memory pool = pools[poolIndex];

        _safeTransferFrom(xToken, msg.sender, address(this), amount);

        uint256 halfX  = amount / 2;
        uint256 xForLP = amount - halfX;

        // Slippage-protected swap
        uint160 limit = _getSqrtPriceLimitSafe(pool.poolAddress, pool.tokenIsToken0);

        _safeApprove(xToken, address(router), halfX);
        uint256 tokenAmount = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           xToken,
                tokenOut:          token,
                fee:               pool.fee,
                recipient:         address(this),
                amountIn:          halfX,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: limit
            })
        );

        _safeApprove(token, address(pm), tokenAmount);
        _safeApprove(xToken, address(pm), xForLP);

        uint256 a0d = pool.tokenIsToken0 ? tokenAmount : xForLP;
        uint256 a1d = pool.tokenIsToken0 ? xForLP : tokenAmount;

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

        // Burn any native token dust from ratio mismatch
        _burnDust();

        emit Fueled(poolIndex, xToken, amount, tokenAmount, xForLP);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Execute — anyone can call after cooldown
    // ═══════════════════════════════════════════════════════════════════

    function execute() external {
        require(block.timestamp >= lastExecute + COOLDOWN, "cooldown");
        lastExecute = block.timestamp;

        uint256 totalBurned;
        uint256 totalDeposited;
        uint256 totalFueled;
        uint256 len = pools.length;

        for (uint256 i; i < len; ++i) {
            try this.processPool(i) returns (uint256 burned, uint256 bought, uint256 fueled) {
                totalBurned += burned;
                totalDeposited += bought;
                totalFueled += fueled;
            } catch {
                emit PoolSkipped(i, pools[i].tokenId);
            }
        }

        emit Executed(totalBurned, totalDeposited, totalFueled, block.timestamp, msg.sender);
    }

    function processPool(uint256 poolIndex) external onlySelf returns (uint256 burned, uint256 bought, uint256 fueled) {
        Pool memory pool = pools[poolIndex];

        // 1. Collect fees
        pm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId:    pool.tokenId,
                recipient:  address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        // 2. Burn ALL native token in contract (fees + dust)
        uint256 tokenBal = IERC20(token).balanceOf(address(this));
        if (tokenBal > 0) {
            _safeTransfer(token, BURN, tokenBal);
            burned = tokenBal;
        }

        // 3. Get total X-token balance (fees + dust from prior cycles)
        uint256 xBal = IERC20(pool.xToken).balanceOf(address(this));
        if (xBal < MIN_PROCESS) return (burned, 0, 0);

        // 4. Divert 10% of X-token to Reactor Prime fuel line
        uint256 fuelAmount = xBal * FUEL_BPS / 10000;
        if (fuelAmount > 0) {
            _safeApprove(pool.xToken, address(reactorPrime), fuelAmount);
            try reactorPrime.fuel(pool.xToken, fuelAmount) {
                fueled = fuelAmount;
                emit FuelSent(pool.xToken, fuelAmount);
            } catch {
                // Reset dangling approval on fuel failure
                _safeApprove(pool.xToken, address(reactorPrime), 0);
            }
        }

        // 5. Remaining: split half buy / half LP
        uint256 xRemaining = IERC20(pool.xToken).balanceOf(address(this));
        if (xRemaining < MIN_PROCESS) return (burned, 0, fueled);

        uint256 xForBuy = xRemaining / 2;
        uint256 xForLP  = xRemaining - xForBuy;

        // 6. Slippage-protected swap: half-X for native token (buy back)
        uint160 limit = _getSqrtPriceLimitSafe(pool.poolAddress, pool.tokenIsToken0);

        _safeApprove(pool.xToken, address(router), xForBuy);
        bought = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           pool.xToken,
                tokenOut:          token,
                fee:               pool.fee,
                recipient:         address(this),
                amountIn:          xForBuy,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: limit
            })
        );

        // 7. Deposit bought token + remaining X as deeper LP
        if (bought > 0 && xForLP > 0) {
            _safeApprove(token, address(pm), bought);
            _safeApprove(pool.xToken, address(pm), xForLP);

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

        // 8. Burn any native token dust from ratio mismatch
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) {
            _safeTransfer(token, BURN, dust);
            burned += dust;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Internal — Slippage Protection
    // ═══════════════════════════════════════════════════════════════════

    /// @dev Read slot0, verify pool isn't being reentered, then cap price movement at 3%.
    function _getSqrtPriceLimitSafe(address poolAddr, bool tokenIsToken0) internal view returns (uint160) {
        (uint160 sqrtPriceX96,,,,,, bool unlocked) = IUniswapV3Pool(poolAddr).slot0();
        require(unlocked, "pool locked");
        return _calcPriceLimit(sqrtPriceX96, tokenIsToken0);
    }

    /// @dev Calculate sqrtPriceLimitX96 that caps price impact at MAX_PRICE_IMPACT_BPS.
    function _calcPriceLimit(uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint160) {
        if (tokenIsToken0) {
            // selling token1 (xToken) for token0 (native) -> sqrtPrice rises
            uint256 limit = uint256(sqrtPriceX96) * (10000 + MAX_PRICE_IMPACT_BPS) / 10000;
            if (limit <= sqrtPriceX96) limit = uint256(sqrtPriceX96) + 1;
            if (limit >= MAX_SQRT_RATIO) limit = MAX_SQRT_RATIO - 1;
            return uint160(limit);
        } else {
            // selling token0 (xToken) for token1 (native) -> sqrtPrice falls
            uint256 limit = uint256(sqrtPriceX96) * (10000 - MAX_PRICE_IMPACT_BPS) / 10000;
            if (limit >= sqrtPriceX96) limit = uint256(sqrtPriceX96) - 1;
            if (limit <= MIN_SQRT_RATIO) limit = MIN_SQRT_RATIO + 1;
            return uint160(limit);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Internal — Safe Token Operations
    // ═══════════════════════════════════════════════════════════════════

    function _safeTransfer(address _token, address to, uint256 amount) internal {
        (bool success, bytes memory data) = _token.call(
            abi.encodeWithSelector(IERC20.transfer.selector, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "transfer failed");
    }

    function _safeTransferFrom(address _token, address from, address to, uint256 amount) internal {
        (bool success, bytes memory data) = _token.call(
            abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "transferFrom failed");
    }

    /// @dev Reset approval to 0 before setting new value (handles USDT-style tokens)
    function _safeApprove(address _token, address spender, uint256 amount) internal {
        (bool success, bytes memory data) = _token.call(
            abi.encodeWithSelector(IERC20.approve.selector, spender, 0)
        );
        require(success && (data.length == 0 || abi.decode(data, (bool))), "approve reset failed");
        if (amount > 0) {
            (success, data) = _token.call(
                abi.encodeWithSelector(IERC20.approve.selector, spender, amount)
            );
            require(success && (data.length == 0 || abi.decode(data, (bool))), "approve failed");
        }
    }

    function _findPool(address xToken) internal view returns (uint256) {
        uint256 len = pools.length;
        for (uint256 i; i < len; ++i) {
            if (pools[i].xToken == xToken) return i;
        }
        return type(uint256).max;
    }

    function _burnDust() internal {
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) {
            _safeTransfer(token, BURN, dust);
            emit DustBurned(dust);
        }
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

    function canFuel(address xToken) external view returns (bool) {
        return _findPool(xToken) < type(uint256).max;
    }

    function dustBalance(address _token) external view returns (uint256) {
        return IERC20(_token).balanceOf(address(this));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  NFT receiver — only accept from admin
    // ═══════════════════════════════════════════════════════════════════

    function onERC721Received(address, address from, uint256, bytes calldata) external view returns (bytes4) {
        require(from == admin, "only admin can send NFTs");
        return this.onERC721Received.selector;
    }
}
