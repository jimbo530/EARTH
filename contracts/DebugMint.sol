// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPool {
    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool);
}

interface INPM {
    function factory() external view returns (address);
}

/// @notice Reproduces the NPM's liquidity calculation to debug M0
contract DebugMint {
    bytes32 constant POOL_INIT_CODE_HASH = 0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54;

    struct Result {
        address computedPool;
        uint160 sqrtPriceX96;
        int24 currentTick;
        uint160 sqrtRatioA;
        uint160 sqrtRatioB;
        uint128 liquidity0;
        uint128 liquidity1;
        uint128 finalLiquidity;
    }

    function debug(
        address npm,
        address token0,
        address token1,
        uint24 fee,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0,
        uint256 amount1
    ) external view returns (Result memory r) {
        address factory = INPM(npm).factory();

        r.computedPool = address(uint160(uint256(keccak256(abi.encodePacked(
            hex'ff',
            factory,
            keccak256(abi.encode(token0, token1, fee)),
            POOL_INIT_CODE_HASH
        )))));

        (r.sqrtPriceX96, r.currentTick, , , , , ) = IPool(r.computedPool).slot0();

        r.sqrtRatioA = _getSqrtRatioAtTick(tickLower);
        r.sqrtRatioB = _getSqrtRatioAtTick(tickUpper);

        if (r.sqrtRatioA > r.sqrtRatioB) (r.sqrtRatioA, r.sqrtRatioB) = (r.sqrtRatioB, r.sqrtRatioA);

        if (r.sqrtPriceX96 <= r.sqrtRatioA) {
            r.finalLiquidity = _getLiquidityForAmount0(r.sqrtRatioA, r.sqrtRatioB, amount0);
        } else if (r.sqrtPriceX96 < r.sqrtRatioB) {
            r.liquidity0 = _getLiquidityForAmount0(r.sqrtPriceX96, r.sqrtRatioB, amount0);
            r.liquidity1 = _getLiquidityForAmount1(r.sqrtRatioA, r.sqrtPriceX96, amount1);
            r.finalLiquidity = r.liquidity0 < r.liquidity1 ? r.liquidity0 : r.liquidity1;
        } else {
            r.finalLiquidity = _getLiquidityForAmount1(r.sqrtRatioA, r.sqrtRatioB, amount1);
        }
    }

    // Exact copy of TickMath.getSqrtRatioAtTick from Uniswap V3
    function _getSqrtRatioAtTick(int24 tick) internal pure returns (uint160 sqrtPriceX96) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        require(absTick <= 887272, "T");

        uint256 ratio = absTick & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : 0x100000000000000000000000000000000;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;

        if (tick > 0) ratio = type(uint256).max / ratio;
        sqrtPriceX96 = uint160((ratio >> 32) + (ratio % (1 << 32) == 0 ? 0 : 1));
    }

    function _getLiquidityForAmount0(uint160 sqrtRatioAX96, uint160 sqrtRatioBX96, uint256 amount0) internal pure returns (uint128) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        uint256 intermediate = _mulDiv(uint256(sqrtRatioAX96), uint256(sqrtRatioBX96), 1 << 96);
        return _toUint128(_mulDiv(amount0, intermediate, uint256(sqrtRatioBX96) - uint256(sqrtRatioAX96)));
    }

    function _getLiquidityForAmount1(uint160 sqrtRatioAX96, uint160 sqrtRatioBX96, uint256 amount1) internal pure returns (uint128) {
        if (sqrtRatioAX96 > sqrtRatioBX96) (sqrtRatioAX96, sqrtRatioBX96) = (sqrtRatioBX96, sqrtRatioAX96);
        return _toUint128(_mulDiv(amount1, 1 << 96, uint256(sqrtRatioBX96) - uint256(sqrtRatioAX96)));
    }

    function _toUint128(uint256 x) internal pure returns (uint128 y) {
        require((y = uint128(x)) == x);
    }

    // Simplified mulDiv (for reasonable values)
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        uint256 prod0;
        uint256 prod1;
        assembly {
            let mm := mulmod(a, b, not(0))
            prod0 := mul(a, b)
            prod1 := sub(sub(mm, prod0), lt(mm, prod0))
        }
        if (prod1 == 0) {
            require(denominator > 0);
            assembly { result := div(prod0, denominator) }
            return result;
        }
        require(denominator > prod1);
        uint256 remainder;
        assembly {
            remainder := mulmod(a, b, denominator)
            prod1 := sub(prod1, gt(remainder, prod0))
            prod0 := sub(prod0, remainder)
        }
        uint256 twos = denominator & (~denominator + 1);
        assembly {
            denominator := div(denominator, twos)
            prod0 := div(prod0, twos)
            twos := add(div(sub(0, twos), twos), 1)
        }
        prod0 |= prod1 * twos;
        uint256 inv = (3 * denominator) ^ 2;
        inv *= 2 - denominator * inv;
        inv *= 2 - denominator * inv;
        inv *= 2 - denominator * inv;
        inv *= 2 - denominator * inv;
        inv *= 2 - denominator * inv;
        inv *= 2 - denominator * inv;
        result = prod0 * inv;
    }
}
