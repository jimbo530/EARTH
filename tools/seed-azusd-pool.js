/**
 * seed-azusd-pool.js — Create EARTH/AZUSD V3 pool (1% fee, full range)
 * Uses all available AZUSD + matching EARTH value.
 * AZUSD ≈ $1 deposit receipt, 18 decimals.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR   = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const REACTOR_ADDR = '0x424D8BC900C6cc22E791C01d7E92CEd149a232f7';
const AZUSD_ADDR   = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const USDC_ADDR    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const V3_NPM       = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_FACTORY   = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

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
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const EARTH_EXTRA_ABI = [
  'function rebaseIndex() view returns (uint256)',
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

async function main() {
  if (!PRIVATE_KEY) { console.error('Set KEEPER_PRIVATE_KEY in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);
  const azusd = new ethers.Contract(AZUSD_ADDR, ERC20_ABI, wallet);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);
  const factory = new ethers.Contract(V3_FACTORY, [
    'function getPool(address,address,uint24) view returns (address)',
  ], provider);

  _nonce = await provider.getTransactionCount(wallet.address, 'latest');
  log('Wallet: ' + wallet.address);
  log('Nonce:  ' + _nonce);

  const earthBal = await retry(() => earth.balanceOf(wallet.address), 'earthBal');
  const azusdBal = await retry(() => azusd.balanceOf(wallet.address), 'azusdBal');
  log('EARTH: ' + ethers.formatEther(earthBal));
  log('AZUSD: ' + ethers.formatEther(azusdBal));

  if (earthBal === 0n || azusdBal === 0n) {
    log('ERROR: Need both EARTH and AZUSD');
    process.exit(1);
  }

  // ── Get EARTH price from EARTH/USDC pool ──────────────────────────────────
  const earthUsdcPool = await retry(() => factory.getPool(EARTH_ADDR, USDC_ADDR, 10000), 'getEarthUsdcPool');
  const earthPool = new ethers.Contract(earthUsdcPool, POOL_ABI, provider);
  const earthSlot0 = await retry(() => earthPool.slot0(), 'earthSlot0');
  const Q96 = 2n ** 96n;
  const earthRawPrice = (Number(earthSlot0[0]) / Number(Q96)) ** 2;
  // EARTH is token0 (0x5Cf), USDC is token1 (0x833) → rawPrice = USDC/EARTH (6 dec adj)
  const earthPriceUsd = earthRawPrice * 1e12;
  log('EARTH price: $' + earthPriceUsd.toFixed(4));

  // ── Calculate amounts ─────────────────────────────────────────────────────
  // Use all AZUSD, match with EARTH at current price
  // AZUSD ≈ $1 each (18 decimals)
  const azusdFloat = Number(ethers.formatEther(azusdBal));
  const earthNeeded = azusdFloat / earthPriceUsd;
  const earthAvail = Number(ethers.formatEther(earthBal));

  let azusdForLP, earthForLP;
  if (earthNeeded <= earthAvail * 0.95) {
    // We have enough EARTH — use all AZUSD
    azusdForLP = azusdBal;
    earthForLP = ethers.parseEther(earthNeeded.toFixed(12));
  } else {
    // Not enough EARTH — use all EARTH, reduce AZUSD
    const azusdNeeded = earthAvail * 0.95 * earthPriceUsd;
    azusdForLP = ethers.parseEther(azusdNeeded.toFixed(12));
    earthForLP = ethers.parseEther((earthAvail * 0.95).toFixed(12));
  }

  // Keep some EARTH reserve for buffer
  const earthReserve = 10000n;
  if (earthForLP + earthReserve > earthBal) {
    earthForLP = earthBal - earthReserve;
  }

  log('');
  log('LP plan:');
  log('  AZUSD: ' + ethers.formatEther(azusdForLP));
  log('  EARTH: ' + ethers.formatEther(earthForLP));

  // ── Token order ───────────────────────────────────────────────────────────
  // AZUSD 0x3595 < EARTH 0x5CfB → AZUSD is token0, EARTH is token1
  const token0 = AZUSD_ADDR;
  const token1 = EARTH_ADDR;
  log('');
  log('token0: ' + token0 + ' (AZUSD)');
  log('token1: ' + token1 + ' (EARTH)');

  // ── Compute sqrtPriceX96 ──────────────────────────────────────────────────
  // price = token1 per token0 = EARTH per AZUSD
  // Both 18 decimals, no adjustment needed
  const earthPerAzusd = 1.0 / earthPriceUsd;
  const sqrtP = Math.sqrt(earthPerAzusd);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtP * Number(Q96)));
  log('Price: ' + earthPerAzusd.toFixed(12) + ' EARTH/AZUSD');
  log('sqrtPriceX96: ' + sqrtPriceX96.toString());

  // ── Create pool ───────────────────────────────────────────────────────────
  log('');
  log('=== Creating EARTH/AZUSD pool ===');
  await sendTx((opts) => npm.createAndInitializePoolIfNecessary(
    token0, token1, FEE_TIER, sqrtPriceX96, opts
  ));
  log('Pool created/initialized');

  const poolAddr = await retry(() => factory.getPool(token0, token1, FEE_TIER), 'getPool');
  log('Pool address: ' + poolAddr);

  // ── Approve tokens ────────────────────────────────────────────────────────
  log('');
  log('=== Approving tokens ===');
  await sendTx((opts) => azusd.approve(V3_NPM, azusdForLP, opts));
  log('  AZUSD approved');
  await sendTx((opts) => earth.approve(V3_NPM, ethers.MaxUint256, opts));
  log('  EARTH approved');

  // ── Rebase buffer + Mint ──────────────────────────────────────────────────
  log('');
  log('=== Minting LP position ===');
  const amount0 = azusdForLP;   // AZUSD
  const amount1 = earthForLP;   // EARTH
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const earthExtra = new ethers.Contract(EARTH_ADDR, EARTH_EXTRA_ABI, provider);
  const rebaseIdx = await retry(() => earthExtra.rebaseIndex(), 'rebaseIdx');
  const D = 10n ** 18n;

  const poolEarthBal = await retry(() => earth.balanceOf(poolAddr), 'poolBal');
  const poolShares = poolEarthBal * D / rebaseIdx;
  log('RebaseIndex:  ' + rebaseIdx.toString());
  log('Pool existing EARTH: ' + poolEarthBal.toString() + ' wei (' + poolShares.toString() + ' shares)');

  // Try staticCall first
  let mintOk = false;
  try {
    const result = await npm.mint.staticCall({
      token0, token1, fee: FEE_TIER,
      tickLower: MIN_TICK, tickUpper: MAX_TICK,
      amount0Desired: amount0, amount1Desired: amount1,
      amount0Min: 0n, amount1Min: 0n,
      recipient: wallet.address, deadline,
    });
    log('  staticCall OK! liquidity=' + result[1].toString());
    mintOk = true;
  } catch(e) {
    log('  staticCall failed: ' + (e.reason || e.shortMessage || ''));
  }

  if (!mintOk) {
    const earthAmt = amount1; // EARTH is token1
    log('Computing buffer for EARTH amount ' + earthAmt.toString() + ' (+-20 range)...');

    let bestBuffer = 0n;
    for (let offset = -20n; offset <= 20n; offset++) {
      const candidateAmt = earthAmt + offset;
      if (candidateAmt <= 0n) continue;
      const mainShares = candidateAmt * D / rebaseIdx;
      const fracMain = (mainShares * rebaseIdx) % D;
      const needed = D - fracMain;
      if (needed === 0n || needed === D) continue;

      const fracExisting = (poolShares * rebaseIdx) % D;
      if (fracExisting >= needed) continue;

      for (let p = 2n; p < 100000n; p++) {
        const totalBuf = poolEarthBal + p;
        const totalBufShares = totalBuf * D / rebaseIdx;
        if (totalBufShares <= poolShares) continue;
        const fracBuf = (totalBufShares * rebaseIdx) % D;
        if (fracBuf >= needed) {
          if (bestBuffer === 0n || p < bestBuffer) bestBuffer = p;
          break;
        }
      }
    }

    if (bestBuffer === 0n) bestBuffer = 500n;
    log('Sending buffer: ' + bestBuffer.toString() + ' wei EARTH');
    await sendTx((opts) => earth.transfer(poolAddr, bestBuffer, opts));
    log('  Buffer sent');

    log('Testing mint via staticCall...');
    try {
      const result = await npm.mint.staticCall({
        token0, token1, fee: FEE_TIER,
        tickLower: MIN_TICK, tickUpper: MAX_TICK,
        amount0Desired: amount0, amount1Desired: amount1,
        amount0Min: 0n, amount1Min: 0n,
        recipient: wallet.address, deadline,
      });
      log('  staticCall OK! liquidity=' + result[1].toString());
      mintOk = true;
    } catch(e) {
      log('  staticCall still failed: ' + (e.reason || e.shortMessage || ''));
      for (let r = 1; r <= 50; r++) {
        await sendTx((opts) => earth.transfer(poolAddr, 2n, opts));
        try {
          const r2 = await npm.mint.staticCall({
            token0, token1, fee: FEE_TIER,
            tickLower: MIN_TICK, tickUpper: MAX_TICK,
            amount0Desired: amount0, amount1Desired: amount1,
            amount0Min: 0n, amount1Min: 0n,
            recipient: wallet.address, deadline,
          });
          log('  Buffer found at retry ' + r + '! liquidity=' + r2[1].toString());
          mintOk = true;
          break;
        } catch(e2) {
          if (r % 10 === 0) log('  retry ' + r + '...');
        }
      }
      if (!mintOk) {
        log('ERROR: Could not find working buffer');
        process.exit(1);
      }
    }
  }

  const mintTx = await sendTx((opts) => npm.mint({
    token0, token1, fee: FEE_TIER,
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

  // ── Transfer NFT to Reactor ─────────────────────────────────────────────
  log('');
  log('=== Transferring NFT to Reactor (LOCKED FOREVER) ===');
  await sendTx((opts) => npm.safeTransferFrom(wallet.address, REACTOR_ADDR, tokenId, opts));
  log('NFT #' + tokenId + ' transferred to Reactor');

  // ── Register pool ───────────────────────────────────────────────────────
  log('');
  log('=== Registering pool in Reactor ===');
  await sendTx((opts) => reactor.addPool(tokenId, opts));
  const poolCount = await reactor.poolCount();
  log('Pool registered! Total pools: ' + poolCount.toString());

  // ── Summary ─────────────────────────────────────────────────────────────
  const finalEarth = await earth.balanceOf(wallet.address);
  const finalAzusd = await azusd.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════════════════');
  log('  EARTH/AZUSD pool LIVE');
  log('  Pool: ' + poolAddr);
  log('  Position NFT #' + tokenId + ' locked in Reactor');
  log('  Total pools: ' + poolCount.toString());
  log('  EARTH remaining: ' + ethers.formatEther(finalEarth));
  log('  AZUSD remaining: ' + ethers.formatEther(finalAzusd));
  log('════════════════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
