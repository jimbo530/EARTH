// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title TasernReactor — Nation burn/buy/back engine for D20 game tokens
/// @notice V2 reactor design. Collects V3 fees, burns nation token (dead address),
///         buys nation token with opposing fees, deposits LP. Positions locked forever.
///         Anyone can call execute() after cooldown. Admin can add pools & deposit liquidity.

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
}

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

contract TasernReactor {

    // ── Immutables ─────────────────────────────────────────────────────────────
    address public immutable nationToken;   // this nation's game token (e.g. DDD)
    INonfungiblePositionManager public immutable pm;
    ISwapRouter02 public immutable router;
    address public immutable burnAddress;   // where burned tokens go (0xdead or retirement NFT)

    // ── State ──────────────────────────────────────────────────────────────────
    uint256 public lastExecute;
    uint256 public constant COOLDOWN = 2 hours;

    struct Pool {
        uint256 tokenId;        // V3 position NFT held by this contract
        address xToken;         // the opposing nation's token in the pair
        uint24  fee;            // V3 fee tier
        bool    nationIsToken0; // true when nationToken is token0 in the V3 pool
    }
    Pool[] public pools;

    address public admin;

    // ── Events ─────────────────────────────────────────────────────────────────
    event Executed(uint256 burned, uint256 bought, uint256 deposited, uint256 timestamp, address caller);
    event PoolAdded(uint256 indexed tokenId, address xToken, uint24 fee);
    event LiquidityDeposited(uint256 indexed poolIndex, uint256 amount0, uint256 amount1);

    // ═══════════════════════════════════════════════════════════════════════════
    //  Constructor
    // ═══════════════════════════════════════════════════════════════════════════

    constructor(address _nationToken, address _pm, address _router, address _burnAddress) {
        nationToken = _nationToken;
        pm          = INonfungiblePositionManager(_pm);
        router      = ISwapRouter02(_router);
        burnAddress = _burnAddress;
        admin       = msg.sender;
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Pool management (admin)
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Register a V3 position. NFT must already be transferred to this contract.
    ///         Validates that nationToken is one side of the pair. Any fee tier accepted.
    function addPool(uint256 tokenId) external {
        require(msg.sender == admin, "not admin");

        (, , address token0, address token1, uint24 fee, , , , , , ,) = pm.positions(tokenId);

        bool nationIs0 = (token0 == nationToken);
        bool nationIs1 = (token1 == nationToken);
        require(nationIs0 || nationIs1, "nation token not in pair");

        address xToken = nationIs0 ? token1 : token0;

        pools.push(Pool({
            tokenId:        tokenId,
            xToken:         xToken,
            fee:            fee,
            nationIsToken0: nationIs0
        }));

        emit PoolAdded(tokenId, xToken, fee);
    }

    /// @notice Deposit additional liquidity into an existing pool position.
    ///         Caller must approve this contract for both tokens first.
    function depositLiquidity(uint256 poolIndex, uint256 nationAmount, uint256 xAmount) external {
        require(msg.sender == admin, "not admin");
        require(poolIndex < pools.length, "invalid pool");

        Pool memory pool = pools[poolIndex];

        if (nationAmount > 0) {
            IERC20(nationToken).transferFrom(msg.sender, address(this), nationAmount);
            IERC20(nationToken).approve(address(pm), nationAmount);
        }
        if (xAmount > 0) {
            IERC20(pool.xToken).transferFrom(msg.sender, address(this), xAmount);
            IERC20(pool.xToken).approve(address(pm), xAmount);
        }

        uint256 a0d = pool.nationIsToken0 ? nationAmount : xAmount;
        uint256 a1d = pool.nationIsToken0 ? xAmount : nationAmount;

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

    function transferAdmin(address newAdmin) external {
        require(msg.sender == admin, "not admin");
        admin = newAdmin;
    }

    function renounceAdmin() external {
        require(msg.sender == admin, "not admin");
        admin = address(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  Execute — anyone can call after cooldown
    // ═══════════════════════════════════════════════════════════════════════════

    /// @notice Process all pools: collect fees -> burn nation token -> buy nation token
    ///         with opposing fees -> deposit LP. Permissionless after cooldown.
    function execute() external {
        require(block.timestamp >= lastExecute + COOLDOWN, "cooldown");
        lastExecute = block.timestamp;

        uint256 totalBurned;
        uint256 totalBought;
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

            uint256 nationFees = pool.nationIsToken0 ? a0 : a1;
            uint256 xFees      = pool.nationIsToken0 ? a1 : a0;

            if (nationFees == 0 && xFees == 0) continue;

            // ── 2. Burn nation token side (send to dead address) ───────────
            if (nationFees > 0) {
                IERC20(nationToken).transfer(burnAddress, nationFees);
                totalBurned += nationFees;
            }

            if (xFees == 0) continue;

            // ── 3. Split X: half buys nation token, half stays for LP ──────
            uint256 xForBuy = xFees / 2;
            uint256 xForLP  = xFees - xForBuy;

            // ── 4. Swap half X -> nation token ─────────────────────────────
            IERC20(pool.xToken).approve(address(router), xForBuy);
            uint256 nationBought = router.exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn:           pool.xToken,
                    tokenOut:          nationToken,
                    fee:               pool.fee,
                    recipient:         address(this),
                    amountIn:          xForBuy,
                    amountOutMinimum:  0,
                    sqrtPriceLimitX96: 0
                })
            );
            totalBought += nationBought;

            // ── 5. Deposit bought nation token + remaining X as LP ─────────
            if (nationBought > 0 && xForLP > 0) {
                IERC20(nationToken).approve(address(pm), nationBought);
                IERC20(pool.xToken).approve(address(pm), xForLP);

                uint256 a0d = pool.nationIsToken0 ? nationBought : xForLP;
                uint256 a1d = pool.nationIsToken0 ? xForLP : nationBought;

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

        emit Executed(totalBurned, totalBought, totalBought, block.timestamp, msg.sender);
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

    function timeUntilExecute() external view returns (uint256) {
        if (block.timestamp >= lastExecute + COOLDOWN) return 0;
        return (lastExecute + COOLDOWN) - block.timestamp;
    }
}
