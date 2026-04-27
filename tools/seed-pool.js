/**
 * seed-pool.js — Create EARTH/WETH V3 pool at 1% fee, seed LP, register with Reactor
 *
 * Uses 0.5 EARTH + 0.0002 WETH for LP. Keeps 0.5 EARTH in wallet as first holder.
 * Prices EARTH at ~$1 (assuming ETH ~$2500).
 *
 * Steps:
 *   1. Wrap ETH → WETH
 *   2. Create + initialize EARTH/WETH pool (1% fee tier)
 *   3. Approve tokens to PositionManager
 *   4. Mint full-range V3 position
 *   5. Transfer position NFT to Reactor (locked forever)
 *   6. Register pool in Reactor (excludes pool from rebase)
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

// Deployed contracts
const EARTH_ADDR   = process.env.EARTH_TOKEN;
const REACTOR_ADDR = process.env.EARTH_REACTOR;

// Base chain addresses (verified from existing keepers)
const WETH_ADDR  = '0x4200000000000000000000000000000000000006';
const V3_NPM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';

// Pool params
const FEE_TIER    = 10000; // 1%
const TICK_SPACING = 200;
const MIN_TICK    = -887200;
const MAX_TICK    = 887200;

// LP amounts
const EARTH_FOR_LP = ethers.parseEther('0.5');  // 0.5 EARTH
const WETH_FOR_LP  = ethers.parseEther('0.0002'); // 0.0002 WETH (~$0.50)

// ABIs
const WETH_ABI = [
  'function deposit() payable',
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const NPM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];
const REACTOR_ABI = [
  'function addPool(uint256 tokenId) external',
  'function poolCount() view returns (uint256)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }

// Sort tokens for V3 (token0 < token1 by address)
function sortTokens(a, b) {
  return a.toLowerCase() < b.toLowerCase() ? [a, b, true] : [b, a, false];
}

// Calculate sqrtPriceX96 from price ratio (token1/token0)
function priceToSqrtX96(price) {
  const sqrtPrice = Math.sqrt(price);
  const Q96 = 2n ** 96n;
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}

async function main() {
  if (!PRIVATE_KEY) { console.error('Set KEEPER_PRIVATE_KEY in tools/.env'); process.exit(1); }
  if (!EARTH_ADDR || !REACTOR_ADDR) { console.error('Set EARTH_TOKEN and EARTH_REACTOR in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const weth = new ethers.Contract(WETH_ADDR, WETH_ABI, wallet);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);

  log('Wallet: ' + wallet.address);
  log('EARTH:  ' + EARTH_ADDR);
  log('Reactor: ' + REACTOR_ADDR);

  const ethBal = await provider.getBalance(wallet.address);
  const earthBal = await earth.balanceOf(wallet.address);
  log('ETH balance:   ' + ethers.formatEther(ethBal));
  log('EARTH balance: ' + ethers.formatEther(earthBal));
  log('');

  // ── Sort tokens (WETH < EARTH by address) ─────────────────────────────────
  const [token0, token1, wethIsToken0] = sortTokens(WETH_ADDR, EARTH_ADDR);
  log('token0: ' + token0 + (wethIsToken0 ? ' (WETH)' : ' (EARTH)'));
  log('token1: ' + token1 + (wethIsToken0 ? ' (EARTH)' : ' (WETH)'));

  // Price = token1 / token0
  // If WETH is token0: price = EARTH/WETH = 2500 (at $1 EARTH, $2500 ETH)
  // If EARTH is token0: price = WETH/EARTH = 0.0004
  const priceRatio = wethIsToken0
    ? Number(ethers.formatEther(EARTH_FOR_LP)) / Number(ethers.formatEther(WETH_FOR_LP))
    : Number(ethers.formatEther(WETH_FOR_LP)) / Number(ethers.formatEther(EARTH_FOR_LP));
  log('Price ratio (token1/token0): ' + priceRatio);

  const sqrtPriceX96 = priceToSqrtX96(priceRatio);
  log('sqrtPriceX96: ' + sqrtPriceX96.toString());
  log('');

  // ── Step 1: Wrap ETH → WETH ──────────────────────────────────────────────
  log('=== Step 1: Wrapping ETH → WETH ===');
  const wrapTx = await weth.deposit({ value: WETH_FOR_LP });
  log('Wrap tx: ' + wrapTx.hash);
  await wrapTx.wait();
  log('Wrapped ' + ethers.formatEther(WETH_FOR_LP) + ' ETH → WETH');

  // ── Step 2: Create + initialize pool ──────────────────────────────────────
  log('');
  log('=== Step 2: Creating EARTH/WETH pool (1% fee) ===');
  const poolTx = await npm.createAndInitializePoolIfNecessary(token0, token1, FEE_TIER, sqrtPriceX96);
  log('Pool tx: ' + poolTx.hash);
  const poolReceipt = await poolTx.wait();
  log('Pool created!');

  // ── Step 3: Approve tokens ────────────────────────────────────────────────
  log('');
  log('=== Step 3: Approving tokens ===');
  await (await earth.approve(V3_NPM, ethers.MaxUint256)).wait();
  await (await weth.approve(V3_NPM, ethers.MaxUint256)).wait();
  log('EARTH + WETH approved for PositionManager');

  // ── Step 4: Mint full-range position ──────────────────────────────────────
  log('');
  log('=== Step 4: Minting LP position ===');
  const amount0 = wethIsToken0 ? WETH_FOR_LP : EARTH_FOR_LP;
  const amount1 = wethIsToken0 ? EARTH_FOR_LP : WETH_FOR_LP;
  const deadline = Math.floor(Date.now() / 1000) + 600;

  const mintTx = await npm.mint({
    token0, token1,
    fee: FEE_TIER,
    tickLower: MIN_TICK,
    tickUpper: MAX_TICK,
    amount0Desired: amount0,
    amount1Desired: amount1,
    amount0Min: 0n,
    amount1Min: 0n,
    recipient: wallet.address,
    deadline,
  });
  log('Mint tx: ' + mintTx.hash);
  const mintReceipt = await mintTx.wait();

  // Parse tokenId from Transfer event
  let tokenId = null;
  for (const l of mintReceipt.logs) {
    if (l.topics.length === 4 && l.topics[0] === ethers.id('Transfer(address,address,uint256)')) {
      const from = '0x' + l.topics[1].slice(26);
      if (from === '0x0000000000000000000000000000000000000000') {
        tokenId = Number(BigInt(l.topics[3]));
        break;
      }
    }
  }
  if (!tokenId) { log('ERROR: Could not parse tokenId from mint receipt'); process.exit(1); }
  log('Position minted! Token ID: ' + tokenId);

  // ── Step 5: Transfer NFT to Reactor (PERMANENT) ──────────────────────────
  log('');
  log('=== Step 5: Transferring NFT to Reactor (LOCKED FOREVER) ===');
  const transferTx = await npm.safeTransferFrom(wallet.address, REACTOR_ADDR, tokenId);
  log('Transfer tx: ' + transferTx.hash);
  await transferTx.wait();
  log('NFT #' + tokenId + ' transferred to Reactor');

  // ── Step 6: Register pool in Reactor ──────────────────────────────────────
  log('');
  log('=== Step 6: Registering pool in Reactor ===');
  const addTx = await reactor.addPool(tokenId);
  log('addPool tx: ' + addTx.hash);
  await addTx.wait();
  const poolCount = await reactor.poolCount();
  log('Pool registered! Total pools: ' + poolCount.toString());

  // ── Summary ───────────────────────────────────────────────────────────────
  const finalEth = await provider.getBalance(wallet.address);
  const finalEarth = await earth.balanceOf(wallet.address);
  log('');
  log('════════════════════════════════════════════════════');
  log('  EARTH/WETH pool LIVE on Base');
  log('  Position NFT #' + tokenId + ' locked in Reactor');
  log('  Pool count: ' + poolCount.toString());
  log('  EARTH in wallet: ' + ethers.formatEther(finalEarth) + ' (holder, gets rebase)');
  log('  ETH remaining:   ' + ethers.formatEther(finalEth));
  log('  Gas used total:  ' + ethers.formatEther(ethBal - finalEth - WETH_FOR_LP) + ' ETH');
  log('════════════════════════════════════════════════════');
  log('');
  log('Machine is LIVE. Anyone can call execute() after 2hr cooldown.');
  log('Run keeper: node tools/keeper.js --loop');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
