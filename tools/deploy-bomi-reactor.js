/**
 * Deploy BOMI ChainReactorV2 + seed BOMI/USDC LP
 *
 * Steps:
 * 1. Deploy ChainReactorV2 (BOMI → BURGERS as fuelTarget)
 * 2. Create BOMI/USDC V3 pool (1% fee) at $0.40/BOMI
 * 3. Approve BOMI + USDC for Position Manager
 * 4. Mint LP: 2.5 BOMI + 1 USDC
 * 5. Transfer LP NFT to reactor
 * 6. addPool() on reactor
 *
 * Token ordering: BOMI (0x46D8) < USDC (0x8335) → BOMI=token0, USDC=token1
 * Price: $0.40 per BOMI, BOMI 18 dec, USDC 6 dec
 *   price = 0.40 * 10^(6-18) = 0.40 * 10^-12 = 4e-13
 *   sqrtPriceX96 = sqrt(4e-13) * 2^96
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const BOMI    = '0x46D8f8Ba030c1D09ae17d2B5107dfef4B331fe0d';
const USDC    = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const MFT     = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const PM      = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const BURGERS_REACTOR = '0xc858026Ec5D30280137032BC6EA86F46ea23C2CA';

const FEE = 10000;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

// BOMI=token0 (18 dec), USDC=token1 (6 dec)
// price = 0.40 * 10^-12 = 4e-13
// sqrtPrice = sqrt(4e-13) = 2e-6.5 = 6.324555e-7
// sqrtPriceX96 = 6.324555e-7 * 2^96
const SQRT_PRICE_X96 = (() => {
  const Q96 = 2n ** 96n;
  const factor = 1000000000000000n; // 1e15
  const sqrtPrice = Math.sqrt(0.40 * 1e-12); // 6.324555e-7
  const sqrtScaled = BigInt(Math.round(sqrtPrice * Number(factor)));
  return sqrtScaled * Q96 / factor;
})();

const BOMI_AMOUNT = ethers.parseEther('2.5');  // 2.5 BOMI ($1)
const USDC_AMOUNT = 1000000n;                   // 1 USDC (6 dec)

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const NPM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address,address,uint256)',
];

const REACTOR_ABI = [
  'function addPool(uint256)',
  'function poolCount() view returns (uint256)',
  'function admin() view returns (address)',
  'function token() view returns (address)',
  'function reactorPrime() view returns (address)',
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString(); }

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log('Wallet:', wallet.address);

  const step = process.argv[2] || 'all';
  const addrFile = path.join(__dirname, 'bomi-reactor-address.txt');
  const idFile = path.join(__dirname, 'bomi-lp-tokenid.txt');

  // ---- STEP 1: Deploy ----
  if (step === 'all' || step === 'deploy') {
    console.log('\n=== STEP 1: Deploy ChainReactorV2 (BOMI) ===');

    // Check BOMI balance
    const bomi = new ethers.Contract(BOMI, ERC20_ABI, provider);
    const bomiBal = await bomi.balanceOf(wallet.address);
    console.log('BOMI balance:', ethers.formatEther(bomiBal));
    if (bomiBal < BOMI_AMOUNT) {
      console.error('Need at least 2.5 BOMI. Send BOMI to ' + wallet.address);
      process.exit(1);
    }

    const artifact = require(path.join(__dirname, '..', 'artifacts', 'contracts', 'ChainReactorV2.sol', 'ChainReactorV2.json'));
    const contractFactory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

    console.log('Constructor args:');
    console.log('  token:        ', BOMI, '(BOMI)');
    console.log('  mft:          ', MFT);
    console.log('  pm:           ', PM);
    console.log('  router:       ', ROUTER);
    console.log('  factory:      ', FACTORY);
    console.log('  reactorPrime: ', BURGERS_REACTOR, '(BURGERS)');

    const feeData = await provider.getFeeData();
    const contract = await contractFactory.deploy(BOMI, MFT, PM, ROUTER, FACTORY, BURGERS_REACTOR, {
      maxFeePerGas: feeData.maxFeePerGas * 3n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
    });
    console.log('Tx:', contract.deploymentTransaction().hash);
    await contract.waitForDeployment();
    const addr = await contract.getAddress();
    console.log('BOMI Reactor deployed:', addr);

    const reactor = new ethers.Contract(addr, REACTOR_ABI, provider);
    const [admin, token, prime] = await Promise.all([reactor.admin(), reactor.token(), reactor.reactorPrime()]);
    console.log('  admin:', admin);
    console.log('  token:', token);
    console.log('  reactorPrime:', prime);

    fs.writeFileSync(addrFile, addr);
    console.log('Address saved to bomi-reactor-address.txt');
    if (step === 'deploy') return;
  }

  // Read reactor address
  let reactorAddr;
  try { reactorAddr = fs.readFileSync(addrFile, 'utf8').trim(); }
  catch { console.error('No reactor address. Run with "deploy" first.'); return; }
  console.log('\nUsing reactor:', reactorAddr);

  // ---- STEP 2: Create pool ----
  if (step === 'all' || step === 'pool') {
    console.log('\n=== STEP 2: Create BOMI/USDC V3 pool (1% fee) ===');
    console.log('sqrtPriceX96:', SQRT_PRICE_X96.toString());
    console.log('Price: $0.40 per BOMI');

    const npm = new ethers.Contract(PM, NPM_ABI, wallet);
    await sleep(2000);
    const feeData = await provider.getFeeData();
    try {
      const tx = await npm.createAndInitializePoolIfNecessary(BOMI, USDC, FEE, SQRT_PRICE_X96, {
        gasLimit: 5_000_000,
        maxFeePerGas: feeData.maxFeePerGas * 3n,
        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
      });
      await tx.wait();
      console.log('Pool created');
    } catch (e) {
      console.log('Pool note:', e.message.slice(0, 120));
    }
    if (step === 'pool') return;
  }

  // ---- STEP 3: Approve ----
  if (step === 'all' || step === 'approve') {
    console.log('\n=== STEP 3: Approve BOMI + USDC ===');
    const bomi = new ethers.Contract(BOMI, ERC20_ABI, wallet);
    const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);

    const bomiAllow = await bomi.allowance(wallet.address, PM);
    if (bomiAllow < BOMI_AMOUNT) {
      console.log('Approving BOMI...');
      const tx = await bomi.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
      await tx.wait();
      console.log('BOMI approved');
    } else {
      console.log('BOMI already approved');
    }

    await sleep(2000);
    const usdcAllow = await usdc.allowance(wallet.address, PM);
    if (usdcAllow < USDC_AMOUNT) {
      console.log('Approving USDC...');
      const tx = await usdc.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
      await tx.wait();
      console.log('USDC approved');
    } else {
      console.log('USDC already approved');
    }
    if (step === 'approve') return;
  }

  // ---- STEP 4: Mint LP ----
  if (step === 'all' || step === 'mint') {
    console.log('\n=== STEP 4: Mint BOMI/USDC LP ===');
    const npm = new ethers.Contract(PM, NPM_ABI, wallet);

    console.log('Minting: 2.5 BOMI + 1 USDC');
    await sleep(2000);
    const feeData = await provider.getFeeData();
    const tx = await npm.mint({
      token0: BOMI,
      token1: USDC,
      fee: FEE,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      amount0Desired: BOMI_AMOUNT,
      amount1Desired: USDC_AMOUNT,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
    }, {
      gasLimit: 5_000_000,
      maxFeePerGas: feeData.maxFeePerGas * 3n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
    });
    const receipt = await tx.wait();

    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const transferLog = receipt.logs.find(l => l.topics[0] === transferTopic && l.address.toLowerCase() === PM.toLowerCase());
    const tokenId = BigInt(transferLog.topics[3]);
    console.log('LP NFT: #' + tokenId.toString());

    fs.writeFileSync(idFile, tokenId.toString());
    if (step === 'mint') return;
  }

  // Read token ID
  let tokenId;
  try { tokenId = fs.readFileSync(idFile, 'utf8').trim(); }
  catch { console.error('No token ID. Run with "mint" first.'); return; }

  // ---- STEP 5: Transfer LP to reactor ----
  if (step === 'all' || step === 'transfer') {
    console.log('\n=== STEP 5: Transfer LP to reactor ===');
    const npm = new ethers.Contract(PM, NPM_ABI, wallet);
    console.log('Transferring NFT #' + tokenId + ' to ' + reactorAddr);
    await sleep(2000);
    const feeData = await provider.getFeeData();
    const tx = await npm.safeTransferFrom(wallet.address, reactorAddr, tokenId, {
      gasLimit: 500_000,
      maxFeePerGas: feeData.maxFeePerGas * 3n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
    });
    await tx.wait();
    console.log('Transferred');
    if (step === 'transfer') return;
  }

  // ---- STEP 6: addPool ----
  if (step === 'all' || step === 'addpool') {
    console.log('\n=== STEP 6: addPool() ===');
    const reactor = new ethers.Contract(reactorAddr, REACTOR_ABI, wallet);
    await sleep(2000);
    const feeData = await provider.getFeeData();
    const tx = await reactor.addPool(tokenId, {
      gasLimit: 500_000,
      maxFeePerGas: feeData.maxFeePerGas * 3n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
    });
    await tx.wait();
    const count = await reactor.poolCount();
    console.log('BOMI reactor: ' + count.toString() + ' pool(s)');
  }

  console.log('\n=== DONE ===');
  console.log('BOMI Reactor:', reactorAddr);
  console.log('Feeds into BURGERS reactor at', BURGERS_REACTOR);
}

main().catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
