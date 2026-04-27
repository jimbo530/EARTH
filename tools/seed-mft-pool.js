/**
 * seed-mft-pool.js — Create EARTH/MfT V3 pool at 1% fee, $10 on each side
 * Uses V2 MfT/WETH quote for pricing. Includes rebase buffer fix.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR   = process.env.EARTH_TOKEN;
const REACTOR_ADDR = process.env.EARTH_REACTOR;

const MFT_ADDR   = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const WETH_ADDR  = '0x4200000000000000000000000000000000000006';
const V3_NPM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const V2_ROUTER  = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';

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
const V2_ROUTER_ABI = [
  'function getAmountsOut(uint256 amountIn, address[] calldata path) view returns (uint256[] memory amounts)',
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
  const mft = new ethers.Contract(MFT_ADDR, ERC20_ABI, wallet);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);
  const v2Router = new ethers.Contract(V2_ROUTER, V2_ROUTER_ABI, provider);

  _nonce = await provider.getTransactionCount(wallet.address, 'latest');
  log('Wallet: ' + wallet.address);
  log('Nonce:  ' + _nonce);

  const earthBal = await retry(() => earth.balanceOf(wallet.address), 'earthBal');
  const mftBal = await retry(() => mft.balanceOf(wallet.address), 'mftBal');
  log('EARTH: ' + ethers.formatEther(earthBal));
  log('MfT:   ' + ethers.formatEther(mftBal));

  // ── Get EARTH price from WETH pool ────────────────────────────────────────
  const wethPoolAddr = await retry(() => factory.getPool(WETH_ADDR, EARTH_ADDR, FEE_TIER), 'getPool');
  const wethPool = new ethers.Contract(wethPoolAddr, POOL_ABI, provider);
  const slot0 = await retry(() => wethPool.slot0(), 'slot0');
  const Q96 = 2n ** 96n;
  const rawPriceWeth = (Number(slot0[0]) / Number(Q96)) ** 2;
  const ethPriceUsd = 2500;
  const earthPriceUsd = ethPriceUsd / rawPriceWeth;
  log('EARTH price: ~$' + earthPriceUsd.toFixed(4));

  // ── Get MfT price from V2 (MfT/WETH) ────────────────────────────────────
  const mftQuoteAmount = ethers.parseEther('1000000');
  const amounts = await retry(() => v2Router.getAmountsOut(mftQuoteAmount, [MFT_ADDR, WETH_ADDR]), 'v2quote');
  const wethFor1M = Number(ethers.formatEther(amounts[1]));
  const mftPriceUsd = (wethFor1M * ethPriceUsd) / 1000000;
  log('MfT price:   ~$' + mftPriceUsd.toExponential(4));

  // ── Calculate amounts ($10 per side) ──────────────────────────────────────
  const TARGET_USD = 10;
  const earthTokensForLP = TARGET_USD / earthPriceUsd;
  const earthForLP = ethers.parseEther(earthTokensForLP.toFixed(6));
  if (earthForLP > earthBal) {
    log('ERROR: Not enough EARTH. Need ' + ethers.formatEther(earthForLP) + ', have ' + ethers.formatEther(earthBal));
    process.exit(1);
  }

  const mftTokensForLP = TARGET_USD / mftPriceUsd;
  const mftForLP = ethers.parseEther(mftTokensForLP.toFixed(0));
  if (mftForLP > mftBal) {
    log('ERROR: Not enough MfT. Need ' + ethers.formatEther(mftForLP) + ', have ' + ethers.formatEther(mftBal));
    process.exit(1);
  }

  log('');
  log('LP plan ($10 per side):');
  log('  EARTH: ' + ethers.formatEther(earthForLP) + ' (~$' + TARGET_USD + ')');
  log('  MfT:   ' + ethers.formatEther(mftForLP) + ' (~$' + TARGET_USD + ')');

  // ── Sort tokens ───────────────────────────────────────────────────────────
  // EARTH 0x5Cf... < MfT 0x8FB... → EARTH is token0, MfT is token1
  const [token0, token1, earthIsToken0] = sortTokens(EARTH_ADDR, MFT_ADDR);
  log('');
  log('token0: ' + token0 + (earthIsToken0 ? ' (EARTH)' : ' (MfT)'));
  log('token1: ' + token1 + (earthIsToken0 ? ' (MfT)' : ' (EARTH)'));

  // ── Calculate sqrtPriceX96 ────────────────────────────────────────────────
  // Both 18 decimals. price = token1_value / token0_value
  const mftPerEarth = earthPriceUsd / mftPriceUsd;
  const rawPrice = earthIsToken0
    ? mftPerEarth           // price = MfT/EARTH (how many MfT raw per EARTH raw)
    : 1 / mftPerEarth;      // price = EARTH/MfT
  log('Raw price (token1/token0): ' + rawPrice.toExponential(6));

  const sqrtPrice = Math.sqrt(rawPrice);
  const sqrtPriceX96_mft = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  log('sqrtPriceX96: ' + sqrtPriceX96_mft.toString());

  // ── Create pool ───────────────────────────────────────────────────────────
  log('');
  log('=== Creating EARTH/MfT pool (1% fee) ===');
  await sendTx((opts) => npm.createAndInitializePoolIfNecessary(token0, token1, FEE_TIER, sqrtPriceX96_mft, opts));
  log('Pool created!');

  // ── Approve tokens ────────────────────────────────────────────────────────
  log('');
  log('=== Approving tokens ===');
  await sendTx((opts) => earth.approve(V3_NPM, ethers.MaxUint256, opts));
  log('  EARTH approved');
  await sendTx((opts) => mft.approve(V3_NPM, mftForLP, opts));
  log('  MfT approved');

  // ── Rebase buffer + Mint LP position ──────────────────────────────────────
  log('');
  log('=== Minting LP position ===');
  const amount0 = earthIsToken0 ? earthForLP : mftForLP;
  const amount1 = earthIsToken0 ? mftForLP : earthForLP;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  // REBASE FIX: Compute buffer accounting for existing pool balance and actual amount0Owed
  const earthExtra = new ethers.Contract(EARTH_ADDR, EARTH_EXTRA_ABI, provider);
  const rebaseIdx = await retry(() => earthExtra.rebaseIndex(), 'rebaseIdx');
  const D = 10n ** 18n;

  const poolAddr = await retry(() => factory.getPool(token0, token1, FEE_TIER), 'getPool');
  log('Pool address: ' + poolAddr);
  log('RebaseIndex:  ' + rebaseIdx.toString());

  // Read pool's current EARTH balance (may have prior buffer from earlier run)
  const poolEarthBal = await retry(() => earth.balanceOf(poolAddr), 'poolBal');
  const poolShares = poolEarthBal * D / rebaseIdx;
  log('Pool existing EARTH: ' + poolEarthBal.toString() + ' wei (' + poolShares.toString() + ' shares)');

  // Try staticCall first — maybe existing buffer already works
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
    // Compute buffer for a range of candidate amount0Owed values
    // Pool may round amount0Owed differently from our earthForLP
    const earthAmt = earthIsToken0 ? amount0 : amount1;
    log('Computing buffer for EARTH amount ' + earthAmt.toString() + ' (+-20 range)...');

    let bestBuffer = 0n;
    for (let offset = -20n; offset <= 20n; offset++) {
      const candidateAmt = earthAmt + offset;
      if (candidateAmt <= 0n) continue;
      const mainShares = candidateAmt * D / rebaseIdx;
      const fracMain = (mainShares * rebaseIdx) % D;
      const needed = D - fracMain;
      if (needed === 0n || needed === D) continue; // no buffer needed

      // Check if existing pool shares already provide alignment
      const fracExisting = (poolShares * rebaseIdx) % D;
      if (fracExisting >= needed) {
        log('  Existing buffer works for offset ' + offset.toString());
        continue;
      }

      // Find additional buffer to send (total shares = poolShares + newShares)
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

    if (bestBuffer === 0n) bestBuffer = 500n; // fallback
    log('Sending additional buffer: ' + bestBuffer.toString() + ' wei EARTH');
    await sendTx((opts) => earth.transfer(poolAddr, bestBuffer, opts));
    log('  Buffer sent');

    // Verify with staticCall
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
      log('  staticCall still FAILED: ' + (e.reason || e.shortMessage || e.message));
      // Last resort: try a few more incremental buffers (2 wei each = 1 share)
      for (let retry = 1; retry <= 50; retry++) {
        await sendTx((opts) => earth.transfer(poolAddr, 2n, opts));
        try {
          const r2 = await npm.mint.staticCall({
            token0, token1, fee: FEE_TIER,
            tickLower: MIN_TICK, tickUpper: MAX_TICK,
            amount0Desired: amount0, amount1Desired: amount1,
            amount0Min: 0n, amount1Min: 0n,
            recipient: wallet.address, deadline,
          });
          log('  Buffer found at retry ' + retry + '! liquidity=' + r2[1].toString());
          mintOk = true;
          break;
        } catch(e2) {
          if (retry % 10 === 0) log('  retry ' + retry + '...');
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

  // ── Transfer NFT to Reactor ───────────────────────────────────────────────
  log('');
  log('=== Transferring NFT to Reactor (LOCKED FOREVER) ===');
  await sendTx((opts) => npm.safeTransferFrom(wallet.address, REACTOR_ADDR, tokenId, opts));
  log('NFT #' + tokenId + ' transferred to Reactor');

  // ── Register pool ─────────────────────────────────────────────────────────
  log('');
  log('=== Registering pool in Reactor ===');
  await sendTx((opts) => reactor.addPool(tokenId, opts));
  const poolCount = await reactor.poolCount();
  log('Pool registered! Total pools: ' + poolCount.toString());

  // ── Summary ───────────────────────────────────────────────────────────────
  const finalEarth = await earth.balanceOf(wallet.address);
  const finalMft = await mft.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════════════════');
  log('  EARTH/MfT pool LIVE');
  log('  Position NFT #' + tokenId + ' locked in Reactor');
  log('  Total pools: ' + poolCount.toString());
  log('  EARTH remaining: ' + ethers.formatEther(finalEarth));
  log('  MfT remaining:   ' + ethers.formatEther(finalMft));
  log('  EARTH price:     ~$' + earthPriceUsd.toFixed(4));
  log('  MfT price:       ~$' + mftPriceUsd.toExponential(4));
  log('════════════════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
