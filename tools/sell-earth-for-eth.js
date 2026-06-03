/**
 * sell-earth-for-eth.js — Every 2 hours:
 * 1. Sell excess EARTH (above 0.03 buffer) for ETH via EARTH/WETH pool
 * 2. Once savings has 0.002+ ETH, distribute:
 *    - If any keeper < 0.001 ETH → send 0.001 to that keeper
 *    - If all keepers > 0.001 → send excess (keep 0.001) to user wallet
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.SAVINGS_PRIVATE_KEY;

const EARTH_ADDR = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const WETH_ADDR  = '0x4200000000000000000000000000000000000006';
const V3_ROUTER  = '0x2626664c2603336E57B271c5C0b26F421741e481';

const USER_WALLET = '0xEdc5999b1Ec1759970a681B9F5C197dd0B474016';
const KEEPERS = [
  '0xE2a4A8b9d77080c57799A94BA8eDeb2Dd6e0aC10', // EARTH/Baseling keeper
];

const KEEP_EARTH = ethers.parseEther('0.03');
const KEEP_ETH = ethers.parseEther('0.001');
const DISTRIBUTE_THRESHOLD = ethers.parseEther('0.002');
const KEEPER_MIN_ETH = ethers.parseEther('0.001');
const KEEPER_TOPUP = ethers.parseEther('0.001');
const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];
const WETH_ABI = [
  'function withdraw(uint256) external',
  'function balanceOf(address) view returns (uint256)',
];

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  if (!PRIVATE_KEY) { console.error('Set SAVINGS_PRIVATE_KEY in tools/.env'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const earth = new ethers.Contract(EARTH_ADDR, ERC20_ABI, wallet);
  const weth = new ethers.Contract(WETH_ADDR, WETH_ABI, wallet);
  const router = new ethers.Contract(V3_ROUTER, ROUTER_ABI, wallet);

  log('EARTH→ETH seller + gas distributor starting');
  log('Wallet: ' + wallet.address);
  log('Keepers: ' + KEEPERS.join(', '));
  log('User wallet: ' + USER_WALLET);

  // Approve router (skip if already done)
  const allowance = await earth.allowance(wallet.address, V3_ROUTER);
  if (allowance > ethers.parseEther('1000000')) {
    log('Router already approved');
  } else {
    const approveTx = await earth.approve(V3_ROUTER, ethers.MaxUint256);
    await approveTx.wait();
    log('Router approved');
  }

  while (true) {
    try {
      // ── Step 1: Sell excess EARTH for ETH ──
      const earthBal = await earth.balanceOf(wallet.address);
      log('EARTH: ' + ethers.formatEther(earthBal));

      if (earthBal > KEEP_EARTH) {
        const sellAmount = earthBal - KEEP_EARTH;
        log('Selling ' + ethers.formatEther(sellAmount) + ' EARTH for WETH...');

        const tx = await router.exactInputSingle({
          tokenIn: EARTH_ADDR,
          tokenOut: WETH_ADDR,
          fee: 10000,
          recipient: wallet.address,
          amountIn: sellAmount,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        });
        await tx.wait();

        // Unwrap WETH to ETH
        const wethBal = await weth.balanceOf(wallet.address);
        if (wethBal > 0n) {
          const unwrapTx = await weth.withdraw(wethBal);
          await unwrapTx.wait();
          log('Unwrapped ' + ethers.formatEther(wethBal) + ' WETH → ETH');
        }
      } else {
        log('EARTH below buffer, nothing to sell');
      }

      // ── Step 2: Distribute ETH if above threshold ──
      const ethBal = await provider.getBalance(wallet.address);
      log('ETH: ' + ethers.formatEther(ethBal));

      if (ethBal >= DISTRIBUTE_THRESHOLD) {
        // Check keepers
        let sent = false;
        for (const keeper of KEEPERS) {
          const kBal = await provider.getBalance(keeper);
          log('  Keeper ' + keeper.slice(0, 10) + '... ETH: ' + ethers.formatEther(kBal));
          if (kBal < KEEPER_MIN_ETH) {
            const myBal = await provider.getBalance(wallet.address);
            if (myBal >= KEEP_ETH + KEEPER_TOPUP) {
              const tx = await wallet.sendTransaction({ to: keeper, value: KEEPER_TOPUP });
              await tx.wait();
              log('  Sent 0.001 ETH to keeper ' + keeper.slice(0, 10) + '...');
              sent = true;
            }
          }
        }

        // If no keepers needed gas, send excess to user
        if (!sent) {
          const myBal = await provider.getBalance(wallet.address);
          if (myBal > KEEP_ETH) {
            const excess = myBal - KEEP_ETH - ethers.parseEther('0.00005'); // leave gas buffer
            if (excess > 0n) {
              const tx = await wallet.sendTransaction({ to: USER_WALLET, value: excess });
              await tx.wait();
              log('  Sent ' + ethers.formatEther(excess) + ' ETH to user wallet');
            }
          }
        }
      } else {
        log('ETH below 0.002 threshold, saving up');
      }

    } catch(e) {
      log('Error: ' + (e.reason || e.shortMessage || e.message).slice(0, 100));
    }

    await sleep(INTERVAL_MS);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
