/**
 * Deploy AZUSD ChainReactorV2 + seed MfT/AZUSD LP
 *
 * Steps:
 * 1. Deploy ChainReactorV2 (AZUSD → BURGERS as reactorPrime)
 * 2. Approve MfT + AZUSD for Position Manager
 * 3. Mint V3 MfT/AZUSD LP (1 AZUSD + ~3.5M MfT)
 * 4. Transfer LP NFT to reactor
 * 5. addPool() on reactor
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const path = require('path');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

// Addresses
const AZUSD   = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const MFT     = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const PM      = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const BURGERS_REACTOR = '0xc858026Ec5D30280137032BC6EA86F46ea23C2CA';

// V3 pool params — 1% fee, full range
const FEE = 10000;
const TICK_SPACING = 200;
const TICK_LOWER = -887200; // nearest MIN_TICK divisible by 200
const TICK_UPPER = 887200;

// Amounts: 1 AZUSD + ~3.5M MfT
const AZUSD_AMOUNT = ethers.parseEther('1');       // 1 AZUSD (18 dec)
const MFT_AMOUNT   = ethers.parseEther('3525055'); // ~3.5M MfT

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const NPM_ABI = [
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address,address,uint256)',
];

const REACTOR_ABI = [
  'function addPool(uint256)',
  'function poolCount() view returns (uint256)',
  'function pools(uint256) view returns (uint256 tokenId, address xToken, uint24 fee, bool active)',
  'function admin() view returns (address)',
  'function token() view returns (address)',
  'function reactorPrime() view returns (address)',
];

async function main() {
  if (!PK) { console.error('No AGENT_PRIVATE_KEY found'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log('Wallet:', wallet.address);

  const step = process.argv[2] || 'all';

  // ---- STEP 1: Deploy ----
  if (step === 'all' || step === 'deploy') {
    console.log('\n=== STEP 1: Deploy ChainReactorV2 (AZUSD) ===');
    const artifact = require(path.join(__dirname, '..', 'artifacts', 'contracts', 'ChainReactorV2.sol', 'ChainReactorV2.json'));

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
    console.log('Constructor args:');
    console.log('  token:        ', AZUSD, '(AZUSD)');
    console.log('  mft:          ', MFT);
    console.log('  pm:           ', PM);
    console.log('  router:       ', ROUTER);
    console.log('  factory:      ', FACTORY);
    console.log('  reactorPrime: ', BURGERS_REACTOR, '(BURGERS)');

    const gasEst = await provider.estimateGas({
      data: factory.getDeployTransaction(AZUSD, MFT, PM, ROUTER, FACTORY, BURGERS_REACTOR).data
    });
    const feeData = await provider.getFeeData();
    const gasCost = gasEst * feeData.gasPrice;
    console.log('Estimated gas:', gasEst.toString(), '(~' + ethers.formatEther(gasCost) + ' ETH)');

    const contract = await factory.deploy(AZUSD, MFT, PM, ROUTER, FACTORY, BURGERS_REACTOR);
    console.log('Tx:', contract.deploymentTransaction().hash);
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    console.log('AZUSD Reactor deployed:', addr);

    // Verify
    const reactor = new ethers.Contract(addr, REACTOR_ABI, provider);
    const [admin, token, prime] = await Promise.all([reactor.admin(), reactor.token(), reactor.reactorPrime()]);
    console.log('  admin:', admin);
    console.log('  token:', token);
    console.log('  reactorPrime:', prime);

    // Save address for next steps
    require('fs').writeFileSync(path.join(__dirname, 'azusd-reactor-address.txt'), addr);
    console.log('Address saved to tools/azusd-reactor-address.txt');
    if (step === 'deploy') return;
  }

  // Read reactor address
  let reactorAddr;
  try {
    reactorAddr = require('fs').readFileSync(path.join(__dirname, 'azusd-reactor-address.txt'), 'utf8').trim();
  } catch {
    console.error('No reactor address found. Run with "deploy" first.');
    return;
  }
  console.log('\nUsing reactor:', reactorAddr);

  // ---- STEP 2: Approve tokens ----
  if (step === 'all' || step === 'approve') {
    console.log('\n=== STEP 2: Approve MfT + AZUSD for Position Manager ===');
    const mft = new ethers.Contract(MFT, ERC20_ABI, wallet);
    const azusd = new ethers.Contract(AZUSD, ERC20_ABI, wallet);

    const mftAllowance = await mft.allowance(wallet.address, PM);
    if (mftAllowance < MFT_AMOUNT) {
      console.log('Approving MfT...');
      const tx = await mft.approve(PM, ethers.MaxUint256);
      await tx.wait();
      console.log('MfT approved:', tx.hash);
    } else {
      console.log('MfT already approved');
    }

    const azusdAllowance = await azusd.allowance(wallet.address, PM);
    if (azusdAllowance < AZUSD_AMOUNT) {
      console.log('Approving AZUSD...');
      const tx = await azusd.approve(PM, ethers.MaxUint256);
      await tx.wait();
      console.log('AZUSD approved:', tx.hash);
    } else {
      console.log('AZUSD already approved');
    }
    if (step === 'approve') return;
  }

  // ---- STEP 3: Mint LP ----
  if (step === 'all' || step === 'mint') {
    console.log('\n=== STEP 3: Mint MfT/AZUSD V3 LP ===');
    // AZUSD (0x3595) < MfT (0x8FB8) so AZUSD=token0, MfT=token1
    const npm = new ethers.Contract(PM, NPM_ABI, wallet);

    const mintParams = {
      token0: AZUSD,
      token1: MFT,
      fee: FEE,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      amount0Desired: AZUSD_AMOUNT,
      amount1Desired: MFT_AMOUNT,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
    };

    console.log('Minting: 1 AZUSD + ~3.5M MfT, fee 10000, full range');
    const tx = await npm.mint(mintParams);
    const receipt = await tx.wait();
    console.log('Tx:', receipt.hash);

    // Extract tokenId from Transfer event (ERC721)
    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const transferLog = receipt.logs.find(l => l.topics[0] === transferTopic && l.address.toLowerCase() === PM.toLowerCase());
    const tokenId = BigInt(transferLog.topics[3]);
    console.log('LP Position NFT:', tokenId.toString());

    require('fs').writeFileSync(path.join(__dirname, 'azusd-lp-tokenid.txt'), tokenId.toString());
    console.log('Token ID saved to tools/azusd-lp-tokenid.txt');
    if (step === 'mint') return;
  }

  // Read token ID
  let tokenId;
  try {
    tokenId = require('fs').readFileSync(path.join(__dirname, 'azusd-lp-tokenid.txt'), 'utf8').trim();
  } catch {
    console.error('No token ID found. Run with "mint" first.');
    return;
  }

  // ---- STEP 4: Transfer LP to reactor ----
  if (step === 'all' || step === 'transfer') {
    console.log('\n=== STEP 4: Transfer LP NFT to reactor ===');
    const npm = new ethers.Contract(PM, NPM_ABI, wallet);
    console.log('Transferring NFT #' + tokenId + ' to ' + reactorAddr);
    const tx = await npm.safeTransferFrom(wallet.address, reactorAddr, tokenId);
    await tx.wait();
    console.log('Transferred:', tx.hash);
    if (step === 'transfer') return;
  }

  // ---- STEP 5: addPool ----
  if (step === 'all' || step === 'addpool') {
    console.log('\n=== STEP 5: addPool() ===');
    const reactor = new ethers.Contract(reactorAddr, REACTOR_ABI, wallet);
    console.log('Calling addPool(' + tokenId + ')...');
    const tx = await reactor.addPool(tokenId);
    await tx.wait();
    console.log('Pool added:', tx.hash);

    const count = await reactor.poolCount();
    console.log('Reactor pool count:', count.toString());
    const pool = await reactor.pools(0);
    console.log('Pool 0:', { tokenId: pool.tokenId.toString(), xToken: pool.xToken, fee: pool.fee, active: pool.active });
  }

  console.log('\n=== DONE ===');
  console.log('AZUSD Reactor:', reactorAddr);
  console.log('Feeds into BURGERS reactor at', BURGERS_REACTOR);
}

main().catch(err => { console.error('ERROR:', err.message || err); process.exit(1); });
