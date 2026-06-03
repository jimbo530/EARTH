/**
 * Deploy Reactor Prime V2 + seed MfT/USDC LP position
 *
 * TX 1: Deploy ReactorPrimeV2
 * TX 2: Approve USDC to NPM
 * TX 3: Approve MfT to NPM
 * TX 4: Multicall (createPool + mint position to reactor)
 * TX 5: addPool(tokenId) on reactor
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('No AGENT_PRIVATE_KEY in Baselings/api/.env');
  process.exit(1);
}

// Addresses
const MFT   = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NPM   = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';

// USDC (0x833...) < MfT (0x8FB...) so USDC = token0, MfT = token1
const TOKEN0 = USDC;
const TOKEN1 = MFT;
const FEE = 10000; // 1%
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

// Amounts: $5 each side
const USDC_AMOUNT = ethers.parseUnits('5', 6);        // 5 USDC
const MFT_AMOUNT  = ethers.parseUnits('18677483', 18); // ~$5 of MfT

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function balanceOf(address) view returns (uint256)'
];

const NPM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function multicall(bytes[] data) payable returns (bytes[] results)'
];

const REACTOR_ABI = [
  'function addPool(uint256 tokenId)',
  'function poolCount() view returns (uint256)',
  'function pools(uint256) view returns (uint256 tokenId, address xToken, uint24 fee, bool tokenIsToken0)',
  'function admin() view returns (address)'
];

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

  const ethBal = await provider.getBalance(wallet.address);
  console.log('ETH:', ethers.formatEther(ethBal));

  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const mft  = new ethers.Contract(MFT, ERC20_ABI, wallet);
  console.log('USDC:', ethers.formatUnits(await usdc.balanceOf(wallet.address), 6));
  console.log('MfT:', ethers.formatEther(await mft.balanceOf(wallet.address)));
  console.log('');

  // === TX 1: Deploy ReactorPrimeV2 ===
  console.log('--- TX 1: Deploy ReactorPrimeV2 ---');
  const artifact = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'artifacts', 'contracts', 'MfTReactorV2.sol', 'ReactorPrimeV2.json')
  ));
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const reactor = await factory.deploy(MFT, NPM, ROUTER, FACTORY);
  const deployTx = reactor.deploymentTransaction();
  console.log('Deploy tx:', deployTx.hash);
  await reactor.waitForDeployment();
  const reactorAddr = await reactor.getAddress();
  console.log('REACTOR PRIME V2:', reactorAddr);
  console.log('');

  // === TX 2: Approve USDC to NPM ===
  console.log('--- TX 2: Approve USDC ---');
  const tx2 = await usdc.approve(NPM, USDC_AMOUNT);
  console.log('Tx:', tx2.hash);
  await tx2.wait();
  console.log('USDC approved');
  console.log('');

  // === TX 3: Approve MfT to NPM ===
  console.log('--- TX 3: Approve MfT ---');
  const tx3 = await mft.approve(NPM, MFT_AMOUNT);
  console.log('Tx:', tx3.hash);
  await tx3.wait();
  console.log('MfT approved');
  console.log('');

  // === TX 4: Create pool + mint position ===
  console.log('--- TX 4: Create pool + mint position ---');
  const npm = new ethers.Contract(NPM, NPM_ABI, wallet);

  // Calculate sqrtPriceX96
  const Q192 = 2n ** 192n;
  const sqrtPriceX96 = sqrtBigInt(MFT_AMOUNT * Q192 / USDC_AMOUNT);
  console.log('sqrtPriceX96:', sqrtPriceX96.toString());

  // Encode multicall data
  const createData = npm.interface.encodeFunctionData(
    'createAndInitializePoolIfNecessary',
    [TOKEN0, TOKEN1, FEE, sqrtPriceX96]
  );

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const mintData = npm.interface.encodeFunctionData('mint', [{
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: USDC_AMOUNT,
    amount1Desired: MFT_AMOUNT,
    amount0Min: 0,
    amount1Min: 0,
    recipient: reactorAddr,
    deadline: deadline
  }]);

  const tx4 = await npm.multicall([createData, mintData]);
  console.log('Tx:', tx4.hash);
  const receipt = await tx4.wait();

  // Find tokenId from Transfer event
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLog = receipt.logs.find(lg =>
    lg.topics[0] === transferTopic &&
    lg.topics.length === 4 &&
    lg.topics[1] === ethers.zeroPadValue('0x0000000000000000000000000000000000000000', 32)
  );

  let tokenId;
  if (transferLog) {
    tokenId = BigInt(transferLog.topics[3]);
    console.log('Position NFT tokenId:', tokenId.toString());
    console.log('NFT owner: reactor at', reactorAddr);
  } else {
    console.error('Could not find tokenId in logs!');
    console.log('Check tx on BaseScan:', tx4.hash);
    process.exit(1);
  }
  console.log('');

  // === TX 5: addPool ===
  console.log('--- TX 5: addPool ---');
  const reactorContract = new ethers.Contract(reactorAddr, REACTOR_ABI, wallet);
  const tx5 = await reactorContract.addPool(tokenId);
  console.log('Tx:', tx5.hash);
  await tx5.wait();

  const poolCount = await reactorContract.poolCount();
  const pool = await reactorContract.pools(0);
  console.log('Pool registered!');
  console.log('Pool count:', poolCount.toString());
  console.log('xToken:', pool.xToken);
  console.log('Fee:', pool.fee.toString());
  console.log('MfT is token0:', pool.tokenIsToken0);
  console.log('');

  console.log('========================================');
  console.log('REACTOR PRIME V2 LIVE');
  console.log('Address:', reactorAddr);
  console.log('Pool 0: MfT/USDC (1% fee)');
  console.log('TokenId:', tokenId.toString());
  console.log('execute() available after 2hr cooldown');
  console.log('========================================');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
