/**
 * sell-earth-for-btc.js — Every 2 hours, sell excess EARTH for cbBTC
 * Keeps a small EARTH buffer (0.001) for gas/operations.
 * Swaps via EARTH/cbBTC V3 pool (1% fee).
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.SAVINGS_PRIVATE_KEY;

const EARTH_ADDR = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const CBBTC_ADDR = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf';
const V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';

const KEEP_EARTH = ethers.parseEther('0.03'); // buffer to keep (initial deposit)
const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!PRIVATE_KEY) { console.error('Set KEEPER_PRIVATE_KEY in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);
  const cbbtc = new ethers.Contract(CBBTC_ADDR, ERC20_ABI, wallet);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);

  log('EARTH→cbBTC seller starting (every 2 hours)');
  log('Wallet: ' + wallet.address);
  log('Keep buffer: ' + ethers.formatEther(KEEP_EARTH) + ' EARTH');

  // Approve router once
  const approveTx = await earth.approve(V3_ROUTER, ethers.MaxUint256);
  await approveTx.wait();
  log('Router approved');

  while (true) {
    try {
      const earthBal = await earth.balanceOf(wallet.address);
      log('EARTH balance: ' + ethers.formatEther(earthBal));

      if (earthBal > KEEP_EARTH) {
        const sellAmount = earthBal - KEEP_EARTH;
        log('Selling ' + ethers.formatEther(sellAmount) + ' EARTH for cbBTC...');

        const tx = await router.exactInputSingle({
          tokenIn: EARTH_ADDR,
          tokenOut: CBBTC_ADDR,
          fee: 10000,
          recipient: wallet.address,
          amountIn: sellAmount,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        });
        const receipt = await tx.wait();

        const btcBal = await cbbtc.balanceOf(wallet.address);
        log('Sold! cbBTC balance: ' + ethers.formatUnits(btcBal, 8));
      } else {
        log('Below buffer, nothing to sell');
      }
    } catch(e) {
      log('Error: ' + (e.reason || e.shortMessage || e.message).slice(0, 100));
    }

    await sleep(INTERVAL_MS);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
