/**
 * seed-char-pool.js — Create EARTH/CHAR V3 pool at 1% fee, $10 on each side
 * Buys CHAR via USDC→CHAR V3 pool (0.3% fee), applies rebase buffer fix
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR   = process.env.EARTH_TOKEN;
const REACTOR_ADDR = process.env.EARTH_REACTOR;

const CHAR_ADDR  = '0x20b048fa035d5763685d695e66adf62c5d9f5055';
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
  const char = new ethers.Contract(CHAR_ADDR, ERC20_ABI, wallet);
  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, wallet);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, wallet);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);

  _nonce = await provider.getTransactionCount(wallet.address, 'latest');
  log('Wallet: ' + wallet.address);
  log('Nonce:  ' + _nonce);

  const earthBal = await retry(() => earth.balanceOf(wallet.address), 'earthBal');
  const charBal = await retry(() => char.balanceOf(wallet.address), 'charBal');
  const usdcBal = await retry(() => usdc.balanceOf(wallet.address), 'usdcBal');
  log('EARTH: ' + ethers.formatEther(earthBal));
  log('CHAR:  ' + ethers.formatEther(charBal));
  log('USDC:  ' + ethers.formatUnits(usdcBal, 6));

  // ── Get EARTH price from WETH pool ────────────────────────────────────────
  const wethPoolAddr = await retry(() => factory.getPool(WETH_ADDR, EARTH_ADDR, FEE_TIER), 'getPool');
  const wethPool = new ethers.Contract(wethPoolAddr, POOL_ABI, provider);
  const slot0 = await retry(() => wethPool.slot0(), 'slot0');
  const Q96 = 2n ** 96n;
  const rawPriceWeth = (Number(slot0[0]) / Number(Q96)) ** 2;
  const ethPriceUsd = 2500;
  const earthPriceUsd = ethPriceUsd / rawPriceWeth;
  log('EARTH price: ~$' + earthPriceUsd.toFixed(4));

  // ── Get CHAR price from CHAR/USDC V3 pool (0.3% fee) ──────────────────────
  const charUsdcPool = new ethers.Contract('0x7af66828a7d1041db8b183f1356797788979eaf8', POOL_ABI, provider);
  const charSlot0 = await retry(() => charUsdcPool.slot0(), 'charSlot0');
  const charRawPrice = (Number(charSlot0[0]) / Number(Q96)) ** 2;
  // CHAR (0x20b..) is token0, USDC (0x833..) is token1
  // price = USDC_raw / CHAR_raw. USDC has 6 dec, CHAR has 18 dec
  // 1 CHAR (1e18 raw) = charRawPrice * 1e18 USDC_raw = charRawPrice * 1e18 / 1e6 USDC = charRawPrice * 1e12 USDC
  const charPriceUsd = charRawPrice * 1e12;
  log('CHAR price:  ~$' + charPriceUsd.toFixed(4));

  // ── Calculate amounts ($10 per side) ────────────────────────────────────────
  const TARGET_USD = 10;
  const earthTokensForLP = TARGET_USD / earthPriceUsd;
  const earthForLP = ethers.parseEther(earthTokensForLP.toFixed(6));
  if (earthForLP > earthBal) {
    log('ERROR: Not enough EARTH. Need ' + ethers.formatEther(earthForLP) + ', have ' + ethers.formatEther(earthBal));
    process.exit(1);
  }

  const charTokensForLP = TARGET_USD / charPriceUsd;
  const charForLP = ethers.parseEther(charTokensForLP.toFixed(6));

  log('');
  log('LP plan ($10 per side):');
  log('  EARTH: ' + ethers.formatEther(earthForLP) + ' (~$' + TARGET_USD + ')');
  log('  CHAR:  ' + ethers.formatEther(charForLP) + ' (~$' + TARGET_USD + ')');

  // ── Buy CHAR if needed ──────────────────────────────────────────────────────
  let charAvail = charBal;
  if (charBal < charForLP) {
    const usdcForBuy = BigInt(Math.ceil(TARGET_USD * 1.10 * 1e6)); // $11 with 10% buffer
    log('');
    log('Buying CHAR with $' + (Number(usdcForBuy) / 1e6).toFixed(2) + ' USDC');

    if (usdcForBuy > usdcBal) {
      log('ERROR: Not enough USDC');
      process.exit(1);
    }

    // Single hop: USDC → CHAR via V3 (0.3% fee)
    await sendTx((opts) => usdc.approve(V3_ROUTER, usdcForBuy, opts));
    log('  USDC approved');
    await sendTx((opts) => router.exactInputSingle({
      tokenIn: USDC_ADDR, tokenOut: CHAR_ADDR,
      fee: 3000, recipient: wallet.address,
      amountIn: usdcForBuy, amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    }, opts));

    charAvail = await char.balanceOf(wallet.address);
    log('  CHAR received: ' + ethers.formatEther(charAvail));
    if (charAvail === 0n) { log('ERROR: USDC→CHAR swap returned 0'); process.exit(1); }
  }

  const charForMint = charAvail < charForLP ? charAvail : charForLP;

  // ── Sort tokens for V3 ──────────────────────────────────────────────────────
  // CHAR 0x20b... < EARTH 0x5Cf... → CHAR is token0, EARTH is token1
  const [token0, token1, earthIsToken0] = sortTokens(EARTH_ADDR, CHAR_ADDR);
  log('');
  log('token0: ' + token0 + (earthIsToken0 ? ' (EARTH)' : ' (CHAR)'));
  log('token1: ' + token1 + (earthIsToken0 ? ' (CHAR)' : ' (EARTH)'));

  // ── Calculate sqrtPriceX96 ──────────────────────────────────────────────────
  // Both 18 decimals → rawPrice = token1_price / token0_price
  // CHAR is token0, EARTH is token1 → price = earthPrice/charPrice (EARTH per CHAR)
  const rawPrice = earthIsToken0
    ? charPriceUsd / earthPriceUsd   // price = CHAR/EARTH
    : earthPriceUsd / charPriceUsd;  // price = EARTH/CHAR
  log('Raw price (token1/token0): ' + rawPrice.toExponential(6));

  const sqrtPrice = Math.sqrt(rawPrice);
  const sqrtPriceX96 = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  log('sqrtPriceX96: ' + sqrtPriceX96.toString());

  // ── Create pool ─────────────────────────────────────────────────────────────
  log('');
  log('=== Creating EARTH/CHAR pool (1% fee) ===');
  await sendTx((opts) => npm.createAndInitializePoolIfNecessary(token0, token1, FEE_TIER, sqrtPriceX96, opts));
  log('Pool created!');

  // ── Approve tokens ──────────────────────────────────────────────────────────
  log('');
  log('=== Approving tokens ===');
  await sendTx((opts) => earth.approve(V3_NPM, ethers.MaxUint256, opts));
  log('  EARTH approved');
  await sendTx((opts) => char.approve(V3_NPM, charForMint, opts));
  log('  CHAR approved');

  // ── Rebase buffer + Mint LP position ────────────────────────────────────────
  log('');
  log('=== Minting LP position ===');
  const amount0 = earthIsToken0 ? earthForLP : charForMint;
  const amount1 = earthIsToken0 ? charForMint : earthForLP;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  // REBASE FIX: Compute buffer accounting for existing pool balance
  const earthExtra = new ethers.Contract(EARTH_ADDR, EARTH_EXTRA_ABI, provider);
  const rebaseIdx = await retry(() => earthExtra.rebaseIndex(), 'rebaseIdx');
  const D = 10n ** 18n;

  const poolAddr = await retry(() => factory.getPool(token0, token1, FEE_TIER), 'getPool');
  log('Pool address: ' + poolAddr);
  log('RebaseIndex:  ' + rebaseIdx.toString());

  const poolEarthBal = await retry(() => earth.balanceOf(poolAddr), 'poolBal');
  const poolShares = poolEarthBal * D / rebaseIdx;
  log('Pool existing EARTH: ' + poolEarthBal.toString() + ' wei (' + poolShares.toString() + ' shares)');

  // Try staticCall first — prior buffer may already work
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
    // Compute buffer for range of candidate amount1Owed values
    const earthAmt = earthIsToken0 ? amount0 : amount1;
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
    log('Sending additional buffer: ' + bestBuffer.toString() + ' wei EARTH');
    await sendTx((opts) => earth.transfer(poolAddr, bestBuffer, opts));
    log('  Buffer sent');

    // Verify
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
      // Brute force: send 2 wei at a time (minimum to transfer 1 share)
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

  // ── Transfer NFT to Reactor ─────────────────────────────────────────────────
  log('');
  log('=== Transferring NFT to Reactor (LOCKED FOREVER) ===');
  await sendTx((opts) => npm.safeTransferFrom(wallet.address, REACTOR_ADDR, tokenId, opts));
  log('NFT #' + tokenId + ' transferred to Reactor');

  // ── Register pool ───────────────────────────────────────────────────────────
  log('');
  log('=== Registering pool in Reactor ===');
  await sendTx((opts) => reactor.addPool(tokenId, opts));
  const poolCount = await reactor.poolCount();
  log('Pool registered! Total pools: ' + poolCount.toString());

  // ── Summary ─────────────────────────────────────────────────────────────────
  const finalEarth = await earth.balanceOf(wallet.address);
  const finalChar = await char.balanceOf(wallet.address);
  const finalUsdc = await usdc.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════════════════');
  log('  EARTH/CHAR pool LIVE');
  log('  Position NFT #' + tokenId + ' locked in Reactor');
  log('  Total pools: ' + poolCount.toString());
  log('  EARTH remaining: ' + ethers.formatEther(finalEarth));
  log('  CHAR remaining:  ' + ethers.formatEther(finalChar));
  log('  USDC remaining:  ' + ethers.formatUnits(finalUsdc, 6));
  log('  EARTH price:     ~$' + earthPriceUsd.toFixed(4));
  log('  CHAR price:      ~$' + charPriceUsd.toFixed(4));
  log('════════════════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
