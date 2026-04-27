/**
 * deploy.js — Deploy EARTH + Reactor to Base, link them together.
 * Uses KEEPER_PRIVATE_KEY from Baselings api/.env
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

// V3 addresses on Base (verified from existing keepers)
const V3_PM      = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

// Load compiled artifacts
const EARTH_ART   = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'EARTH.sol', 'EARTH.json')));
const REACTOR_ART = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'Reactor.sol', 'Reactor.json')));

async function main() {
  if (!PRIVATE_KEY) { console.error('No AGENT_PRIVATE_KEY or KEEPER_PRIVATE_KEY found'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  console.log('Deployer:', wallet.address);
  const bal = await provider.getBalance(wallet.address);
  console.log('ETH balance:', ethers.formatEther(bal));
  console.log('');

  // ── Step 1: Deploy EARTH ──────────────────────────────────────────────────
  console.log('=== Step 1: Deploying EARTH token ===');
  const initialSupply = ethers.parseEther('1'); // 1 EARTH
  const earthFactory = new ethers.ContractFactory(EARTH_ART.abi, EARTH_ART.bytecode, wallet);
  const earthContract = await earthFactory.deploy(initialSupply);
  console.log('Tx sent:', earthContract.deploymentTransaction().hash);
  await earthContract.waitForDeployment();
  const earthAddr = await earthContract.getAddress();
  console.log('EARTH deployed:', earthAddr);
  console.log('');

  // ── Step 2: Deploy Reactor ────────────────────────────────────────────────
  console.log('=== Step 2: Deploying Reactor ===');
  console.log('  EARTH:', earthAddr);
  console.log('  PM:', V3_PM);
  console.log('  Router:', V3_ROUTER);
  console.log('  Factory:', V3_FACTORY);
  const reactorFactory = new ethers.ContractFactory(REACTOR_ART.abi, REACTOR_ART.bytecode, wallet);
  const reactorContract = await reactorFactory.deploy(earthAddr, V3_PM, V3_ROUTER, V3_FACTORY);
  console.log('Tx sent:', reactorContract.deploymentTransaction().hash);
  await reactorContract.waitForDeployment();
  const reactorAddr = await reactorContract.getAddress();
  console.log('Reactor deployed:', reactorAddr);
  console.log('');

  // ── Step 3: Link — call setReactor on EARTH ──────────────────────────────
  console.log('=== Step 3: Linking EARTH ↔ Reactor ===');
  const earth = new ethers.Contract(earthAddr, EARTH_ART.abi, wallet);
  const tx = await earth.setReactor(reactorAddr);
  console.log('setReactor tx:', tx.hash);
  await tx.wait();
  console.log('Reactor linked! Deployer renounced.');
  console.log('');

  // ── Summary ───────────────────────────────────────────────────────────────
  const balAfter = await provider.getBalance(wallet.address);
  console.log('════════════════════════════════════════');
  console.log('  EARTH:   ', earthAddr);
  console.log('  Reactor: ', reactorAddr);
  console.log('  Supply:   1 EARTH (held by', wallet.address + ')');
  console.log('  Gas used: ', ethers.formatEther(bal - balAfter), 'ETH');
  console.log('════════════════════════════════════════');
  console.log('');
  console.log('Next: Create EARTH/WETH V3 pool at 1% fee, add LP, then run:');
  console.log('  node tools/add-pool.js <positionTokenId>');

  // Save addresses for other scripts
  const envContent = `KEEPER_PRIVATE_KEY=${PRIVATE_KEY}\nEARTH_TOKEN=${earthAddr}\nEARTH_REACTOR=${reactorAddr}\n`;
  fs.writeFileSync(path.join(__dirname, '.env'), envContent);
  console.log('');
  console.log('Addresses saved to tools/.env');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
