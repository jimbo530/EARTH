/**
 * Seed MfT/AZUSD 0.05% V3 pool → Reactor Prime V2
 *
 * TX 1: Approve AZUSD to NPM
 * TX 2: Approve MfT to NPM
 * TX 3: createAndInitializePoolIfNecessary (0.05% fee, correct price)
 * TX 4: mint full-range position (NFT goes to reactor)
 * TX 5: addPool(tokenId) on reactor
 *
 * Both tokens are 18 decimals. AZUSD ≈ $1 deposit receipt.
 * MfT price: ~$0.000000309 (from MfT/WETH V2 pair)
 * 1 AZUSD ≈ 3,236,246 MfT
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('No AGENT_PRIVATE_KEY in Baselings/api/.env');
  process.exit(1);
}

const MFT   = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const AZUSD = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const NPM   = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';

// AZUSD 0x3595 < MfT 0x8FB8 → AZUSD = token0, MfT = token1
const TOKEN0 = AZUSD;
const TOKEN1 = MFT;
const FEE = 500; // 0.05%

// 0.05% tick spacing = 10
const TICK_LOWER = -887270;
const TICK_UPPER =  887270;

const REACTOR = '0xed3aE91b2bb22307c07438EEebA2500C18EABcFE';

// Amounts: $5 each side
// AZUSD is 18 decimals, ~$1 each → 5 AZUSD = $5
// MfT price ~$0.000000309 → $5 = 16,181,230 MfT
const AZUSD_AMOUNT = ethers.parseEther('5');
const MFT_AMOUNT   = ethers.parseEther('16181230');

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

  const erc20Abi = [
    'function approve(address, uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ];
  const azusd = new ethers.Contract(AZUSD, erc20Abi, wallet);
  const mft   = new ethers.Contract(MFT, erc20Abi, wallet);

  const azBal = await azusd.balanceOf(wallet.address);
  const mftBal = await mft.balanceOf(wallet.address);
  console.log('AZUSD bal:', ethers.formatEther(azBal));
  console.log('MfT bal:', ethers.formatEther(mftBal));
  console.log('ETH:', ethers.formatEther(await provider.getBalance(wallet.address)));
  console.log('');

  if (azBal < AZUSD_AMOUNT) {
    console.error('Not enough AZUSD! Need 5, have', ethers.formatEther(azBal));
    process.exit(1);
  }
  if (mftBal < MFT_AMOUNT) {
    console.error('Not enough MfT! Need 16181230, have', ethers.formatEther(mftBal));
    process.exit(1);
  }

  // Both tokens 18 decimals → price_raw = MfT_amount / AZUSD_amount
  // sqrtPriceX96 = sqrt(price_raw) * 2^96
  const Q96 = 2n ** 96n;
  const sqrtPriceX96 = sqrtBigInt(MFT_AMOUNT * Q96 * Q96 / AZUSD_AMOUNT);
  console.log('sqrtPriceX96:', sqrtPriceX96.toString());
  console.log('');

  const npm = new ethers.Contract(NPM, [
    'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address)',
    'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
  ], wallet);

  // === TX 1: Approve AZUSD ===
  console.log('--- TX 1: Approve AZUSD to NPM ---');
  let tx = await azusd.approve(NPM, AZUSD_AMOUNT);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Done\n');

  // === TX 2: Approve MfT ===
  console.log('--- TX 2: Approve MfT to NPM ---');
  tx = await mft.approve(NPM, MFT_AMOUNT);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Done\n');

  // === TX 3: Create + initialize pool ===
  console.log('--- TX 3: Create 0.05% AZUSD/MfT pool ---');
  tx = await npm.createAndInitializePoolIfNecessary(TOKEN0, TOKEN1, FEE, sqrtPriceX96);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Pool created!\n');

  // === TX 4: Mint position ===
  console.log('--- TX 4: Mint position to reactor ---');
  const deadline = Math.floor(Date.now() / 1000) + 600;
  tx = await npm.mint({
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: AZUSD_AMOUNT,
    amount1Desired: MFT_AMOUNT,
    amount0Min: 0,
    amount1Min: 0,
    recipient: REACTOR,
    deadline: deadline
  });
  console.log('Tx:', tx.hash);
  const receipt = await tx.wait();

  // Parse tokenId from Transfer event
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLog = receipt.logs.find(lg =>
    lg.topics[0] === transferTopic &&
    lg.topics.length === 4 &&
    lg.topics[1] === ethers.zeroPadValue(ethers.ZeroAddress, 32)
  );

  let tokenId;
  if (transferLog) {
    tokenId = BigInt(transferLog.topics[3]);
    console.log('Token ID:', tokenId.toString());
  } else {
    console.error('Could not parse tokenId!');
    console.log('Check tx:', tx.hash);
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

  tx = await reactor.addPool(tokenId);
  console.log('Tx:', tx.hash);
  await tx.wait();

  const poolCount = await reactor.poolCount();
  const pool = await reactor.pools(poolCount - 1n);
  console.log('');
  console.log('========================================');
  console.log('REACTOR PRIME V2 SEEDED');
  console.log('Reactor:  ', REACTOR);
  console.log('Pool:      MfT/AZUSD (0.05% fee)');
  console.log('Token ID: ', tokenId.toString());
  console.log('xToken:   ', pool.xToken);
  console.log('MfT is token0:', pool.tokenIsToken0);
  console.log('Pool count:', poolCount.toString());
  console.log('execute() ready after 2hr cooldown');
  console.log('========================================');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
