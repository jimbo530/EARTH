# Polygon Reactor Build — Shared Brief

Status: IN PROGRESS (2026-04-28)
Wallet: Reactor wallet (REACTOR_PRIVATE_KEY in Baselings/api/.env) — NOT YET FUNDED
Address: 0x87Ab7093A24EE3090176A1eEA030AA266c9c9D6b

## What We're Building

ReactorV3 deployments on Polygon for charity/game token ecosystem.
Contract source: contracts/ReactorV3.sol (already written, battle-tested design)

## Architecture

```
Blue chips (WPOL/WETH/USDC) <--> Game tokens (DDD, others) <--> Charity tokens (CCC, others)
```

- Game tokens get blue chip pairs (real liquidity)
- Game tokens get charity token pairs (impact ecosystem)
- ReactorV3 manages V3 pools: collect fees -> burn token -> buyback -> deepen LP -> optional rebase
- Charity tokens use supportsRebase=false (burn to 0xdead)

## Known Tokens on Polygon

| Token | Type | Address | Decimals |
|-------|------|---------|----------|
| CCC (Carbon Counting Coin) | Charity | 0x11f98A36aCBD04cA3Aa3a149d402AFFbD5966fe7 | 16 |
| DDD (Durgan Dynasty Doubloon) | Game | 0x4BF82cF0d6b2afC87367052B793097153C859D38 | 18 |

Existing V2 pair (DDD/CCC): 0x73e6a1630486d0874ec56339327993a3e4684691
More game tokens and charity tokens TBD — user is tracking down at least 2 more charities.

## Pool Setup Rules

- CCC target price: $0.10 per token
- $50 of each paired token per pool (= 500 CCC per pool at $0.10)
- All pools on Uniswap V3 (Polygon)
- Full range positions, locked forever in reactor

## Uniswap V3 Addresses (Polygon)

- NonfungiblePositionManager: 0xC36442b4a4522E871399CD717aBDD847Ab11FE88
- SwapRouter02: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
- Factory: 0x1F98431c8aD98523631AE4a59f267346ea31F984

## ReactorV3 Constructor Args (when deploying)

```
_token:          <token address>
_pm:             0xC36442b4a4522E871399CD717aBDD847Ab11FE88
_router:         0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
_factory:        0x1F98431c8aD98523631AE4a59f267346ea31F984
_supportsRebase: false (for charity tokens — burn to 0xdead)
_rebaseNum:      0 (no rebase)
_rebaseDen:      1
```

## Polygon RPC

Working: https://polygon-bor-rpc.publicnode.com
Dead: https://polygon-rpc.com (401), https://rpc.ankr.com/polygon (needs API key)

## Tools

- Reactor wallet script: C:\Users\bigji\Documents\Baselings\tools\reactor-wallet.js
  Commands: balance, send, send-token, call, deploy

## Important Rules (from user)

- NEVER execute on-chain without explicit user approval for EACH transaction
- NEVER type wallet addresses from memory — always verify from tool/script output
- Always identify pool type (V2/V3/Algebra) before swapping
- Deploy contracts via localhost HTML pages with embedded bytecode, not Remix/CLI
- Wallet extensions need http:// not file://, use `npx serve -l 8888`
