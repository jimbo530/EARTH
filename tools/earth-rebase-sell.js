/**
 * EARTH Rebase Sell
 *
 * Holds 0.03 EARTH, sells excess for ETH via EARTH/WETH V3 pool.
 * Distributes ETH gas to agent wallets that are running low.
 *
 * Usage:
 *   node earth-rebase-sell.js              — run once
 *   node earth-rebase-sell.js --loop       — check every 30 min
 */

// Load .env — local dir first (VPS), then Baselings fallback (dev)
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const RPC = 'https://mainnet.base.org';
const PK  = process.env.TRADE2_PRIVATE_KEY;

const EARTH  = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const WETH   = '0x4200000000000000000000000000000000000006';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FEE    = 10000;

const HOLD_AMOUNT    = ethers.parseEther('0.1');    // keep 0.1 EARTH for rebase
const MIN_SELL       = ethers.parseEther('0.001');  // don't sell dust
const GAS_LOW        = ethers.parseEther('0.0005'); // top up if below this
const GAS_TARGET     = ethers.parseEther('0.002');  // top up to this amount
const CHECK_INTERVAL = 24 * 60 * 60 * 1000;        // 24 hours

// Agent wallets to keep funded with gas
const AGENT_WALLETS = [
  // Game wallet
  '0x6f5CCeAf0820228FCF5D6644F0b0736Ea4f7f61F',
  // Trade wallet
  '0xb4D045c656a303fa6452C43EefAEB7D8B40917CC',
];

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const WETH_ABI = [
  'function withdraw(uint256 wad)',
  'function balanceOf(address) view returns (uint256)',
];

function ts() { return new Date().toISOString().slice(0, 19); }
function log(msg) { console.log('[' + ts() + '] ' + msg); }

async function run(provider, wallet) {
  const earth = new ethers.Contract(EARTH, ERC20_ABI, wallet);
  const weth = new ethers.Contract(WETH, WETH_ABI, wallet);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);

  // Check EARTH balance
  const earthBal = await earth.balanceOf(wallet.address);
  log('EARTH balance: ' + ethers.formatEther(earthBal));

  if (earthBal <= HOLD_AMOUNT) {
    log('Below hold threshold (0.03). Nothing to sell.');
    return;
  }

  const excess = earthBal - HOLD_AMOUNT;
  if (excess < MIN_SELL) {
    log('Excess too small to sell (' + ethers.formatEther(excess) + ')');
    return;
  }

  // Approve EARTH to router if needed
  const allowance = await earth.allowance(wallet.address, ROUTER);
  if (allowance < excess) {
    log('Approving EARTH to router...');
    const appTx = await earth.approve(ROUTER, ethers.MaxUint256, { gasLimit: 100_000 });
    await appTx.wait();
    log('Approved');
  }

  // Swap EARTH → WETH
  log('Selling ' + ethers.formatEther(excess) + ' EARTH for WETH...');
  const feeData = await provider.getFeeData();
  const tx = await router.exactInputSingle({
    tokenIn: EARTH,
    tokenOut: WETH,
    fee: FEE,
    recipient: wallet.address,
    amountIn: excess,
    amountOutMinimum: 0,
    sqrtPriceLimitX96: 0,
  }, {
    gasLimit: 500_000,
    maxFeePerGas: feeData.maxFeePerGas * 3n,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n,
  });
  const receipt = await tx.wait();
  log('Sold | tx: ' + receipt.hash.slice(0, 14) + '...');

  // Unwrap WETH → ETH
  const wethBal = await weth.balanceOf(wallet.address);
  if (wethBal > 0n) {
    log('Unwrapping ' + ethers.formatEther(wethBal) + ' WETH...');
    const unwrapTx = await weth.withdraw(wethBal, { gasLimit: 100_000 });
    await unwrapTx.wait();
    log('Unwrapped to ETH');
  }

  // Distribute gas to agent wallets
  const selfBal = await provider.getBalance(wallet.address);
  log('Keeper ETH after sell: ' + ethers.formatEther(selfBal));

  for (const addr of AGENT_WALLETS) {
    const bal = await provider.getBalance(addr);
    log('  ' + addr.slice(0, 10) + '... ETH: ' + ethers.formatEther(bal));

    if (bal < GAS_LOW) {
      const sendAmount = GAS_TARGET - bal;
      const keeperBal = await provider.getBalance(wallet.address);

      // Keep enough for our own gas
      if (keeperBal < sendAmount + ethers.parseEther('0.001')) {
        log('  Not enough ETH to top up ' + addr.slice(0, 10) + '...');
        continue;
      }

      log('  Topping up ' + addr.slice(0, 10) + '... with ' + ethers.formatEther(sendAmount) + ' ETH');
      const sendTx = await wallet.sendTransaction({
        to: addr,
        value: sendAmount,
        gasLimit: 21_000,
      });
      await sendTx.wait();
      log('  Sent | tx: ' + sendTx.hash.slice(0, 14) + '...');
    }
  }

  const finalBal = await provider.getBalance(wallet.address);
  log('Keeper ETH remaining: ' + ethers.formatEther(finalBal));
}

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);

  log('=== EARTH Rebase Sell ===');
  log('Wallet: ' + wallet.address);
  log('Hold: 0.1 EARTH | Sell excess for ETH');
  log('Gas wallets: ' + AGENT_WALLETS.length);

  if (process.argv[2] === '--loop') {
    log('Loop mode — checking once per day');
    while (true) {
      try {
        await run(provider, wallet);
      } catch (e) {
        log('ERROR: ' + e.message.slice(0, 150));
      }
      log('Next check in 24 hours\n');
      await new Promise(r => setTimeout(r, CHECK_INTERVAL));
    }
  } else {
    await run(provider, wallet);
  }
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
