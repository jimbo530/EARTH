/**
 * Seed MfT/USDC 0.05% V3 pool → Reactor Prime V2
 *
 * TX 1: Approve USDC to NPM
 * TX 2: Approve MfT to NPM
 * TX 3: createAndInitializePoolIfNecessary (0.05% fee, correct price)
 * TX 4: mint full-range position (NFT goes to reactor)
 * TX 5: addPool(tokenId) on reactor
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const MFT   = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NPM   = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';

// USDC < MfT by address
const TOKEN0 = USDC;
const TOKEN1 = MFT;
const FEE = 500;  // 0.05% — clean pool, no broken state

// 0.05% tick spacing = 10
const TICK_LOWER = -887270;
const TICK_UPPER =  887270;

// Reactor V2 deployed earlier
const REACTOR = '0xed3aE91b2bb22307c07438EEebA2500C18EABcFE';

// Amounts: $5 each side
const USDC_AMOUNT = ethers.parseUnits('5', 6);
const MFT_AMOUNT  = ethers.parseUnits('18677483', 18);

function sqrtBigInt(n) {
  if (n <= 0n) return 0n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('Wallet:', wallet.address);
  console.log('Reactor:', REACTOR);
  console.log('Fee tier: 0.05% (500)');
  console.log('');

  const usdc = new ethers.Contract(USDC, [
    'function approve(address, uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ], wallet);
  const mft = new ethers.Contract(MFT, [
    'function approve(address, uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ], wallet);
  const npm = new ethers.Contract(NPM, [
    'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address)',
    'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
  ], wallet);

  // Calculate sqrtPriceX96 from amounts
  const Q192 = 2n ** 192n;
  const sqrtPriceX96 = sqrtBigInt(MFT_AMOUNT * Q192 / USDC_AMOUNT);
  console.log('sqrtPriceX96:', sqrtPriceX96.toString());
  console.log('');

  // === TX 1: Approve USDC ===
  console.log('--- TX 1: Approve USDC ---');
  const tx1 = await usdc.approve(NPM, USDC_AMOUNT);
  console.log('Tx:', tx1.hash);
  await tx1.wait();
  console.log('Done');
  console.log('');

  // === TX 2: Approve MfT ===
  console.log('--- TX 2: Approve MfT ---');
  const tx2 = await mft.approve(NPM, MFT_AMOUNT);
  console.log('Tx:', tx2.hash);
  await tx2.wait();
  console.log('Done');
  console.log('');

  // === TX 3: Create + initialize pool ===
  console.log('--- TX 3: Create pool (0.05% MfT/USDC) ---');
  const tx3 = await npm.createAndInitializePoolIfNecessary(TOKEN0, TOKEN1, FEE, sqrtPriceX96);
  console.log('Tx:', tx3.hash);
  await tx3.wait();
  console.log('Pool created');
  console.log('');

  // === TX 4: Mint position ===
  console.log('--- TX 4: Mint position to reactor ---');
  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx4 = await npm.mint({
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: USDC_AMOUNT,
    amount1Desired: MFT_AMOUNT,
    amount0Min: 0,
    amount1Min: 0,
    recipient: REACTOR,
    deadline: deadline
  });
  console.log('Tx:', tx4.hash);
  const receipt = await tx4.wait();

  // Parse tokenId from Transfer event
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLog = receipt.logs.find(lg =>
    lg.topics[0] === transferTopic &&
    lg.topics.length === 4 &&
    lg.topics[1] === ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32)
  );

  let tokenId;
  if (transferLog) {
    tokenId = BigInt(transferLog.topics[3]);
    console.log('Token ID:', tokenId.toString());
  } else {
    console.error('Could not parse tokenId!');
    console.log('Check tx:', tx4.hash);
    process.exit(1);
  }
  console.log('');

  // === TX 5: addPool ===
  console.log('--- TX 5: addPool on reactor ---');
  const reactor = new ethers.Contract(REACTOR, [
    'function addPool(uint256 tokenId)',
    'function poolCount() view returns (uint256)',
    'function pools(uint256) view returns (uint256 tokenId, address xToken, uint24 fee, bool tokenIsToken0)'
  ], wallet);

  const tx5 = await reactor.addPool(tokenId);
  console.log('Tx:', tx5.hash);
  await tx5.wait();

  const pool = await reactor.pools(0);
  console.log('');
  console.log('========================================');
  console.log('REACTOR PRIME V2 SEEDED');
  console.log('Reactor:  ', REACTOR);
  console.log('Pool 0:    MfT/USDC (0.05% fee)');
  console.log('Token ID: ', tokenId.toString());
  console.log('xToken:   ', pool.xToken);
  console.log('MfT is token0:', pool.tokenIsToken0);
  console.log('execute() ready after 2hr cooldown');
  console.log('========================================');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
