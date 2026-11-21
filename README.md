# EARTH

**A permissionless deflationary rebase token on Base.** Holders' balances grow over time while supply burns faster than it mints.

- **Token (Base mainnet):** [`0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08`](https://basescan.org/address/0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08)
- **Burn:** 0.5% of every trade — forever
- **Rebase:** 0.3% of volume distributed proportionally to all holders
- **Cooldown:** 2 hours between `execute()` cycles (permissionless — anyone can call)

See [`EARTH-TOKENOMICS.md`](./EARTH-TOKENOMICS.md) for the full mechanics.

## How it works

Every 2 hours, anyone can call `Reactor.execute()`. For each registered EARTH/X pool, the Reactor:

1. **Collects** accrued LP fees (EARTH + X)
2. **Burns** the EARTH side
3. **Buys** more EARTH with half the X side
4. **Deepens** liquidity by depositing the bought EARTH + remaining X back as LP
5. **Rebases** holders by minting ~0.3% of volume worth of new EARTH

No admin keys, no governance vote, no withdraw function. The contract runs until the chain stops.

## Repository layout

```
contracts/
  EARTH.sol         — Rebase ERC20. Reactor is the sole minter (via rebase index).
  Reactor.sol       — Permissionless burn / buy / LP / rebase engine.
  DebugMint.sol     — Test helper. Not deployed to mainnet.

deploy/             — Static HTML deployer pages (1-deploy-earth through 4-execute).
tools/              — Build scripts for the deploy pages.
hardhat.config.js   — Hardhat config for local compile / test.
```

## Quick start

```bash
npm install
npm run compile          # hardhat compile
npm run build-deploy     # regenerate static deploy pages
npm run serve            # serve deploy/ at http://localhost:8888
```

## Contract addresses (Base, chain 8453)

| Contract | Address |
|----------|---------|
| EARTH token | [`0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08`](https://basescan.org/address/0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08) |
| Reactor | _(set via `setReactor` after deploy — see `deploy/2-deploy-reactor.html`)_ |

## License

MIT
