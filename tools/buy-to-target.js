/**
 * buy-to-target.js — Buy $0.10 of EARTH every 60s until target price reached
 * Routes: USDC → WETH (0.05%) → EARTH (1%)
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const EARTH_ADDR = process.env.EARTH_TOKEN;

const USDC      = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH      = '0x4200000000000000000000000000000000000006';
const V3_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

const ROUTER_ABI = [
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];

const TARGET_PRICE = 100;       // $100 per EARTH
const AMOUNT_USDC = 100000n;    // $0.10
const INTERVAL_MS = 60000;      // 60 seconds
const MAX_ROUNDS = 1000;        // safety cap

function ts() { return new Date().toISOString().slice(0, 19); }

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, provider);

  console.log(`[${ts()}] Wallet: ${wallet.address}`);
  console.log(`[${ts()}] Target: $${TARGET_PRICE} per EARTH`);
  console.log(`[${ts()}] Buying $0.10 every 60s until target hit`);
  console.log('');

  // Approve big chunk upfront
  const bigApproval = AMOUNT_USDC * BigInt(MAX_ROUNDS);
  const allowance = await usdc.allowance(wallet.address, V3_ROUTER);
  if (allowance < bigApproval) {
    console.log(`[${ts()}] Approving USDC to router...`);
    const nonce = await provider.getTransactionCount(wallet.address, 'latest');
    const tx = await usdc.approve(V3_ROUTER, bigApproval, { nonce });
    await tx.wait();
    console.log(`[${ts()}] Approved`);
  }

  const path = ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [USDC, 500, WETH, 10000, EARTH_ADDR]
  );

  let totalEarth = 0n;
  let totalSpent = 0;
  let currentPrice = 0;

  for (let i = 1; i <= MAX_ROUNDS; i++) {
    try {
      // Check USDC balance
      const usdcBal = await usdc.balanceOf(wallet.address);
      if (usdcBal < AMOUNT_USDC) {
        console.log(`[${ts()}] Out of USDC ($${ethers.formatUnits(usdcBal, 6)} remaining). Stopping.`);
        break;
      }

      const earthBefore = await earth.balanceOf(wallet.address);
      const nonce = await provider.getTransactionCount(wallet.address, 'latest');

      const tx = await router.exactInput({
        path,
        recipient: wallet.address,
        amountIn: AMOUNT_USDC,
        amountOutMinimum: 0n,
      }, { nonce });
      await tx.wait();

      const earthAfter = await earth.balanceOf(wallet.address);
      const got = earthAfter - earthBefore;
      totalEarth += got;
      totalSpent += 0.10;

      if (got > 0n) {
        currentPrice = 0.10 / Number(ethers.formatEther(got));
      }

      console.log(`[${ts()}] #${i} | Got: ${ethers.formatEther(got)} | Price: $${currentPrice.toFixed(2)} | Spent: $${totalSpent.toFixed(2)} | Total EARTH: ${ethers.formatEther(totalEarth)}`);

      if (currentPrice >= TARGET_PRICE) {
        console.log('');
        console.log(`[${ts()}] TARGET HIT! $${currentPrice.toFixed(2)} per EARTH`);
        break;
      }
    } catch (e) {
      console.log(`[${ts()}] #${i} ERROR: ${e.shortMessage || e.message}`);
    }

    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }

  const finalEarth = await earth.balanceOf(wallet.address);
  const finalUsdc = await usdc.balanceOf(wallet.address);
  console.log('');
  console.log(`[${ts()}] ════════════════════════════════════════`);
  console.log(`[${ts()}]   Final price:  $${currentPrice.toFixed(2)}`);
  console.log(`[${ts()}]   Total spent:  $${totalSpent.toFixed(2)}`);
  console.log(`[${ts()}]   EARTH held:   ${ethers.formatEther(finalEarth)}`);
  console.log(`[${ts()}]   USDC left:    ${ethers.formatUnits(finalUsdc, 6)}`);
  console.log(`[${ts()}] ════════════════════════════════════════`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
