// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Mock Uniswap V3 primitives for Reactor.execute() end-to-end tests.
/// @notice Not deployed. Compiled only as part of the hardhat test suite.

interface IERC20Test {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
}

contract MockERC20 {
    string public name;
    string public symbol;
    uint8  public constant decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) { name = n; symbol = s; }

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        emit Transfer(address(0), to, amt);
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(balanceOf[msg.sender] >= amt, "ERC20: insufficient");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        emit Transfer(msg.sender, to, amt);
        return true;
    }

    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        emit Approval(msg.sender, spender, amt);
        return true;
    }

    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        require(allowance[from][msg.sender] >= amt, "ERC20: allowance");
        require(balanceOf[from] >= amt, "ERC20: insufficient");
        unchecked { allowance[from][msg.sender] -= amt; }
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        emit Transfer(from, to, amt);
        return true;
    }
}

contract MockNPM {
    // Per-tokenId metadata, settable by tests.
    mapping(uint256 => address) public _ownerOf;
    mapping(uint256 => address) public token0Of;
    mapping(uint256 => address) public token1Of;
    mapping(uint256 => uint24)  public feeOf;
    mapping(uint256 => uint256) public collectA0;
    mapping(uint256 => uint256) public collectA1;

    // Test introspection — last increaseLiquidity call args.
    uint256 public lastTokenId;
    uint256 public lastAmount0Desired;
    uint256 public lastAmount1Desired;
    uint256 public lastAmount0Min;
    uint256 public lastAmount1Min;
    uint256 public increaseLiquidityCallCount;

    struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
    struct IncreaseLiquidityParams { uint256 tokenId; uint256 amount0Desired; uint256 amount1Desired; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }

    function setPosition(uint256 tokenId, address owner, address t0, address t1, uint24 fee) external {
        _ownerOf[tokenId] = owner;
        token0Of[tokenId] = t0;
        token1Of[tokenId] = t1;
        feeOf[tokenId] = fee;
    }

    function setCollectAmounts(uint256 tokenId, uint256 a0, uint256 a1) external {
        collectA0[tokenId] = a0;
        collectA1[tokenId] = a1;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return _ownerOf[tokenId];
    }

    function positions(uint256 tokenId) external view returns (
        uint96 nonce,
        address operator,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 feeGrowthInside0LastX128,
        uint256 feeGrowthInside1LastX128,
        uint128 tokensOwed0,
        uint128 tokensOwed1
    ) {
        token0 = token0Of[tokenId];
        token1 = token1Of[tokenId];
        fee = feeOf[tokenId];
        // remaining named returns auto-zero-init; silence unused-var warnings
        nonce; operator; tickLower; tickUpper; liquidity;
        feeGrowthInside0LastX128; feeGrowthInside1LastX128;
        tokensOwed0; tokensOwed1;
    }

    function collect(CollectParams calldata p) external payable returns (uint256, uint256) {
        uint256 a0 = collectA0[p.tokenId];
        uint256 a1 = collectA1[p.tokenId];
        if (a0 > 0) IERC20Test(token0Of[p.tokenId]).transfer(p.recipient, a0);
        if (a1 > 0) IERC20Test(token1Of[p.tokenId]).transfer(p.recipient, a1);
        // Reset so subsequent collect() with same tokenId returns 0 unless re-set.
        collectA0[p.tokenId] = 0;
        collectA1[p.tokenId] = 0;
        return (a0, a1);
    }

    function increaseLiquidity(IncreaseLiquidityParams calldata p) external payable returns (uint128, uint256, uint256) {
        lastTokenId = p.tokenId;
        lastAmount0Desired = p.amount0Desired;
        lastAmount1Desired = p.amount1Desired;
        lastAmount0Min = p.amount0Min;
        lastAmount1Min = p.amount1Min;
        increaseLiquidityCallCount++;
        // Pull both sides from caller as if we deposited at the current ratio.
        IERC20Test(token0Of[p.tokenId]).transferFrom(msg.sender, address(this), p.amount0Desired);
        IERC20Test(token1Of[p.tokenId]).transferFrom(msg.sender, address(this), p.amount1Desired);
        return (0, p.amount0Desired, p.amount1Desired);
    }
}

contract MockRouter {
    // Settable bought amount per (tokenIn, tokenOut) pair.
    mapping(bytes32 => uint256) public boughtOut;
    address public tokenOutSource;  // address that holds tokenOut and approves this router

    struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }

    function setSwap(address tokenIn, address tokenOut, uint256 out) external {
        boughtOut[keccak256(abi.encodePacked(tokenIn, tokenOut))] = out;
    }

    function setTokenOutSource(address src) external {
        tokenOutSource = src;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable returns (uint256 out) {
        out = boughtOut[keccak256(abi.encodePacked(p.tokenIn, p.tokenOut))];
        // Pull tokenIn from caller.
        IERC20Test(p.tokenIn).transferFrom(msg.sender, address(this), p.amountIn);
        // Pay tokenOut from source (set by test, must have pre-approved this router).
        if (out > 0 && tokenOutSource != address(0)) {
            IERC20Test(p.tokenOut).transferFrom(tokenOutSource, p.recipient, out);
        }
    }
}

contract MockFactory {
    mapping(bytes32 => address) public _pool;

    function setPool(address t0, address t1, uint24 fee, address pool) external {
        _pool[keccak256(abi.encodePacked(t0, t1, fee))] = pool;
        _pool[keccak256(abi.encodePacked(t1, t0, fee))] = pool;
    }

    function getPool(address t0, address t1, uint24 fee) external view returns (address) {
        return _pool[keccak256(abi.encodePacked(t0, t1, fee))];
    }
}
