// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Reactor — Permissionless EARTH burn/buyback/LP engine
/// @notice Collects V3 fees, burns EARTH, buys+deposits LP, rebases holders.
///         Anyone can call execute() after the 2-hour cooldown.
///         Holds V3 position NFTs permanently — no withdraw function exists.

interface IEARTH {
    function burn(uint256 amount) external;
    function rebase(uint256 mintAmount) external;
    function excludeFromRebase(address account) external;
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function totalNonExcludedShares() external view returns (uint256);
}

interface IERC20 {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
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

contract Reactor {

    // ── Immutables ─────────────────────────────────────────────────────────────
    IEARTH                      public immutable earth;
    INonfungiblePositionManager public immutable pm;
    ISwapRouter02               public immutable router;
    IUniswapV3Factory           public immutable factory;

    // ── State ──────────────────────────────────────────────────────────────────
    uint256 public lastExecute;
    uint256 public constant COOLDOWN = 2 hours;

    struct Pool {
        uint256 tokenId;       // V3 position NFT held by this contract
        address xToken;        // the non-EARTH token in the pair
        bool    earthIsToken0; // true when EARTH is token0 in the V3 pool
    }
    Pool[] public pools;

    address public admin;          // can add pools; transfer to timelock later
    address public pendingAdmin;   // two-step transfer target — must call acceptAdmin()

    /// @notice Mint amount carried over from prior execute() calls when the rebase
    ///         delta would have rounded to zero. Distributed on the next successful rebase.
    uint256 public undistributedMint;

    /// @dev Reentrancy guard. The cooldown check already prevents same-function
    ///      re-entry, but this is defense-in-depth and silences static analyzers.
    uint256 private _entered = 1;

    modifier nonReentrant() {
        require(_entered == 1, "reentrant");
        _entered = 2;
        _;
        _entered = 1;
    }

    // ── Events ─────────────────────────────────────────────────────────────────
    event Executed(uint256 burned, uint256 minted, uint256 timestamp, address caller);
    event PoolAdded(uint256 indexed tokenId, address xToken, address poolAddr);
    event AdminTransferProposed(address indexed pendingAdmin);
    event AdminTransferred(address indexed previousAdmin, address indexed newAdmin);
    event MintDeferred(uint256 amount);
    event MintFlushed(uint256 amount);

    // ═══════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(address _earth, address _pm, address _router, address _factory) {
        earth   = IEARTH(_earth);
        pm      = INonfungiblePositionManager(_pm);
        router  = ISwapRouter02(_router);
        factory = IUniswapV3Factory(_factory);
        admin   = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pool management (admin only — timelock later)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Register a V3 position. The NFT must already be transferred to this contract.
    ///         Validates 1% fee tier and that EARTH is one side of the pair.
    ///         Automatically excludes the V3 pool contract from rebase.
    function addPool(uint256 tokenId) external {
        require(msg.sender == admin, "not admin");
        require(pm.ownerOf(tokenId) == address(this), "reactor does not own NFT");

        (, , address token0, address token1, uint24 fee, , , , , , ,) = pm.positions(tokenId);
        require(fee == 10000, "must be 1% fee tier");

        bool earthIs0 = (token0 == address(earth));
        bool earthIs1 = (token1 == address(earth));
        require(earthIs0 || earthIs1, "EARTH not in pair");

        address xToken = earthIs0 ? token1 : token0;

        pools.push(Pool({
            tokenId:       tokenId,
            xToken:        xToken,
            earthIsToken0: earthIs0
        }));

        // Exclude the V3 pool contract from rebase so phantom tokens don't appear
        address poolAddr = factory.getPool(token0, token1, fee);
        require(poolAddr != address(0), "pool not found");
        earth.excludeFromRebase(poolAddr);

        emit PoolAdded(tokenId, xToken, poolAddr);
    }

    /// @notice Propose an admin transfer. The new admin must call acceptAdmin()
    ///         to complete the transfer, preventing fat-finger bricks.
    function transferAdmin(address newAdmin) external {
        require(msg.sender == admin, "not admin");
        pendingAdmin = newAdmin;
        emit AdminTransferProposed(newAdmin);
    }

    function acceptAdmin() external {
        require(msg.sender == pendingAdmin, "not pending admin");
        address previous = admin;
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(previous, admin);
    }

    function renounceAdmin() external {
        require(msg.sender == admin, "not admin");
        address previous = admin;
        admin = address(0);
        pendingAdmin = address(0);
        emit AdminTransferred(previous, address(0));
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Execute — anyone can call after cooldown
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Process all pools: collect fees → burn EARTH → buy EARTH with X → deposit LP → rebase holders.
    ///         Reverts if called before COOLDOWN has elapsed since last execution.
    function execute() external nonReentrant {
        require(block.timestamp >= lastExecute + COOLDOWN, "cooldown");
        lastExecute = block.timestamp;

        uint256 totalEarthBurned;
        uint256 totalEarthBought;
        uint256 len = pools.length;

        for (uint256 i; i < len; ++i) {
            Pool memory pool = pools[i];

            // ── 1. Collect accrued fees from V3 position ───────────────────
            (uint256 a0, uint256 a1) = pm.collect(
                INonfungiblePositionManager.CollectParams({
                    tokenId:   pool.tokenId,
                    recipient: address(this),
                    amount0Max: type(uint128).max,
                    amount1Max: type(uint128).max
                })
            );

            uint256 earthFees = pool.earthIsToken0 ? a0 : a1;
            uint256 xFees     = pool.earthIsToken0 ? a1 : a0;

            if (earthFees == 0 && xFees == 0) continue;

            // ── 2. Burn EARTH side of fees (0.5% of volume) ────────────────
            if (earthFees > 0) {
                earth.burn(earthFees);
                totalEarthBurned += earthFees;
            }

            if (xFees == 0) continue;

            // ── 3. Split X: half buys EARTH, half stays for LP ─────────────
            uint256 xForBuy = xFees / 2;
            uint256 xForLP  = xFees - xForBuy;

            // ── 4. Swap half-X → EARTH ─────────────────────────────────────
            IERC20(pool.xToken).approve(address(router), xForBuy);
            uint256 earthBought = router.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn:           pool.xToken,
                    tokenOut:          address(earth),
                    fee:               10000,
                    recipient:         address(this),
                    amountIn:          xForBuy,
                    amountOutMinimum:  0,        // small amounts, MEV risk acceptable
                    sqrtPriceLimitX96: 0
                })
            );
            totalEarthBought += earthBought;

            // ── 5. Deposit bought EARTH + remaining X as LP ────────────────
            //      5% slippage tolerance protects against sandwich attacks on
            //      the LP add — if pool ratio moves >5% within this tx, the
            //      add (and the entire execute) reverts; nothing is lost,
            //      next caller retries after cooldown reset.
            if (earthBought > 0 && xForLP > 0) {
                IEARTH(address(earth)).approve(address(pm), earthBought);
                IERC20(pool.xToken).approve(address(pm), xForLP);

                uint256 a0d = pool.earthIsToken0 ? earthBought : xForLP;
                uint256 a1d = pool.earthIsToken0 ? xForLP : earthBought;

                pm.increaseLiquidity(
                    INonfungiblePositionManager.IncreaseLiquidityParams({
                        tokenId:        pool.tokenId,
                        amount0Desired: a0d,
                        amount1Desired: a1d,
                        amount0Min:     a0d * 95 / 100,
                        amount1Min:     a1d * 95 / 100,
                        deadline:       block.timestamp
                    })
                );
            }
        }

        // ── 6. Rebase: mint 0.3% of volume to holders ─────────────────────
        //
        // Fees in EARTH terms ≈ earthBurned + earthBought × 2
        //   (earthBurned = 0.5% of volume; earthBought ≈ value of 0.25% of volume)
        // Total fees ≈ 1% of volume → multiply by 0.3 to get 0.3% of volume
        //
        // Carry forward any prior undistributed mint so precision loss in
        // EARTH.rebase() (delta rounds to 0) never silently discards value.
        //
        uint256 totalFeesInEarth = totalEarthBurned + (totalEarthBought * 2);
        uint256 mintAmount = (totalFeesInEarth * 3 / 10) + undistributedMint;
        uint256 effectiveMint = 0;

        if (mintAmount > 0) {
            uint256 shares = earth.totalNonExcludedShares();
            if (shares > 0 && mintAmount * 1e18 / shares > 0) {
                earth.rebase(mintAmount);
                effectiveMint = mintAmount;
                if (undistributedMint > 0) emit MintFlushed(undistributedMint);
                undistributedMint = 0;
            } else {
                undistributedMint = mintAmount;
                emit MintDeferred(mintAmount);
            }
        }

        emit Executed(totalEarthBurned, effectiveMint, block.timestamp, msg.sender);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  NFT receiver — required to accept V3 position NFTs
    // ═══════════════════════════════════════════════════════════════════════════

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC721Received.selector;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Views
    // ═══════════════════════════════════════════════════════════════════════════

    function poolCount() external view returns (uint256) {
        return pools.length;
    }
}
