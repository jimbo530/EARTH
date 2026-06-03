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

The Reactor manages 9 V3 liquidity pools (1% fee, full range):

| Pool | What It Means |
|------|---------------|
| EARTH/WETH | Trade EARTH for ETH |
| EARTH/USDC | Trade EARTH for dollars |
| EARTH/cbBTC | Trade EARTH for Bitcoin |
| EARTH/MfT | Trade EARTH for memefortrees |
| EARTH/CHAR | Trade EARTH for Biochar |
| EARTH/POOP | Trade EARTH for POOP |
| EARTH/BURGERS | Trade EARTH for Burgers |
| EARTH/TGN | Trade EARTH for TGN |
| EARTH/AZUSD | Trade EARTH for AZUSD |

Every pool feeds the same Reactor. More pools = more fee sources = more burns + deeper liquidity across all pairs. Each new pool also creates new arb routes between every existing pair — the network effect is multiplicative.

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

## The 1% Fee Shield

Most MEV sandwich attacks target low-fee pools (0.05%, 0.3%) where the cost of front-running is cheap. On a 1% pool, an attacker pays 1% on their buy and 1% on their sell — roughly 2% in fees just to execute the attack. Those fees go directly into the pool and get collected by the Reactor next cycle.

For a sandwich to be profitable, the attacker must extract more than 2% from price manipulation. On thin liquidity with small swap amounts, the math doesn't work — they'd lose money trying. And even if they succeed, they just funded multiple future Reactor cycles. The "attack" is closer to a donation.

The Reactor doesn't care who trades or why. Bots, humans, MEV, arbitrage — it all becomes burn fuel.

---

## The Multi-Pool Volume Multiplier

Every pool in the network is an arb surface. When a large trade moves the price on EARTH/WETH, the EARTH/USDC, EARTH/cbBTC, EARTH/POOP, and every other pool become mispriced. Arb bots equalize across all pairs, each trade paying 1% fees.

A single large buy or sell can trigger 3-5x its volume in arb activity across the pool network. More pools = more arb paths = bigger volume multiplier from any single real trade. The total fee generation across the system far exceeds what any one pool produces alone.

Every pool you add doesn't just create a new trading pair — it creates new arb routes between every existing pair. The network effect is multiplicative, not additive.

---

## The Reactor Cascade

The Reactor creates its own echo. It fires, the swap moves price, arb corrects across pools, those arb trades generate fees, those fees accumulate for 2 hours, the Reactor fires again — partially funded by its own last execution. It feeds itself.

In a multi-reactor network (like the Tales of Tasern nation token ring), reactors fire sequentially — staggered 15 minutes apart across a 2-hour cycle. Each reactor's activity generates arb that deposits fees into the next reactor's pools before it fires. By the time the last reactor executes, it's collecting fees from its own last cycle plus the decaying ripples of every reactor before it. Then the cycle restarts and the first reactor picks up the tail of the last.

The energy decays each step, but it never fully dies. A few cents in organic volume becomes the seed for a continuous low-frequency hum of activity across the entire network. The ripples go around the ring and come back.

---

## External Volume: BTC and ETH

The EARTH/WETH and EARTH/cbBTC pools are connected to the two deepest, most active markets in crypto. BTC and ETH trade globally, 24/7. Any price movement on either creates arb opportunities against EARTH pools. That arb pays 1% fees. Those fees compound into locked LP. That LP ripples through the entire network.

The system doesn't need internal volume to function. Global crypto markets are the engine. Game activity is bonus — it accelerates things when players are active, but the base layer grinds forever on external market activity alone.

It works in both directions. BTC pumps — EARTH/cbBTC mispriced — arb corrects — fees collected. BTC dumps — same thing. Volatility is the fuel, and crypto is always volatile. The Reactor is parasitically feeding off global market activity to permanently deepen its own liquidity.

---

## Permanent LP Compounding

Reactor positions have no withdraw function. LP is locked forever by design. Every cycle deepens liquidity that can never be pulled.

Each cycle: fees collected, tokens burned, remaining swapped and deposited back as LP. That LP generates more fees next cycle. More fees means more LP deposited, which means more fees generated. The liquidity floor is permanently rising.

Deeper LP means less slippage, which enables larger trades, which generates more fees, which deepens LP further. Nothing ever comes out. Every reactor across the network is a one-way valve — value enters, LP accumulates, it never leaves.

---

## Charity Integration

Charity tokens (like CHAR/Biochar for carbon credits) plug into the same reactor network. A charity reactor builds LP and burns supply for the charity token — it doesn't route money to a foundation, it strengthens the token itself as a funding instrument.

Connected to the same pool network, charity token reactors benefit from the cascade. Every arb ripple, every reactor fire deposits fee energy into the charity token's pools. The charity doesn't need donors. It needs the network to exist and trade. The reactors convert raw volume into permanent LP for real-world impact tokens.

Play the game, fund carbon credits. Trade a nation token, send a kid to school. Nobody has to choose to donate — the system converts volume into impact automatically.

---

Built by memefortrees.base.eth
