/**
 * test-execute.js — Debug the execute() call to find what's reverting
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { ethers } = require('ethers');

const BASE_RPC = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.KEEPER_PRIVATE_KEY;
const REACTOR_ADDR = process.env.EARTH_REACTOR;
const EARTH_ADDR = process.env.EARTH_TOKEN;

const V3_NPM = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';

const NPM_ABI = [
  'function positions(uint256 tokenId) view returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)',
  'function ownerOf(uint256 tokenId) view returns (address)',
];

const REACTOR_ABI = [
  'function execute() external',
  'function lastExecute() view returns (uint256)',
  'function poolCount() view returns (uint256)',
  'function pools(uint256) view returns (uint256 tokenId, address xToken, bool earthIsToken0)',
  'function earth() view returns (address)',
  'function admin() view returns (address)',
];

const EARTH_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function isExcluded(address) view returns (bool)',
  'function reactor() view returns (address)',
];

async function main() {
  const provider = new ethers.JsonRpcProvider(BASE_RPC);
  const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
  const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, wallet);
  const earth = new ethers.Contract(EARTH_ADDR, EARTH_ABI, provider);
  const npm = new ethers.Contract(V3_NPM, NPM_ABI, provider);

  console.log('=== Reactor State ===');
  const poolCount = Number(await reactor.poolCount());
  console.log('Pools:', poolCount);
  console.log('Admin:', await reactor.admin());
  console.log('Earth:', await reactor.earth());
  console.log('Reactor excluded?', await earth.isExcluded(REACTOR_ADDR));
  console.log('Reactor EARTH bal:', ethers.formatEther(await earth.balanceOf(REACTOR_ADDR)));

  for (let i = 0; i < poolCount; i++) {
    const pool = await reactor.pools(i);
    console.log(`\n--- Pool ${i} ---`);
    console.log('  tokenId:', pool.tokenId.toString());
    console.log('  xToken:', pool.xToken);
    console.log('  earthIsToken0:', pool.earthIsToken0);

    // Check NFT ownership
    const owner = await npm.ownerOf(pool.tokenId);
    console.log('  NFT owner:', owner);
    console.log('  Owned by Reactor?', owner.toLowerCase() === REACTOR_ADDR.toLowerCase());

    // Check position
    const pos = await npm.positions(pool.tokenId);
    console.log('  token0:', pos[2]);
    console.log('  token1:', pos[3]);
    console.log('  fee:', pos[4].toString());
    console.log('  liquidity:', pos[5] ? pos[7].toString() : '0');
    console.log('  tokensOwed0:', pos[10].toString());
    console.log('  tokensOwed1:', pos[11].toString());
  }

  console.log('\n=== Trying execute with 500k gas ===');
  try {
    const tx = await reactor.execute({ gasLimit: 500000 });
    console.log('Tx:', tx.hash);
    const receipt = await tx.wait();
    console.log('SUCCESS! Gas used:', receipt.gasUsed.toString());

    for (const log of receipt.logs) {
      try {
        const parsed = reactor.interface.parseLog(log);
        if (parsed) console.log('Event:', parsed.name, parsed.args);
      } catch(_) {}
    }
  } catch (e) {
    console.log('REVERTED:', e.shortMessage || e.message);
    if (e.data) console.log('Revert data:', e.data);
  }
}

main().catch(err => console.error('FATAL:', err.message));
