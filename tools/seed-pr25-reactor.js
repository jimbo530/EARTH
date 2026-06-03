/**
 * Seed PR25 reactor with LP positions against all game tokens
 * Usage: node tools/seed-pr25-reactor.js
 */
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');

const envContent = fs.readFileSync(path.resolve('C:/Users/bigji/Documents/Tales-of-Tasern/tools/.env'), 'utf8');
const PK = envContent.match(/BALANCER_PRIVATE_KEY=(\S+)/)[1].trim();

const RPC = 'https://polygon-bor-rpc.publicnode.com';
const PR25 = '0x72e4327f592e9cb09d5730a55d1d68de144af53c';
const NPM = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
const REACTOR = '0xA4100Fc1B2B33FaB79f8E99e04185Fe7361FaF5D';
const FEE = 10000;
const TICK_LOWER = -887200;
const TICK_UPPER = 887200;
const PR25_DEC = 10;

const delay = ms => new Promise(r => setTimeout(r, ms));

// All game tokens to pair with PR25
// PR25 amount per pool: ~0.15 each (8 pools from ~1.4 PR25)
const PAIRS = [
  { name: 'EGP',  addr: '0x64f6f111e9fdb753877f17f399b759de97379170', dec: 18, otherAmt: '1000',   pr25Amt: '0.15' },
  { name: 'OGC',  addr: '0xccf37622e6b72352e7b410481dd4913563038b7c', dec: 18, otherAmt: '100000', pr25Amt: '0.15' },
  { name: 'IGS',  addr: '0xe302672798d12e7f68c783db2c2d5e6b48ccf3ce', dec: 8,  otherAmt: '100000', pr25Amt: '0.15' },
  { name: 'BTN',  addr: '0xd7c584d40216576f1d8651eab8bef9de69497666', dec: 8,  otherAmt: '100000', pr25Amt: '0.15' },
  { name: 'LGP',  addr: '0xddc330761761751e005333208889bfe36c6e6760', dec: 18, otherAmt: '100000', pr25Amt: '0.15' },
  { name: 'DHG',  addr: '0x75c0a194cd8b4f01d5ed58be5b7c5b61a9c69d0a', dec: 8,  otherAmt: '100000', pr25Amt: '0.15' },
  { name: 'PKT',  addr: '0x8a088dceecbcf457762eb7c66f78fff27dc0c04a', dec: 18, otherAmt: '100000', pr25Amt: '0.15' },
  { name: 'CCC',  addr: '0x11f98a36acbd04ca3aa3a149d402affbd5966fe7', dec: 16, otherAmt: '50',     pr25Amt: '0.15' },
];

function tickToSqrtPriceX96(tick) {
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const Q96 = 2n ** 96n;
  const sqrtPriceBig = BigInt(Math.round(sqrtPrice * 1e15));
  return (sqrtPriceBig * Q96) / BigInt(1e15);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const wallet = new ethers.Wallet(PK, provider);
  console.log('Wallet:', wallet.address);

  const factoryC = new ethers.Contract(FACTORY, [
    'function getPool(address,address,uint24) view returns (address)',
    'function createPool(address,address,uint24) returns (address)',
  ], wallet);

  const poolABI = [
    'function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
    'function initialize(uint160)',
  ];

  const npmABI = [
    'function mint(tuple(address token0,address token1,uint24 fee,int24 tickLower,int24 tickUpper,uint256 amount0Desired,uint256 amount1Desired,uint256 amount0Min,uint256 amount1Min,address recipient,uint256 deadline)) payable returns (uint256 tokenId,uint128 liquidity,uint256 amount0,uint256 amount1)',
    'function safeTransferFrom(address,address,uint256)',
  ];

  const erc20ABI = [
    'function approve(address,uint256) returns (bool)',
    'function allowance(address,address) view returns (uint256)',
  ];

  const npm = new ethers.Contract(NPM, npmABI, wallet);
  const reactorABI = ['function addPool(uint256)', 'function poolCount() view returns (uint256)'];
  const reactor = new ethers.Contract(REACTOR, reactorABI, wallet);

  // Approve all tokens for NPM first
  console.log('\n--- Approving all tokens ---');
  const allTokens = [PR25, ...PAIRS.map(p => p.addr)];
  for (const addr of allTokens) {
    const c = new ethers.Contract(addr, erc20ABI, wallet);
    const allowance = await c.allowance(wallet.address, NPM);
    if (allowance < ethers.parseEther('1000000')) {
      const tx = await c.approve(NPM, ethers.MaxUint256, { type: 0 });
      await tx.wait();
      console.log('Approved:', addr.slice(0, 10) + '...');
    }
    await delay(1000);
  }

  const tokenIds = [];

  for (const pair of PAIRS) {
    console.log('\n--- ' + pair.name + '/PR25 ---');

    // Determine token ordering
    const isOtherToken0 = pair.addr.toLowerCase() < PR25.toLowerCase();
    const token0 = isOtherToken0 ? pair.addr : PR25;
    const token1 = isOtherToken0 ? PR25 : pair.addr;
    const dec0 = isOtherToken0 ? pair.dec : PR25_DEC;
    const dec1 = isOtherToken0 ? PR25_DEC : pair.dec;
    const amount0 = ethers.parseUnits(isOtherToken0 ? pair.otherAmt : pair.pr25Amt, dec0);
    const amount1 = ethers.parseUnits(isOtherToken0 ? pair.pr25Amt : pair.otherAmt, dec1);

    // Check/create pool
    let poolAddr = await factoryC.getPool(token0, token1, FEE);
    if (poolAddr === ethers.ZeroAddress) {
      console.log('Creating pool...');
      const tx = await factoryC.createPool(token0, token1, FEE, { type: 0 });
      await tx.wait();
      await delay(3000);
      poolAddr = await factoryC.getPool(token0, token1, FEE);
      console.log('Pool created:', poolAddr);
    }

    // Initialize if needed
    const pool = new ethers.Contract(poolAddr, poolABI, wallet);
    try {
      const slot0 = await pool.slot0();
      if (slot0[0] === 0n) throw new Error('not init');
      console.log('Pool initialized, tick:', slot0[1].toString());
    } catch (e) {
      // Calculate init tick from amounts and decimals
      // price = amount1_raw / amount0_raw
      const rawPrice = Number(amount1) / Number(amount0);
      const initTick = Math.round(Math.log(rawPrice) / Math.log(1.0001));
      // Round to tick spacing
      const rounded = Math.round(initTick / 200) * 200;
      const sqrtPrice = tickToSqrtPriceX96(rounded);
      console.log('Initializing at tick', rounded, '...');
      const tx = await pool.initialize(sqrtPrice, { type: 0 });
      await tx.wait();
      console.log('Initialized');
    }
    await delay(2000);

    // Mint position
    console.log('Minting LP...');
    console.log('  token0:', ethers.formatUnits(amount0, dec0), isOtherToken0 ? pair.name : 'PR25');
    console.log('  token1:', ethers.formatUnits(amount1, dec1), isOtherToken0 ? 'PR25' : pair.name);

    const params = {
      token0, token1, fee: FEE,
      tickLower: TICK_LOWER,
      tickUpper: TICK_UPPER,
      amount0Desired: amount0,
      amount1Desired: amount1,
      amount0Min: 0,
      amount1Min: 0,
      recipient: wallet.address,
      deadline: Math.floor(Date.now() / 1000) + 600,
    };

    const tx = await npm.mint(params, { gasLimit: 600000, type: 0 });
    const r = await tx.wait();
    console.log('Minted! Tx:', r.hash.slice(0, 20) + '...');

    // Find tokenId
    for (const log of r.logs) {
      if (log.topics[0] === '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f') {
        const tokenId = BigInt(log.topics[1]);
        console.log('Position NFT #' + tokenId.toString());
        tokenIds.push(tokenId.toString());
      }
    }
    // Fallback: check Transfer from NPM
    if (tokenIds.length < PAIRS.indexOf(pair) + 1) {
      for (const log of r.logs) {
        if (log.topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' &&
            log.address.toLowerCase() === NPM.toLowerCase() && log.topics.length === 4) {
          const tokenId = BigInt(log.topics[3]);
          console.log('Position NFT #' + tokenId.toString());
          tokenIds.push(tokenId.toString());
        }
      }
    }
    await delay(3000);
  }

  // Transfer all NFTs to reactor
  console.log('\n--- Transferring NFTs to reactor ---');
  for (const id of tokenIds) {
    console.log('Transferring #' + id + '...');
    const tx = await npm.safeTransferFrom(wallet.address, REACTOR, id, { gasLimit: 300000, type: 0 });
    await tx.wait();
    console.log('  Done');
    await delay(2000);
  }

  // addPool for each
  console.log('\n--- Adding pools to reactor ---');
  for (const id of tokenIds) {
    console.log('addPool(' + id + ')...');
    const tx = await reactor.addPool(id, { gasLimit: 300000, type: 0 });
    await tx.wait();
    console.log('  Added');
    await delay(2000);
  }

  console.log('\nReactor pool count:', (await reactor.poolCount()).toString());
  console.log('Token IDs:', tokenIds.join(', '));

  fs.writeFileSync(path.join(__dirname, 'pr25-reactor-tokenids.txt'), tokenIds.join('\n'));
  console.log('\nDONE!');
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
