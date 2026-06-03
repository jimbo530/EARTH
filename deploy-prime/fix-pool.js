/**
 * Fix broken 1% MfT/USDC pool
 *
 * Pool 0xcB7a140C422EFc9392FC578d1F47F721cd9DC914 is at inverted tick -427359 with 0 liquidity.
 * Steps:
 *   1. Deploy PoolFixer helper
 *   2. Send dust USDC + MfT to it
 *   3. Call fix() → injects L=1 via direct pool.mint()
 *   4. Sweep leftover dust back
 *   5. Approve USDC to SwapRouter
 *   6. Swap USDC → MfT to push price to correct tick
 *
 * Total cost: < $0.10 (gas + dust)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('No AGENT_PRIVATE_KEY in Baselings/api/.env');
  process.exit(1);
}

const POOL   = '0xcB7a140C422EFc9392FC578d1F47F721cd9DC914';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MFT    = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

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

  const ethBal = await provider.getBalance(wallet.address);
  console.log('ETH:', ethers.formatEther(ethBal));

  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const mft  = new ethers.Contract(MFT, ERC20_ABI, wallet);
  console.log('USDC:', ethers.formatUnits(await usdc.balanceOf(wallet.address), 6));
  console.log('MfT:', ethers.formatEther(await mft.balanceOf(wallet.address)));

  // Check pool state before
  const poolContract = new ethers.Contract(POOL, POOL_ABI, provider);
  let slot0 = await poolContract.slot0();
  let liq = await poolContract.liquidity();
  console.log('\n=== POOL STATE BEFORE ===');
  console.log('Tick:', slot0[1].toString());
  console.log('Liquidity:', liq.toString());

  if (liq > 0n) {
    console.log('Pool already has liquidity! Skipping fixer deploy.');
    console.log('Jumping to swap step...');
  } else {
    // === TX 1: Deploy PoolFixer ===
    console.log('\n--- TX 1: Deploy PoolFixer ---');
    const artifact = JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'artifacts', 'contracts', 'PoolFixer.sol', 'PoolFixer.json')
    ));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    const fixer = await factory.deploy();
    console.log('Deploy tx:', fixer.deploymentTransaction().hash);
    await fixer.waitForDeployment();
    const fixerAddr = await fixer.getAddress();
    console.log('PoolFixer:', fixerAddr);

    // === TX 2: Send dust USDC to fixer ===
    console.log('\n--- TX 2: Send 100 USDC units to fixer ---');
    let tx = await usdc.transfer(fixerAddr, 100);
    console.log('Tx:', tx.hash);
    await tx.wait();
    console.log('Done');

    // === TX 3: Send dust MfT to fixer ===
    console.log('\n--- TX 3: Send 100 MfT units to fixer ---');
    tx = await mft.transfer(fixerAddr, 100);
    console.log('Tx:', tx.hash);
    await tx.wait();
    console.log('Done');

    // === TX 4: fix() — inject L=1 ===
    console.log('\n--- TX 4: fix(pool, -887200, 887200) ---');
    const fixerContract = new ethers.Contract(fixerAddr, FIXER_ABI, wallet);
    tx = await fixerContract.fix(POOL, -887200, 887200);
    console.log('Tx:', tx.hash);
    await tx.wait();
    console.log('L=1 injected!');

    // Check pool after fix
    slot0 = await poolContract.slot0();
    liq = await poolContract.liquidity();
    console.log('Tick after fix:', slot0[1].toString());
    console.log('Liquidity after fix:', liq.toString());

    // === TX 5-6: Sweep leftovers ===
    console.log('\n--- TX 5-6: Sweep dust back ---');
    tx = await fixerContract.sweep(USDC, wallet.address);
    console.log('Sweep USDC tx:', tx.hash);
    await tx.wait();
    tx = await fixerContract.sweep(MFT, wallet.address);
    console.log('Sweep MfT tx:', tx.hash);
    await tx.wait();
    console.log('Dust recovered');
  }

  // === TX 7: Approve USDC to SwapRouter ===
  console.log('\n--- TX 7: Approve USDC to SwapRouter ---');
  // Only approve $2 max — with L=1 it'll barely use anything
  const swapBudget = ethers.parseUnits('2', 6);
  let tx = await usdc.approve(ROUTER, swapBudget);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Approved 2 USDC');

  // === TX 8: Swap USDC → MfT to fix price ===
  console.log('\n--- TX 8: Swap USDC → MfT (fix price) ---');
  // Target: MfT ~$0.000000268, so 1 USDC ≈ 3,735,497 MfT
  // price(token1/token0) = 3735497e18 / 1e6 = 3.735497e24
  // sqrtPriceX96 = sqrt(price * 2^192)
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
  console.log('Final liquidity:', liq.toString());
  console.log('sqrtPriceX96:', slot0[0].toString());
  console.log('========================================');
  console.log('\nReady for seed-1pct.js or page 2 to mint real position.');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
