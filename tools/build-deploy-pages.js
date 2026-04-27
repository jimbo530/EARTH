/**
 * build-deploy-pages.js — Reads compiled artifacts, generates HTML deploy pages
 */
const fs = require('fs');
const path = require('path');

const EARTH_ART = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'EARTH.sol', 'EARTH.json')));
const REACTOR_ART = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'Reactor.sol', 'Reactor.json')));

// ── Base chain addresses (verified from existing keepers) ──────────────────
const BASE_CHAIN_ID = '0x2105'; // 8453
const V3_PM       = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_ROUTER   = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY  = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const WETH        = '0x4200000000000000000000000000000000000006';

const deployDir = path.join(__dirname, '..', 'deploy');

// ============================================================================
//  Page 1: Deploy EARTH token
// ============================================================================
const page1 = `<!DOCTYPE html>
<html><head><title>1 - Deploy EARTH Token</title>
<style>
  body { font-family: monospace; background: #111; color: #0f0; padding: 2em; max-width: 800px; margin: 0 auto; }
  button { font-size: 1.2em; padding: 0.5em 1.5em; background: #0a0; color: #000; border: none; cursor: pointer; margin: 0.5em 0; }
  button:hover { background: #0f0; }
  input { font-family: monospace; font-size: 1em; padding: 0.4em; background: #222; color: #0f0; border: 1px solid #0f0; width: 100%; }
  #log { white-space: pre-wrap; margin-top: 1em; padding: 1em; background: #0a0a0a; border: 1px solid #333; min-height: 200px; }
  .addr { color: #ff0; font-weight: bold; }
</style>
</head><body>
<h1>EARTH Token Deploy</h1>
<p>Deploys EARTH rebase ERC20. Initial supply goes to your wallet.</p>
<label>Initial Supply (whole tokens, e.g. "1" = 1 EARTH):</label><br>
<input id="supply" value="1" /><br><br>
<button onclick="deploy()">Deploy EARTH</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const ABI = ${JSON.stringify(EARTH_ART.abi)};
const BYTECODE = "${EARTH_ART.bytecode}";
const CHAIN_ID = "${BASE_CHAIN_ID}";

const log = document.getElementById('log');
function l(msg) { log.textContent += msg + '\\n'; }

async function deploy() {
  try {
    if (!window.ethereum) { l('ERROR: No wallet found'); return; }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if ('0x' + net.chainId.toString(16) !== CHAIN_ID) {
      l('ERROR: Switch to Base (chain 8453)'); return;
    }
    const signer = await provider.getSigner();
    l('Deployer: ' + await signer.getAddress());

    const supplyWhole = document.getElementById('supply').value;
    const supplyWei = ethers.parseEther(supplyWhole);
    l('Initial supply: ' + supplyWhole + ' EARTH (' + supplyWei.toString() + ' wei)');

    l('Deploying EARTH...');
    const factory = new ethers.ContractFactory(ABI, BYTECODE, signer);
    const contract = await factory.deploy(supplyWei);
    l('Tx sent: ' + contract.deploymentTransaction().hash);
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    l('');
    l('=== EARTH DEPLOYED ===');
    l('Address: ' + addr);
    l('');
    l('SAVE THIS ADDRESS — you need it for Reactor deploy (page 2).');
  } catch(e) { l('ERROR: ' + e.message); }
}
</script></body></html>`;

// ============================================================================
//  Page 2: Deploy Reactor
// ============================================================================
const page2 = `<!DOCTYPE html>
<html><head><title>2 - Deploy Reactor</title>
<style>
  body { font-family: monospace; background: #111; color: #0f0; padding: 2em; max-width: 800px; margin: 0 auto; }
  button { font-size: 1.2em; padding: 0.5em 1.5em; background: #0a0; color: #000; border: none; cursor: pointer; margin: 0.5em 0; }
  button:hover { background: #0f0; }
  input { font-family: monospace; font-size: 1em; padding: 0.4em; background: #222; color: #0f0; border: 1px solid #0f0; width: 100%; }
  #log { white-space: pre-wrap; margin-top: 1em; padding: 1em; background: #0a0a0a; border: 1px solid #333; min-height: 200px; }
</style>
</head><body>
<h1>Reactor Deploy</h1>
<p>Deploys the Reactor, then calls setReactor() on EARTH to lock it in.</p>
<label>EARTH Token Address (from page 1):</label><br>
<input id="earthAddr" placeholder="0x..." /><br><br>
<button onclick="deploy()">Deploy Reactor + Link</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const REACTOR_ABI = ${JSON.stringify(REACTOR_ART.abi)};
const REACTOR_BYTECODE = "${REACTOR_ART.bytecode}";
const EARTH_ABI = ${JSON.stringify(EARTH_ART.abi)};
const CHAIN_ID = "${BASE_CHAIN_ID}";
const PM      = "${V3_PM}";
const ROUTER  = "${V3_ROUTER}";
const FACTORY = "${V3_FACTORY}";

const log = document.getElementById('log');
function l(msg) { log.textContent += msg + '\\n'; }

async function deploy() {
  try {
    if (!window.ethereum) { l('ERROR: No wallet found'); return; }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if ('0x' + net.chainId.toString(16) !== CHAIN_ID) {
      l('ERROR: Switch to Base (chain 8453)'); return;
    }
    const signer = await provider.getSigner();
    l('Deployer: ' + await signer.getAddress());

    const earthAddr = document.getElementById('earthAddr').value.trim();
    if (!earthAddr) { l('ERROR: Enter EARTH address'); return; }

    l('Deploying Reactor...');
    l('  EARTH:   ' + earthAddr);
    l('  PM:      ' + PM);
    l('  Router:  ' + ROUTER);
    l('  Factory: ' + FACTORY);

    const factory = new ethers.ContractFactory(REACTOR_ABI, REACTOR_BYTECODE, signer);
    const reactor = await factory.deploy(earthAddr, PM, ROUTER, FACTORY);
    l('Tx sent: ' + reactor.deploymentTransaction().hash);
    await reactor.waitForDeployment();
    const reactorAddr = await reactor.getAddress();
    l('');
    l('=== REACTOR DEPLOYED: ' + reactorAddr + ' ===');
    l('');

    // Now call setReactor on EARTH
    l('Calling EARTH.setReactor(' + reactorAddr + ')...');
    const earth = new ethers.Contract(earthAddr, EARTH_ABI, signer);
    const tx = await earth.setReactor(reactorAddr);
    l('Tx sent: ' + tx.hash);
    await tx.wait();
    l('setReactor confirmed! Reactor is locked. Deployer renounced.');
    l('');
    l('=== SETUP COMPLETE ===');
    l('EARTH:   ' + earthAddr);
    l('Reactor: ' + reactorAddr);
    l('');
    l('Next: Create a V3 pool on Uniswap, add initial LP, then use page 3 to register it.');
  } catch(e) { l('ERROR: ' + e.message); }
}
</script></body></html>`;

// ============================================================================
//  Page 3: Add Pool (transfer NFT + register)
// ============================================================================
const page3 = `<!DOCTYPE html>
<html><head><title>3 - Add Pool to Reactor</title>
<style>
  body { font-family: monospace; background: #111; color: #0f0; padding: 2em; max-width: 800px; margin: 0 auto; }
  button { font-size: 1.2em; padding: 0.5em 1.5em; background: #0a0; color: #000; border: none; cursor: pointer; margin: 0.5em 0; }
  button:hover { background: #0f0; }
  input { font-family: monospace; font-size: 1em; padding: 0.4em; background: #222; color: #0f0; border: 1px solid #0f0; width: 100%; }
  #log { white-space: pre-wrap; margin-top: 1em; padding: 1em; background: #0a0a0a; border: 1px solid #333; min-height: 200px; }
</style>
</head><body>
<h1>Add Pool to Reactor</h1>
<p>Transfers V3 position NFT to the Reactor (PERMANENTLY), then registers it.
  The pool must be EARTH paired with some X token at 1% fee tier.</p>
<label>Reactor Address:</label><br>
<input id="reactorAddr" placeholder="0x..." /><br><br>
<label>V3 Position Token ID (from Uniswap LP):</label><br>
<input id="tokenId" placeholder="e.g. 123456" /><br><br>
<button onclick="addPool()">Transfer NFT + Register Pool</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const REACTOR_ABI = ${JSON.stringify(REACTOR_ART.abi)};
const CHAIN_ID = "${BASE_CHAIN_ID}";
const PM = "${V3_PM}";

const PM_ABI = [
  "function safeTransferFrom(address from, address to, uint256 tokenId)",
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function positions(uint256 tokenId) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)"
];

const log = document.getElementById('log');
function l(msg) { log.textContent += msg + '\\n'; }

async function addPool() {
  try {
    if (!window.ethereum) { l('ERROR: No wallet found'); return; }
    const provider = new ethers.BrowserProvider(window.ethereum);
    const net = await provider.getNetwork();
    if ('0x' + net.chainId.toString(16) !== CHAIN_ID) {
      l('ERROR: Switch to Base (chain 8453)'); return;
    }
    const signer = await provider.getSigner();
    const me = await signer.getAddress();
    l('Wallet: ' + me);

    const reactorAddr = document.getElementById('reactorAddr').value.trim();
    const tokenId = document.getElementById('tokenId').value.trim();
    if (!reactorAddr || !tokenId) { l('ERROR: Fill both fields'); return; }

    const pmContract = new ethers.Contract(PM, PM_ABI, signer);

    // Check position info
    l('Reading position #' + tokenId + '...');
    const pos = await pmContract.positions(tokenId);
    l('  token0: ' + pos[2]);
    l('  token1: ' + pos[3]);
    l('  fee:    ' + pos[4].toString());
    if (pos[4].toString() !== '10000') {
      l('ERROR: Position must be 1% fee tier (10000), got ' + pos[4].toString());
      return;
    }

    // Check ownership
    const owner = await pmContract.ownerOf(tokenId);
    if (owner.toLowerCase() !== me.toLowerCase()) {
      l('ERROR: You do not own position #' + tokenId + ' (owner: ' + owner + ')');
      return;
    }

    // Transfer NFT to Reactor (PERMANENT — no way to get it back)
    l('');
    l('WARNING: Transferring position NFT to Reactor is PERMANENT.');
    l('The LP is locked forever. Proceeding...');
    l('');
    l('Transferring NFT #' + tokenId + ' to Reactor...');
    const tx1 = await pmContract.safeTransferFrom(me, reactorAddr, tokenId);
    l('Tx sent: ' + tx1.hash);
    await tx1.wait();
    l('NFT transferred!');

    // Register pool in Reactor
    l('Registering pool in Reactor...');
    const reactor = new ethers.Contract(reactorAddr, REACTOR_ABI, signer);
    const tx2 = await reactor.addPool(tokenId);
    l('Tx sent: ' + tx2.hash);
    await tx2.wait();
    l('');
    l('=== POOL REGISTERED ===');
    l('Position #' + tokenId + ' is now managed by Reactor.');
    l('The burn/buyback/LP machine is running for this pair.');
    l('');
    l('Anyone can now call execute() on the Reactor after the 2hr cooldown.');
  } catch(e) { l('ERROR: ' + e.message); }
}
</script></body></html>`;

// ============================================================================
//  Page 4: Execute (trigger the cycle)
// ============================================================================
const page4 = `<!DOCTYPE html>
<html><head><title>4 - Execute Reactor</title>
<style>
  body { font-family: monospace; background: #111; color: #0f0; padding: 2em; max-width: 800px; margin: 0 auto; }
  button { font-size: 1.2em; padding: 0.5em 1.5em; background: #0a0; color: #000; border: none; cursor: pointer; margin: 0.5em 0; }
  button:hover { background: #0f0; }
  input { font-family: monospace; font-size: 1em; padding: 0.4em; background: #222; color: #0f0; border: 1px solid #0f0; width: 100%; }
  #log { white-space: pre-wrap; margin-top: 1em; padding: 1em; background: #0a0a0a; border: 1px solid #333; min-height: 200px; }
  .stat { color: #ff0; }
</style>
</head><body>
<h1>Execute Reactor</h1>
<p>Anyone can call this. Burns EARTH, buys back, deepens LP, rebases holders.</p>
<label>Reactor Address:</label><br>
<input id="reactorAddr" placeholder="0x..." /><br><br>
<button onclick="checkStatus()">Check Status</button>
<button onclick="execute()">Execute</button>
<div id="log">Waiting...</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/ethers/6.13.4/ethers.umd.min.js"></script>
<script>
const REACTOR_ABI = ${JSON.stringify(REACTOR_ART.abi)};
const EARTH_ABI = ${JSON.stringify(EARTH_ART.abi)};
const CHAIN_ID = "${BASE_CHAIN_ID}";

const log = document.getElementById('log');
function l(msg) { log.textContent += msg + '\\n'; }

async function getContracts() {
  const provider = new ethers.BrowserProvider(window.ethereum);
  const net = await provider.getNetwork();
  if ('0x' + net.chainId.toString(16) !== CHAIN_ID) throw new Error('Switch to Base');
  const signer = await provider.getSigner();
  const reactorAddr = document.getElementById('reactorAddr').value.trim();
  if (!reactorAddr) throw new Error('Enter Reactor address');
  const reactor = new ethers.Contract(reactorAddr, REACTOR_ABI, signer);
  const earthAddr = await reactor.earth();
  const earth = new ethers.Contract(earthAddr, EARTH_ABI, provider);
  return { provider, signer, reactor, earth, earthAddr };
}

async function checkStatus() {
  try {
    log.textContent = '';
    const { reactor, earth, earthAddr } = await getContracts();

    const poolCount = await reactor.poolCount();
    const lastExec = await reactor.lastExecute();
    const cooldown = await reactor.COOLDOWN();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nextExec = lastExec + cooldown;
    const ready = now >= nextExec;

    l('EARTH:       ' + earthAddr);
    l('Total Supply: ' + ethers.formatEther(await earth.totalSupply()) + ' EARTH');
    l('Rebase Index: ' + (await earth.rebaseIndex()).toString());
    l('Pools:        ' + poolCount.toString());
    l('Last Execute: ' + (lastExec > 0n ? new Date(Number(lastExec) * 1000).toISOString() : 'never'));
    l('Ready:        ' + (ready ? 'YES' : 'No — wait ' + ((Number(nextExec) - Number(now)) / 60).toFixed(0) + ' min'));
  } catch(e) { l('ERROR: ' + e.message); }
}

async function execute() {
  try {
    log.textContent = '';
    const { reactor, signer } = await getContracts();
    l('Calling execute()...');
    const tx = await reactor.execute();
    l('Tx sent: ' + tx.hash);
    const receipt = await tx.wait();
    l('Confirmed! Gas used: ' + receipt.gasUsed.toString());

    // Parse events
    for (const evLog of receipt.logs) {
      try {
        const parsed = reactor.interface.parseLog(evLog);
        if (parsed && parsed.name === 'Executed') {
          l('');
          l('Burned:  ' + ethers.formatEther(parsed.args.burned) + ' EARTH');
          l('Minted:  ' + ethers.formatEther(parsed.args.minted) + ' EARTH to holders');
          l('Caller:  ' + parsed.args.caller);
        }
      } catch(_) {}
    }
    l('');
    l('Cycle complete.');
  } catch(e) { l('ERROR: ' + e.message); }
}
</script></body></html>`;

// ── Write files ────────────────────────────────────────────────────────────
fs.writeFileSync(path.join(deployDir, '1-deploy-earth.html'), page1);
fs.writeFileSync(path.join(deployDir, '2-deploy-reactor.html'), page2);
fs.writeFileSync(path.join(deployDir, '3-add-pool.html'), page3);
fs.writeFileSync(path.join(deployDir, '4-execute.html'), page4);

console.log('Deploy pages built:');
console.log('  deploy/1-deploy-earth.html');
console.log('  deploy/2-deploy-reactor.html');
console.log('  deploy/3-add-pool.html');
console.log('  deploy/4-execute.html');
console.log('');
console.log('Run: npx serve deploy -l 8888');
