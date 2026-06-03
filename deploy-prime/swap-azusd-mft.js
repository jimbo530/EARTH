/**
 * Buy MfT with AZUSD $0.10 at a time through the 1% pool, 1 min apart
 * Runs until AZUSD balance < 0.1
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;

const AZUSD  = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const MFT    = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';

const SWAP_AMOUNT = ethers.parseEther('0.1'); // $0.10
const DELAY_MS = 60000; // 1 min

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const azusd = new ethers.Contract(AZUSD, [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ], wallet);

  const router = new ethers.Contract(ROUTER, [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)'
  ], wallet);

  // Approve max upfront
  const bal = await azusd.balanceOf(wallet.address);
  console.log('AZUSD balance:', ethers.formatEther(bal));
  console.log('Approving all to router...');
  const tx = await azusd.approve(ROUTER, bal);
  await tx.wait();
  console.log('Approved');
  console.log('');

  let count = 0;
  while (true) {
    const remaining = await azusd.balanceOf(wallet.address);
    if (remaining < SWAP_AMOUNT) {
      console.log('AZUSD remaining:', ethers.formatEther(remaining), '— done');
      break;
    }

    count++;
    const ts = new Date().toISOString().slice(11, 19);
    try {
      const swapTx = await router.exactInputSingle({
        tokenIn: AZUSD,
        tokenOut: MFT,
        fee: 10000,
        recipient: wallet.address,
        amountIn: SWAP_AMOUNT,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
      });
      await swapTx.wait();
      const left = ethers.formatEther(await azusd.balanceOf(wallet.address));
      console.log(`[${ts}] #${count} | AZUSD left: ${left}`);
    } catch (e) {
      console.log(`[${ts}] #${count} FAILED: ${e.message.slice(0, 100)}`);
    }

    await sleep(DELAY_MS);
  }

  console.log('');
  console.log('=== COMPLETE ===');
  console.log('Total swaps:', count);
  console.log('MfT balance:', ethers.formatEther(await new ethers.Contract(MFT, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(wallet.address)));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
