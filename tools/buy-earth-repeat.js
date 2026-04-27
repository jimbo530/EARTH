/**
 * buy-earth-repeat.js — Buy $0.10 of EARTH every 60 seconds for 10 rounds
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

const ROUNDS = 10;
const AMOUNT_USDC = 100000n; // $0.10 in 6 decimals
const INTERVAL_MS = 60000;   // 60 seconds

function ts() { return new Date().toISOString().slice(0, 19); }

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, provider);

  console.log(`[${ts()}] Wallet: ${wallet.address}`);
  console.log(`[${ts()}] Plan: Buy $0.10 EARTH x ${ROUNDS} rounds, 1/min`);
  console.log('');

  // Approve USDC for all rounds upfront
  const totalUsdc = AMOUNT_USDC * BigInt(ROUNDS);
  const allowance = await usdc.allowance(wallet.address, V3_ROUTER);
  if (allowance < totalUsdc) {
    console.log(`[${ts()}] Approving $${Number(totalUsdc) / 1e6} USDC to router...`);
    const nonce = await provider.getTransactionCount(wallet.address, 'latest');
    const tx = await usdc.approve(V3_ROUTER, totalUsdc, { nonce });
    await tx.wait();
    console.log(`[${ts()}] Approved`);
  }

  // USDC → WETH (0.05%) → EARTH (1%)
  const path = ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [USDC, 500, WETH, 10000, EARTH_ADDR]
  );

  let totalEarth = 0n;

  for (let i = 1; i <= ROUNDS; i++) {
    try {
      const earthBefore = await earth.balanceOf(wallet.address);
      const nonce = await provider.getTransactionCount(wallet.address, 'latest');

      console.log(`[${ts()}] Round ${i}/${ROUNDS} — buying $0.10 of EARTH...`);
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

      const price = 0.10 / Number(ethers.formatEther(got));
      console.log(`[${ts()}]   Got: ${ethers.formatEther(got)} EARTH | Price: $${price.toFixed(4)} | Total: ${ethers.formatEther(totalEarth)}`);
    } catch (e) {
      console.log(`[${ts()}]   ERROR: ${e.shortMessage || e.message}`);
    }

    if (i < ROUNDS) {
      console.log(`[${ts()}]   Waiting 60s...`);
      await new Promise(r => setTimeout(r, INTERVAL_MS));
    }
  }

  const finalEarth = await earth.balanceOf(wallet.address);
  const finalUsdc = await usdc.balanceOf(wallet.address);
  const finalPrice = 1.0 / Number(ethers.formatEther(totalEarth / 10n)); // avg over $1 spent

  console.log('');
  console.log(`[${ts()}] ════════════════════════════════════════`);
  console.log(`[${ts()}]   Done! ${ROUNDS} buys complete`);
  console.log(`[${ts()}]   Total EARTH bought: ${ethers.formatEther(totalEarth)}`);
  console.log(`[${ts()}]   Total spent: $1.00`);
  console.log(`[${ts()}]   EARTH balance: ${ethers.formatEther(finalEarth)}`);
  console.log(`[${ts()}]   USDC remaining: ${ethers.formatUnits(finalUsdc, 6)}`);
  console.log(`[${ts()}] ════════════════════════════════════════`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
