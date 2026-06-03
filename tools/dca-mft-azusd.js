/**
 * DCA buy MfT with AZUSD through the MfT/AZUSD V3 pool
 * $0.25 AZUSD per swap, 1 swap per minute
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const AZUSD  = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const MFT    = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const FEE    = 10000;

const SWAP_AMOUNT = ethers.parseEther('0.25');
const INTERVAL_MS = 60_000;

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];

const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const router = new ethers.Contract(ROUTER, ROUTER_ABI, wallet);
  const azusd = new ethers.Contract(AZUSD, ERC20_ABI, wallet);
  const mft = new ethers.Contract(MFT, ERC20_ABI, provider);

  console.log('Wallet:', wallet.address);
  console.log('DCA: 0.25 AZUSD -> MfT every 60s');

  // Approve router if needed
  const allowance = await azusd.allowance(wallet.address, ROUTER);
  if (allowance < ethers.parseEther('1000')) {
    console.log('Approving AZUSD to router...');
    const tx = await azusd.approve(ROUTER, ethers.MaxUint256);
    await tx.wait();
    console.log('Approved');
  }

  let swapCount = 0;

  async function doSwap() {
    try {
      const bal = await azusd.balanceOf(wallet.address);
      if (bal < SWAP_AMOUNT) {
        console.log('[' + new Date().toLocaleTimeString() + '] Not enough AZUSD (' + ethers.formatEther(bal) + '). Stopping.');
        process.exit(0);
      }

      const tx = await router.exactInputSingle({
        tokenIn: AZUSD,
        tokenOut: MFT,
        fee: FEE,
        recipient: wallet.address,
        amountIn: SWAP_AMOUNT,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0,
      }, { gasLimit: 500_000 });
      const receipt = await tx.wait();

      swapCount++;
      const mftBal = await mft.balanceOf(wallet.address);
      const azusdBal = await azusd.balanceOf(wallet.address);
      console.log('[' + new Date().toLocaleTimeString() + '] Swap #' + swapCount + ' | 0.25 AZUSD -> MfT | MfT: ' + Number(ethers.formatEther(mftBal)).toFixed(0) + ' | AZUSD left: ' + ethers.formatEther(azusdBal) + ' | tx: ' + receipt.hash.slice(0, 10) + '...');
    } catch (e) {
      console.error('[' + new Date().toLocaleTimeString() + '] Swap failed:', e.message.slice(0, 120));
    }
  }

  await doSwap();
  setInterval(doSwap, INTERVAL_MS);
}

main().catch(err => { console.error('ERROR:', err.message); process.exit(1); });
