# EARTH Tokenomics

**A permissionless deflationary rebase token with autonomous liquidity deepening.**

Base Mainnet | `0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08`

---

## The Core Idea

EARTH has a Reactor — an immutable smart contract that runs every 2 hours, collecting trading fees from V3 liquidity pools. It burns EARTH, buys more EARTH, deepens liquidity, and distributes yield to holders. No admin keys needed. Anyone can call `execute()`.

The math guarantees that **more EARTH is burned than minted**, making the token permanently deflationary while holders' balances still grow.

---

## How It Works

### The Rebase Model

EARTH uses a share-based balance system. Your wallet holds *shares*, and a global `rebaseIndex` converts shares to tokens:

```
balance = shares * rebaseIndex / 1e18
```

When the Reactor mints new tokens, it increases `rebaseIndex` — every holder's balance grows proportionally without any transfers. Pools and the Reactor are excluded from rebase so they don't receive phantom tokens.

### The Reactor Cycle (every 2 hours)

```
For each pool (EARTH/X):

1. COLLECT    → Reactor pulls accrued fees (EARTH + X token)
2. BURN       → All EARTH fees are burned forever
3. SWAP       → Half of X fees buy EARTH from the pool
4. DEEPEN     → Bought EARTH + remaining X deposited back as LP
5. REBASE     → Mint 0.3% of volume worth of EARTH to all holders
```

No human intervention. No governance vote. The contract runs until the chain stops.

---

## The Deflationary Math

Every swap through an EARTH pool pays a 1% fee. Here's what happens to that 1%:

| Step | Action | EARTH Effect |
|------|--------|--------------|
| Fee collected | 0.5% is EARTH, 0.5% is X token | — |
| Burn | 0.5% of volume burned | **-0.5% supply** |
| Buyback | Half of X (0.25% of volume) buys EARTH | Price support |
| LP deposit | Bought EARTH + remaining X → LP | Deeper liquidity |
| Rebase | Mint 0.3% of volume to holders | **+0.3% supply** |

**Net per cycle: -0.5% burned + 0.3% minted = -0.2% of volume removed from supply**

Every trade makes EARTH scarcer. The buyback creates constant buy pressure. The LP deposit makes the pool deeper so the next trade has less slippage. It's a flywheel.

### The Rebase Math

```solidity
rebaseIndex += mintAmount * 1e18 / totalNonExcludedShares
```

If 1000 shares exist and 0.003 EARTH is minted:
```
rebaseIndex increases by 0.003 * 1e18 / 1000 = 3e12
```

Every holder's balance increases proportionally. A wallet with 100 shares sees:
```
Before: 100 * 1.000000000000000000e18 / 1e18 = 100.000000 EARTH
After:  100 * 1.000000000003000000e18 / 1e18 = 100.000000000300 EARTH
```

Small per cycle, but it compounds every 2 hours — 4,380 times per year.

---

## Supply Dynamics

| Metric | Value |
|--------|-------|
| Initial supply | 1.000000 EARTH |
| Current supply | ~0.46 EARTH (net deflationary) |
| Rebase frequency | Every 2 hours |
| Burn rate | 0.5% of all volume |
| Mint rate | 0.3% of all volume |
| Net deflation | 0.2% of all volume permanently removed |

The supply can only decrease over time (assuming any trading volume exists).

---

## Pool Structure

The Reactor manages 6 V3 liquidity pools (1% fee, full range):

| Pool | What It Means |
|------|---------------|
| EARTH/WETH | Trade EARTH for ETH |
| EARTH/USDC | Trade EARTH for dollars |
| EARTH/cbBTC | Trade EARTH for Bitcoin |
| EARTH/MfT | Trade EARTH for memefortrees |
| EARTH/CHAR | Trade EARTH for Biochar |
| EARTH/POOP | Trade EARTH for POOP |

Every pool feeds the same Reactor. More pools = more fee sources = more burns + deeper liquidity across all pairs.

Reactor: `0x424D8BC900C6cc22E791C01d7E92CEd149a232f7`

---

## Why It's Trustless

| Property | Guarantee |
|----------|-----------|
| No admin mint | Only the Reactor can mint, and only via `rebase()` formula |
| No token drain | Reactor has no withdraw function — LP is locked forever |
| Permissionless execute | Anyone can call `execute()` after the 2-hour cooldown |
| Immutable burn | `burn()` is permanent — tokens are gone |
| Deployer renounced | `_deployer = address(0)` after Reactor was set |
| Reactor locked | `setReactor()` can only be called once, ever |

The only admin action remaining is adding new pools to the Reactor. Once `renounceAdmin()` is called, even that is gone — the system runs forever with no human control.

---

## For Agents

### Reading EARTH State

```javascript
// Current supply
const supply = await earth.totalSupply();

// Your balance (auto-rebased)
const balance = await earth.balanceOf(walletAddress);

// Current rebase multiplier
const index = await earth.rebaseIndex();
// index > 1e18 means rebases have occurred
// Your real balance = shares * index / 1e18

// Reactor cooldown
const lastExec = await reactor.lastExecute();
const canExecute = Date.now() / 1000 >= lastExec + 7200;

// Pool count
const pools = await reactor.poolCount();
```

### Executing the Reactor

```javascript
// Anyone can call this — you get no reward, but the system runs
await reactor.execute();
// Burns EARTH, buys EARTH, deepens LP, rebases holders
```

### Buying EARTH

Swap any paired token for EARTH through Uniswap V3 at 1% fee:
```javascript
await router.exactInputSingle({
  tokenIn: WETH_ADDRESS,
  tokenOut: '0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08',
  fee: 10000,
  recipient: yourWallet,
  amountIn: ethAmount,
  amountOutMinimum: 0,
  sqrtPriceLimitX96: 0
});
```

### Key Addresses (Base Mainnet)

```
EARTH Token:    0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08
Reactor:        0x424D8BC900C6cc22E791C01d7E92CEd149a232f7
EARTH/WETH:     (query V3 factory)
EARTH/USDC:     (query V3 factory)
EARTH/cbBTC:    0xD2907a46294d0Ad9a463591ee1bEa1a46b6ACb36
EARTH/MfT:      0xfDa4F5aeC252F2853e3779e4c20a2c2ddC369bcE
EARTH/CHAR:     0xA2f2B3C8e751A99D5DE1538792A16bB1b73A776b
EARTH/POOP:     0x07a5F1FA87C5b39EAC2842DeC84e0ede9A95b70f
V3 Factory:     0x33128a8fC17869897dcE68Ed026d694621f6FDfD
SwapRouter02:   0x2626664c2603336E57B271c5C0b26F421741e481
```

---

## The Flywheel

```
  Trade happens
       |
       v
  1% fee collected
       |
   ----+----
   |       |
   v       v
 EARTH    X token
 burned   split 50/50
   |       |        |
   |       v        v
   |    Buy EARTH   Keep X
   |       |        |
   |       +--------+
   |            |
   |            v
   |     Deposit as LP
   |     (pool deeper)
   |
   v
 Supply shrinks
 Price supported
 Holders rebased
       |
       v
 More attractive
 More volume
 Cycle repeats
```

Built by memefortrees.base.eth
