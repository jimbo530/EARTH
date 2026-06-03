/**
 * Retry: fund deployed PoolFixer with more tokens, call fix(), then swap
 * Fixer already deployed at 0x630886AdF40702Fdf1861dB056931568eF65C220
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const POOL   = '0xcB7a140C422EFc9392FC578d1F47F721cd9DC914';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MFT    = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FIXER  = '0x630886AdF40702Fdf1861dB056931568eF65C220';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];

const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
  'function liquidity() view returns (uint128)'
];

const FIXER_ABI = [
  'function fix(address pool, int24 tickLower, int24 tickUpper)',
  'function sweep(address token, address to)'
];

const SWAP_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)'
];

function sqrtBigInt(n) {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('Wallet:', wallet.address);
  console.log('Fixer:', FIXER);

  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const mft  = new ethers.Contract(MFT, ERC20_ABI, wallet);

  // Check what fixer already has
  const fixerUsdc = await usdc.balanceOf(FIXER);
  const fixerMft = await mft.balanceOf(FIXER);
  console.log('Fixer USDC bal:', fixerUsdc.toString(), 'units');
  console.log('Fixer MfT bal:', fixerMft.toString(), 'units');

  const poolContract = new ethers.Contract(POOL, POOL_ABI, provider);
  let slot0 = await poolContract.slot0();
  let liq = await poolContract.liquidity();
  console.log('\nPool tick:', slot0[1].toString());
  console.log('Pool liquidity:', liq.toString());

  if (liq > 0n) {
    console.log('Pool already has liquidity, skipping to swap');
  } else {
    // Send more tokens: 500,000 USDC units ($0.50) and 10^15 MfT units (0.001 MfT)
    // This should be plenty for L=1 at full range
    const usdcToSend = 500000n - fixerUsdc; // top up to 500k units
    const mftToSend = 1000000000000000n - fixerMft; // top up to 10^15 units

    if (usdcToSend > 0n) {
      console.log('\n--- Send', usdcToSend.toString(), 'more USDC units to fixer ---');
      let tx = await usdc.transfer(FIXER, usdcToSend);
      console.log('Tx:', tx.hash);
      await tx.wait();
      console.log('Done');
    }

    if (mftToSend > 0n) {
      console.log('--- Send', mftToSend.toString(), 'more MfT units to fixer ---');
      let tx = await mft.transfer(FIXER, mftToSend);
      console.log('Tx:', tx.hash);
      await tx.wait();
      console.log('Done');
    }

    // Verify balances
    console.log('Fixer USDC now:', (await usdc.balanceOf(FIXER)).toString());
    console.log('Fixer MfT now:', (await mft.balanceOf(FIXER)).toString());

    // Call fix()
    console.log('\n--- fix(pool, -887200, 887200) ---');
    const fixerContract = new ethers.Contract(FIXER, FIXER_ABI, wallet);
    let tx = await fixerContract.fix(POOL, -887200, 887200);
    console.log('Tx:', tx.hash);
    await tx.wait();
    console.log('L=1 injected!');

    // Check pool
    slot0 = await poolContract.slot0();
    liq = await poolContract.liquidity();
    console.log('Tick after fix:', slot0[1].toString());
    console.log('Liquidity:', liq.toString());

    // Sweep leftovers
    console.log('\n--- Sweep dust back ---');
    tx = await fixerContract.sweep(USDC, wallet.address);
    console.log('Sweep USDC:', tx.hash);
    await tx.wait();
    tx = await fixerContract.sweep(MFT, wallet.address);
    console.log('Sweep MfT:', tx.hash);
    await tx.wait();
    console.log('Recovered');
  }

  // Approve USDC to router ($0.50 max budget for swap)
  console.log('\n--- Approve USDC to SwapRouter ---');
  const swapBudget = ethers.parseUnits('0.5', 6); // $0.50
  let tx = await usdc.approve(ROUTER, swapBudget);
  console.log('Tx:', tx.hash);
  await tx.wait();

  // Swap USDC → MfT to fix price
  console.log('\n--- Swap USDC → MfT (fix price) ---');
  const Q192 = 2n ** 192n;
  const targetPrice = (3735497n * 1000000000000000000n) * Q192 / 1000000n;
  const targetSqrt = sqrtBigInt(targetPrice);
  console.log('Target sqrtPriceX96:', targetSqrt.toString());

  const router = new ethers.Contract(ROUTER, SWAP_ABI, wallet);
  tx = await router.exactInputSingle({
    tokenIn: USDC,
    tokenOut: MFT,
    fee: 10000,
    recipient: wallet.address,
    amountIn: swapBudget,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: targetSqrt
  });
  console.log('Tx:', tx.hash);
  await tx.wait();

  // Final state
  slot0 = await poolContract.slot0();
  liq = await poolContract.liquidity();
  console.log('\n========================================');
  console.log('1% POOL FIXED');
  console.log('Pool:', POOL);
  console.log('Final tick:', slot0[1].toString());
  console.log('Liquidity:', liq.toString());
  console.log('========================================');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
