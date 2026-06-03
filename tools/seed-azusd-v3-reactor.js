/**
 * Seed AZUSD V3 Reactor — create LP positions for MfT, USDC, WETH
 * ~$1 each side, full range, 1% fee
 *
 * Usage:
 *   node tools/seed-azusd-v3-reactor.js check
 *   node tools/seed-azusd-v3-reactor.js approve
 *   node tools/seed-azusd-v3-reactor.js mint
 *   node tools/seed-azusd-v3-reactor.js transfer
 *   node tools/seed-azusd-v3-reactor.js addpools
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', 'Baselings', 'api', '.env') });
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = 'https://base.publicnode.com';
const PK = process.env.AGENT_PRIVATE_KEY;

const AZUSD = '0x3595ca37596D5895B70EFAB592ac315D5B9809B2';
const MFT   = '0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3';
const USDC  = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH  = '0x4200000000000000000000000000000000000006';

const NPM     = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
const FACTORY = '0x33128a8fC17869897dcE68Ed026d694621f6FDfD';
const REACTOR = fs.readFileSync(path.join(__dirname, 'azusd-reactor-v3-address.txt'), 'utf8').trim();

const FEE = 10000; // 1%
const TICK_SPACING = 200;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;

const delay = ms => new Promise(r => setTimeout(r, ms));

// Pairs: AZUSD is always token0 (0x3595 < all others)
const PAIRS = [
  {
    name: 'AZUSD/MfT',
    token0: AZUSD, token1: MFT,
    dec0: 18, dec1: 18,
    // ~$1 each side: 1 AZUSD + ~3.3M MfT
    amount0: ethers.parseEther('1'),
    amount1: ethers.parseEther('3300000'),
    // price = MfT per AZUSD ≈ 3,333,333 → tick ≈ 150220
    initTick: 150220,
  },
  {
    name: 'AZUSD/USDC',
    token0: AZUSD, token1: USDC,
    dec0: 18, dec1: 6,
    // ~$1 each side: 1 AZUSD + 1 USDC
    amount0: ethers.parseEther('1'),
    amount1: ethers.parseUnits('1', 6),
    // price = USDC_raw / AZUSD_raw = 1e6/1e18 = 1e-12 → tick = ln(1e-12)/ln(1.0001) ≈ -276324
    // Round to nearest 200: -276400
    initTick: -276400,
  },
  {
    name: 'AZUSD/WETH',
    token0: AZUSD, token1: WETH,
    dec0: 18, dec1: 18,
    // ~$1 each side: 1 AZUSD + 0.0004 WETH ($1 at ~$2500)
    amount0: ethers.parseEther('1'),
    amount1: ethers.parseEther('0.0004'),
    // price = WETH per AZUSD = 1/2500 = 0.0004 → tick = ln(0.0004)/ln(1.0001) ≈ -78244
    // Round to nearest 200: -78200
    initTick: -78200,
  },
];

function tickToSqrtPriceX96(tick) {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const Q96 = 2n ** 96n;
  const sqrtPriceBig = BigInt(Math.round(sqrtPrice * 1e15));
  return (sqrtPriceBig * Q96) / BigInt(1e15);
}

async function main() {
  if (!PK) { console.error('No AGENT_PRIVATE_KEY'); process.exit(1); }

  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  const cmd = process.argv[2] || 'check';

  console.log('Wallet:', wallet.address);
  console.log('Reactor V3:', REACTOR);

  const factoryABI = [
    'function getPool(address,address,uint24) view returns (address)',
    'function createPool(address,address,uint24) returns (address)',
  ];
  const poolABI = [
    'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
    'function initialize(uint160)',
    'function liquidity() view returns (uint128)',
  ];
  const npmABI = [
    'function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
    'function safeTransferFrom(address,address,uint256)',
  ];
  const erc20ABI = [
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)',
  ];
  const reactorABI = [
    'function addPool(uint256)',
    'function poolCount() view returns (uint256)',
  ];

  const factory = new ethers.Contract(FACTORY, factoryABI, wallet);
  const npm = new ethers.Contract(NPM, npmABI, wallet);
  const reactor = new ethers.Contract(REACTOR, reactorABI, wallet);

  // ---- CHECK ----
  if (cmd === 'check') {
    for (const pair of PAIRS) {
      const poolAddr = await factory.getPool(pair.token0, pair.token1, FEE);
      console.log(`\n${pair.name} (1% fee):`);
      console.log('  Pool:', poolAddr);
      if (poolAddr === ethers.ZeroAddress) {
        console.log('  Status: DOES NOT EXIST — will create + initialize');
      } else {
        const pool = new ethers.Contract(poolAddr, poolABI, provider);
        try {
          const slot0 = await pool.slot0();
          console.log('  Tick:', slot0[1].toString());
          console.log('  Liquidity:', (await pool.liquidity()).toString());
        } catch (e) {
          console.log('  Status: exists but NOT INITIALIZED');
        }
      }
      await delay(1500);
    }
    console.log('\nReactor pools:', (await reactor.poolCount()).toString());
    return;
  }

  // ---- APPROVE ----
  if (cmd === 'approve') {
    const MAX = ethers.MaxUint256;
    const tokensToApprove = [
      { name: 'AZUSD', addr: AZUSD },
      { name: 'MfT', addr: MFT },
      { name: 'USDC', addr: USDC },
      { name: 'WETH', addr: WETH },
    ];
    for (const t of tokensToApprove) {
      const c = new ethers.Contract(t.addr, erc20ABI, wallet);
      const allowance = await c.allowance(wallet.address, NPM);
      if (allowance < ethers.parseEther('1000')) {
        console.log(`Approving ${t.name}...`);
        const tx = await c.approve(NPM, MAX);
        await tx.wait();
        console.log(`  ${t.name} approved`);
      } else {
        console.log(`${t.name} already approved`);
      }
      await delay(2000);
    }
    return;
  }

  // ---- MINT ----
  if (cmd === 'mint') {
    const tokenIds = [];

    for (const pair of PAIRS) {
      console.log(`\n--- ${pair.name} ---`);

      // Check/create pool
      let poolAddr = await factory.getPool(pair.token0, pair.token1, FEE);
      if (poolAddr === ethers.ZeroAddress) {
        console.log('Creating pool...');
        const tx = await factory.createPool(pair.token0, pair.token1, FEE);
        await tx.wait();
        await delay(3000);
        poolAddr = await factory.getPool(pair.token0, pair.token1, FEE);
        console.log('Pool created:', poolAddr);
      }

      // Initialize if needed
      const pool = new ethers.Contract(poolAddr, poolABI, wallet);
      try {
        const slot0 = await pool.slot0();
        if (slot0[0] === 0n) throw new Error('not init');
        console.log('Pool initialized, tick:', slot0[1].toString());
      } catch (e) {
        const sqrtPrice = tickToSqrtPriceX96(pair.initTick);
        console.log('Initializing at tick', pair.initTick, '...');
        const tx = await pool.initialize(sqrtPrice);
        await tx.wait();
        console.log('Initialized');
      }
      await delay(2000);

      // Mint position
      console.log('Minting LP...');
      console.log('  amount0:', ethers.formatUnits(pair.amount0, pair.dec0));
      console.log('  amount1:', ethers.formatUnits(pair.amount1, pair.dec1));

      const params = {
        token0: pair.token0,
        token1: pair.token1,
        fee: FEE,
        tickLower: TICK_LOWER,
        tickUpper: TICK_UPPER,
        amount0Desired: pair.amount0,
        amount1Desired: pair.amount1,
        amount0Min: 0,
        amount1Min: 0,
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
      };

      const tx = await npm.mint(params, { gasLimit: 600000 });
      const r = await tx.wait();
      console.log('Minted! Tx:', r.hash);

      // Find tokenId from logs
      for (const log of r.logs) {
        if (log.topics[0] === '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f') {
          const tokenId = BigInt(log.topics[1]);
          console.log('Position NFT #' + tokenId.toString());
          tokenIds.push(tokenId.toString());
        }
      }
      await delay(3000);
    }

    // Save token IDs
    fs.writeFileSync(path.join(__dirname, 'azusd-v3-tokenids.txt'), tokenIds.join('\n'));
    console.log('\nToken IDs saved to tools/azusd-v3-tokenids.txt');
    console.log('Next: node tools/seed-azusd-v3-reactor.js transfer');
    return;
  }

  // ---- TRANSFER ----
  if (cmd === 'transfer') {
    const idsFile = path.join(__dirname, 'azusd-v3-tokenids.txt');
    if (!fs.existsSync(idsFile)) { console.log('No token IDs. Run mint first.'); return; }
    const ids = fs.readFileSync(idsFile, 'utf8').trim().split('\n');

    for (const id of ids) {
      console.log('Transferring NFT #' + id + ' to reactor...');
      const tx = await npm.safeTransferFrom(wallet.address, REACTOR, id);
      await tx.wait();
      console.log('  Transferred');
      await delay(2000);
    }
    console.log('\nNext: node tools/seed-azusd-v3-reactor.js addpools');
    return;
  }

  // ---- ADDPOOLS ----
  if (cmd === 'addpools') {
    const idsFile = path.join(__dirname, 'azusd-v3-tokenids.txt');
    if (!fs.existsSync(idsFile)) { console.log('No token IDs. Run mint first.'); return; }
    const ids = fs.readFileSync(idsFile, 'utf8').trim().split('\n');

    for (const id of ids) {
      console.log('addPool(' + id + ')...');
      const tx = await reactor.addPool(id, { gasLimit: 300000 });
      await tx.wait();
      console.log('  Added');
      await delay(2000);
    }
    console.log('\nReactor pools:', (await reactor.poolCount()).toString());
    console.log('DONE! Update reactor-call-line.js with new address.');
    return;
  }

  console.log('Commands: check, approve, mint, transfer, addpools');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
