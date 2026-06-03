/**
 * trade-loop.js — Rotate $0.10 trades through EARTH pools
 * Sequence: POOP→EARTH→MfT→TGN→EARTH→POOP→AZUSD→EARTH→MfT→POOP (repeat)
 * 1 trade per minute, generates volume on all EARTH pools.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH   = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const POOP    = '0x126555aecBAC290b25644e4b7f29c016aE95f4dc';
const MFT     = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const TGN     = '0xD75dfa972C6136f1c594Fec1945302f885E1ab29';
const AZUSD   = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const WETH    = '0x4200000000000000000000000000000000000006';
const V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

const FEE = 10000; // 1%
const TARGET_USD = 0.10;
const INTERVAL_MS = 60_000; // 1 minute
const USD_PER_PAIR = 20; // $20 on each pair before moving on
const TRADES_PER_PAIR = Math.round(USD_PER_PAIR / TARGET_USD); // 200 trades

// Trade sequence — each entry is [tokenIn, tokenOut, via] where via is optional intermediate
const TRADES = [
  [POOP,  EARTH, null],    // 1. POOP → EARTH
  [EARTH, MFT,   null],    // 2. EARTH → MfT
  [MFT,   TGN,   EARTH],  // 3. MfT → TGN (via EARTH)
  [TGN,   EARTH, null],    // 4. TGN → EARTH
  [EARTH, POOP,  null],    // 5. EARTH → POOP
  [POOP,  AZUSD, EARTH],  // 6. POOP → AZUSD (via EARTH)
  [AZUSD, EARTH, null],    // 7. AZUSD → EARTH
  [EARTH, MFT,   null],    // 8. EARTH → MfT
  [MFT,   POOP,  EARTH],  // 9. MfT → POOP (via EARTH)
];

const NAMES = {};
NAMES[EARTH] = 'EARTH';
NAMES[POOP] = 'POOP';
NAMES[MFT] = 'MfT';
NAMES[TGN] = 'TGN';
NAMES[AZUSD] = 'AZUSD';
NAMES[WETH] = 'WETH';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function decimals() view returns (uint8)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
];
const POOL_ABI = [
  'function slot0() view returns (uint160, int24, uint16, uint16, uint16, uint8, bool)',
  'function token0() view returns (address)',
];
const FACTORY_ABI = [
  'function getPool(address, address, uint24) view returns (address)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function encodePath(tokens, fees) {
  let encoded = tokens[0].toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    encoded += fees[i].toString(16).padStart(6, '0');
    encoded += tokens[i + 1].slice(2).toLowerCase();
  }
  return '0x' + encoded.slice(2);
}

async function getPoopPriceUsd(provider) {
  const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);
  const poopWethAddr = await factory.getPool(POOP, WETH, 10000);
  const pool = new ethers.Contract(poopWethAddr, POOL_ABI, provider);
  const [slot0, t0] = await Promise.all([pool.slot0(), pool.token0()]);
  const Q96 = 2n ** 96n;
  const rawPrice = (Number(slot0[0]) / Number(Q96)) ** 2;
  // POOP 0x126 < WETH 0x420 → POOP is token0, price = WETH/POOP
  const poopPriceUsd = rawPrice * 2500;
  return poopPriceUsd;
}

async function main() {
  if (!PRIVATE_KEY) { console.error('Set KEEPER_PRIVATE_KEY in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);

  log('Trade loop starting — $' + TARGET_USD + '/trade, 1/min');
  log('Wallet: ' + wallet.address);
  log('Sequence: ' + TRADES.map(t => NAMES[t[0]] + '→' + NAMES[t[1]]).join(' | '));

  // Approve all tokens for router (skip if already approved)
  const tokens = [POOP, EARTH, MFT, TGN, AZUSD];
  for (const addr of tokens) {
    const c = new ethers.Contract(addr, ERC20_ABI, wallet);
    const allowance = await c.allowance(wallet.address, V3_ROUTER);
    if (allowance > ethers.parseEther('1000000')) {
      log('Already approved ' + NAMES[addr]);
    } else {
      const tx = await c.approve(V3_ROUTER, ethers.MaxUint256);
      await tx.wait();
      log('Approved ' + NAMES[addr]);
    }
  }

  let pairIdx = 0;
  let totalTrades = 0;

  while (true) {
    const [tokenIn, tokenOut, via] = TRADES[pairIdx % TRADES.length];
    const pairName = NAMES[tokenIn] + '→' + NAMES[tokenOut] + (via ? ' (via ' + NAMES[via] + ')' : '');
    log('');
    log('=== Starting pair: ' + pairName + ' — ' + TRADES_PER_PAIR + ' trades of $' + TARGET_USD + ' ===');

    for (let i = 0; i < TRADES_PER_PAIR; i++) {
      try {
        // Calculate $0.10 worth of tokenIn
        const inContract = new ethers.Contract(tokenIn, ERC20_ABI, wallet);
        let amountIn;

        if (tokenIn === POOP) {
          const poopPrice = await getPoopPriceUsd(provider);
          amountIn = ethers.parseEther((TARGET_USD / poopPrice).toFixed(6));
        } else {
          // Price other tokens via their EARTH pool
          const factory = new ethers.Contract(V3_FACTORY, FACTORY_ABI, provider);
          const earthUsdcPool = await factory.getPool(EARTH, '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 10000);
          const ep = new ethers.Contract(earthUsdcPool, POOL_ABI, provider);
          const es0 = await ep.slot0();
          const Q96 = 2n ** 96n;
          const earthPriceUsd = ((Number(es0[0]) / Number(Q96)) ** 2) * 1e12;

          if (tokenIn === EARTH) {
            amountIn = ethers.parseEther((TARGET_USD / earthPriceUsd).toFixed(12));
          } else {
            // Get tokenIn price via EARTH pool
            const pairPool = await factory.getPool(tokenIn, EARTH, 10000);
            const pp = new ethers.Contract(pairPool, POOL_ABI, provider);
            const [ps0, pt0] = await Promise.all([pp.slot0(), pp.token0()]);
            const rawP = (Number(ps0[0]) / Number(Q96)) ** 2;
            // rawP = token1/token0; figure out which is which
            const tokenInIsT0 = pt0.toLowerCase() === tokenIn.toLowerCase();
            const tokenInPerEarth = tokenInIsT0 ? 1 / rawP : rawP;
            const tokenInPriceUsd = earthPriceUsd / tokenInPerEarth;
            amountIn = ethers.parseEther((TARGET_USD / tokenInPriceUsd).toFixed(12));
          }
        }

        const bal = await inContract.balanceOf(wallet.address);
        if (amountIn > bal) amountIn = bal;
        if (amountIn < 1000n) {
          log('  [' + (i+1) + '/' + TRADES_PER_PAIR + '] No ' + NAMES[tokenIn] + ' — skipping pair');
          break;
        }

        if (via) {
          const path = encodePath([tokenIn, via, tokenOut], [FEE, FEE]);
          await (await router.exactInput({
            path, recipient: wallet.address, amountIn, amountOutMinimum: 0n,
          })).wait();
        } else {
          await (await router.exactInputSingle({
            tokenIn, tokenOut, fee: FEE, recipient: wallet.address,
            amountIn, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n,
          })).wait();
        }

        totalTrades++;
        if ((i + 1) % 10 === 0 || i === 0) {
          const outBal = await (new ethers.Contract(tokenOut, ERC20_ABI, wallet)).balanceOf(wallet.address);
          log('  [' + (i+1) + '/' + TRADES_PER_PAIR + '] ' + pairName + ' | ' + NAMES[tokenOut] + ' bal: ' + ethers.formatEther(outBal).slice(0, 12) + ' | total: ' + totalTrades);
        }

      } catch(e) {
        log('  [' + (i+1) + '] ERROR: ' + (e.reason || e.shortMessage || e.message).slice(0, 100));
      }

      await sleep(INTERVAL_MS);
    }

    pairIdx++;
    log('=== Pair done. Moving to next. Total trades: ' + totalTrades + ' ===');
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
