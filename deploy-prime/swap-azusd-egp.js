/**
 * Buy EGP with AZUSD $0.10 at a time through V2 pair, 1 min apart
 * Stops after $5 spent (50 swaps)
 * V2 pair: 0xba705f2982f46a1bb2bb7309afddfee8e7380ea9
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;

const AZUSD  = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const EGP    = '0xc1ba76771bbf0dd841347630e57c793f9d5accee';
const V2_ROUTER = '0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24';

const SWAP_AMOUNT = ethers.parseEther('0.1'); // $0.10
const MAX_SWAPS = 50; // $5 total
const DELAY_MS = 60000; // 1 min

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

  const azusd = new ethers.Contract(AZUSD, [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
  ], wallet);

  const egp = new ethers.Contract(EGP, [
    'function balanceOf(address) view returns (uint256)'
  ], wallet);

  const router = new ethers.Contract(V2_ROUTER, [
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)'
  ], wallet);

  const bal = await azusd.balanceOf(wallet.address);
  const egpBal = await egp.balanceOf(wallet.address);
  console.log('AZUSD balance:', ethers.formatEther(bal));
  console.log('EGP balance:', ethers.formatEther(egpBal));

  // Approve AZUSD to V2 router
  console.log('Approving AZUSD to V2 router...');
  const tx = await azusd.approve(V2_ROUTER, ethers.parseEther('10'));
  await tx.wait();
  console.log('Approved');
  console.log('');

  let count = 0;
  while (count < MAX_SWAPS) {
    const remaining = await azusd.balanceOf(wallet.address);
    if (remaining < SWAP_AMOUNT) {
      console.log('AZUSD remaining:', ethers.formatEther(remaining), '-- not enough, done');
      break;
    }

    count++;
    const ts = new Date().toISOString().slice(11, 19);
    try {
      const deadline = Math.floor(Date.now() / 1000) + 300;
      const swapTx = await router.swapExactTokensForTokens(
        SWAP_AMOUNT,
        0,
        [AZUSD, EGP],
        wallet.address,
        deadline
      );
      await swapTx.wait();
      const egpNow = ethers.formatEther(await egp.balanceOf(wallet.address));
      const azusdLeft = ethers.formatEther(await azusd.balanceOf(wallet.address));
      console.log(`[${ts}] #${count}/${MAX_SWAPS} | EGP: ${egpNow} | AZUSD left: ${azusdLeft}`);
    } catch (e) {
      console.log(`[${ts}] #${count} FAILED: ${e.message.slice(0, 120)}`);
    }

    if (count < MAX_SWAPS) await sleep(DELAY_MS);
  }

  console.log('');
  console.log('=== COMPLETE ===');
  console.log('Total swaps:', count);
  console.log('EGP balance:', ethers.formatEther(await egp.balanceOf(wallet.address)));
  console.log('AZUSD balance:', ethers.formatEther(await azusd.balanceOf(wallet.address)));
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
