// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReactorPrimeV3 — Terminal reactor for MfT (accepts fuel, never forwards)
///
/// The gravity well of the reactor network. Secondary reactors send 10% of
/// X-side fees here via fuel(). This reactor collects LP fees, burns MfT,
/// buys back with X-tokens, and deepens liquidity — but never pays forward.
///
/// Safety features (all from SporeReactorV4):
///   - Reentrancy guard
///   - Two-step admin transfer + renounce
///   - Pool disable/enable (no remove — pools are permanent)
///   - Slippage protection via slot0 sqrtPriceLimitX96 (3% cap)
///   - Cached poolAddress per pool
///   - Duplicate xToken prevention
///   - Pool cap (20)
///   - Safe approve (reset to 0 first)
///   - onERC721 admin guard
///   - Emergency pause
///   - MIN_PROCESS / MIN_FUEL thresholds
///   - Dust burn after every operation
///   - Permissionless deposits (two-sided + single-sided)
///
/// Positions are locked forever — no withdraw function exists.
/// Anyone can call execute() after the 2-hour cooldown.

// ═══════════════════════════════════════════════════════════════════════════
//  Interfaces
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
//  Contract
// ═══════════════════════════════════════════════════════════════════════════

contract ReactorPrimeV3 {

    // ── Constants ────────────────────────────────────────────────────────────
    address private constant BURN = 0xfd780B0aE569e15e514B819ecFDF46f804953a4B;
    uint256 public  constant COOLDOWN  = 2 hours;
    uint256 public  constant MAX_POOLS = 20;
    uint256 public  constant MIN_FUEL  = 1000;
    uint256 public  constant MIN_PROCESS = 1000;
    uint256 public  constant MAX_PRICE_IMPACT_BPS = 300; // 3% max slippage per swap

    // UniswapV3 TickMath bounds
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    // ── Immutables ───────────────────────────────────────────────────────────
    address                      public immutable token;   // MfT
    INonfungiblePositionManager  public immutable pm;
    ISwapRouter02                public immutable router;
    IUniswapV3Factory            public immutable factory;

    // ── State ────────────────────────────────────────────────────────────────
    uint256 public lastExecute;
    bool public paused;

    struct Pool {
        uint256 tokenId;
        address xToken;
        address poolAddress;
        uint24  fee;
        bool    tokenIsToken0;
        bool    disabled;
    }
    Pool[] public pools;
    mapping(uint256 => bool) public registeredTokenId;
    mapping(address => bool) public hasXToken;

    // Two-step admin transfer
    address public admin;
    address public pendingAdmin;

    // Reentrancy guard
    uint256 private _locked = 1;
    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    // ── Events ──────────────────────────────────────────────────────────────
    event Executed(uint256 burned, uint256 deposited, uint256 timestamp, address caller);
    event PoolAdded(uint256 indexed tokenId, address xToken, address poolAddr, uint24 fee);
    event PoolDisabled(uint256 indexed poolIndex, uint256 tokenId);
    event PoolEnabled(uint256 indexed poolIndex, uint256 tokenId);
    event PoolSkipped(uint256 indexed poolIndex, uint256 tokenId);
    event FuelReceived(address indexed xToken, uint256 amount);
    event LiquidityDeposited(uint256 indexed poolIndex, uint256 amount0, uint256 amount1);
    event SingleDeposit(uint256 indexed poolIndex, address inputToken, uint256 inputAmount, uint256 token0Deposited, uint256 token1Deposited);
    event DustBurned(uint256 amount);
    event AdminTransferStarted(address indexed current, address indexed pending);
    event AdminTransferred(address indexed previous, address indexed newAdmin);
    event Paused(bool status);

    // ── Modifiers ───────────────────────────────────────────────────────────
    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    modifier onlySelf() {
        require(msg.sender == address(this), "internal only");
        _;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(
        address _token,
        address _pm,
        address _router,
        address _factory
    ) {
        require(_token   != address(0), "zero token");
        require(_pm      != address(0), "zero pm");
        require(_router  != address(0), "zero router");
        require(_factory != address(0), "zero factory");

        token   = _token;
        pm      = INonfungiblePositionManager(_pm);
        router  = ISwapRouter02(_router);
        factory = IUniswapV3Factory(_factory);
        admin   = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pool Management (admin only)
    // ═══════════════════════════════════════════════════════════════════════════

    function addPool(uint256 tokenId) external onlyAdmin {
        require(pools.length < MAX_POOLS, "max pools reached");
        require(!registeredTokenId[tokenId], "already registered");
        require(pm.ownerOf(tokenId) == address(this), "NFT not owned by reactor");

        (, , address token0, address token1, uint24 fee, , , , , , ,) = pm.positions(tokenId);

        bool is0 = (token0 == token);
        bool is1 = (token1 == token);
        require(is0 || is1, "token not in pair");

        address xToken = is0 ? token1 : token0;
        require(xToken != token, "xToken cannot be native token");

        address poolAddr = factory.getPool(token0, token1, fee);
        require(poolAddr != address(0), "pool not found");

        pools.push(Pool({
            tokenId:       tokenId,
            xToken:        xToken,
            poolAddress:   poolAddr,
            fee:           fee,
            tokenIsToken0: is0,
            disabled:      false
        }));
        registeredTokenId[tokenId] = true;
        hasXToken[xToken] = true;

        emit PoolAdded(tokenId, xToken, poolAddr, fee);
    }

    function disablePool(uint256 poolIndex) external onlyAdmin {
        require(poolIndex < pools.length, "invalid index");
        require(!pools[poolIndex].disabled, "already disabled");
        pools[poolIndex].disabled = true;
        emit PoolDisabled(poolIndex, pools[poolIndex].tokenId);
    }

    function enablePool(uint256 poolIndex) external onlyAdmin {
        require(poolIndex < pools.length, "invalid index");
        require(pools[poolIndex].disabled, "already enabled");
        pools[poolIndex].disabled = false;
        emit PoolEnabled(poolIndex, pools[poolIndex].tokenId);
    }

    // ── Two-step admin transfer ─────────────────────────────────────────────

    function transferAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "zero address");
        pendingAdmin = newAdmin;
        emit AdminTransferStarted(admin, newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "not pending admin");
        emit AdminTransferred(admin, pendingAdmin);
        admin = pendingAdmin;
        pendingAdmin = address(0);
    }

    function renounceAdmin() external onlyAdmin {
        emit AdminTransferred(admin, address(0));
        admin = address(0);
        pendingAdmin = address(0);
    }

    // ── Emergency pause ─────────────────────────────────────────────────

    function setPaused(bool _paused) external onlyAdmin {
        paused = _paused;
        emit Paused(_paused);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Permissionless Deposits
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Deepen an existing pool with both tokens. Caller must approve both.
    function depositLiquidity(uint256 poolIndex, uint256 tokenAmount, uint256 xAmount) external nonReentrant {
        require(poolIndex < pools.length, "invalid index");
        require(!pools[poolIndex].disabled, "pool disabled");
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

    /// @notice Single-sided deposit. Send one token, swaps half, deposits both sides.
    function depositSingle(uint256 poolIndex, uint256 amount, bool isNativeToken) external nonReentrant {
        require(poolIndex < pools.length, "invalid index");
        require(!pools[poolIndex].disabled, "pool disabled");
        require(amount > 0, "zero amount");

        Pool memory pool = pools[poolIndex];
        address inputToken = isNativeToken ? token : pool.xToken;
        address outputToken = isNativeToken ? pool.xToken : token;

        _safeTransferFrom(inputToken, msg.sender, address(this), amount);

        uint256 halfIn = amount / 2;

        // Swap half to the other side
        uint160 limit = _getSqrtPriceLimitForDeposit(pool.poolAddress, pool.tokenIsToken0, isNativeToken);
        _safeApprove(inputToken, address(router), halfIn);
        uint256 swapped = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           inputToken,
                tokenOut:          outputToken,
                fee:               pool.fee,
                recipient:         address(this),
                amountIn:          halfIn,
                amountOutMinimum:  0,
                sqrtPriceLimitX96: limit
            })
        );

        // Deposit both sides
        uint256 tokenAmt = isNativeToken ? (amount - halfIn) : swapped;
        uint256 xAmt     = isNativeToken ? swapped : (amount - halfIn);

        _safeApprove(token, address(pm), tokenAmt);
        _safeApprove(pool.xToken, address(pm), xAmt);

        pm.increaseLiquidity(
            INonfungiblePositionManager.IncreaseLiquidityParams({
                tokenId:        pool.tokenId,
                amount0Desired: pool.tokenIsToken0 ? tokenAmt : xAmt,
                amount1Desired: pool.tokenIsToken0 ? xAmt : tokenAmt,
                amount0Min:     0,
                amount1Min:     0,
                deadline:       block.timestamp
            })
        );

        // Return any dust to caller
        _returnDust(pool.xToken);

        emit SingleDeposit(poolIndex, inputToken, amount, tokenAmt, xAmt);
    }

    function _returnDust(address xToken) internal {
        uint256 d0 = IERC20(token).balanceOf(address(this));
        uint256 d1 = IERC20(xToken).balanceOf(address(this));
        if (d0 > 0) _safeTransfer(token, msg.sender, d0);
        if (d1 > 0) _safeTransfer(xToken, msg.sender, d1);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Fuel Intake (from downstream reactors — Prime keeps everything)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice One-way fuel from downstream reactors. Swaps half to MfT, deposits both as LP.
    ///         No forwarding — this is the terminal reactor.
    function fuel(address xToken, uint256 amount) external nonReentrant {
        require(amount >= MIN_FUEL, "below minimum fuel");

        uint256 poolIndex = _findPool(xToken);
        require(poolIndex < type(uint256).max, "no pool for token");

        Pool memory pool = pools[poolIndex];
        require(!pool.disabled, "pool disabled");

        _safeTransferFrom(xToken, msg.sender, address(this), amount);

        uint256 halfX  = amount / 2;
        uint256 xForLP = amount - halfX;

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

        _burnDust();

        emit FuelReceived(xToken, amount);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Execute — anyone can call after cooldown (unless paused)
    // ═══════════════════════════════════════════════════════════════════════════

    function execute() external nonReentrant {
        require(!paused, "paused");
        require(block.timestamp >= lastExecute + COOLDOWN, "cooldown");
        lastExecute = block.timestamp;

        uint256 totalBurned;
        uint256 totalDeposited;
        uint256 len = pools.length;

        for (uint256 i; i < len; ++i) {
            if (pools[i].disabled) {
                emit PoolSkipped(i, pools[i].tokenId);
                continue;
            }
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
        pm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId:    pool.tokenId,
                recipient:  address(this),
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );

        // 2. Burn ALL native token (MfT) in contract
        uint256 tokenBal = IERC20(token).balanceOf(address(this));
        if (tokenBal > 0) {
            _safeTransfer(token, BURN, tokenBal);
            burned = tokenBal;
        }

        // 3. Get total X-token balance
        uint256 xBal = IERC20(pool.xToken).balanceOf(address(this));
        if (xBal < MIN_PROCESS) return (burned, 0);

        // 4. No fuel forwarding — Prime keeps 100%
        //    Split: half buyback, half LP deepening

        uint256 xForBuy = xBal / 2;
        uint256 xForLP  = xBal - xForBuy;

        // 5. Slippage-protected swap: half-X for MfT (buyback)
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

        // 6. Deposit bought MfT + remaining X as deeper LP
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

        // 7. Burn any MfT dust from ratio mismatch
        uint256 dust = IERC20(token).balanceOf(address(this));
        if (dust > 0) {
            _safeTransfer(token, BURN, dust);
            burned += dust;
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Slippage Protection
    // ═══════════════════════════════════════════════════════════════════════════

    function _getSqrtPriceLimitSafe(address poolAddr, bool tokenIsToken0) internal view returns (uint160) {
        (uint160 sqrtPriceX96,,,,,, bool unlocked) = IUniswapV3Pool(poolAddr).slot0();
        require(unlocked, "pool locked");
        return _calcPriceLimit(sqrtPriceX96, tokenIsToken0);
    }

    function _getSqrtPriceLimitForDeposit(address poolAddr, bool tokenIsToken0, bool sellingNative) internal view returns (uint160) {
        (uint160 sqrtPriceX96,,,,,, bool unlocked) = IUniswapV3Pool(poolAddr).slot0();
        require(unlocked, "pool locked");
        if (sellingNative) {
            return _calcPriceLimit(sqrtPriceX96, !tokenIsToken0);
        }
        return _calcPriceLimit(sqrtPriceX96, tokenIsToken0);
    }

    function _calcPriceLimit(uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint160) {
        if (tokenIsToken0) {
            // selling token1 (xToken) for token0 (MfT) — sqrtPrice rises
            uint256 limit = uint256(sqrtPriceX96) * (10000 + MAX_PRICE_IMPACT_BPS) / 10000;
            if (limit <= sqrtPriceX96) limit = uint256(sqrtPriceX96) + 1;
            if (limit >= MAX_SQRT_RATIO) limit = MAX_SQRT_RATIO - 1;
            return uint160(limit);
        } else {
            // selling token0 (xToken) for token1 (MfT) — sqrtPrice falls
            uint256 limit = uint256(sqrtPriceX96) * (10000 - MAX_PRICE_IMPACT_BPS) / 10000;
            if (limit >= sqrtPriceX96) limit = uint256(sqrtPriceX96) - 1;
            if (limit <= MIN_SQRT_RATIO) limit = MIN_SQRT_RATIO + 1;
            return uint160(limit);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal — Safe Token Operations
    // ═══════════════════════════════════════════════════════════════════════════

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
            if (pools[i].xToken == xToken && !pools[i].disabled) return i;
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════════════════════

    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    function activePoolCount() external view returns (uint256) {
        uint256 count;
        uint256 len = pools.length;
        for (uint256 i; i < len; ++i) {
            if (!pools[i].disabled) count++;
        }
        return count;
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  NFT receiver — only accept from admin
    // ═══════════════════════════════════════════════════════════════════════════

    function onERC721Received(address, address from, uint256, bytes calldata) external view returns (bytes4) {
        require(from == admin, "only admin can send NFTs");
        return this.onERC721Received.selector;
    }
}
