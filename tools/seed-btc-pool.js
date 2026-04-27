/**
 * seed-btc-pool.js — Buy cbBTC, create EARTH/cbBTC V3 pool at 1% fee, seed LP, register in Reactor
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR   = process.env.EARTH_TOKEN;
const REACTOR_ADDR = process.env.EARTH_REACTOR;

const cbBTC_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const USDC_ADDR  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDR  = '0x4200000000000000000000000000000000000006';
const V3_NPM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';

const FEE_TIER = 10000;
const MIN_TICK = -887200;
const MAX_TICK = 887200;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function transfer(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];
const NPM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
];
const REACTOR_ABI = [
  'function addPool(uint256 tokenId) external',
  'function poolCount() view returns (uint256)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
];
const FACTORY_ABI = [
  'function getPool(address, address, uint24) view returns (address)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function retry(fn, label, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try { return await fn(); }
    catch(e) {
      if (i === attempts) throw e;
      log('  RPC retry ' + i + '/' + attempts + ' for ' + label);
      await sleep(2000);
    }
  }
}

let _nonce = null;
async function sendTx(fn) {
  const tx = await fn({ nonce: _nonce, gasLimit: 6000000 });
  log('  tx: ' + tx.hash);
  await tx.wait();
  _nonce++;
  return tx;
}

function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b, true] : [b, a, false];
}

async function main() {
  if (!PRIVATE_KEY || !EARTH_ADDR || !REACTOR_ADDR) {
    console.error('Set KEEPER_PRIVATE_KEY, EARTH_TOKEN, EARTH_REACTOR in tools/.env');
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);
  const btc = new ethers.Contract(cbBTC_ADDR, ERC20_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, wallet);
  const weth = new ethers.Contract(WETH_ADDR, ERC20_ABI, wallet);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, wallet);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);

  _nonce = await provider.getTransactionCount(wallet.address, 'latest');
  log('Wallet: ' + wallet.address);
  log('Nonce:  ' + _nonce);

  const earthBal = await retry(() => earth.balanceOf(wallet.address), 'earthBal');
  const btcBal = await retry(() => btc.balanceOf(wallet.address), 'btcBal');
  const usdcBal = await retry(() => usdc.balanceOf(wallet.address), 'usdcBal');
  log('EARTH: ' + ethers.formatEther(earthBal));
  log('cbBTC: ' + ethers.formatUnits(btcBal, 8));
  log('USDC:  ' + ethers.formatUnits(usdcBal, 6));

  // ── Get EARTH price from WETH pool ────────────────────────────────────────
  const wethPoolAddr = await retry(() => factory.getPool(WETH_ADDR, EARTH_ADDR, FEE_TIER), 'getPool');
  const wethPool = new ethers.Contract(wethPoolAddr, POOL_ABI, provider);
  const slot0 = await retry(() => wethPool.slot0(), 'slot0');
  const Q96 = 2n ** 96n;
  const rawPriceWeth = (Number(slot0[0]) / Number(Q96)) ** 2;
  const earthPerWeth = rawPriceWeth; // EARTH is token1
  const ethPriceUsd = 2500;
  const earthPriceUsd = ethPriceUsd / earthPerWeth;
  log('EARTH price: ~$' + earthPriceUsd.toFixed(4));

  // ── Get BTC price from cbBTC/WETH pool ────────────────────────────────────
  const btcWethPool = await retry(() => factory.getPool(cbBTC_ADDR, WETH_ADDR, 500), 'btcPool');
  const btcPool = new ethers.Contract(btcWethPool, POOL_ABI, provider);
  const btcSlot0 = await retry(() => btcPool.slot0(), 'btcSlot0');
  const btcSqrtP = Number(btcSlot0[0]);
  const btcRawPrice = (btcSqrtP / Number(Q96)) ** 2;
  // cbBTC (0xcbB7) > WETH (0x4200), so WETH is token0, cbBTC is token1
  // price = cbBTC_raw / WETH_raw = btcRawPrice
  // But cbBTC has 8 decimals, WETH has 18
  // Real price: btcRawPrice * 1e18/1e8 = btcRawPrice * 1e10 WETH per cbBTC
  // Wait, need to check token order
  const wethLower = WETH_ADDR.toLowerCase();
  const btcLower = cbBTC_ADDR.toLowerCase();
  const wethIsToken0_btc = wethLower < btcLower;
  let btcPriceUsd;
  if (wethIsToken0_btc) {
    // price = cbBTC_raw / WETH_raw
    // 1 WETH_raw buys btcRawPrice cbBTC_raw
    // 1 WETH ($2500) = btcRawPrice * 1e-8 cbBTC (since 8 decimals)
    // 1 cbBTC = $2500 / (btcRawPrice * 1e-8) = $2500 * 1e8 / btcRawPrice... no
    // Actually: price = token1/token0 in raw units
    // If WETH is token0: price = cbBTC_raw per WETH_raw
    // 1e18 WETH_raw = btcRawPrice * 1e18 cbBTC_raw? No.
    // price = sqrtP^2 = cbBTC_raw/WETH_raw for 1 unit
    // So btcRawPrice WETH_raw = 1 cbBTC_raw
    // 1 cbBTC = 1e8 human, 1 WETH = 1e18 human
    // btcRawPrice = cbBTC_raw / WETH_raw (for pool price)
    // So 1 WETH_raw buys 1/btcRawPrice * cbBTC_raw? No
    // Actually price in V3 = token1_amount / token0_amount
    // So for amount0 WETH_raw in, you get amount0 * price cbBTC_raw out
    // price = btcRawPrice
    // 1e18 WETH_raw → 1e18 * btcRawPrice cbBTC_raw
    // In human: 1 WETH → 1e18 * btcRawPrice / 1e8 cbBTC
    // = btcRawPrice * 1e10 cbBTC
    const btcPerWeth = btcRawPrice * 1e10;
    btcPriceUsd = ethPriceUsd / btcPerWeth;
    log('cbBTC per WETH: ' + btcPerWeth.toFixed(8));
    log('cbBTC price: ~$' + btcPriceUsd.toFixed(0));
  } else {
    // cbBTC is token0, WETH is token1
    // price = WETH_raw / cbBTC_raw = btcRawPrice
    // 1e8 cbBTC_raw → 1e8 * btcRawPrice WETH_raw
    // In human: 1 cbBTC → 1e8 * btcRawPrice / 1e18 WETH = btcRawPrice * 1e-10 WETH
    const wethPerBtc = btcRawPrice * 1e-10;
    btcPriceUsd = wethPerBtc * ethPriceUsd;
    log('WETH per cbBTC: ' + wethPerBtc.toFixed(4));
    log('cbBTC price: ~$' + btcPriceUsd.toFixed(0));
  }

  // ── Step 1: Buy cbBTC with USDC ───────────────────────────────────────────
  // $10 worth on each side
  const TARGET_USD_PER_SIDE = 10;
  const earthTokensForLP = TARGET_USD_PER_SIDE / earthPriceUsd;
  const earthForLP = ethers.parseEther(earthTokensForLP.toFixed(6));
  if (earthForLP > earthBal) {
    log('ERROR: Not enough EARTH. Need ' + ethers.formatEther(earthForLP) + ', have ' + ethers.formatEther(earthBal));
    process.exit(1);
  }
  const earthValueUsd = TARGET_USD_PER_SIDE;
  const btcNeeded = TARGET_USD_PER_SIDE / btcPriceUsd;
  const usdcToBuy = BigInt(Math.ceil(TARGET_USD_PER_SIDE * 1.05 * 1e6)); // $10.50 with 5% buffer

  log('');
  log('LP plan:');
  log('  EARTH for LP: ' + ethers.formatEther(earthForLP) + ' (~$' + earthValueUsd.toFixed(2) + ')');
  log('  cbBTC needed: ' + btcNeeded.toFixed(8) + ' (~$' + earthValueUsd.toFixed(2) + ')');
  log('  USDC to spend: $' + (Number(usdcToBuy) / 1e6).toFixed(2));

  if (usdcToBuy > usdcBal) {
    log('ERROR: Not enough USDC');
    process.exit(1);
  }

  log('');
  log('=== Step 1: Buying cbBTC with USDC (two hops) ===');

  // Hop 1: USDC → WETH via V3 exactInputSingle
  log('  Hop 1: USDC → WETH');
  await sendTx((opts) => usdc.approve(V3_ROUTER, usdcToBuy, opts));
  log('  USDC approved');
  await sendTx((opts) => router.exactInputSingle({
    tokenIn: USDC_ADDR, tokenOut: WETH_ADDR,
    fee: 500, recipient: wallet.address,
    amountIn: usdcToBuy, amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  }, opts));
  const wethBal = await weth.balanceOf(wallet.address);
  log('  WETH received: ' + ethers.formatEther(wethBal));
  if (wethBal === 0n) { log('ERROR: USDC→WETH swap returned 0'); process.exit(1); }

  // Hop 2: WETH → cbBTC via V3 exactInputSingle
  log('  Hop 2: WETH → cbBTC');
  await sendTx((opts) => weth.approve(V3_ROUTER, wethBal, opts));
  log('  WETH approved');
  await sendTx((opts) => router.exactInputSingle({
    tokenIn: WETH_ADDR, tokenOut: cbBTC_ADDR,
    fee: 500, recipient: wallet.address,
    amountIn: wethBal, amountOutMinimum: 0n,
    sqrtPriceLimitX96: 0n,
  }, opts));
  const btcBalAfter = await btc.balanceOf(wallet.address);
  log('  cbBTC received: ' + ethers.formatUnits(btcBalAfter, 8));
  if (btcBalAfter === 0n) { log('ERROR: WETH→cbBTC swap returned 0'); process.exit(1); }

  // ── Calculate pool price ──────────────────────────────────────────────────
  // EARTH is token0 (0x5C < 0xcB), cbBTC is token1
  // price = token1_raw / token0_raw
  // For equal $ value: earthPriceUsd of EARTH = btcPriceUsd of cbBTC
  // 1 EARTH_raw (1e18) = earthPriceUsd USD
  // earthPriceUsd USD of cbBTC = (earthPriceUsd / btcPriceUsd) cbBTC = (earthPriceUsd / btcPriceUsd) * 1e8 cbBTC_raw
  // price = ((earthPriceUsd / btcPriceUsd) * 1e8) / 1e18 = (earthPriceUsd / btcPriceUsd) * 1e-10
  const rawPrice = (earthPriceUsd / btcPriceUsd) * 1e-10;
  log('');
  log('Raw price (cbBTC_raw / EARTH_raw): ' + rawPrice.toExponential(6));

  const sqrtPrice = Math.sqrt(rawPrice);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  log('sqrtPriceX96: ' + sqrtPriceX96.toString());

  // ── Step 2: Create pool ───────────────────────────────────────────────────
  log('');
  log('=== Step 2: Creating EARTH/cbBTC pool (1% fee) ===');
  await sendTx((opts) => npm.createAndInitializePoolIfNecessary(EARTH_ADDR, cbBTC_ADDR, FEE_TIER, sqrtPriceX96, opts));
  log('Pool created!');

  // ── Step 3: Approve tokens ────────────────────────────────────────────────
  log('');
  log('=== Step 3: Approving tokens ===');
  await sendTx((opts) => earth.approve(V3_NPM, ethers.MaxUint256, opts));
  log('  EARTH approved');
  await sendTx((opts) => btc.approve(V3_NPM, btcBalAfter, opts));
  log('  cbBTC approved');

  // ── Step 4: Buffer + Mint LP position ─────────────────────────────────────
  log('');
  log('=== Step 4: Minting LP position ===');
  // EARTH is token0, cbBTC is token1
  const amount0 = earthForLP;
  const amount1 = btcBalAfter;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  // REBASE FIX: Pre-send a small EARTH buffer to the pool.
  // EARTH's _transfer loses 1 wei due to double integer division rounding
  // when rebaseIndex > 1e18. Pre-sending shifts the combined rounding to
  // compensate, making the V3 pool's strict M0 balance check pass.
  const EARTH_ABI_FULL = ['function rebaseIndex() view returns (uint256)'];
  const earthFull = new ethers.Contract(EARTH_ADDR, EARTH_ABI_FULL, provider);
  const rebaseIdx = await earthFull.rebaseIndex();
  const D = 10n ** 18n;

  // Compute optimal buffer: find P where combined rounding gains 1 wei
  const a0shares = amount0 * D / rebaseIdx;
  const fracA = (a0shares * rebaseIdx) % D;
  const needed = D - fracA;
  let buffer = 0n;
  for (let p = 2n; p < 100000n; p++) {
    const ps = p * D / rebaseIdx;
    if (ps === 0n) continue;
    const fracP = (ps * rebaseIdx) % D;
    if (fracP >= needed) {
      buffer = p;
      break;
    }
  }
  if (buffer === 0n) buffer = 1000n; // fallback

  log('Rebase buffer: sending ' + buffer.toString() + ' wei EARTH to pool');
  const poolAddr = await retry(() => factory.getPool(EARTH_ADDR, cbBTC_ADDR, FEE_TIER), 'getPool');
  await sendTx((opts) => earth.transfer(poolAddr, buffer, opts));
  log('  Buffer sent to ' + poolAddr);

  // Test with staticCall first
  log('Testing mint via staticCall...');
  try {
    const result = await npm.mint.staticCall({
      token0: EARTH_ADDR, token1: cbBTC_ADDR,
      fee: FEE_TIER,
      tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: amount0, amount1Desired: amount1,
      amount0Min: 0n, amount1Min: 0n,
      recipient: wallet.address, deadline,
    });
    log('  staticCall OK! liquidity=' + result[1].toString());
  } catch(e) {
    log('  staticCall FAILED: ' + (e.reason || e.shortMessage || e.message));
    log('  Aborting — cbBTC is in wallet, can retry manually');
    process.exit(1);
  }

  const mintTx = await sendTx((opts) => npm.mint({
    token0: EARTH_ADDR, token1: cbBTC_ADDR,
    fee: FEE_TIER,
    tickLower: MIN_TICK, tickUpper: MAX_TICK,
    amount0Desired: amount0, amount1Desired: amount1,
    amount0Min: 0n, amount1Min: 0n,
    recipient: wallet.address, deadline,
  }, opts));
  const mintReceipt = await provider.getTransactionReceipt(mintTx.hash);

  let tokenId = null;
  for (const l of mintReceipt.logs) {
    if (l.topics.length === 4 && l.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
      const from = '0x' + l.topics[1].slice(26);
      if (from === '0x0000000000000000000000000000000000000000') {
        tokenId = Number(BigInt(l.topics[3]));
        break;
      }
    }
  }
  if (!tokenId) { log('ERROR: Could not parse tokenId'); process.exit(1); }
  log('Position minted! Token ID: ' + tokenId);

  // ── Step 5: Transfer NFT to Reactor ───────────────────────────────────────
  log('');
  log('=== Step 5: Transferring NFT to Reactor (LOCKED FOREVER) ===');
  await sendTx((opts) => npm.safeTransferFrom(wallet.address, REACTOR_ADDR, tokenId, opts));
  log('NFT #' + tokenId + ' transferred to Reactor');

  // ── Step 6: Register pool ─────────────────────────────────────────────────
  log('');
  log('=== Step 6: Registering pool in Reactor ===');
  await sendTx((opts) => reactor.addPool(tokenId, opts));
  const poolCount = await reactor.poolCount();
  log('Pool registered! Total pools: ' + poolCount.toString());

  // ── Summary ───────────────────────────────────────────────────────────────
  const finalEarth = await earth.balanceOf(wallet.address);
  const finalBtc = await btc.balanceOf(wallet.address);
  const finalUsdc = await usdc.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════════════════');
  log('  EARTH/cbBTC pool LIVE');
  log('  Position NFT #' + tokenId + ' locked in Reactor');
  log('  Total pools: ' + poolCount.toString());
  log('  EARTH remaining: ' + ethers.formatEther(finalEarth));
  log('  cbBTC remaining: ' + ethers.formatUnits(finalBtc, 8));
  log('  USDC remaining:  ' + ethers.formatUnits(finalUsdc, 6));
  log('  EARTH price:     ~$' + earthPriceUsd.toFixed(4));
  log('  cbBTC price:     ~$' + btcPriceUsd.toFixed(0));
  log('════════════════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
