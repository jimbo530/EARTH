require('dotenv').config();
/**
 * deploy-prime.js — Deploy Reactor Prime V1 for MfT on Base
 */
const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Constructor args
const MFT       = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const V3_PM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY= '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('Deployer:', wallet.address);

  const bal = await provider.getBalance(wallet.address);
  console.log('Balance:', ethers.formatEther(bal), 'ETH');
  if (bal === 0n) { console.log('ERROR: No ETH for gas'); return; }

  const artifact = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'artifacts', 'contracts', 'MfTReactor.sol', 'ReactorPrime.json')
  ));

  console.log('');
  console.log('Deploying Reactor Prime V1...');
  console.log('  token:   ', MFT);
  console.log('  pm:      ', V3_PM);
  console.log('  router:  ', V3_ROUTER);
  console.log('  factory: ', V3_FACTORY);
  console.log('');

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy(MFT, V3_PM, V3_ROUTER, V3_FACTORY);
  console.log('Tx sent:', contract.deploymentTransaction().hash);

  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  console.log('');
  console.log('=== REACTOR PRIME V1 DEPLOYED ===');
  console.log('Address:', addr);
  console.log('Admin:  ', wallet.address);
  console.log('Burn to:', '0xfd780B0aE569e15e514B819ecFDF46f804953a4B');
  console.log('');

  const balAfter = await provider.getBalance(wallet.address);
  console.log('Gas cost:', ethers.formatEther(bal - balAfter), 'ETH');
}

main().catch(e => { console.error('DEPLOY FAILED:', e.message); process.exit(1); });
