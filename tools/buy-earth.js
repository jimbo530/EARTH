/**
 * buy-earth.js — Buy EARTH with USDC on the V3 pool
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;

const EARTH_ADDR = process.env.EARTH_TOKEN;
const USDC       = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH       = '0x4200000000000000000000000000000000000006';
const V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) external payable returns (uint256 amountOut)',
];
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function decimals() view returns (uint8)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);
  const usdc = new ethers.Contract(USDC, ERC20_ABI, wallet);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);

  const earthBefore = await earth.balanceOf(wallet.address);
  const usdcBal = await usdc.balanceOf(wallet.address);
  console.log('USDC balance:', ethers.formatUnits(usdcBal, 6));
  console.log('EARTH before:', ethers.formatEther(earthBefore));

  // Buy $0.10 worth — route USDC → WETH → EARTH
  // USDC has 6 decimals, so $0.10 = 100000
  const amountIn = 100000n; // 0.1 USDC

  // Approve USDC to router
  await (await usdc.approve(V3_ROUTER, amountIn)).wait();
  console.log('USDC approved');

  // Multi-hop: USDC →(0.05% fee)→ WETH →(1% fee)→ EARTH
  // Path encoding: token + fee + token + fee + token
  // USDC(6) → 500 fee → WETH → 10000 fee → EARTH
  const path = ethers.solidityPacked(
    ['address', 'uint24', 'address', 'uint24', 'address'],
    [USDC, 500, WETH, 10000, EARTH_ADDR]
  );

  console.log('Swapping $0.10 USDC → WETH → EARTH...');
  const tx = await router.exactInput({
    path: path,
    recipient: wallet.address,
    amountIn: amountIn,
    amountOutMinimum: 0n,
  });
  console.log('Tx:', tx.hash);
  await tx.wait();

  const earthAfter = await earth.balanceOf(wallet.address);
  const earthReceived = earthAfter - earthBefore;
  console.log('');
  console.log('EARTH received:', ethers.formatEther(earthReceived));
  console.log('EARTH after:   ', ethers.formatEther(earthAfter));
  console.log('');

  // Calculate effective price
  const pricePerEarth = 0.10 / Number(ethers.formatEther(earthReceived));
  console.log('Effective price: $' + pricePerEarth.toFixed(4) + ' per EARTH');
  console.log('Implied MC:      $' + pricePerEarth.toFixed(2) + ' (1 EARTH total supply)');
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
