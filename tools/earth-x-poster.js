/**
 * earth-x-poster.js — Posts EARTH tokenomics facts to X every 3 hours
 * Rotates through educational posts about the deflationary rebase mechanics.
 * Uses same X API creds as the meme poster.
 */
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { TwitterApi } = require('twitter-api-v2');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'earth-post-log.json');
const POST_INTERVAL = 3 * 60 * 60 * 1000; // 3 hours

const EARTH_ADDR = '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08';
const REACTOR_ADDR = '0x424D8BC900C6cc22E791C01d7E92CEd149a232f7';
const BASE_RPC = 'https://mainnet.base.org';

const EARTH_ABI = [
  'function totalSupply() view returns (uint256)',
  'function rebaseIndex() view returns (uint256)',
];
const REACTOR_ABI = [
  'function lastExecute() view returns (uint256)',
  'function poolCount() view returns (uint256)',
];

// ── Tweet templates ─────────────────────────────────────────────────────────
// {supply}, {pools}, {index}, {deflation}, {lastExec} are replaced with live data
const TWEETS = [
  `The math is simple:

Every $EARTH trade:
- 0.5% burned forever
- 0.3% rebased to holders
= 0.2% net deflation per trade

No admin. No governance. Just math.

Supply: {supply} EARTH (started at 1.0)

github.com/jimbo530/EARTH`,

  `$EARTH has {pools} liquidity pools feeding one Reactor.

Every 2 hours, anyone can call execute():
1. Collect fees
2. Burn the EARTH side
3. Buy more EARTH with the other side
4. Deepen the LP
5. Rebase all holders

Permissionless and unstoppable.`,

  `Your $EARTH balance grows automatically.

rebaseIndex: {index}

Every holder's balance = shares * rebaseIndex
When the Reactor executes, index goes up.
No claiming. No staking. Just hold.

Current supply: {supply} (started at 1.0)`,

  `$EARTH Reactor has run {cycles} cycles since launch.

Each cycle:
- Burns EARTH (deflationary)
- Buys EARTH (price support)
- Deepens LP (less slippage)
- Rebases holders (passive yield)

All in one permissionless tx.

0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08`,

  `Why $EARTH is net deflationary:

Fee = 1% of volume
Burned = 0.5% (the EARTH side)
Minted = 0.3% (rebase to holders)

0.5% out > 0.3% in

Every trade shrinks the supply.
Supply: {supply} EARTH
Started: 1.000000 EARTH

Contracts verified on Base.`,

  `$EARTH pools:
- EARTH/WETH
- EARTH/USDC
- EARTH/cbBTC
- EARTH/MfT
- EARTH/CHAR
- EARTH/POOP

{pools} pools, all feeding one Reactor.
More pools = more fees = more burns.

The flywheel only spins one direction.`,

  `The $EARTH Reactor is immutable:

- No withdraw function (LP locked forever)
- No admin mint (only rebase formula)
- Deployer renounced
- setReactor() locked after first call
- Anyone can call execute()

The only remaining admin action is adding pools.
After renounceAdmin() — fully autonomous forever.`,

  `How to build a deflationary rebase token:

1. Share-based balances (no iteration)
2. Immutable Reactor (no rug)
3. burn > rebase (net deflationary)
4. Permissionless execute (no keeper dependency)
5. LP locked forever (no drain)

Open source: github.com/jimbo530/EARTH`,

  `$EARTH rebase math:

rebaseIndex += mintAmount * 1e18 / totalShares

One storage write. Every holder's balance updates instantly.
No loops. No gas scaling. O(1) distribution.

This is how you do yield without staking contracts.`,

  `Agent-readable $EARTH:

const supply = await earth.totalSupply()
const index = await earth.rebaseIndex()
const pools = await reactor.poolCount()
const canExec = now >= lastExecute + 7200

All on Base. All permissionless.
github.com/jimbo530/EARTH`,

  `The $EARTH flywheel:

Trade -> 1% fee -> burn + buyback -> deeper LP -> more attractive -> more trades

Supply: {supply} EARTH (down from 1.0)
Pools: {pools}
Reactor: autonomous

It only goes one way.`,

  `$EARTH is what happens when you make burn > mint mandatory.

No vote needed. No multisig. No timelock.
The contract enforces deflation mathematically.

0.5% burned per trade.
0.3% rebased per trade.
Net: -0.2% supply per trade. Always.`
];

// ── Live data fetcher ───────────────────────────────────────────────────────
async function getLiveData() {
  try {
    const provider = new ethers.JsonRpcProvider(BASE_RPC);
    const earth = new ethers.Contract(EARTH_ADDR, EARTH_ABI, provider);
    const reactor = new ethers.Contract(REACTOR_ADDR, REACTOR_ABI, provider);

    const [supply, index, lastExec, pools] = await Promise.all([
      earth.totalSupply(),
      earth.rebaseIndex(),
      reactor.lastExecute(),
      reactor.poolCount(),
    ]);

    const supplyStr = Number(ethers.formatEther(supply)).toFixed(6);
    const indexStr = (Number(index) / 1e18).toFixed(12);
    const cyclesSinceLaunch = Math.floor((Date.now() / 1000 - Number(lastExec)) / 7200);
    const deflation = ((1 - Number(ethers.formatEther(supply))) * 100).toFixed(1);

    return {
      supply: supplyStr,
      index: indexStr,
      pools: pools.toString(),
      deflation: deflation + '%',
      cycles: Math.max(1, Math.floor(Number(lastExec) / 7200)).toString(),
      lastExec: new Date(Number(lastExec) * 1000).toISOString().slice(0, 16),
    };
  } catch(e) {
    return {
      supply: '~0.46', index: '1.005+', pools: '6',
      deflation: '~54%', cycles: 'many', lastExec: 'recently',
    };
  }
}

function fillTemplate(template, data) {
  return template
    .replace(/\{supply\}/g, data.supply)
    .replace(/\{index\}/g, data.index)
    .replace(/\{pools\}/g, data.pools)
    .replace(/\{deflation\}/g, data.deflation)
    .replace(/\{cycles\}/g, data.cycles)
    .replace(/\{lastExec\}/g, data.lastExec);
}

// ── Posting ─────────────────────────────────────────────────────────────────
function createClient() {
  const { API_KEY, API_SECRET, ACCESS_TOKEN, ACCESS_TOKEN_SECRET } = process.env;
  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    console.error('Missing X API credentials in tools/.env');
    process.exit(1);
  }
  return new TwitterApi({
    appKey: API_KEY, appSecret: API_SECRET,
    accessToken: ACCESS_TOKEN, accessSecret: ACCESS_TOKEN_SECRET,
  });
}

function loadLog() {
  if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  return { postIndex: 0, posts: [] };
}

function saveLog(log) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

function log(msg) { console.log(`[${new Date().toISOString().slice(0,19)}] ${msg}`); }

async function postTweet() {
  const postLog = loadLog();
  const client = createClient();
  const data = await getLiveData();

  const idx = postLog.postIndex % TWEETS.length;
  const tweet = fillTemplate(TWEETS[idx], data);

  try {
    const result = await client.v2.tweet(tweet);
    log('Posted tweet #' + (idx + 1) + ': ' + tweet.slice(0, 60) + '...');
    postLog.postIndex = idx + 1;
    postLog.posts.push({
      time: new Date().toISOString(),
      index: idx,
      tweetId: result.data.id,
    });
    saveLog(postLog);
  } catch(e) {
    log('Post failed: ' + (e.message || e).toString().slice(0, 100));
  }
}

async function main() {
  log('EARTH X Poster starting — posting every 3 hours');
  log('Tweets in rotation: ' + TWEETS.length);

  // Post immediately on start
  await postTweet();

  // Then every 3 hours
  setInterval(postTweet, POST_INTERVAL);
}

main();
