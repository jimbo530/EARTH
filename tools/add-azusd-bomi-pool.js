/**
 * Add AZUSD pool to BOMI reactor
 *
 * Token ordering: AZUSD (0x3595) < BOMI (0x46D8) → AZUSD=token0, BOMI=token1
 * Price: $0.40/BOMI, $1/AZUSD → 1 AZUSD = 2.5 BOMI → price(t1/t0) = 2.5
 * Both 18 decimals → sqrtPriceX96 = sqrt(2.5) * 2^96
 *
 * Usage: node add-azusd-bomi-pool.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const AZUSD = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const BOMI  = '0x46D8f8Ba030c1D09ae17d2B5107dfef4B331fe0d';
const PM    = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const BOMI_REACTOR = '0x409009453Ce04Bc5ac936bA6FbE42dd04971fFF0';

const FEE = 10000;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

// AZUSD=token0 (18 dec), BOMI=token1 (18 dec)
// price = 2.5 (BOMI per AZUSD), both 18 dec so no decimal adjustment
// sqrtPriceX96 = sqrt(2.5) * 2^96
const SQRT_PRICE_X96 = (() => {
  const Q96 = 2n ** 96n;
  const sqrtPrice = Math.sqrt(2.5); // 1.58113883...
  const factor = 1000000000000000n; // 1e15
  const sqrtScaled = BigInt(Math.round(sqrtPrice * Number(factor)));
  return sqrtScaled * Q96 / factor;
})();

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
];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString(); }

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log('Wallet:', wallet.address);

  const azusd = new ethers.Contract(AZUSD, ERC20_ABI, wallet);
  const bomi = new ethers.Contract(BOMI, ERC20_ABI, wallet);

  const [aBal, bBal] = await Promise.all([
    azusd.balanceOf(wallet.address),
    bomi.balanceOf(wallet.address),
  ]);
  console.log('AZUSD:', ethers.formatEther(aBal));
  console.log('BOMI:', ethers.formatEther(bBal));

  // Use all BOMI, match with AZUSD (BOMI/2.5 = AZUSD needed)
  const bomiAmount = bBal;
  // For full range LP, PM will take what it needs from both sides
  // Offer all BOMI and enough AZUSD to match
  const azusdAmount = bBal * 10n / 25n + ethers.parseEther('0.01'); // BOMI/2.5 + small buffer
  if (azusdAmount > aBal) {
    console.error('Not enough AZUSD. Need ~' + ethers.formatEther(azusdAmount) + ', have ' + ethers.formatEther(aBal));
    process.exit(1);
  }

  console.log('Will use up to:', ethers.formatEther(bomiAmount), 'BOMI +', ethers.formatEther(azusdAmount), 'AZUSD');

  // Step 1: Create pool if needed
  console.log('\n=== STEP 1: Create AZUSD/BOMI pool (1% fee) ===');
  console.log('sqrtPriceX96:', SQRT_PRICE_X96.toString());
  const npm = new ethers.Contract(PM, NPM_ABI, wallet);
  await sleep(2000);
  const feeData = await provider.getFeeData();
  try {
    const tx = await npm.createAndInitializePoolIfNecessary(AZUSD, BOMI, FEE, SQRT_PRICE_X96, {
      gasLimit: 5_000_000,
      maxFeePerGas: feeData.maxFeePerGas * 3n,
      maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
    });
    await tx.wait();
    console.log('Pool created/verified');
  } catch (e) {
    console.log('Pool note:', e.message.slice(0, 120));
  }

  // Step 2: Approve
  console.log('\n=== STEP 2: Approve AZUSD + BOMI ===');
  await sleep(2000);
  const aAllow = await azusd.allowance(wallet.address, PM);
  if (aAllow < azusdAmount) {
    console.log('Approving AZUSD...');
    const tx = await azusd.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
    await tx.wait();
    console.log('AZUSD approved');
  } else {
    console.log('AZUSD already approved');
  }

  await sleep(2000);
  const bAllow = await bomi.allowance(wallet.address, PM);
  if (bAllow < bomiAmount) {
    console.log('Approving BOMI...');
    const tx = await bomi.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
    await tx.wait();
    console.log('BOMI approved');
  } else {
    console.log('BOMI already approved');
  }

  // Step 3: Mint LP
  console.log('\n=== STEP 3: Mint AZUSD/BOMI LP ===');
  await sleep(2000);
  const feeData2 = await provider.getFeeData();
  const tx = await npm.mint({
    token0: AZUSD,
    token1: BOMI,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: azusdAmount,
    amount1Desired: bomiAmount,
    amount0Min: 0,
    amount1Min: 0,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600,
  }, {
    gasLimit: 5_000_000,
    maxFeePerGas: feeData2.maxFeePerGas * 3n,
    maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas * 3n,
  });
  const receipt = await tx.wait();

  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLog = receipt.logs.find(l => l.topics[0] === transferTopic && l.address.toLowerCase() === PM.toLowerCase());
  const tokenId = BigInt(transferLog.topics[3]);
  console.log('[' + ts() + '] LP NFT: #' + tokenId.toString());
  console.log('tx:', receipt.hash.slice(0, 14) + '...');

  // Step 4: Transfer to reactor
  console.log('\n=== STEP 4: Transfer LP to BOMI reactor ===');
  await sleep(3000);
  const feeData3 = await provider.getFeeData();
  const tx2 = await npm.safeTransferFrom(wallet.address, BOMI_REACTOR, tokenId, {
    gasLimit: 500_000,
    maxFeePerGas: feeData3.maxFeePerGas * 3n,
    maxPriorityFeePerGas: feeData3.maxPriorityFeePerGas * 3n,
  });
  await tx2.wait();
  console.log('[' + ts() + '] Transferred NFT #' + tokenId.toString() + ' to reactor');

  // Step 5: addPool
  console.log('\n=== STEP 5: addPool() ===');
  const reactor = new ethers.Contract(BOMI_REACTOR, REACTOR_ABI, wallet);
  await sleep(3000);
  const feeData4 = await provider.getFeeData();
  const tx3 = await reactor.addPool(tokenId, {
    gasLimit: 500_000,
    maxFeePerGas: feeData4.maxFeePerGas * 3n,
    maxPriorityFeePerGas: feeData4.maxPriorityFeePerGas * 3n,
  });
  await tx3.wait();
  const count = await reactor.poolCount();
  console.log('[' + ts() + '] BOMI reactor: ' + count.toString() + ' pool(s)');

  console.log('\n=== DONE ===');
  console.log('AZUSD/BOMI LP added to BOMI reactor');
}

main().catch(err => { console.error('FATAL:', err.message || err); process.exit(1); });
