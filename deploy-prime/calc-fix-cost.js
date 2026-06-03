/**
 * Calculate exact USDC cost to inject L=1 at various tick ranges
 * for the broken 1% MfT/USDC pool at tick -427359
 */
const { ethers } = require('ethers');

const Q96 = 2n ** 96n;

function tickToSqrtPriceX96(tick) {
  // sqrtPriceX96 = sqrt(1.0001^tick) * 2^96
  const sqrtPrice = Math.sqrt(Math.pow(1.0001, tick));
  // Convert to bigint carefully
  const scaled = sqrtPrice * Number(Q96);
  return BigInt(Math.floor(scaled));
}

function getAmount0(sqrtA, sqrtB, L) {
  // amount0 = L * Q96 * (sqrtB - sqrtA) / (sqrtA * sqrtB)  [rounded up]
  if (sqrtB <= sqrtA) return 0n;
  const num = L * Q96 * (sqrtB - sqrtA);
  const den = sqrtA * sqrtB;
  return num / den + 1n; // round up
}

function getAmount1(sqrtA, sqrtB, L) {
  // amount1 = L * (sqrtB - sqrtA) / Q96  [rounded up]
  if (sqrtB <= sqrtA) return 0n;
  return L * (sqrtB - sqrtA) / Q96 + 1n;
}

const currentTick = -427359;
const sqrtCurrent = tickToSqrtPriceX96(currentTick);
console.log('Current tick:', currentTick);
console.log('sqrtPriceX96:', sqrtCurrent.toString());
console.log('');

// Test various ranges
const ranges = [
  [-427400, -427200, 'narrowest (1 spacing)'],
  [-427400, -426000, '7 spacings wide'],
  [-427400, -420000, '37 spacings'],
  [-887200,  887200, 'full range'],
];

for (const [lower, upper, label] of ranges) {
  const sqrtLower = tickToSqrtPriceX96(lower);
  const sqrtUpper = tickToSqrtPriceX96(upper);

  let amount0, amount1;

  if (currentTick < lower) {
    // All token0
    amount0 = getAmount0(sqrtLower, sqrtUpper, 1n);
    amount1 = 0n;
  } else if (currentTick >= upper) {
    // All token1
    amount0 = 0n;
    amount1 = getAmount1(sqrtLower, sqrtUpper, 1n);
  } else {
    // In range
    amount0 = getAmount0(sqrtCurrent, sqrtUpper, 1n);
    amount1 = getAmount1(sqrtLower, sqrtCurrent, 1n);
  }

  const usdcDollars = Number(amount0) / 1e6;
  const mftTokens = Number(amount1) / 1e18;

  console.log(`Range [${lower}, ${upper}] — ${label}`);
  console.log(`  USDC: ${amount0.toString()} units ($${usdcDollars.toFixed(4)})`);
  console.log(`  MfT:  ${amount1.toString()} units (${mftTokens.toFixed(6)} MfT)`);
  console.log('');
}
