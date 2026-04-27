/**
 * seed-usdc-pool.js — Create EARTH/USDC V3 pool at 1% fee, seed with all EARTH + matching USDC
 *
 * Uses current market price from the WETH pool to set the USDC pool price.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR   = process.env.EARTH_TOKEN;
const REACTOR_ADDR = process.env.EARTH_REACTOR;

const USDC_ADDR  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDR  = '0x4200000000000000000000000000000000000006';
const V3_NPM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

const FEE_TIER = 10000;
const MIN_TICK = -887200;
const MAX_TICK = 887200;

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
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
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];
const FACTORY_ABI = [
  'function getPool(address, address, uint24) view returns (address)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Send tx with explicit nonce, wait for confirm, bump nonce
let _nonce = null;
async function sendTx(fn) {
  const tx = await fn({ nonce: _nonce });
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
  const usdc = new ethers.Contract(USDC_ADDR, ERC20_ABI, wallet);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);

  // Init nonce
  _nonce = await provider.getTransactionCount(wallet.address, 'latest');
  log('Wallet: ' + wallet.address);
  log('Nonce:  ' + _nonce);

  const earthBal = await earth.balanceOf(wallet.address);
  const usdcBal = await usdc.balanceOf(wallet.address);
  log('EARTH balance: ' + ethers.formatEther(earthBal));
  log('USDC balance:  ' + ethers.formatUnits(usdcBal, 6));

  // ── Get current EARTH price from WETH pool ────────────────────────────────
  const wethPoolAddr = await factory.getPool(WETH_ADDR, EARTH_ADDR, FEE_TIER);
  log('WETH pool: ' + wethPoolAddr);
  const wethPool = new ethers.Contract(wethPoolAddr, POOL_ABI, provider);
  const slot0 = await wethPool.slot0();
  const sqrtPriceX96 = slot0[0];

  // WETH is token0, EARTH is token1 in the WETH pool
  // price = (sqrtPriceX96 / 2^96)^2 = EARTH per WETH
  const Q96 = 2n ** 96n;
  const priceEarthPerWeth = Number(sqrtPriceX96) ** 2 / Number(Q96) ** 2;
  const ethPriceUsd = 2500; // approximate
  const earthPriceUsd = ethPriceUsd / priceEarthPerWeth;
  log('EARTH/WETH price: ' + priceEarthPerWeth.toFixed(2) + ' EARTH per WETH');
  log('EARTH price (est): $' + earthPriceUsd.toFixed(4));

  // ── Calculate amounts for USDC pool ───────────────────────────────────────
  // Use all EARTH in wallet
  const earthForLP = earthBal;
  const earthValueUsd = Number(ethers.formatEther(earthForLP)) * earthPriceUsd;
  // Match with equal USDC
  const usdcForLP = BigInt(Math.floor(earthValueUsd * 1e6)); // USDC has 6 decimals

  log('');
  log('LP plan:');
  log('  EARTH: ' + ethers.formatEther(earthForLP));
  log('  USDC:  $' + (Number(usdcForLP) / 1e6).toFixed(6));

  if (usdcForLP > usdcBal) {
    log('ERROR: Not enough USDC. Need $' + (Number(usdcForLP) / 1e6).toFixed(2) + ', have $' + ethers.formatUnits(usdcBal, 6));
    process.exit(1);
  }

  // ── Sort tokens for V3 ────────────────────────────────────────────────────
  const [token0, token1, usdcIsToken0] = sortTokens(USDC_ADDR, EARTH_ADDR);
  log('token0: ' + token0 + (usdcIsToken0 ? ' (USDC)' : ' (EARTH)'));
  log('token1: ' + token1 + (usdcIsToken0 ? ' (EARTH)' : ' (USDC)'));

  // Price = token1 / token0 (adjusted for decimals)
  // If USDC is token0 (6 dec), EARTH is token1 (18 dec):
  //   raw price = (EARTH_amount_raw / USDC_amount_raw)
  //   But V3 price is in raw units: price = token1_raw / token0_raw
  //   For $1.14/EARTH: 1 USDC ($1) buys 1/1.14 EARTH
  //   raw: 1e6 USDC = (1/1.14)*1e18 EARTH
  //   price = ((1/1.14)*1e18) / 1e6 = (1/1.14)*1e12
  let rawPrice;
  if (usdcIsToken0) {
    // price = EARTH_raw / USDC_raw for equal dollar value
    // 1 USDC_raw (1e6) = (1/earthPriceUsd) EARTH = (1/earthPriceUsd)*1e18 EARTH_raw
    // price = (1/earthPriceUsd)*1e18 / 1e6 = 1e12 / earthPriceUsd
    rawPrice = 1e12 / earthPriceUsd;
  } else {
    // price = USDC_raw / EARTH_raw
    // 1 EARTH_raw (1e18) = earthPriceUsd USDC = earthPriceUsd*1e6 USDC_raw
    // price = earthPriceUsd*1e6 / 1e18 = earthPriceUsd / 1e12
    rawPrice = earthPriceUsd / 1e12;
  }
  log('Raw price (token1/token0): ' + rawPrice);

  const sqrtPrice = Math.sqrt(rawPrice);
  const sqrtPriceX96_usdc = BigInt(Math.floor(sqrtPrice * Number(Q96)));
  log('sqrtPriceX96: ' + sqrtPriceX96_usdc.toString());
  log('');

  // ── Check if pool already exists ──────────────────────────────────────────
  const existingPool = await factory.getPool(EARTH_ADDR, USDC_ADDR, FEE_TIER);
  if (existingPool !== '0x0000000000000000000000000000000000000000') {
    log('Pool already exists: ' + existingPool + ' — skipping create');
  } else {
    log('=== Step 1: Creating EARTH/USDC pool (1% fee) ===');
    await sendTx((opts) => npm.createAndInitializePoolIfNecessary(token0, token1, FEE_TIER, sqrtPriceX96_usdc, opts));
    log('Pool created!');
  }

  // ── Step 2: Approve tokens ────────────────────────────────────────────────
  log('');
  log('=== Step 2: Approving tokens ===');
  await sendTx((opts) => earth.approve(V3_NPM, ethers.MaxUint256, opts));
  log('  EARTH approved');
  await sendTx((opts) => usdc.approve(V3_NPM, usdcForLP, opts));
  log('  USDC approved');

  // ── Step 3: Mint full-range position ──────────────────────────────────────
  log('');
  log('=== Step 3: Minting LP position ===');
  const amount0 = usdcIsToken0 ? usdcForLP : earthForLP;
  const amount1 = usdcIsToken0 ? earthForLP : usdcForLP;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const mintTx = await sendTx((opts) => npm.mint({
    token0, token1,
    fee: FEE_TIER,
    tickLower: MIN_TICK,
    tickUpper: MAX_TICK,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: wallet.address,
    deadline,
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

  // ── Step 4: Transfer NFT to Reactor ───────────────────────────────────────
  log('');
  log('=== Step 4: Transferring NFT to Reactor (LOCKED FOREVER) ===');
  await sendTx((opts) => npm.safeTransferFrom(wallet.address, REACTOR_ADDR, tokenId, opts));
  log('NFT #' + tokenId + ' transferred to Reactor');

  // ── Step 5: Register pool ─────────────────────────────────────────────────
  log('');
  log('=== Step 5: Registering pool in Reactor ===');
  await sendTx((opts) => reactor.addPool(tokenId, opts));
  const poolCount = await reactor.poolCount();
  log('Pool registered! Total pools: ' + poolCount.toString());

  // ── Summary ───────────────────────────────────────────────────────────────
  const finalEarth = await earth.balanceOf(wallet.address);
  const finalUsdc = await usdc.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════════════════');
  log('  EARTH/USDC pool LIVE');
  log('  Position NFT #' + tokenId + ' locked in Reactor');
  log('  Total pools: ' + poolCount.toString());
  log('  EARTH remaining: ' + ethers.formatEther(finalEarth));
  log('  USDC remaining:  ' + ethers.formatUnits(finalUsdc, 6));
  log('  EARTH price:     ~$' + earthPriceUsd.toFixed(4));
  log('════════════════════════════════════════════════════');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
