/**
 * Add cbBTC pools to BURGERS, EGP, and AZUSD reactors
 * Creates V3 pools (they don't exist yet), mints LP, transfers to reactor, addPool()
 *
 * Prices (via AZUSD pools):
 *   BURGERS: $0.00000089
 *   EGP:     $0.00019796
 *   AZUSD:   $1.00
 *   cbBTC:   $76,458
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');

const RPC = 'https://mainnet.base.org';
const PK = process.env.AGENT_PRIVATE_KEY || process.env.KEEPER_PRIVATE_KEY;

const cbBTC = '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf'; // 8 dec
const PM    = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const FEE   = 10000;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

const BTC_USD = 76458;

const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
];
const NPM_ABI = [
  'function createAndInitializePoolIfNecessary(address token0, address token1, uint24 fee, uint160 sqrtPriceX96) external payable returns (address pool)',
  'function mint((address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function safeTransferFrom(address,address,uint256)',
];
const REACTOR_ABI = ['function addPool(uint256)', 'function poolCount() view returns (uint256)'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// All tokens are token0 (< 0xcbB7), cbBTC is token1
// V3 price = token1_raw / token0_raw
// For token0 (18 dec) at price $P0, and cbBTC (8 dec) at $76458:
//   1 raw token0 = 10^-18 tokens = 10^-18 * P0 USD
//   That buys (10^-18 * P0 / 76458) cbBTC = (10^-18 * P0 / 76458) * 10^8 raw cbBTC
//   price = (P0 / 76458) * 10^(8-18) = (P0 / 76458) * 10^-10
//   sqrtPriceX96 = sqrt(price) * 2^96

function calcSqrtPriceX96(tokenPriceUSD) {
  const price = (tokenPriceUSD / BTC_USD) * 1e-10;
  const sqrtPrice = Math.sqrt(price);
  // Use high precision: sqrtPrice * 2^96
  const Q96 = 2n ** 96n;
  const factor = 1e15; // precision multiplier
  const sqrtScaled = BigInt(Math.round(sqrtPrice * factor));
  return sqrtScaled * Q96 / BigInt(factor);
}

const REACTORS = [
  {
    name: 'BURGERS',
    reactor: '0xc858026Ec5D30280137032BC6EA86F46ea23C2CA',
    token: '0x06A05043eb2C1691b19c2C13219dB9212269dDc5',
    priceUSD: 0.00000089,
    // ~$3.91 / $0.00000089 = ~4,393,258 BURGERS needed (we have 25K, so limit to 25K)
    // At 25K BURGERS = $0.022 → cbBTC = $0.022/76458 = 0.00000000029 cbBTC (basically dust)
    // Actually we need to match: let's use the cbBTC as limiter
    cbbtcRaw: 1700n, // 0.000017 cbBTC (~$1.30)
    tokenAmount: ethers.parseEther('1500000'), // 1.5M BURGERS (~$1.33)
  },
  {
    name: 'EGP',
    reactor: '0x10A710fced92eB096F796F43BCCFb60884c13819',
    token: '0xc1ba76771bbf0dd841347630e57c793f9d5accee',
    priceUSD: 0.00019796,
    cbbtcRaw: 1700n, // 0.000017 cbBTC (~$1.30)
    tokenAmount: ethers.parseEther('6500'), // 6500 EGP (~$1.29)
  },
  {
    name: 'AZUSD',
    reactor: '0xD8AFb7caD1f8A3Ddc4E16c1516a94949eb119281',
    token: '0x3595ca37596D5895B70EFAB592ac315D5B9809B2',
    priceUSD: 1.0,
    cbbtcRaw: 1700n, // 0.000017 cbBTC (~$1.30)
    tokenAmount: ethers.parseEther('1.3'), // 1.3 AZUSD (~$1.30)
  },
];

async function main() {
  if (!PK) { console.error('No key'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const npm = new ethers.Contract(PM, NPM_ABI, wallet);
  console.log('Wallet:', wallet.address);

  // Approve cbBTC to PM
  console.log('Approving cbBTC...');
  const cbbtcToken = new ethers.Contract(cbBTC, ERC20_ABI, wallet);
  const allow = await cbbtcToken.allowance(wallet.address, PM);
  if (allow < 10000n) {
    const tx = await cbbtcToken.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
    await tx.wait();
    console.log('cbBTC approved');
  } else {
    console.log('cbBTC already approved');
  }

  for (const r of REACTORS) {
    console.log('\n=== ' + r.name + ' ===');

    const token0 = r.token; // always < cbBTC
    const token1 = cbBTC;

    // Approve token to PM
    await sleep(2000);
    const tokenContract = new ethers.Contract(r.token, ERC20_ABI, wallet);
    const tokenAllow = await tokenContract.allowance(wallet.address, PM);
    if (tokenAllow < r.tokenAmount) {
      console.log('Approving ' + r.name + '...');
      const tx = await tokenContract.approve(PM, ethers.MaxUint256, { gasLimit: 100_000 });
      await tx.wait();
    }

    // Create pool
    const sqrtPriceX96 = calcSqrtPriceX96(r.priceUSD);
    console.log('sqrtPriceX96: ' + sqrtPriceX96.toString());
    console.log('Creating ' + r.name + '/cbBTC pool...');
    await sleep(2000);
    const feeData = await provider.getFeeData();
    const gasOpts = { gasLimit: 5_000_000, maxFeePerGas: feeData.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * 3n };

    try {
      const tx = await npm.createAndInitializePoolIfNecessary(token0, token1, FEE, sqrtPriceX96, gasOpts);
      await tx.wait();
      console.log('Pool created');
    } catch (e) {
      console.log('Pool note: ' + e.message.slice(0, 100));
    }

    // Mint LP
    console.log('Minting: ' + ethers.formatEther(r.tokenAmount) + ' ' + r.name + ' + ' + ethers.formatUnits(r.cbbtcRaw, 8) + ' cbBTC');
    await sleep(2000);
    const feeData2 = await provider.getFeeData();
    const gasOpts2 = { gasLimit: 5_000_000, maxFeePerGas: feeData2.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData2.maxPriorityFeePerGas * 3n };

    const mintTx = await npm.mint({
      token0, token1, fee: FEE,
      tickLower: TICK_LOWER, tickUpper: TICK_UPPER,
      amount0Desired: r.tokenAmount,
      amount1Desired: r.cbbtcRaw,
      amount0Min: 0, amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
    }, gasOpts2);
    const receipt = await mintTx.wait();

    const transferTopic = ethers.id('Transfer(address,address,uint256)');
    const transferLog = receipt.logs.find(l => l.topics[0] === transferTopic && l.address.toLowerCase() === PM.toLowerCase());
    const tokenId = BigInt(transferLog.topics[3]);
    console.log('LP NFT: #' + tokenId.toString());

    // Transfer to reactor
    console.log('Transferring to reactor...');
    await sleep(2000);
    const feeData3 = await provider.getFeeData();
    const tx2 = await npm.safeTransferFrom(wallet.address, r.reactor, tokenId,
      { gasLimit: 500_000, maxFeePerGas: feeData3.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData3.maxPriorityFeePerGas * 3n });
    await tx2.wait();

    // addPool
    console.log('Adding pool...');
    await sleep(2000);
    const reactor = new ethers.Contract(r.reactor, REACTOR_ABI, wallet);
    const feeData4 = await provider.getFeeData();
    const tx3 = await reactor.addPool(tokenId,
      { gasLimit: 500_000, maxFeePerGas: feeData4.maxFeePerGas * 3n, maxPriorityFeePerGas: feeData4.maxPriorityFeePerGas * 3n });
    await tx3.wait();
    const count = await reactor.poolCount();
    console.log(r.name + ' reactor: ' + count.toString() + ' pools');
  }

  console.log('\nAll cbBTC fuel lines added.');
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
