/**
 * Deploy AZUSD ChainReactorV3 (MEV Protected)
 *
 * Usage:
 *   node tools/deploy-azusd-reactor-v3.js deploy    — deploy the contract
 *   node tools/deploy-azusd-reactor-v3.js verify    — verify deployed address
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = 'https://base.publicnode.com';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

// Constructor args — same as V2
const TOKEN         = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2'; // AZUSD
const MFT           = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const PM            = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const ROUTER        = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FACTORY       = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const REACTOR_PRIME = '0xc858026Ec5D30280137032BC6EA86F46ea23C2CA'; // BURGERS reactor

async function main() {
  if (!PK) { console.error('No AGENT_PRIVATE_KEY'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const cmd = process.argv[2] || 'deploy';

  console.log('Wallet:', wallet.address);
  const balance = await provider.getBalance(wallet.address);
  console.log('ETH balance:', ethers.formatEther(balance));

  if (cmd === 'deploy') {
    const abiPath = path.join(__dirname, '..', 'build', 'ChainReactorV3_sol_ChainReactorV3.abi');
    const binPath = path.join(__dirname, '..', 'build', 'ChainReactorV3_sol_ChainReactorV3.bin');

    const abi = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    const bytecode = '0x' + fs.readFileSync(binPath, 'utf8').trim();

    console.log('\nDeploying ChainReactorV3 (MEV Protected)...');
    console.log('  token (AZUSD):', TOKEN);
    console.log('  mft:          ', MFT);
    console.log('  pm:           ', PM);
    console.log('  router:       ', ROUTER);
    console.log('  factory:      ', FACTORY);
    console.log('  reactorPrime: ', REACTOR_PRIME);

    const factory = new ethers.ContractFactory(abi, bytecode, wallet);
    const contract = await factory.deploy(TOKEN, MFT, PM, ROUTER, FACTORY, REACTOR_PRIME);
    console.log('\nTx:', contract.deploymentTransaction().hash);
    console.log('Waiting for confirmation...');

    await contract.waitForDeployment();
    const addr = await contract.getAddress();

    console.log('\n========================================');
    console.log('AZUSD CHAIN REACTOR V3 DEPLOYED');
    console.log('Address:', addr);
    console.log('Admin:', wallet.address);
    console.log('MEV Protection: 3% max price impact');
    console.log('MIN_PROCESS: 1000');
    console.log('Fuel: AZUSD -> BURGERS -> MfT Prime');
    console.log('========================================');

    // Save address
    fs.writeFileSync(path.join(__dirname, 'azusd-reactor-v3-address.txt'), addr);
    console.log('\nAddress saved to tools/azusd-reactor-v3-address.txt');
    return;
  }

  if (cmd === 'verify') {
    const addrFile = path.join(__dirname, 'azusd-reactor-v3-address.txt');
    if (!fs.existsSync(addrFile)) { console.log('No address file. Deploy first.'); return; }
    const addr = fs.readFileSync(addrFile, 'utf8').trim();
    console.log('Reactor V3:', addr);

    const abi = [
      'function token() view returns (address)',
      'function mft() view returns (address)',
      'function reactorPrime() view returns (address)',
      'function admin() view returns (address)',
      'function poolCount() view returns (uint256)',
      'function COOLDOWN() view returns (uint256)',
      'function MIN_PROCESS() view returns (uint256)',
      'function MAX_PRICE_IMPACT_BPS() view returns (uint256)',
    ];
    const reactor = new ethers.Contract(addr, abi, provider);

    console.log('token:', await reactor.token());
    console.log('mft:', await reactor.mft());
    console.log('reactorPrime:', await reactor.reactorPrime());
    console.log('admin:', await reactor.admin());
    console.log('poolCount:', (await reactor.poolCount()).toString());
    console.log('COOLDOWN:', (await reactor.COOLDOWN()).toString(), 'seconds');
    console.log('MIN_PROCESS:', (await reactor.MIN_PROCESS()).toString());
    console.log('MAX_PRICE_IMPACT_BPS:', (await reactor.MAX_PRICE_IMPACT_BPS()).toString(), '(3%)');
    return;
  }

  console.log('Commands: deploy, verify');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
