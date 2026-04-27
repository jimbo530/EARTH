/**
 * buy-earth-with-poop.js — Buy EARTH with POOP, $0.10 per swap, 1 per minute
 * Swaps through EARTH/POOP V3 pool (1% fee) until POOP runs out.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const POOP_ADDR  = '0x126555aecBAC290b25644e4b7f29c016aE95f4dc';
const WETH_ADDR  = '0x4200000000000000000000000000000000000006';
const V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

const TARGET_USD = 0.10;
const INTERVAL_MS = 60_000; // 1 minute

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
];
const FACTORY_ABI = [
  'function getPool(address, address, uint24) view returns (address)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retry(fn, label, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch(e) {
      if (i === attempts) throw e;
      await sleep(2000);
    }
  }
}

async function main() {
  if (!PRIVATE_KEY) { console.error('Set KEEPER_PRIVATE_KEY in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const poop = new ethers.Contract(POOP_ADDR, ERC20_ABI, wallet);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);

  log('Wallet: ' + wallet.address);

  // Approve router for all POOP
  const poopBal = await retry(() => poop.balanceOf(wallet.address), 'poopBal');
  log('POOP balance: ' + ethers.formatEther(poopBal));
  log('Approving router...');
  const approveTx = await poop.approve(V3_ROUTER, ethers.MaxUint256);
  await approveTx.wait();
  log('Approved');

  // Get POOP price from POOP/WETH pool
  const poopWethAddr = await retry(() => factory.getPool(POOP_ADDR, WETH_ADDR, 10000), 'poopPool');
  const poopWethPool = new ethers.Contract(poopWethAddr, POOL_ABI, provider);

  let swapCount = 0;
  let totalEarthBought = 0n;
  let totalPoopSpent = 0n;

  while (true) {
    try {
      // Check remaining POOP
      const remaining = await retry(() => poop.balanceOf(wallet.address), 'bal');
      if (remaining === 0n) {
        log('Out of POOP. Done!');
        break;
      }

      // Get current POOP price
      const slot0 = await retry(() => poopWethPool.slot0(), 'slot0');
      const Q96 = 2n ** 96n;
      const rawPrice = (Number(slot0[0]) / Number(Q96)) ** 2;
      // POOP 0x126 < WETH 0x420 → POOP token0, price = WETH/POOP
      const poopPriceUsd = rawPrice * 2500;

      // Calculate POOP amount for $0.10
      const poopTokens = TARGET_USD / poopPriceUsd;
      let poopAmount = ethers.parseEther(poopTokens.toFixed(6));

      // Don't swap more than we have
      if (poopAmount > remaining) poopAmount = remaining;
      if (poopAmount === 0n) {
        log('POOP amount too small. Done!');
        break;
      }

      // Swap POOP → EARTH via 1% pool
      const tx = await router.exactInputSingle({
        tokenIn: POOP_ADDR,
        tokenOut: EARTH_ADDR,
        fee: 10000,
        recipient: wallet.address,
        amountIn: poopAmount,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      });
      const receipt = await tx.wait();

      swapCount++;
      totalPoopSpent += poopAmount;

      const earthBal = await retry(() => earth.balanceOf(wallet.address), 'earthBal');
      const poopLeft = await retry(() => poop.balanceOf(wallet.address), 'poopLeft');

      log('#' + swapCount + ' | Swapped ' + ethers.formatEther(poopAmount).slice(0, 8) + ' POOP (~$' + TARGET_USD + ') | EARTH: ' + ethers.formatEther(earthBal).slice(0, 10) + ' | POOP left: ' + ethers.formatEther(poopLeft).slice(0, 8));

    } catch(e) {
      log('Swap error: ' + (e.reason || e.shortMessage || e.message).slice(0, 80));
      log('Retrying next cycle...');
    }

    await sleep(INTERVAL_MS);
  }

  const finalEarth = await earth.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════');
  log('  Total swaps: ' + swapCount);
  log('  Total POOP spent: ' + ethers.formatEther(totalPoopSpent));
  log('  EARTH balance: ' + ethers.formatEther(finalEarth));
  log('════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
