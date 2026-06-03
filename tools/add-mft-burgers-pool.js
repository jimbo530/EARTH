/**
 * Add MfT pool to BURGERS reactor
 *
 * Mints BURGERS/MfT LP into existing V3 pool, transfers to BURGERS reactor, addPool()
 *
 * Token ordering: BURGERS (0x06A0) < MfT (0x8FB8) → BURGERS=token0, MfT=token1
 * Pool: 0xc0ac5a160ecfb2623c83560038f129a6ca27b5b6 (1% fee)
 * Price: 1 BURGERS ≈ 2.95 MfT
 *
 * Usage: node add-mft-burgers-pool.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const BURGERS = '0x06A05043eb2C1691b19c2C13219dB9212269dDc5';
const MFT     = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const PM      = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const BURGERS_REACTOR = '0xc858026Ec5D30280137032BC6EA86F46ea23C2CA';

const FEE = 10000;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

// ~$9 each side (fits available BURGERS balance)
const BURGERS_AMOUNT = ethers.parseEther('11000000');
const MFT_AMOUNT     = ethers.parseEther('32450000');

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
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString(); }

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log('Wallet:', wallet.address);

  const burgers = new ethers.Contract(BURGERS, ERC20_ABI, wallet);
  const mft = new ethers.Contract(MFT, ERC20_ABI, wallet);

  // Check balances
  const [bBal, mBal] = await Promise.all([
    burgers.balanceOf(wallet.address),
    mft.balanceOf(wallet.address),
  ]);
  console.log('BURGERS:', ethers.formatEther(bBal));
  console.log('MfT:', ethers.formatEther(mBal));

  if (bBal < BURGERS_AMOUNT) { console.error('Not enough BURGERS'); process.exit(1); }
  if (mBal < MFT_AMOUNT) { console.error('Not enough MfT'); process.exit(1); }

  // Step 1: Approve
  console.log('\n=== STEP 1: Approve BURGERS + MfT ===');
  const bAllow = await burgers.allowance(wallet.address, PM);
  if (bAllow < BURGERS_AMOUNT) {
    console.log('Approving BURGERS...');
    const tx = await burgers.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
    await tx.wait();
    console.log('BURGERS approved');
  } else {
    console.log('BURGERS already approved');
  }

  await sleep(2000);
  const mAllow = await mft.allowance(wallet.address, PM);
  if (mAllow < MFT_AMOUNT) {
    console.log('Approving MfT...');
    const tx = await mft.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
    await tx.wait();
    console.log('MfT approved');
  } else {
    console.log('MfT already approved');
  }

  // Step 2: Mint LP
  console.log('\n=== STEP 2: Mint BURGERS/MfT LP ===');
  console.log('BURGERS (token0):', ethers.formatEther(BURGERS_AMOUNT));
  console.log('MfT (token1):', ethers.formatEther(MFT_AMOUNT));

  const npm = new ethers.Contract(PM, NPM_ABI, wallet);
  await sleep(2000);
  const feeData = await provider.getFeeData();
  const tx = await npm.mint({
    token0: BURGERS,
    token1: MFT,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: BURGERS_AMOUNT,
    amount1Desired: MFT_AMOUNT,
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
  console.log('[' + ts() + '] LP NFT: #' + tokenId.toString());
  console.log('tx:', receipt.hash.slice(0, 14) + '...');

  // Step 3: Transfer LP to reactor
  console.log('\n=== STEP 3: Transfer LP to BURGERS reactor ===');
  await sleep(3000);
  const feeData2 = await provider.getFeeData();
  const tx2 = await npm.safeTransferFrom(wallet.address, BURGERS_REACTOR, tokenId, {
    gasLimit: 500_000,
    maxFeePerGas: feeData2.maxFeePerGas * 3n,
    maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas * 3n,
  });
  await tx2.wait();
  console.log('[' + ts() + '] Transferred NFT #' + tokenId.toString() + ' to reactor');

  // Step 4: addPool
  console.log('\n=== STEP 4: addPool() ===');
  const reactor = new ethers.Contract(BURGERS_REACTOR, REACTOR_ABI, wallet);
  await sleep(3000);
  const feeData3 = await provider.getFeeData();
  const tx3 = await reactor.addPool(tokenId, {
    gasLimit: 500_000,
    maxFeePerGas: feeData3.maxFeePerGas * 3n,
    maxPriorityFeePerGas: feeData3.maxPriorityFeePerGas * 3n,
  });
  await tx3.wait();
  const count = await reactor.poolCount();
  console.log('[' + ts() + '] BURGERS reactor: ' + count.toString() + ' pool(s)');

  console.log('\n=== DONE ===');
  console.log('BURGERS/MfT LP added to BURGERS reactor');
  console.log('On fuel() fail to Prime, MfT stays local and deepens this LP');
}

main().catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
