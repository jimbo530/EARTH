/**
 * keeper.js — EARTH Reactor keeper
 *
 * Calls Reactor.execute() 10x/day (every 2.4 hours).
 * Uses KEEPER_PRIVATE_KEY from .env (same key as Baseling keepers).
 * staticCall check before real tx to avoid gas waste on reverts.
 *
 * Usage:
 *   node tools/keeper.js              — run once (check + execute if ready)
 *   node tools/keeper.js --loop       — run forever, fire every 2.4 hours
 *   node tools/keeper.js --status     — show reactor status
 */
// Load .env: check DOTENV_PATH (VPS), then local .env
const _envPath = process.env.DOTENV_PATH || require('path').join(__dirname, '.env');
require('dotenv').config({ path: _envPath });
const { ethers } = require('ethers');

// ── Config ─────────────────────────────────────────────────────────────────
const BASE_RPC = 'https://mainnet.base.org';

// FILL AFTER DEPLOY
const REACTOR_ADDR = process.env.EARTH_REACTOR || '';
const EARTH_ADDR   = process.env.EARTH_TOKEN   || '';

const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const REACTOR_ABI = [
  'function execute() external',
  'function lastExecute() view returns (uint256)',
  'function COOLDOWN() view returns (uint256)',
  'function poolCount() view returns (uint256)',
  'function earth() view returns (address)',
  'event Executed(uint256 burned, uint256 minted, uint256 timestamp, address caller)',
];

// ── Fee gate ────────────────────────────────────────────────────────────────
const FEE_GATE_MIN_USD = 0.05;
const STALE_OVERRIDE_SECS = 48 * 60 * 60; // 48h — fire regardless if idle this long

const NPM_ADDR = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDR = '0x4200000000000000000000000000000000000006';
const cbBTC_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';

const NPM_POS_ABI = ['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)'];
const RX_POOLS_ABI = ['function pools(uint256) view returns (uint256 tokenId, address xToken, uint24 fee, bool tokenIsToken0)'];
const SLOT0_ABI = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'];
const V3F_ADDR = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const V3F_ABI = ['function getPool(address,address,uint24) view returns (address)'];

const EARTH_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function rebaseIndex() view returns (uint256)',
];

function ts() { return new Date().toISOString().slice(0, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

async function getEthPrice(provider) {
  try {
    const v3f = new ethers.Contract(V3F_ADDR, V3F_ABI, provider);
    const pool = await v3f.getPool(WETH_ADDR, USDC_ADDR, 500);
    if (pool !== ethers.ZeroAddress) {
      const s = await new ethers.Contract(pool, SLOT0_ABI, provider).slot0();
      return Math.pow(1.0001, Number(s[1])) * 1e12;
    }
  } catch (e) { console.error('[' + ts() + '] ETH price fetch failed:', e.message || e); }
  return 2400; // fallback
}

async function getBtcPrice(provider) {
  try {
    const v3f = new ethers.Contract(V3F_ADDR, V3F_ABI, provider);
    const pool = await v3f.getPool(cbBTC_ADDR, USDC_ADDR, 500);
    if (pool !== ethers.ZeroAddress) {
      const s = await new ethers.Contract(pool, SLOT0_ABI, provider).slot0();
      return 1 / (Math.pow(1.0001, Number(s[1])) * 0.01);
    }
  } catch (e) { console.error('[' + ts() + '] BTC price fetch failed:', e.message || e); }
  return 80000; // fallback
}

async function checkFees(provider) {
  const rx = new ethers.Contract(REACTOR_ADDR, RX_POOLS_ABI, provider);
  const npm = new ethers.Contract(NPM_ADDR, NPM_POS_ABI, provider);
  const count = Number(await rx.poolCount());

  const ethPrice = await getEthPrice(provider);
  const btcPrice = await getBtcPrice(provider);

  let totalUsd = 0;
  for (let i = 0; i < count; i++) {
    try {
      const pool = await rx.pools(i);
      const pos = await npm.positions(pool.tokenId);
      const owed0 = pos.tokensOwed0;
      const owed1 = pos.tokensOwed1;
      if (owed0 === 0n && owed1 === 0n) continue;

      const xt = pool.xToken.toLowerCase();
      if (xt === USDC_ADDR.toLowerCase()) {
        const usdcOwed = pool.tokenIsToken0 ? owed1 : owed0;
        totalUsd += Number(ethers.formatUnits(usdcOwed, 6));
      } else if (xt === WETH_ADDR.toLowerCase()) {
        const wethOwed = pool.tokenIsToken0 ? owed1 : owed0;
        totalUsd += Number(ethers.formatEther(wethOwed)) * ethPrice;
      } else if (xt === cbBTC_ADDR.toLowerCase()) {
        const btcOwed = pool.tokenIsToken0 ? owed1 : owed0;
        totalUsd += Number(ethers.formatUnits(btcOwed, 8)) * btcPrice;
      } else {
        // Meme/small tokens — rough $0.001 estimate per token
        totalUsd += Number(ethers.formatEther(owed0)) * 0.001;
        totalUsd += Number(ethers.formatEther(owed1)) * 0.001;
      }
    } catch (e) {
      log('  pool ' + i + ' fee read failed: ' + (e.message || '').slice(0, 60));
    }
  }
  return totalUsd;
}

async function main() {
  if (!PRIVATE_KEY) { console.error('Set KEEPER_PRIVATE_KEY in tools/.env'); process.exit(1); }
  if (!REACTOR_ADDR) { console.error('Set EARTH_REACTOR in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);

  log('Keeper wallet: ' + wallet.address);
  log('Reactor: ' + REACTOR_ADDR);

  const cmd = process.argv[2];

  if (cmd === '--status') {
    await showStatus(provider, reactor);
    return;
  }

  if (cmd === '--loop') {
    log('Starting keeper loop (fire every 2.4 hours, 10x/day)...');
    while (true) {
      await tryExecute(provider, wallet, reactor);
      await sleep(144 * 60 * 1000); // 144 min = 2.4 hours
    }
  }

  // Default: single run
  await tryExecute(provider, wallet, reactor);
}

async function showStatus(provider, reactor) {
  const poolCount = await reactor.poolCount();
  const lastExec = await reactor.lastExecute();
  const cooldown = await reactor.COOLDOWN();
  const now = BigInt(Math.floor(Date.now() / 1000));
  const nextExec = lastExec + cooldown;
  const ready = now >= nextExec;

  log('Pools:        ' + poolCount.toString());
  log('Last execute: ' + (lastExec > 0n ? new Date(Number(lastExec) * 1000).toISOString() : 'never'));
  log('Cooldown:     ' + (Number(cooldown) / 3600) + ' hours');
  log('Ready:        ' + (ready ? 'YES' : 'No — ' + Math.ceil(Number(nextExec - now) / 60) + ' min remaining'));

  if (EARTH_ADDR) {
    const earth = new ethers.Contract(EARTH_ADDR, EARTH_ABI, provider);
    log('Total supply: ' + ethers.formatEther(await earth.totalSupply()) + ' EARTH');
    log('Rebase index: ' + (await earth.rebaseIndex()).toString());
  }

  const bal = await provider.getBalance(await reactor.runner.getAddress());
  log('Keeper ETH:   ' + ethers.formatEther(bal));
}

async function tryExecute(provider, wallet, reactor) {
  try {
    const lastExec = await reactor.lastExecute();
    const cooldown = await reactor.COOLDOWN();
    const now = BigInt(Math.floor(Date.now() / 1000));

    if (now < lastExec + cooldown) {
      const remaining = Number(lastExec + cooldown - now);
      log('Cooldown active. ' + Math.ceil(remaining / 60) + ' min remaining.');
      return;
    }

    const poolCount = await reactor.poolCount();
    if (poolCount === 0n) {
      log('No pools registered. Skipping.');
      return;
    }

    // Fee gate: skip if fees < $0.05 (unless stale > 48h)
    const idleSecs = Number(now - lastExec);
    const stale = idleSecs >= STALE_OVERRIDE_SECS;
    try {
      const feesUsd = await checkFees(provider);
      if (feesUsd < FEE_GATE_MIN_USD && !stale) {
        log('FEES $' + feesUsd.toFixed(4) + ' < $' + FEE_GATE_MIN_USD.toFixed(2) + ' — skipping (idle ' + Math.round(idleSecs / 3600) + 'h)');
        return;
      }
      log('FEES $' + feesUsd.toFixed(4) + (stale ? ' (stale override, idle ' + Math.round(idleSecs / 3600) + 'h)' : ''));
    } catch (e) {
      log('Fee check failed: ' + (e.message || '').slice(0, 80) + ' — firing anyway');
    }

    // staticCall first to avoid burning gas on reverts
    try {
      await reactor.execute.staticCall({ gasLimit: 8000000 });
    } catch (simErr) {
      log('SKIP: execute() would revert — ' + (simErr.reason || simErr.message).slice(0, 120));
      return;
    }

    log('Executing Reactor...');
    const tx = await reactor.execute({ gasLimit: 8000000 });
    log('Tx sent: ' + tx.hash);
    const receipt = await tx.wait();
    log('Confirmed! Gas: ' + receipt.gasUsed.toString());

    // Parse Executed event
    for (const evLog of receipt.logs) {
      try {
        const parsed = reactor.interface.parseLog(evLog);
        if (parsed && parsed.name === 'Executed') {
          log('  Burned: ' + ethers.formatEther(parsed.args[0]) + ' EARTH');
          log('  Minted: ' + ethers.formatEther(parsed.args[1]) + ' EARTH to holders');
        }
      } catch(e) { /* non-Executed log, safe to skip */ }
    }
  } catch(err) {
    log('ERROR: ' + err.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
