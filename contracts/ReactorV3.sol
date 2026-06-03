// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReactorV3 — Hardened burn/buyback/LP engine
///
/// Third-generation Reactor design. Improvements over V1 (EARTH) and V2 (Tasern):
///
///   1. NFT ownership validation   — addPool verifies pm.ownerOf(tokenId) == address(this)
///   2. Per-pool try/catch         — one failing pool cannot brick the entire system
///   3. Slippage protection        — sqrtPriceLimitX96 derived from pool.slot0() (3% max impact)
///   4. removePool + pause         — admin can remove or disable pools without redeployment
///   5. depositLiquidity           — admin can manually deepen any pool position
///   6. Multi-fee tier             — any V3 fee tier accepted (not locked to 1%)
///   7. isExcluded-safe exclusion  — checks before calling excludeFromRebase to prevent reverts
///   8. Dual-mode burn             — supports rebase tokens (EARTH) and standard tokens (dead-addr)
///   9. Configurable rebase ratio  — set at deploy time via rebaseNum/rebaseDen
///
///   Positions are locked forever — no withdraw function exists.
///   Anyone can call execute() after the 2-hour cooldown.

// ═══════════════════════════════════════════════════════════════════════════
//  Interfaces
// ═══════════════════════════════════════════════════════════════════════════

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @dev Optional rebase interface — only used when supportsRebase == true
interface IRebaseToken {
    function burn(uint256 amount) external;
    function rebase(uint256 mintAmount) external;
    function excludeFromRebase(address account) external;
    function isExcluded(address account) external view returns (bool);
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

contract ReactorV3 {

    // ── Constants ─────────────────────────────────────────────────────────────
    // UniswapV3 TickMath bounds — sqrtPriceLimitX96 must stay within these
    uint160 private constant MIN_SQRT_RATIO = 4295128739;
    uint160 private constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ── Immutables ────────────────────────────────────────────────────────────
    address                        public immutable token;
    INonfungiblePositionManager    public immutable pm;
    ISwapRouter02                  public immutable router;
    IUniswapV3Factory              public immutable factory;
    bool                           public immutable supportsRebase; // true = EARTH-style, false = dead-addr burn
    uint256                        public immutable rebaseNum;      // e.g. 3  (rebase = fees * 3/10)
    uint256                        public immutable rebaseDen;      // e.g. 10

    // ── State ─────────────────────────────────────────────────────────────────
    uint256 public lastExecute;
    uint256 public constant COOLDOWN = 2 hours;
    uint256 public constant MAX_PRICE_IMPACT_BPS = 300; // 3%

    struct Pool {
        uint256 tokenId;       // V3 position NFT held by this contract
        address xToken;        // the non-token side of the pair
        address poolAddress;   // V3 pool contract (cached for slot0 lookups)
        uint24  fee;           // V3 fee tier (any tier accepted)
        bool    tokenIsToken0; // true when token is token0 in the V3 pool
        bool    active;        // false = skipped during execute()
    }
    Pool[] public pools;

    address public admin;

    // ── Events ────────────────────────────────────────────────────────────────
    event Executed(uint256 burned, uint256 minted, uint256 timestamp, address caller);
    event PoolAdded(uint256 indexed tokenId, address xToken, address poolAddr, uint24 fee);
    event PoolRemoved(uint256 indexed poolIndex, uint256 tokenId);
    event PoolSkipped(uint256 indexed poolIndex, uint256 tokenId);
    event LiquidityDeposited(uint256 indexed poolIndex, uint256 amount0, uint256 amount1);

    // ── Modifiers ─────────────────────────────────────────────────────────────
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

    /// @param _token           The token this reactor manages (EARTH, DDD, etc.)
    /// @param _pm              Uniswap V3 NonfungiblePositionManager
    /// @param _router          Uniswap V3 SwapRouter02
    /// @param _factory         Uniswap V3 Factory
    /// @param _supportsRebase  true = call burn()/rebase(), false = send to 0xdead
    /// @param _rebaseNum       Numerator for rebase ratio (e.g. 3 for 30%)
    /// @param _rebaseDen       Denominator for rebase ratio (e.g. 10 for 30%)
    constructor(
        address _token,
        address _pm,
        address _router,
        address _factory,
        bool    _supportsRebase,
        uint256 _rebaseNum,
        uint256 _rebaseDen
    ) {
        require(_rebaseDen > 0, "zero denominator");
        require(_rebaseNum <= _rebaseDen, "rebase > 100%");

        token          = _token;
        pm             = INonfungiblePositionManager(_pm);
        router         = ISwapRouter02(_router);
        factory        = IUniswapV3Factory(_factory);
        supportsRebase = _supportsRebase;
        rebaseNum      = _rebaseNum;
        rebaseDen      = _rebaseDen;
        admin          = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pool Management (admin only)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Register a V3 position. The NFT must already be transferred to this contract.
    ///         Validates ownership, token presence, and pool existence.
    function addPool(uint256 tokenId) external onlyAdmin {
        // V3 FIX: verify this contract actually owns the NFT
        require(pm.ownerOf(tokenId) == address(this), "NFT not owned by reactor");

        (, , address token0, address token1, uint24 fee, , , , , , ,) = pm.positions(tokenId);

        bool is0 = (token0 == token);
        bool is1 = (token1 == token);
        require(is0 || is1, "token not in pair");

        address xToken   = is0 ? token1 : token0;
        address poolAddr = factory.getPool(token0, token1, fee);
        require(poolAddr != address(0), "pool not found");

        pools.push(Pool({
            tokenId:       tokenId,
            xToken:        xToken,
            poolAddress:   poolAddr,
            fee:           fee,
            tokenIsToken0: is0,
            active:        true
        }));

        // Exclude pool from rebase if supported (safe: checks isExcluded first)
        if (supportsRebase) {
            bool alreadyExcluded;
            try IRebaseToken(token).isExcluded(poolAddr) returns (bool ex) {
                alreadyExcluded = ex;
            } catch {}
            if (!alreadyExcluded) {
                IRebaseToken(token).excludeFromRebase(poolAddr);
            }
        }

        emit PoolAdded(tokenId, xToken, poolAddr, fee);
    }

    /// @notice Remove a pool from the reactor. Uses swap-and-pop — indices may shift.
    ///         The position NFT stays in the contract (locked forever by design).
    function removePool(uint256 poolIndex) external onlyAdmin {
        require(poolIndex < pools.length, "invalid index");

        uint256 removedTokenId = pools[poolIndex].tokenId;

        // Swap with last element and pop
        pools[poolIndex] = pools[pools.length - 1];
        pools.pop();

        emit PoolRemoved(poolIndex, removedTokenId);
    }

    /// @notice Pause or resume a pool without removing it.
    function setPoolActive(uint256 poolIndex, bool active) external onlyAdmin {
        require(poolIndex < pools.length, "invalid index");
        pools[poolIndex].active = active;
    }

    /// @notice Deposit additional liquidity into an existing pool position.
    ///         Caller must approve this contract for both tokens before calling.
    function depositLiquidity(uint256 poolIndex, uint256 tokenAmount, uint256 xAmount) external onlyAdmin {
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

    function transferAdmin(address newAdmin) external onlyAdmin {
        admin = newAdmin;
    }

    function renounceAdmin() external onlyAdmin {
        admin = address(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Execute — anyone can call after cooldown
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Process all active pools. Per-pool try/catch ensures one failure
    ///         doesn't brick the entire system. Skipped pools emit PoolSkipped.
    function execute() external {
        require(block.timestamp >= lastExecute + COOLDOWN, "cooldown");
        lastExecute = block.timestamp;

        uint256 totalBurned;
        uint256 totalBought;
        uint256 len = pools.length;

        for (uint256 i; i < len; ++i) {
            if (!pools[i].active) continue;

            // V3 FIX: try/catch per pool — one bad pool can't kill the rest
            try this.processPool(i) returns (uint256 burned, uint256 bought) {
                totalBurned += burned;
                totalBought += bought;
            } catch {
                emit PoolSkipped(i, pools[i].tokenId);
            }
        }

        // Rebase: mint proportional yield to holders
        if (supportsRebase) {
            uint256 totalFeesInToken = totalBurned + (totalBought * 2);
            uint256 mintAmount = totalFeesInToken * rebaseNum / rebaseDen;
            if (mintAmount > 0) {
                IRebaseToken(token).rebase(mintAmount);
            }
            emit Executed(totalBurned, mintAmount, block.timestamp, msg.sender);
        } else {
            emit Executed(totalBurned, 0, block.timestamp, msg.sender);
        }
    }

    /// @notice Process a single pool: collect → burn → swap → deposit.
    ///         Called only by execute() via this.processPool() for try/catch isolation.
    function processPool(uint256 poolIndex) external onlySelf returns (uint256 burned, uint256 bought) {
        Pool memory pool = pools[poolIndex];

        // ── 1. Collect accrued fees from V3 position ─────────────────────
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

        // ── 2. Burn token side of fees ───────────────────────────────────
        if (tokenFees > 0) {
            if (supportsRebase) {
                IRebaseToken(token).burn(tokenFees);
            } else {
                IERC20(token).transfer(DEAD, tokenFees);
            }
            burned = tokenFees;
        }

        if (xFees == 0) return (burned, 0);

        // ── 3. Split X: half buys token, half stays for LP ───────────────
        uint256 xForBuy = xFees / 2;
        uint256 xForLP  = xFees - xForBuy;

        // ── 4. Swap half-X → token with slippage protection ─────────────
        //   V3 FIX: derive sqrtPriceLimitX96 from pool.slot0() to cap MEV
        (uint160 sqrtPriceX96,,,,,,) = IUniswapV3Pool(pool.poolAddress).slot0();
        uint160 sqrtPriceLimit = _calcPriceLimit(sqrtPriceX96, pool.tokenIsToken0);

        IERC20(pool.xToken).approve(address(router), xForBuy);
        bought = router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn:           pool.xToken,
                tokenOut:          token,
                fee:               pool.fee,
                recipient:         address(this),
                amountIn:          xForBuy,
                amountOutMinimum:  0,                // sqrtPriceLimit handles slippage
                sqrtPriceLimitX96: sqrtPriceLimit
            })
        );

        // ── 5. Deposit bought token + remaining X as LP ──────────────────
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

    // ═══════════════════════════════════════════════════════════════════════════
    //  Internal
    // ═══════════════════════════════════════════════════════════════════════════

    /// @dev Calculate sqrtPriceLimitX96 for a swap, capping price impact at MAX_PRICE_IMPACT_BPS.
    ///      Buying token (token0) with X (token1): sqrtPrice increases → limit above current.
    ///      Buying token (token1) with X (token0): sqrtPrice decreases → limit below current.
    function _calcPriceLimit(uint160 sqrtPriceX96, bool tokenIsToken0) internal pure returns (uint160) {
        if (tokenIsToken0) {
            // Selling token1 for token0: price (token1/token0) increases
            uint256 limit = uint256(sqrtPriceX96) * (10000 + MAX_PRICE_IMPACT_BPS) / 10000;
            // Ensure limit is above current price (rounding edge case)
            if (limit <= sqrtPriceX96) limit = uint256(sqrtPriceX96) + 1;
            // Cap at V3 max
            if (limit >= MAX_SQRT_RATIO) limit = MAX_SQRT_RATIO - 1;
            return uint160(limit);
        } else {
            // Selling token0 for token1: price decreases
            uint256 limit = uint256(sqrtPriceX96) * (10000 - MAX_PRICE_IMPACT_BPS) / 10000;
            // Ensure limit is below current price
            if (limit >= sqrtPriceX96) limit = uint256(sqrtPriceX96) - 1;
            // Floor at V3 min
            if (limit <= MIN_SQRT_RATIO) limit = MIN_SQRT_RATIO + 1;
            return uint160(limit);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════════════════════

    function poolCount() external view returns (uint256) {
        return pools.length;
    }

    function timeUntilExecute() external view returns (uint256) {
        if (block.timestamp >= lastExecute + COOLDOWN) return 0;
        return (lastExecute + COOLDOWN) - block.timestamp;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  NFT receiver — required to accept V3 position NFTs
    // ═══════════════════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }
}
