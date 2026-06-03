/**
 * Reactor Heartbeat — fires execute() on ALL reactors bottom-up every 2 hours
 *
 * - Checks uncollected fees per reactor — skips if < $0.50
 * - staticCall to detect reverts before spending gas
 * - On failure: investigates (state, balances, revert reason) and writes report
 * - Skips known-broken reactors (clone reentrancy)
 * - 1 min between successful fires for fees to settle
 * - Loops every 2 hours
 *
 * Usage: node reactor-call-line.js           (runs forever, 2hr loop)
 *        node reactor-call-line.js --once     (single pass)
 */

// Load .env: check DOTENV_PATH (VPS), then local .env, then fallback to Baselings
const _path = require('path');
const _envPath = process.env.DOTENV_PATH
  || (require('fs').existsSync(_path.join(__dirname, '.env')) ? _path.join(__dirname, '.env') : null)
  || _path.join(__dirname, '..', '..', 'Baselings', 'api', '.env');
require('dotenv').config({ path: _envPath });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const ABI_SPORE = [
  'function execute()',
  'function poolCount() view returns (uint256)',
  'function activePoolCount() view returns (uint256)',
  'function lastExecute() view returns (uint256)',
  'function timeUntilExecute() view returns (uint256)',
];

const ABI_CHAIN = [
  'function execute()',
  'function lastExecute() view returns (uint256)',
  'function timeUntilExecute() view returns (uint256)',
];

// Bottom-up order: feeders → band chain → MycoPad → [launched tokens auto-inserted] → main chain → Prime
const CORE_LINE = [
  // --- Feeder layer ---
  { name: 'ecowealth',    addr: '0xc7E739f223934C5F69EBA36BcDf808c4379b1985', abi: 'chain' },

  // --- BB/EB v5 (feed EB relay) ---
  { name: 'BB v5',        addr: '0x3b31B8c9338ebFE2e737e5dd6361cEf0Bdc431e3', abi: 'spore' },
  { name: 'EB v5',        addr: '0x2e06EB264dB2C7bcD8B9a216827b7D0eF3beACA2', abi: 'spore' },

  // --- EB relay (feeds MycoPad) ---
  { name: 'EB relay',     addr: '0xC28e64551816535d9ef06CE95844F2b5317353bA', abi: 'spore' },

  // --- Band reactors (feed MycoPad) ---
  { name: 'BTCband v1',   addr: '0x2879706E115150BBB9ffb5C432024264dEE0852F', abi: 'spore' },
  { name: 'ETHband v1',   addr: '0x7018660EFBd7CfE3219388322417D405fC15b23B', abi: 'spore' },
  { name: 'BTCband v2',   addr: '0x038B87f2Abc1dcE269FF7DE4d3e721b5b57eD8cf', abi: 'spore' },
  { name: 'ETHband v2',   addr: '0xeB02d1137342cD08C1c4bf61C188d86C5253b631', abi: 'spore' },
  { name: 'BB v3',        addr: '0x5375817c1798d43036d3b2DAAfaFB8e2247bAcF2', abi: 'spore' },
  { name: 'EB v3',        addr: '0x361A4E356847c5a0C60B510b2531b640aC51f090', abi: 'spore' },

  // --- MycoPad hub (processes band + launched token fees) ---
  { name: 'MycoPad',      addr: '0xF5B9Fc40080aAcC262f078eCE374A2268dcdb045', abi: 'spore' },

  // --- BBT/EBT tight bands (feed V1 Prime) ---
  { name: 'BBT',          addr: '0x6853679E3240E207031dDddDeaA8d131dEc0EC92', abi: 'spore' },
  { name: 'EBT',          addr: '0xFA6823332D2Bc882a62Ceb4029Dde2573709698B', abi: 'spore' },

  // --- WALL (feed V1 Prime) ---
  { name: 'WALL',         addr: '0xBEe606A4Dd8c7027613FA300C517782A14A56490', abi: 'spore' },

  // --- FF (Flaunch Fund) ---
  { name: 'FF',            addr: '0x864d3EeDC039982346ffD49B7003Dc38F428EB38', abi: 'spore' },

  // --- PIZZA chain (PIZZA → BURGERS V4 → NFS → V1 Prime) ---
  { name: 'PIZZA',        addr: '0xe93Aa8104Ad035AC88b984320D80b5c335B2B96C', abi: 'spore' },
  { name: 'BURGERS V4',   addr: '0x2867F1107d3A4767018740e10f0067702a8eC682', abi: 'spore' },
  { name: 'NFS',          addr: '0x286416cE59B355dEFf1a02d52013d4CBDC11F3bF', abi: 'spore' },

  // --- Main chain (Row 4 → Row 3 → Row 2 → Row 1) ---
  { name: 'TGN',          addr: '0xc3f09dAEF814177E52B4C04ec2872B564a36989D', abi: 'spore' },
  { name: 'AZUSD V3',     addr: '0x6888ef2F92E3073a378f7153548e9C7691c90d23', abi: 'chain' },  // MEV protected (3% slippage cap, pool lock check)
  { name: 'AZUSD V2',     addr: '0xD8AFb7caD1f8A3Ddc4E16c1516a94949eb119281', abi: 'chain' },  // legacy — no slippage protection, 5 pools still earning
  { name: 'BURGERS',      addr: '0xc858026Ec5D30280137032BC6EA86F46ea23C2CA', abi: 'chain' },
  { name: 'CHAR',         addr: '0xc2eBe90fB9bC7897f06DC00666951Fa9a49A397A', abi: 'chain' },
  { name: 'EGP',          addr: '0x10A710fced92eB096F796F43BCCFb60884c13819', abi: 'chain' },
  { name: 'MfT V1 Prime', addr: '0xed3aE91b2bb22307c07438EEebA2500C18EABcFE', abi: 'chain' },

  // --- Terminal (receives fuel, never forwards) ---
  { name: 'MfT PrimeV3',  addr: '0xA97af9770B79C3f0467ec8b3AD7e464154dbc9BA', abi: 'spore' },
];

// Launched tokens fire first — inserted at the TOP of the call line

// Fetch launched token reactors from Supabase
async function fetchLaunchedReactors() {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.log('[' + ts() + '] No Supabase creds — skipping launched token discovery');
    return [];
  }

  const headers = { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY };
  let rows;

  try {
    // Try with char_reactor_address column
    let res = await fetch(
      SUPABASE_URL + '/rest/v1/launched_tokens?select=symbol,reactor_address,char_reactor_address&chain_id=eq.8453',
      { headers }
    );

    if (!res.ok) {
      // Column might not exist — fallback without it
      res = await fetch(
        SUPABASE_URL + '/rest/v1/launched_tokens?select=symbol,reactor_address&chain_id=eq.8453',
        { headers }
      );
    }

    if (!res.ok) {
      console.log('[' + ts() + '] Supabase launched_tokens fetch failed: ' + res.status);
      return [];
    }

    rows = await res.json();
  } catch (e) {
    console.log('[' + ts() + '] Launched token fetch error: ' + (e.message || '').slice(0, 80));
    return [];
  }

  // Build a set of addresses already in CORE_LINE to avoid duplicates
  const coreAddrs = new Set(CORE_LINE.map(r => r.addr.toLowerCase()));

  const entries = [];
  for (const row of rows) {
    // Main token reactor
    if (row.reactor_address) {
      const addr = row.reactor_address;
      if (!BROKEN.has(addr) && !coreAddrs.has(addr.toLowerCase())) {
        entries.push({ name: row.symbol + ' rx', addr, abi: 'spore', launched: true });
      }
    }
    // CHAR reactor (if column exists)
    if (row.char_reactor_address) {
      const addr = row.char_reactor_address;
      if (!BROKEN.has(addr) && !coreAddrs.has(addr.toLowerCase())) {
        entries.push({ name: row.symbol + ' CHAR rx', addr, abi: 'spore', launched: true });
      }
    }
  }

  return entries;
}

// Build full call line — launched tokens fire first (top), then core network
function buildCallLine(launched) {
  if (launched.length === 0) return CORE_LINE;
  return [...launched, ...CORE_LINE];
}

// Archived broken reactors (old V2/V3 clone factories, removed from Supabase 2026-05-09)
// ILM 0x885f, RT 0x3FE9, SC 0xB7C5, BRUH 0xE967
// All current V5.2 reactors work — firing failures are call/gas issues, not broken contracts
const BROKEN = new Set([]);

const NPM_ADDR = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const USDC_ADDR = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH_ADDR = '0x4200000000000000000000000000000000000006';
const cbBTC_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const MFT_ADDR = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const BURN_ADDR = '0xfd780B0aE569e15e514B819ecFDF46f804953a4B';

const NPM_POS_ABI = ['function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128 tokensOwed0,uint128 tokensOwed1)'];
const RX_POOLS_ABI = ['function pools(uint256) view returns (uint256 tokenId, address xToken, address poolAddress, uint24 fee, bool tokenIsToken0, bool disabled)', 'function poolCount() view returns (uint256)'];
const SLOT0_ABI = ['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)'];
const V3F_ADDR = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const V3F_ABI = ['function getPool(address,address,uint24) view returns (address)'];
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)'];

const FEE_GATE_MIN_USD = 0.50;
const LOOP_INTERVAL = 2 * 60 * 60 * 1000; // 2 hours
const MAX_RETRIES = 3;
const RETRY_DELAY = 120_000;
const POST_FIRE_DELAY = 60_000;
const INTER_REACTOR_DELAY = 2_000; // 2s between reactors to avoid RPC rate limits
const RPC_RETRY_DELAY = 3_000;     // 3s backoff on rate limit
const RPC_MAX_RETRIES = 3;
const REPORT_DIR = path.join(__dirname, 'reports');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toISOString().slice(11, 19); }
function datestamp() { return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); }

// Rate-limit-aware RPC call — retries on -32016 "over rate limit"
function isRateLimitError(e) {
  const msg = (e.message || e.error?.message || '').toLowerCase();
  return msg.includes('rate limit') || msg.includes('missing revert data');
}

async function rpcRetry(fn, label) {
  for (let i = 1; i <= RPC_MAX_RETRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      if (isRateLimitError(e) && i < RPC_MAX_RETRIES) {
        await sleep(RPC_RETRY_DELAY * i);
        continue;
      }
      throw e;
    }
  }
}

// Get ETH and BTC prices (cached per pass)
let _ethPrice = 2400, _btcPrice = 80000;
async function refreshPrices(provider) {
  const v3f = new ethers.Contract(V3F_ADDR, V3F_ABI, provider);
  try {
    const ethPool = await v3f.getPool(WETH_ADDR, USDC_ADDR, 500);
    if (ethPool !== ethers.ZeroAddress) {
      const s = await new ethers.Contract(ethPool, SLOT0_ABI, provider).slot0();
      _ethPrice = Math.pow(1.0001, Number(s[1])) * 1e12;
    }
  } catch (e) { console.log('[' + ts() + '] ETH price fetch failed: ' + (e.message || '').slice(0, 60)); }
  try {
    const btcPool = await v3f.getPool(cbBTC_ADDR, USDC_ADDR, 500);
    if (btcPool !== ethers.ZeroAddress) {
      const s = await new ethers.Contract(btcPool, SLOT0_ABI, provider).slot0();
      _btcPrice = 1 / (Math.pow(1.0001, Number(s[1])) * 0.01);
    }
  } catch (e) { console.log('[' + ts() + '] BTC price fetch failed: ' + (e.message || '').slice(0, 60)); }
}

// Check uncollected fees on all reactor pools, return estimated USD total
async function checkFees(reactorAddr, provider) {
  const rx = new ethers.Contract(reactorAddr, RX_POOLS_ABI, provider);
  const npm = new ethers.Contract(NPM_ADDR, NPM_POS_ABI, provider);
  const count = Number(await rx.poolCount());

  let totalUsd = 0;
  for (let i = 0; i < count; i++) {
    try {
      const pool = await rx.pools(i);
      if (pool.disabled) continue;
      const pos = await npm.positions(pool.tokenId);
      const owed0 = pos.tokensOwed0;
      const owed1 = pos.tokensOwed1;
      if (owed0 === 0n && owed1 === 0n) continue;

      const xt = pool.xToken.toLowerCase();
      if (xt === USDC_ADDR.toLowerCase()) {
        const usdcOwed = pool.tokenIsToken0 ? owed1 : owed0;
        totalUsd += Number(ethers.formatUnits(usdcOwed, 6));
        const bandOwed = pool.tokenIsToken0 ? owed0 : owed1;
        totalUsd += Number(ethers.formatEther(bandOwed));
      } else if (xt === WETH_ADDR.toLowerCase()) {
        const wethOwed = pool.tokenIsToken0 ? owed1 : owed0;
        totalUsd += Number(ethers.formatEther(wethOwed)) * _ethPrice;
        const bandOwed = pool.tokenIsToken0 ? owed0 : owed1;
        totalUsd += Number(ethers.formatEther(bandOwed));
      } else if (xt === cbBTC_ADDR.toLowerCase()) {
        const btcOwed = pool.tokenIsToken0 ? owed1 : owed0;
        totalUsd += Number(ethers.formatUnits(btcOwed, 8)) * _btcPrice;
        const bandOwed = pool.tokenIsToken0 ? owed0 : owed1;
        totalUsd += Number(ethers.formatEther(bandOwed));
      } else {
        // MfT or other 18-dec token — count both sides at rough estimate
        totalUsd += Number(ethers.formatEther(owed0)) * 0.001;
        totalUsd += Number(ethers.formatEther(owed1)) * 0.001;
      }
    } catch (e) {
      console.log('[' + ts() + ']   pool ' + i + ' fee read failed: ' + (e.message || '').slice(0, 60));
    }
  }
  return totalUsd;
}

// Investigate a failed reactor — check state, balances, revert reason
async function investigate(name, addr, revertReason, provider) {
  const report = [];
  report.push('# Reactor Failure Report: ' + name);
  report.push('Address: ' + addr);
  report.push('Time: ' + new Date().toISOString());
  report.push('Revert: ' + revertReason);
  report.push('');

  // Code size
  try {
    const code = await provider.getCode(addr);
    report.push('Code size: ' + ((code.length - 2) / 2) + ' bytes');
  } catch (e) { report.push('Code size: ERROR - ' + (e.message || '').slice(0, 60)); }

  // Implementation (if proxy)
  try {
    const code = await provider.getCode(addr);
    if (code.length <= 100) {
      // Minimal proxy — extract impl
      const implAddr = '0x' + code.slice(22, 62);
      report.push('Proxy impl: ' + implAddr);
      const implCode = await provider.getCode(implAddr);
      report.push('Impl size: ' + ((implCode.length - 2) / 2) + ' bytes');
    }
  } catch (e) { report.push('Impl check: ERROR - ' + (e.message || '').slice(0, 60)); }

  // timeUntilExecute
  try {
    const data = await provider.call({ to: addr.toLowerCase(), data: '0xd46cd1c9', gas: '0x1C9C380' });
    const timeLeft = Number(BigInt(data.slice(0, 66)));
    report.push('timeUntilExecute: ' + timeLeft + 's' + (timeLeft > 0 ? ' (IN COOLDOWN)' : ' (READY)'));
  } catch (e) { report.push('timeUntilExecute: ERROR - ' + (e.message || '').slice(0, 60)); }

  // _locked slot (slot 0 for most reactors)
  try {
    const slot0 = await provider.getStorage(addr, 0);
    report.push('Storage slot 0: ' + slot0);
  } catch (e) { report.push('Storage slot 0: ERROR - ' + (e.message || '').slice(0, 60)); }

  // Native token balance
  try {
    // Read token() from reactor
    const tokenData = await provider.call({ to: addr.toLowerCase(), data: '0xfc0c546a', gas: '0x1C9C380' });
    const tokenAddr = '0x' + tokenData.slice(26, 66);
    report.push('Native token: ' + tokenAddr);

    const tokenContract = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const bal = await tokenContract.balanceOf(addr);
    report.push('Native token balance: ' + ethers.formatEther(bal));

    let sym = 'unknown';
    try { sym = await tokenContract.symbol(); } catch (e) { report.push('Symbol read failed: ' + (e.message || '').slice(0, 40)); }
    report.push('Native token symbol: ' + sym);
  } catch (e) { report.push('Token check: ERROR - ' + (e.message || '').slice(0, 60)); }

  // ETH balance
  try {
    const ethBal = await provider.getBalance(addr);
    report.push('ETH balance: ' + ethers.formatEther(ethBal));
  } catch (e) { report.push('ETH balance: ERROR - ' + (e.message || '').slice(0, 60)); }

  // Pool count and pool states
  try {
    const countData = await provider.call({ to: addr.toLowerCase(), data: '0xf525cb68', gas: '0x1C9C380' });
    const poolCount = Number(BigInt(countData.slice(0, 66)));
    report.push('Pool count: ' + poolCount);

    for (let i = 0; i < poolCount && i < 15; i++) {
      try {
        const idx = ethers.zeroPadValue(ethers.toBeHex(i), 32).slice(2);
        const data = await provider.call({ to: addr.toLowerCase(), data: '0xac4afa38' + idx, gas: '0x1C9C380' });
        if (data.length >= 194) {
          const tokenId = BigInt('0x' + data.slice(2, 66));
          const xToken = '0x' + data.slice(90, 130);

          // Check if position still exists
          const npm = new ethers.Contract(NPM_ADDR, NPM_POS_ABI, provider);
          try {
            const pos = await npm.positions(tokenId);
            const liquidity = pos[7];
            report.push('  Pool ' + i + ': NFT#' + tokenId + ' xToken=' + xToken.slice(0, 10) + '... liq=' + liquidity.toString());
          } catch (e) {
            report.push('  Pool ' + i + ': NFT#' + tokenId + ' xToken=' + xToken.slice(0, 10) + '... POSITION READ FAILED');
          }
        }
      } catch (e) {
        report.push('  Pool ' + i + ': read failed - ' + (e.message || '').slice(0, 40));
      }
    }
  } catch (e) { report.push('Pool count: ERROR - ' + (e.message || '').slice(0, 60)); }

  // Simulate execute with detailed error
  try {
    await provider.call({ to: addr.toLowerCase(), data: '0x61461954', gas: '0x1C9C380' });
    report.push('execute() staticcall NOW: SUCCESS (transient failure?)');
  } catch (e) {
    const msg = e.data || e.message || 'unknown';
    report.push('execute() staticcall NOW: STILL FAILING');
    report.push('Error data: ' + String(msg).slice(0, 200));
  }

  report.push('');
  report.push('--- END REPORT ---');
  return report.join('\n');
}

function saveReport(name, reportText) {
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const filename = datestamp() + '_' + name.replace(/\s+/g, '-') + '.txt';
  const filepath = path.join(REPORT_DIR, filename);
  fs.writeFileSync(filepath, reportText);
  return filepath;
}

async function fireReactor(contract, name, wallet) {
  try {
    await rpcRetry(() => contract.execute.staticCall({ gasLimit: 8_000_000 }), name + ' staticCall');
  } catch (e) {
    const reason = e.reason || (e.message || '').slice(0, 200);
    return { status: 'sim_fail', reason };
  }

  const tx = await contract.execute({ gasLimit: 8_000_000 });
  const receipt = await tx.wait();
  return { status: 'ok', gas: receipt.gasUsed.toString(), hash: tx.hash };
}

async function runPass(provider, wallet) {
  const bal = await provider.getBalance(wallet.address);

  // Discover launched tokens from Supabase
  const launched = await fetchLaunchedReactors();
  const callLine = buildCallLine(launched);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('[' + ts() + '] HEARTBEAT — ' + new Date().toISOString().slice(0, 10));
  console.log('[' + ts() + '] Wallet: ' + wallet.address + ' | ETH: ' + ethers.formatEther(bal));
  console.log('[' + ts() + '] Core: ' + CORE_LINE.length + ' | Launched: ' + launched.length + ' | Total: ' + callLine.length + ' (' + BROKEN.size + ' broken, skipped)');
  if (launched.length > 0) {
    console.log('[' + ts() + '] Launched tokens: ' + launched.map(r => r.name).join(', '));
  }

  await refreshPrices(provider);
  console.log('[' + ts() + '] ETH=$' + Math.round(_ethPrice) + ' BTC=$' + Math.round(_btcPrice));
  console.log('═══════════════════════════════════════════════════════════');

  let fired = 0, skipped = 0, failed = 0, reports = [];

  for (let i = 0; i < callLine.length; i++) {
    const r = callLine[i];
    const num = String(i + 1).padStart(2, ' ');

    // Skip known broken reactors
    if (BROKEN.has(r.addr)) {
      console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' BROKEN (clone reentrancy) — skipped');
      skipped++;
      continue;
    }

    const abi = r.abi === 'spore' ? ABI_SPORE : ABI_CHAIN;
    const contract = new ethers.Contract(r.addr, abi, wallet);

    // Pace RPC calls to avoid rate limiting on public endpoint
    if (i > 0) await sleep(INTER_REACTOR_DELAY);

    // Check cooldown (with rate-limit retry)
    try {
      const remaining = await rpcRetry(() => contract.timeUntilExecute(), r.name + ' cooldown');
      if (remaining > 0n) {
        console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' COOLDOWN ' + Number(remaining) + 's (' + Math.round(Number(remaining) / 60) + 'min)');
        skipped++;
        continue;
      }
    } catch (e) {
      console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' cooldown check failed: ' + (e.message || '').slice(0, 40));
    }

    // Fee gate (with rate-limit retry)
    let feesUsd = -1;
    try {
      feesUsd = await rpcRetry(() => checkFees(r.addr, provider), r.name + ' fees');
      if (feesUsd < FEE_GATE_MIN_USD) {
        console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' FEES $' + feesUsd.toFixed(4) + ' < $' + FEE_GATE_MIN_USD.toFixed(2) + ' — skipping');
        skipped++;
        continue;
      }
      console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' FEES $' + feesUsd.toFixed(4) + ' — firing...');
    } catch (e) {
      console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' fee check failed: ' + (e.message || '').slice(0, 60) + ' — firing anyway');
    }

    // Fire with retries — investigate on final failure
    let didFire = false;
    let lastReason = '';
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const result = await fireReactor(contract, r.name, wallet);

        if (result.status === 'sim_fail') {
          lastReason = result.reason;
          if (attempt < MAX_RETRIES) {
            console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' REVERT (' + attempt + '/' + MAX_RETRIES + '): ' + lastReason.slice(0, 80));
            await sleep(RETRY_DELAY);
            continue;
          }
          // Final attempt failed — investigate
          console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' FAILED after ' + MAX_RETRIES + ' retries — investigating...');
          const report = await investigate(r.name, r.addr, lastReason, provider);
          const reportPath = saveReport(r.name, report);
          console.log('[' + ts() + ']     Report saved: ' + reportPath);
          reports.push({ name: r.name, path: reportPath });
          failed++;
          break;
        }

        console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' FIRED gas=' + result.gas + ' tx=' + result.hash.slice(0, 14) + '...');
        fired++;
        didFire = true;
        break;

      } catch (e) {
        lastReason = (e.reason || e.message || '').slice(0, 200);
        if (attempt < MAX_RETRIES) {
          console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' FAIL (' + attempt + '/' + MAX_RETRIES + '): ' + lastReason.slice(0, 80));
          await sleep(RETRY_DELAY);
        } else {
          console.log('[' + ts() + '] ' + num + '. ' + r.name.padEnd(14) + ' FAILED after ' + MAX_RETRIES + ' attempts — investigating...');
          const report = await investigate(r.name, r.addr, lastReason, provider);
          const reportPath = saveReport(r.name, report);
          console.log('[' + ts() + ']     Report saved: ' + reportPath);
          reports.push({ name: r.name, path: reportPath });
          failed++;
        }
      }
    }

    // Wait 1 min after fire for fees to settle upstream
    if (didFire && i < callLine.length - 1) {
      await sleep(POST_FIRE_DELAY);
    }
  }

  const balAfter = await provider.getBalance(wallet.address);
  console.log('');
  console.log('───────────────────────────────────────────────────────────');
  console.log('[' + ts() + '] PASS COMPLETE');
  console.log('[' + ts() + '] Fired: ' + fired + ' | Skipped: ' + skipped + ' | Failed: ' + failed);
  console.log('[' + ts() + '] ETH spent: ' + ethers.formatEther(bal - balAfter) + ' | Remaining: ' + ethers.formatEther(balAfter));
  if (reports.length > 0) {
    console.log('[' + ts() + '] FAILURE REPORTS:');
    for (const r of reports) {
      console.log('           ' + r.name + ' → ' + r.path);
    }
  }
  console.log('───────────────────────────────────────────────────────────');

  return { fired, skipped, failed, reports };
}

async function main() {
  if (!PK) { console.error('Set AGENT_PRIVATE_KEY or KEEPER_PRIVATE_KEY in env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const once = process.argv.includes('--once');

  if (once) {
    await runPass(provider, wallet);
    return;
  }

  console.log('[' + ts() + '] Reactor Heartbeat starting — 2hr loop, $' + FEE_GATE_MIN_USD.toFixed(2) + ' fee gate');
  console.log('[' + ts() + '] Core reactors: ' + CORE_LINE.length + ' | Auto-discovers launched tokens from Supabase');
  console.log('[' + ts() + '] Reports saved to: ' + REPORT_DIR);

  while (true) {
    try {
      await runPass(provider, wallet);
    } catch (e) {
      console.error('[' + ts() + '] PASS ERROR: ' + (e.message || '').slice(0, 200));
    }

    console.log('[' + ts() + '] Next heartbeat in 2 hours...');
    await sleep(LOOP_INTERVAL);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
