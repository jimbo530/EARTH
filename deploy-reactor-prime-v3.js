const path = require('path');
require(path.join(__dirname, '..', 'Baselings', 'api', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', 'Baselings', 'api', '.env') });
const { ethers } = require(path.join(__dirname, '..', 'Baselings', 'api', 'node_modules', 'ethers'));
const fs = require('fs');

const BUILD_DIR = path.join(__dirname, 'contracts', 'prime-v3-build');
const PREFIX = 'Documents_EARTH_contracts_ReactorPrimeV3_sol_ReactorPrimeV3';

const ABI = JSON.parse(fs.readFileSync(path.join(BUILD_DIR, PREFIX + '.abi'), 'utf8'));
const BYTECODE = '0x' + fs.readFileSync(path.join(BUILD_DIR, PREFIX + '.bin'), 'utf8').trim();

// Constructor args — Base mainnet
const MFT_TOKEN        = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const POSITION_MANAGER = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const SWAP_ROUTER      = '0x2626664c2603336E57B271c5C0b26F421741e481';
const V3_FACTORY       = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

async function main() {
  const RPC = process.env.ALCHEMY_RPC || 'https://mainnet.base.org';
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  console.log('Deployer:', wallet.address);

  const bal = await provider.getBalance(wallet.address);
  console.log('ETH balance:', ethers.formatEther(bal));

  if (bal < ethers.parseEther('0.0005')) {
    console.log('ERROR: Need at least 0.0005 ETH for deploy');
    process.exit(1);
  }

  console.log('\n--- Deploying ReactorPrimeV3 (MfT Terminal Reactor) ---');
  console.log('MfT Token:', MFT_TOKEN);
  console.log('Position Manager:', POSITION_MANAGER);
  console.log('Swap Router:', SWAP_ROUTER);
  console.log('V3 Factory:', V3_FACTORY);
  console.log('Bytecode size:', (BYTECODE.length - 2) / 2, 'bytes');

  const factory = new ethers.ContractFactory(ABI, BYTECODE, wallet);

  // Constructor: (address _token, address _pm, address _router, address _factory)
  const contract = await factory.deploy(MFT_TOKEN, POSITION_MANAGER, SWAP_ROUTER, V3_FACTORY);
  console.log('Deploy TX:', contract.deploymentTransaction().hash);
  console.log('Waiting for confirmation...');

  await contract.waitForDeployment();
  const addr = await contract.getAddress();

  console.log('\n========================================');
  console.log('ReactorPrimeV3 DEPLOYED:', addr);
  console.log('========================================');
  console.log('Admin:', wallet.address);
  console.log('BaseScan: https://basescan.org/address/' + addr);

  // Verify on-chain state
  const rc = new ethers.Contract(addr, ABI, provider);
  console.log('\n--- On-chain verification ---');
  console.log('admin():', await rc.admin());
  console.log('token():', await rc.token());
  console.log('poolCount():', (await rc.poolCount()).toString());
  console.log('paused():', await rc.paused());
  console.log('COOLDOWN:', (await rc.COOLDOWN()).toString(), 'seconds');
  console.log('MAX_POOLS:', (await rc.MAX_POOLS()).toString());
  console.log('MIN_FUEL:', (await rc.MIN_FUEL()).toString());
  console.log('MIN_PROCESS:', (await rc.MIN_PROCESS()).toString());
  console.log('MAX_PRICE_IMPACT_BPS:', (await rc.MAX_PRICE_IMPACT_BPS()).toString());
}

main().catch(e => { console.error('FATAL:', e.message || e); process.exit(1); });
