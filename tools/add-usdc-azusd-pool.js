/**
 * Add USDC/AZUSD pool to AZUSD reactor
 * 1% fee, ~$1 each side, 1:1 deposit receipt price
 *
 * token0 = AZUSD (18 dec, 0x3595...)
 * token1 = USDC  (6 dec,  0x8335...)
 * price = token1_raw / token0_raw = 1e6 / 1e18 = 1e-12
 * sqrtPriceX96 = sqrt(1e-12) * 2^96
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const AZUSD    = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2'; // 18 dec
const USDC     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // 6 dec
const PM       = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const REACTOR  = '0xD8AFb7caD1f8A3Ddc4E16c1516a94949eb119281';
const FEE      = 10000;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

// token0 = AZUSD (0x3595 < 0x8335), token1 = USDC
// 1:1 USD peg: 1 AZUSD (1e18 raw) = 1 USDC (1e6 raw)
// price = 1e6 / 1e18 = 1e-12
// sqrtPrice = 1e-6
// sqrtPriceX96 = 1e-6 * 2^96
const SQRT_PRICE_X96 = 79228162514264337593544n;

const AZUSD_AMOUNT = ethers.parseEther('1.0');   // 1 AZUSD
const USDC_AMOUNT  = 1000000n;                    // 1 USDC (6 dec)

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];
const NPM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address,address,uint256)',
];
const REACTOR_ABI = ['function addPool(uint256)', 'function poolCount() view returns (uint256)'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function ts() { return new Date().toLocaleTimeString(); }

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const npm = new ethers.Contract(PM, NPM_ABI, wallet);
  console.log('Wallet:', wallet.address);

  const azusd = new ethers.Contract(AZUSD, ERC20_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);

  // Step 1: Approve both tokens to PM
  console.log('[' + ts() + '] Checking approvals...');
  const azusdAllow = await azusd.allowance(wallet.address, PM);
  if (azusdAllow < AZUSD_AMOUNT) {
    console.log('Approving AZUSD...');
    const tx = await azusd.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
    await tx.wait();
    console.log('AZUSD approved');
  } else {
    console.log('AZUSD already approved');
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

  // Step 2: Create pool
  console.log('[' + ts() + '] Creating AZUSD/USDC pool (1% fee)...');
  console.log('sqrtPriceX96:', SQRT_PRICE_X96.toString());
  await sleep(2000);
  const feeData = await provider.getFeeData();
  const gasOpts = { gasLimit: 5_000_000, maxFeePerGas: feeData.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n };

  try {
    const tx = await npm.createAndInitializePoolIfNecessary(AZUSD, USDC, FEE, SQRT_PRICE_X96, gasOpts);
    await tx.wait();
    console.log('Pool created');
  } catch (e) {
    console.log('Pool note:', e.message.slice(0, 120));
  }

  // Step 3: Mint LP
  console.log('[' + ts() + '] Minting: 1 AZUSD + 1 USDC');
  await sleep(2000);
  const feeData2 = await provider.getFeeData();
  const gasOpts2 = { gasLimit: 5_000_000, maxFeePerGas: feeData2.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas * 3n };

  const mintTx = await npm.mint({
    token0: AZUSD,
    token1: USDC,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: AZUSD_AMOUNT,
    amount1Desired: USDC_AMOUNT,
    amount0Min: 0,
    amount1Min: 0,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600,
  }, gasOpts2);
  const receipt = await mintTx.wait();

  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLog = receipt.logs.find(l => l.topics[0] === transferTopic && l.address.toLowerCase() === PM.toLowerCase());
  const tokenId = BigInt(transferLog.topics[3]);
  console.log('LP NFT: #' + tokenId.toString());

  // Step 4: Transfer to reactor
  console.log('[' + ts() + '] Transferring to reactor...');
  await sleep(2000);
  const feeData3 = await provider.getFeeData();
  const tx2 = await npm.safeTransferFrom(wallet.address, REACTOR, tokenId,
    { gasLimit: 500_000, maxFeePerGas: feeData3.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData3.maxPriorityFeePerGas * 3n });
  await tx2.wait();
  console.log('Transferred');

  // Step 5: addPool
  console.log('[' + ts() + '] Adding pool to reactor...');
  await sleep(2000);
  const reactor = new ethers.Contract(REACTOR, REACTOR_ABI, wallet);
  const feeData4 = await provider.getFeeData();
  const tx3 = await reactor.addPool(tokenId,
    { gasLimit: 500_000, maxFeePerGas: feeData4.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData4.maxPriorityFeePerGas * 3n });
  await tx3.wait();
  const count = await reactor.poolCount();
  console.log('AZUSD reactor: ' + count.toString() + ' pools');
  console.log('Done — USDC/AZUSD pool added to AZUSD reactor');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
