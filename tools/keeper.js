/**
 * keeper.js — EARTH Reactor keeper
 *
 * Calls Reactor.execute() every 2 hours.
 * Uses KEEPER_PRIVATE_KEY from .env (same key as Baseling keepers).
 *
 * Usage:
 *   node tools/keeper.js              — run once (check + execute if ready)
 *   node tools/keeper.js --loop       — run forever, check every 10 min
 *   node tools/keeper.js --status     — show reactor status
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
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

const EARTH_ABI = [
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function rebaseIndex() view returns (uint256)',
];

function ts() { return new Date().toISOString().slice(0, 19); }
function log(msg) { console.log(`[${ts()}] ${msg}`); }

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
    log('Starting keeper loop (check every 10 min)...');
    while (true) {
      await tryExecute(provider, wallet, reactor);
      await sleep(10 * 60 * 1000); // 10 min
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

    log('Executing Reactor...');
    const tx = await reactor.execute({ gasLimit: 2000000 });
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
      } catch(_) {}
    }
  } catch(err) {
    log('ERROR: ' + err.message);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
