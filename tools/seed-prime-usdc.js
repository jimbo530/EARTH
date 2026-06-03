require('dotenv').config();
/**
 * seed-prime-usdc.js — Create MfT/USDC V3 pool, mint position, register in Reactor Prime
 */
const { ethers } = require('ethers');
const path = require('path');
const fs = require('fs');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const MFT      = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const USDC     = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PM       = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const REACTOR  = '0xB4dD1350738Ce8c01Cc229F14d7135a60a51634a';
const FEE      = 10000; // 1%

// USDC is token0 (0x8335 < 0x8FB8), MfT is token1
const TOKEN0 = USDC;
const TOKEN1 = MFT;
const SQRT_PRICE_X96 = '41625886572807675904';

// Full range ticks for 1% fee (tickSpacing = 200)
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

// Amounts: ~$50 each side
const USDC_AMOUNT = 50000000n;  // 50 USDC (6 decimals)
const MFT_AMOUNT  = ethers.parseEther('181134918'); // ~$50 of MfT

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)'
];

const PM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) payable returns (address pool)',
  'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address from, address to, uint256 tokenId)'
];

const REACTOR_ABI = ['function addPool(uint256 tokenId)', 'function poolCount() view returns (uint256)'];

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  console.log('Wallet:', wallet.address);

  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const mft = new ethers.Contract(MFT, ERC20_ABI, wallet);
  const pm = new ethers.Contract(PM, PM_ABI, wallet);
  const reactor = new ethers.Contract(REACTOR, REACTOR_ABI, wallet);

  // Step 1: Create and initialize pool
  console.log('\n--- Step 1: Create MfT/USDC V3 pool (1% fee) ---');
  const tx1 = await pm.createAndInitializePoolIfNecessary(TOKEN0, TOKEN1, FEE, SQRT_PRICE_X96);
  console.log('Tx:', tx1.hash);
  const r1 = await tx1.wait();
  console.log('Pool created! Gas:', r1.gasUsed.toString());

  // Step 2: Approve tokens
  console.log('\n--- Step 2: Approve tokens ---');
  const tx2a = await usdc.approve(PM, USDC_AMOUNT);
  console.log('USDC approve tx:', tx2a.hash);
  await tx2a.wait();
  const tx2b = await mft.approve(PM, MFT_AMOUNT);
  console.log('MfT approve tx:', tx2b.hash);
  await tx2b.wait();
  console.log('Approvals confirmed.');

  // Step 3: Mint position
  console.log('\n--- Step 3: Mint full-range position ---');
  console.log('USDC (token0):', ethers.formatUnits(USDC_AMOUNT, 6));
  console.log('MfT (token1):', ethers.formatEther(MFT_AMOUNT));

  const mintParams = {
    token0: TOKEN0,
    token1: TOKEN1,
    fee: FEE,
    tickLower: TICK_LOWER,
    tickUpper: TICK_UPPER,
    amount0Desired: USDC_AMOUNT,
    amount1Desired: MFT_AMOUNT,
    amount0Min: 0,
    amount1Min: 0,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600
  };

  const tx3 = await pm.mint(mintParams, { gasLimit: 1000000 });
  console.log('Mint tx:', tx3.hash);
  const r3 = await tx3.wait();
  console.log('Gas:', r3.gasUsed.toString());

  // Parse Transfer event to get tokenId
  let tokenId;
  for (const log of r3.logs) {
    // Transfer(address,address,uint256) - ERC721
    if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' && log.address.toLowerCase() === PM.toLowerCase()) {
      tokenId = BigInt(log.topics[3]);
      break;
    }
  }
  if (!tokenId) { console.log('ERROR: Could not find tokenId from mint'); return; }
  console.log('Position NFT ID:', tokenId.toString());

  // Step 4: Transfer NFT to reactor + register
  console.log('\n--- Step 4: Transfer NFT to Reactor Prime + register ---');
  const tx4a = await pm.safeTransferFrom(wallet.address, REACTOR, tokenId);
  console.log('Transfer tx:', tx4a.hash);
  await tx4a.wait();
  console.log('NFT transferred to reactor.');

  const tx4b = await reactor.addPool(tokenId);
  console.log('addPool tx:', tx4b.hash);
  await tx4b.wait();
  console.log('Pool registered!');

  const count = await reactor.poolCount();
  console.log('\n=== DONE ===');
  console.log('Reactor Prime pools:', count.toString());
  console.log('MfT/USDC position #' + tokenId.toString() + ' locked in reactor.');
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
