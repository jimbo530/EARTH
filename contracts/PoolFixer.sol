// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PoolFixer — inject 1 unit of liquidity into a broken V3 pool
/// @dev One-time use. Costs dust. Enables swaps to fix the price.

interface IPool {
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external returns (uint256 amount0, uint256 amount1);
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

contract PoolFixer {
    function fix(address pool, int24 tickLower, int24 tickUpper) external {
        IPool(pool).mint(address(this), tickLower, tickUpper, 1, abi.encode(msg.sender));
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata data) external {
        address payer = abi.decode(data, (address));
        // Pool tells us exactly what's needed (will be dust for L=1)
        if (amount0Owed > 0) IERC20(0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913).transfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3).transfer(msg.sender, amount1Owed);
    }

    // Recover any tokens sent to this contract
    function sweep(address token, address to) external {
        IERC20(token).transfer(to, IERC20(token).balanceOf(address(this)));
    }
}
