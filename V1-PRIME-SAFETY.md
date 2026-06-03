# V1 Reactor Prime — Operational Safety Guide

**Contract:** `0xed3aE91b2bb22307c07438EEebA2500C18EABcFE` (Base)
**Source:** `ChainReactor.sol`
**Admin:** `0xE2a4A8b9d77080c57799A94BA8eDeb2Dd6e0aC10` (agent/keeper wallet)
**Burn address:** `0xfd780B0aE569e15e514B819ecFDF46f804953a4B`
**Status:** Permanent. 10 pools registered. No upgrade path. Runs until the chain stops.

---

## What V1 Prime Cannot Do

These limitations exist in the deployed bytecode and can never be changed:

| Missing Feature | What It Means | Risk Level |
|---|---|---|
| No pool disable | A bad pool can't be turned off — try/catch skips it but wastes gas every 2hr cycle | Medium |
| No pool removal | Array only grows, slots never freed | Low (10 pools is fine) |
| No reentrancy guard | `fuel()` and `depositLiquidity()` make external calls without lock | Low (callers are your own contracts) |
| No slippage protection | Buyback swaps use `sqrtPriceLimitX96: 0` — sandwichable | Medium on thin pools |
| No duplicate xToken check | Two pools with same xToken cross-contaminate in processPool | HIGH if violated |
| Single-step admin transfer | `transferAdmin()` is immediate — one typo = admin gone forever | HIGH if careless |
| No pool cap | Unbounded array — too many pools could hit gas limits | Low (stay under ~15-20) |

---

## Adding Pools — Step-by-Step Checklist

### Before You Start
- [ ] Verify the xToken address is correct (run from tool output, never type from memory)
- [ ] Check the xToken is NOT already in the reactor:
  ```
  for i in 0..poolCount()-1: call pools(i) and check xToken field
  ```
- [ ] Confirm you trust this token long-term (a dead token = permanent wasted gas)
- [ ] Pool on Prime must exist BEFORE matching pool on any secondary reactor

### Execution Order
1. Mint a V3 position with the correct token pair and fee tier
2. Verify position via `NonfungiblePositionManager.positions(tokenId)` — check token0, token1, fee
3. Transfer position NFT to reactor: `safeTransferFrom(you, reactor, tokenId)`
4. Call `addPool(tokenId)` on reactor
5. Verify: call `poolCount()` and `pools(newIndex)` — confirm xToken, fee, tokenIsToken0

### Testing First
- Always mint with DUST amounts first (smallest practical value)
- Send dust NFT → addPool → verify → only then mint real-depth position
- Use `depositLiquidity()` to add depth to the dust position instead of minting a new one

---

## Admin Key Safety

The admin key controls only two functions:
- `addPool(tokenId)` — register new position
- `transferAdmin(newAdmin)` — change admin address

Everything else is permissionless:
- `execute()` — anyone can call after 2hr cooldown
- `fuel()` — secondary reactors call this
- `depositLiquidity()` — anyone can deepen existing pools

### Recommendations
- Store admin key on **hardware wallet** — never use from hot wallet
- The keeper wallet calls `execute()` — it does NOT need admin
- **Ideal endgame:** Call `renounceAdmin()` once all desired pools are registered. This makes the reactor fully immutable. No one can add pools or change admin. It just runs.
- If you must keep admin active, never call `transferAdmin()` without triple-checking the address

---

## Monitoring Checklist

Run these checks periodically (weekly or after any changes):

### PoolSkipped Events
```
Check Executed event logs — any PoolSkipped in the same tx means a pool failed.
If the same pool skips every cycle, that xToken's V3 pool may have:
- Zero liquidity
- Been deactivated
- Position fully out of range
```
**V1 cannot disable a failing pool.** Accept the wasted gas and note it.

### Dust Accumulation
```
Call dustBalance(tokenAddress) for MfT and each xToken.
V1's processPool uses balanceOf sweeps, so dust should clear each cycle.
If dust accumulates, a pool may be stuck.
```

### Fuel Intake Health
```
Watch Fueled events on Prime.
If secondary reactors' fuel() calls start failing:
- Prime may not have a matching pool for that xToken
- The matching pool may be out of range
- The position may have zero liquidity
```

### Gas Cost Trends
```
Track execute() gas usage over time.
Rising gas = deeper positions (more tokens to process) or more pools.
Both are "good problems" but worth monitoring.
```

---

## What Happens When a Pool Goes Bad

A pool "goes bad" when its xToken rugs, its V3 pool drains, or the position moves out of range.

**Good news:** Per-pool `try/catch` means one bad pool can't brick the others. It emits `PoolSkipped` and moves on.

**Bad news:** That pool slot is permanently occupied. The wasted gas per cycle is small (just the failed collect attempt), but it's there forever.

**Prevention is the only cure.** Only add pools for:
- Ecosystem tokens you control (MfT, POOP, BURGERS, CHAR, EGP, AZUSD, etc.)
- Blue chips (WETH, USDC, cbBTC)
- Impact tokens with long-term commitment (EARTH, CCC, etc.)

Never add a pool for a random third-party token you don't control.

---

## Current Pool Registry (as of 2026-05-01)

| Index | Position | Pair | Fee |
|---|---|---|---|
| 0 | #5044961 | AZUSD/MfT | 500 |
| 1 | #5044965 | AZUSD/MfT | 10000 |
| 2 | #5045025 | MfT/TGN | 10000 |
| 3 | #5045052 | MfT/cbBTC | 10000 |
| 4 | #5045071 | ecowealth/MfT | 10000 |
| 5 | #5045098 | CHAR/MfT | 10000 |
| 6 | #5045102 | axlREGEN/MfT | 10000 |
| 7 | #5045146 | BURGERS/MfT | 10000 |
| 8 | #5045173 | MfT/EGP | 10000 |
| 9 | #5047037 | POOP/MfT | 10000 |

**Note:** Pool 0 and Pool 1 are both AZUSD/MfT at different fee tiers. This is safe because they have different tokenIds, but it means AZUSD dust could be swept by whichever pool processes first. Monitor both.

---

## Call Line Position

V1 Prime is **Row 1** in the reactor call line (`EARTH/tools/reactor-call-line.js`).

Execution order: Row 3 (AZUSD, BOMI) → Row 2 (BURGERS, CHAR, EGP) → **Row 1 (MfT Prime)**

Prime fires last so it collects fuel from all secondary reactors that fired before it. The 60-second delay between reactors allows arb correction trades to generate additional fees.
