/**
 * build-prime-pages.js — Generates HTML deploy pages for Reactor Prime V1
 */
const fs = require('fs');
const path = require('path');

const ART = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'MfTReactor.sol', 'ReactorPrime.json')));

const BASE_CHAIN_ID = '0x2105'; // 8453
const MFT       = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const V3_PM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY= '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

const deployDir = path.join(__dirname, '..', 'deploy-prime');
if (!fs.existsSync(deployDir)) fs.mkdirSync(deployDir);

const STYLE = `
  body { font-family: monospace; background: #111; color: #0f0; padding: 2em; max-width: 800px; margin: 0 auto; }
  h1 { color: #0f0; }
  button { font-size: 1.2em; padding: 0.5em 1.5em; background: #0a0; color: #000; border: none; cursor: pointer; margin: 0.5em 0.5em 0.5em 0; }
  button:hover { background: #0f0; }
  input, select { font-family: monospace; font-size: 1em; padding: 0.4em; background: #222; color: #0f0; border: 1px solid #0f0; width: 100%; box-sizing: border-box; }
  label { display: block; margin-top: 1em; color: #0a0; }
  #log { white-space: pre-wrap; margin-top: 1em; padding: 1em; background: #0a0a0a; border: 1px solid #333; min-height: 200px; overflow-y: auto; }
  .warn { color: #ff0; }
  .ok { color: #0f0; }
  .err { color: #f44; }
`;

// ============================================================================
//  Page 1: Deploy Reactor Prime
// ============================================================================
const page1 = `<!DOCTYPE html>
<html><head><title>1 - Deploy Reactor Prime V1</title>
<style>${STYLE}</style>
</head><body>
<h1>Reactor Prime V1 — Deploy</h1>
<p>Deploys the MfT Reactor Prime. Burns MfT, deepens LP, accepts fuel from secondary reactors.</p>
<p class="warn">Constructor args are pre-filled for Base. Only change if you know what you're doing.</p>

<label>MfT Token:</label>
<input id="token" value="${MFT}" />
<label>V3 Position Manager:</label>
<input id="pm" value="${V3_PM}" />
<label>V3 SwapRouter02:</label>
<input id="router" value="${V3_ROUTER}" />
<label>V3 Factory:</label>
<input id="factory" value="${V3_FACTORY}" />
<br><br>
<button onclick="deploy()">Deploy Reactor Prime</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const ABI = ${JSON.stringify(ART.abi)};
const BYTECODE = "${ART.bytecode}";
const CHAIN_ID = "${BASE_CHAIN_ID}";

const log = document.getElementById('log');
function l(msg, cls) {
  const span = document.createElement('span');
  span.className = cls || '';
  span.textContent = msg + '\\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function deploy() {
  try {
    log.textContent = '';
    if (!window.ethereum) { l('No wallet found', 'err'); return; }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if ('0x' + net.chainId.toString(16) !== CHAIN_ID) {
      l('Switch to Base (chain 8453)', 'err'); return;
    }
    const signer = await provider.getSigner();
    l('Deployer: ' + await signer.getAddress());

    const token   = document.getElementById('token').value.trim();
    const pm      = document.getElementById('pm').value.trim();
    const router  = document.getElementById('router').value.trim();
    const factory = document.getElementById('factory').value.trim();

    l('');
    l('Constructor args:');
    l('  token:   ' + token);
    l('  pm:      ' + pm);
    l('  router:  ' + router);
    l('  factory: ' + factory);
    l('');

    l('Deploying Reactor Prime V1...');
    const f = new ethers.ContractFactory(ABI, BYTECODE, signer);
    const contract = await f.deploy(token, pm, router, factory);
    l('Tx sent: ' + contract.deploymentTransaction().hash);
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    l('');
    l('=== REACTOR PRIME DEPLOYED ===', 'ok');
    l('Address: ' + addr, 'ok');
    l('');
    l('SAVE THIS ADDRESS for pages 2 and 3.');
    l('Admin: ' + await signer.getAddress());
    l('');
    l('Next: Create V3 positions on Uniswap (MfT/WETH, MfT/USDC, etc.)');
    l('      Then use page 2 to register each position.');
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}
</script></body></html>`;

// ============================================================================
//  Page 2: Add Pool (transfer NFT + register)
// ============================================================================
const page2 = `<!DOCTYPE html>
<html><head><title>2 - Add Pool to Reactor Prime</title>
<style>${STYLE}</style>
</head><body>
<h1>Reactor Prime V1 — Add Pool</h1>
<p>Transfers a V3 position NFT to the Reactor (PERMANENTLY), then registers it.</p>
<p class="warn">WARNING: This is irreversible. The LP position is locked forever.</p>

<label>Reactor Prime Address:</label>
<input id="reactorAddr" placeholder="0x..." />
<label>V3 Position Token ID:</label>
<input id="tokenId" placeholder="e.g. 5012345" />
<br><br>
<button onclick="addPool()">Transfer NFT + Register Pool</button>
<button onclick="checkPool()">Check Position Info</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const REACTOR_ABI = ${JSON.stringify(ART.abi)};
const CHAIN_ID = "${BASE_CHAIN_ID}";
const PM = "${V3_PM}";
const MFT = "${MFT}";

const PM_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)"
];

const ERC20_ABI = ["function symbol() view returns (string)"];

const log = document.getElementById('log');
function l(msg, cls) {
  const span = document.createElement('span');
  span.className = cls || '';
  span.textContent = msg + '\\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function getCtx() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  if ('0x' + net.chainId.toString(16) !== CHAIN_ID) throw new Error('Switch to Base');
  const signer = await provider.getSigner();
  return { provider, signer };
}

async function checkPool() {
  try {
    log.textContent = '';
    const { provider } = await getCtx();
    const tokenId = document.getElementById('tokenId').value.trim();
    if (!tokenId) { l('Enter token ID', 'err'); return; }

    const pmC = new ethers.Contract(PM, PM_ABI, provider);
    const pos = await pmC.positions(tokenId);
    const token0 = pos[2], token1 = pos[3], fee = pos[4];

    let sym0 = token0, sym1 = token1;
    try { sym0 = await new ethers.Contract(token0, ERC20_ABI, provider).symbol(); } catch(_){}
    try { sym1 = await new ethers.Contract(token1, ERC20_ABI, provider).symbol(); } catch(_){}

    const owner = await pmC.ownerOf(tokenId);
    const hasMft = token0.toLowerCase() === MFT.toLowerCase() || token1.toLowerCase() === MFT.toLowerCase();

    l('Position #' + tokenId);
    l('  Pair:    ' + sym0 + ' / ' + sym1);
    l('  token0:  ' + token0);
    l('  token1:  ' + token1);
    l('  Fee:     ' + fee.toString() + ' (' + (Number(fee) / 10000) + '%)');
    l('  Owner:   ' + owner);
    l('  Has MfT: ' + (hasMft ? 'YES' : 'NO'), hasMft ? 'ok' : 'err');
    if (!hasMft) l('  This position does not contain MfT — cannot add to Reactor Prime', 'err');
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}

async function addPool() {
  try {
    log.textContent = '';
    const { signer } = await getCtx();
    const me = await signer.getAddress();
    l('Wallet: ' + me);

    const reactorAddr = document.getElementById('reactorAddr').value.trim();
    const tokenId = document.getElementById('tokenId').value.trim();
    if (!reactorAddr || !tokenId) { l('Fill both fields', 'err'); return; }

    const pmC = new ethers.Contract(PM, PM_ABI, signer);

    // Check ownership
    const owner = await pmC.ownerOf(tokenId);
    if (owner.toLowerCase() !== me.toLowerCase()) {
      l('You do not own position #' + tokenId + ' (owner: ' + owner + ')', 'err');
      return;
    }

    // Check it has MfT
    const pos = await pmC.positions(tokenId);
    const hasMft = pos[2].toLowerCase() === MFT.toLowerCase() || pos[3].toLowerCase() === MFT.toLowerCase();
    if (!hasMft) { l('Position does not contain MfT', 'err'); return; }

    l('');
    l('PERMANENT: Transferring position NFT to Reactor.', 'warn');
    l('LP is locked forever. No way to retrieve it.', 'warn');
    l('');

    // Transfer NFT
    l('Transferring NFT #' + tokenId + '...');
    const tx1 = await pmC.safeTransferFrom(me, reactorAddr, tokenId);
    l('Tx: ' + tx1.hash);
    await tx1.wait();
    l('NFT transferred!', 'ok');

    // Register pool
    l('Registering pool...');
    const reactor = new ethers.Contract(reactorAddr, REACTOR_ABI, signer);
    const tx2 = await reactor.addPool(tokenId);
    l('Tx: ' + tx2.hash);
    await tx2.wait();
    l('');
    l('=== POOL REGISTERED ===', 'ok');
    l('Position #' + tokenId + ' is now managed by Reactor Prime.');
    l('');

    // Show pool count
    const count = await reactor.poolCount();
    l('Total pools in reactor: ' + count.toString());
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}
</script></body></html>`;

// ============================================================================
//  Page 3: Status / Execute / Fuel
// ============================================================================
const page3 = `<!DOCTYPE html>
<html><head><title>3 - Reactor Prime Control</title>
<style>${STYLE}</style>
</head><body>
<h1>Reactor Prime V1 — Control</h1>

<label>Reactor Prime Address:</label>
<input id="reactorAddr" placeholder="0x..." />
<br><br>
<button onclick="checkStatus()">Status</button>
<button onclick="execute()">Execute</button>
<br>
<h3>Manual Fuel</h3>
<label>xToken Address (WETH, USDC, etc.):</label>
<input id="fuelToken" placeholder="0x..." />
<label>Amount (in wei):</label>
<input id="fuelAmount" placeholder="e.g. 1000000" />
<button onclick="doFuel()">Fuel</button>
<button onclick="checkCanFuel()">Can Fuel?</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const REACTOR_ABI = ${JSON.stringify(ART.abi)};
const CHAIN_ID = "${BASE_CHAIN_ID}";

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)"
];

const log = document.getElementById('log');
function l(msg, cls) {
  const span = document.createElement('span');
  span.className = cls || '';
  span.textContent = msg + '\\n';
  log.appendChild(span);
  log.scrollTop = log.scrollHeight;
}

async function getCtx() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  if ('0x' + net.chainId.toString(16) !== CHAIN_ID) throw new Error('Switch to Base');
  const signer = await provider.getSigner();
  const addr = document.getElementById('reactorAddr').value.trim();
  if (!addr) throw new Error('Enter Reactor address');
  const reactor = new ethers.Contract(addr, REACTOR_ABI, signer);
  return { provider, signer, reactor, addr };
}

async function checkStatus() {
  try {
    log.textContent = '';
    const { reactor, provider } = await getCtx();
    const token = await reactor.token();
    const poolCount = await reactor.poolCount();
    const admin = await reactor.admin();
    const lastExec = await reactor.lastExecute();
    const cooldown = await reactor.COOLDOWN();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nextExec = lastExec + cooldown;
    const ready = now >= nextExec;

    l('=== REACTOR PRIME STATUS ===', 'ok');
    l('MfT Token:    ' + token);
    l('Admin:        ' + admin);
    l('Pools:        ' + poolCount.toString());
    l('Last Execute: ' + (lastExec > 0n ? new Date(Number(lastExec) * 1000).toISOString() : 'never'));
    l('Ready:        ' + (ready ? 'YES — can execute now' : 'No — wait ' + ((Number(nextExec) - Number(now)) / 60).toFixed(1) + ' min'), ready ? 'ok' : 'warn');
    l('');

    for (let i = 0; i < Number(poolCount); i++) {
      const pool = await reactor.pools(i);
      let sym = pool[1];
      try { sym = await new ethers.Contract(pool[1], ERC20_ABI, provider).symbol(); } catch(_){}
      l('Pool ' + i + ': MfT/' + sym + ' (fee ' + pool[2].toString() + ', NFT #' + pool[0].toString() + ')');
    }
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}

async function execute() {
  try {
    log.textContent = '';
    const { reactor } = await getCtx();
    l('Calling execute()...');
    const tx = await reactor.execute({ gasLimit: 4000000 });
    l('Tx: ' + tx.hash);
    const receipt = await tx.wait();
    l('Confirmed! Gas: ' + receipt.gasUsed.toString(), 'ok');

    for (const evLog of receipt.logs) {
      try {
        const parsed = reactor.interface.parseLog(evLog);
        if (parsed && parsed.name === 'Executed') {
          l('');
          l('Burned:    ' + ethers.formatEther(parsed.args.burned) + ' MfT');
          l('Deposited: ' + ethers.formatEther(parsed.args.deposited) + ' MfT as LP');
        }
        if (parsed && parsed.name === 'PoolSkipped') {
          l('Pool ' + parsed.args.poolIndex.toString() + ' skipped (no fees or error)', 'warn');
        }
      } catch(_) {}
    }
    l('');
    l('Cycle complete.', 'ok');
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}

async function checkCanFuel() {
  try {
    log.textContent = '';
    const { reactor, provider } = await getCtx();
    const xToken = document.getElementById('fuelToken').value.trim();
    if (!xToken) { l('Enter xToken address', 'err'); return; }

    let sym = xToken;
    try { sym = await new ethers.Contract(xToken, ERC20_ABI, provider).symbol(); } catch(_){}

    const can = await reactor.canFuel(xToken);
    l(sym + ': ' + (can ? 'YES — matching pool exists' : 'NO — no MfT/' + sym + ' pool in reactor'), can ? 'ok' : 'err');
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}

async function doFuel() {
  try {
    log.textContent = '';
    const { reactor, signer, addr } = await getCtx();
    const xToken = document.getElementById('fuelToken').value.trim();
    const amount = document.getElementById('fuelAmount').value.trim();
    if (!xToken || !amount) { l('Fill token and amount', 'err'); return; }

    // Check canFuel
    const can = await reactor.canFuel(xToken);
    if (!can) { l('No matching pool for this token', 'err'); return; }

    // Approve
    const erc20 = new ethers.Contract(xToken, ERC20_ABI, signer);
    let sym = xToken;
    try { sym = await erc20.symbol(); } catch(_){}

    l('Approving ' + amount + ' ' + sym + '...');
    const appTx = await erc20.approve(addr, amount);
    await appTx.wait();
    l('Approved.', 'ok');

    // Fuel
    l('Calling fuel(' + sym + ', ' + amount + ')...');
    const tx = await reactor.fuel(xToken, amount, { gasLimit: 1000000 });
    l('Tx: ' + tx.hash);
    const receipt = await tx.wait();
    l('Confirmed! Gas: ' + receipt.gasUsed.toString(), 'ok');

    for (const evLog of receipt.logs) {
      try {
        const parsed = reactor.interface.parseLog(evLog);
        if (parsed && parsed.name === 'Fueled') {
          l('');
          l('Pool:         ' + parsed.args.poolIndex.toString());
          l('xToken in:    ' + parsed.args.xIn.toString());
          l('MfT deposited: ' + parsed.args.mftDeposited.toString());
          l('X deposited:   ' + parsed.args.xDeposited.toString());
        }
      } catch(_) {}
    }
    l('');
    l('Fuel deposited.', 'ok');
  } catch(e) { l('ERROR: ' + e.message, 'err'); }
}
</script></body></html>`;

// ── Write files ──────────────────────────────────────────────────────────
fs.writeFileSync(path.join(deployDir, '1-deploy-reactor-prime.html'), page1);
fs.writeFileSync(path.join(deployDir, '2-add-pool.html'), page2);
fs.writeFileSync(path.join(deployDir, '3-control.html'), page3);

console.log('Reactor Prime deploy pages built:');
console.log('  deploy-prime/1-deploy-reactor-prime.html');
console.log('  deploy-prime/2-add-pool.html');
console.log('  deploy-prime/3-control.html');
console.log('');
console.log('Run: npx serve deploy-prime -l 8888');
