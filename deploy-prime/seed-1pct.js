/**
 * Seed MfT/USDC 1% V3 pool → Reactor Prime V2
 *
 * The 1% pool exists at inverted price (tick -427359). Fix:
 * 1. Mint full-range position (at wrong price, mostly USDC)
 * 2. Swap USDC → MfT to push price to correct level
 * 3. addPool on reactor
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const MFT    = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NPM    = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

const TOKEN0 = USDC;  // 0x833... < 0x8FB...
const TOKEN1 = MFT;
const FEE = 10000;    // 1%

// 1% tick spacing = 200
const TICK_LOWER = -887200;
const TICK_UPPER =  887200;

const REACTOR = '0xed3aE91b2bb22307c07438EEebA2500C18EABcFE';

// Amounts
const USDC_APPROVE = ethers.parseUnits('10', 6);       // 10 USDC total budget
const MFT_APPROVE  = ethers.parseUnits('18677483', 18);
const USDC_MINT    = ethers.parseUnits('5', 6);         // $5 for position
const MFT_MINT     = ethers.parseUnits('18677483', 18); // $5 of MfT
const USDC_SWAP    = ethers.parseUnits('5', 6);         // $5 max for price fix

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
  console.log('');

  const erc20Abi = [
    'function approve(address, uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ];
  const usdc = new ethers.Contract(USDC, erc20Abi, wallet);
  const mft  = new ethers.Contract(MFT, erc20Abi, wallet);

  console.log('USDC bal:', ethers.formatUnits(await usdc.balanceOf(wallet.address), 6));
  console.log('MfT bal:', ethers.formatEther(await mft.balanceOf(wallet.address)));
  console.log('');

  // === TX 1: Approve USDC to NPM ===
  console.log('--- TX 1: Approve USDC to NPM ---');
  let tx = await usdc.approve(NPM, USDC_APPROVE);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Done\n');

  // === TX 2: Approve MfT to NPM ===
  console.log('--- TX 2: Approve MfT to NPM ---');
  tx = await mft.approve(NPM, MFT_APPROVE);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Done\n');

  // === TX 3: Mint full-range position at wrong price ===
  console.log('--- TX 3: Mint position (1% pool, full range) ---');
  const npm = new ethers.Contract(NPM, [
    'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
  ], wallet);

  const deadline = Math.floor(Date.now() / 1000) + 600;
  tx = await npm.mint({
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: USDC_MINT,
    amount1Desired: MFT_MINT,
    amount0Min: 0,
    amount1Min: 0,
    recipient: REACTOR,
    deadline: deadline
  });
  console.log('Tx:', tx.hash);
  const receipt = await tx.wait();

  // Parse tokenId
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const transferLog = receipt.logs.find(lg =>
    lg.topics[0] === transferTopic &&
    lg.topics.length === 4 &&
    lg.topics[1] === ethers.zeroPadValue(ethers.ZeroAddress, 32)
  );
  const tokenId = BigInt(transferLog.topics[3]);
  console.log('Token ID:', tokenId.toString());
  console.log('NFT owner: reactor');

  // Check pool state after mint
  const poolContract = new ethers.Contract('0xcB7a140C422EFc9392FC578d1F47F721cd9DC914', [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function liquidity() view returns (uint128)'
  ], provider);
  let slot0 = await poolContract.slot0();
  console.log('Pool tick after mint:', slot0[1].toString());
  console.log('Pool liquidity:', (await poolContract.liquidity()).toString());
  console.log('');

  // === TX 4: Approve USDC to SwapRouter ===
  console.log('--- TX 4: Approve USDC to SwapRouter ---');
  tx = await usdc.approve(ROUTER, USDC_SWAP);
  console.log('Tx:', tx.hash);
  await tx.wait();
  console.log('Done\n');

  // === TX 5: Swap USDC → MfT to fix price ===
  console.log('--- TX 5: Swap USDC → MfT (fix price) ---');

  // Target sqrtPriceX96: based on real MfT price (~$0.000000268)
  // 1 USDC ≈ 3,735,497 MfT
  // price_raw = (3735497 * 10^18) / (1 * 10^6) = 3.735497e24
  // sqrtPriceX96 = sqrt(price_raw * 2^192)
  const Q192 = 2n ** 192n;
  const targetPrice = (BigInt('3735497') * BigInt('1000000000000000000')) * Q192 / BigInt('1000000');
  const targetSqrtPriceX96 = sqrtBigInt(targetPrice);
  console.log('Target sqrtPriceX96:', targetSqrtPriceX96.toString());

  // Swapping token0 (USDC) → token1 (MfT) pushes price UP
  // For zeroForOne = false (token0 → token1), sqrtPriceLimitX96 must be > current
  const swapRouter = new ethers.Contract(ROUTER, [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)'
  ], wallet);

  tx = await swapRouter.exactInputSingle({
    tokenIn: USDC,
    tokenOut: MFT,
    fee: FEE,
    recipient: wallet.address,
    amountIn: USDC_SWAP,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: targetSqrtPriceX96
  });
  console.log('Tx:', tx.hash);
  await tx.wait();

  // Check pool state after swap
  slot0 = await poolContract.slot0();
  console.log('Pool tick after swap:', slot0[1].toString());
  console.log('Price fixed!\n');

  // === TX 6: addPool on reactor ===
  console.log('--- TX 6: addPool ---');
  const reactor = new ethers.Contract(REACTOR, [
    'function addPool(uint256 tokenId)',
    'function poolCount() view returns (uint256)',
    'function pools(uint256) view returns (uint256 tokenId, address xToken, uint24 fee, bool tokenIsToken0)'
  ], wallet);

  tx = await reactor.addPool(tokenId);
  console.log('Tx:', tx.hash);
  await tx.wait();

  const pool = await reactor.pools(0);
  console.log('');
  console.log('========================================');
  console.log('REACTOR PRIME V2 SEEDED');
  console.log('Reactor:    ', REACTOR);
  console.log('Pool 0:      MfT/USDC (1% fee)');
  console.log('Token ID:   ', tokenId.toString());
  console.log('xToken:     ', pool.xToken, '(USDC)');
  console.log('MfT is token0:', pool.tokenIsToken0);
  console.log('Final tick: ', slot0[1].toString());
  console.log('execute() ready after 2hr cooldown');
  console.log('========================================');
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
