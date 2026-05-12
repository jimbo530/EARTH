# Security Policy

EARTH is a live token on Base mainnet ([`0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08`](https://basescan.org/address/0x5CfBecf0209F7ada1EdF1fC0D2Fce3a809C0aE08)) with permanently-locked LP and a permissionless `Reactor.execute()` cycle. Bugs in `EARTH.sol` or `Reactor.sol` are unrecoverable post-deploy — please disclose privately.

## Reporting a Vulnerability

**Preferred:** [GitHub Private Vulnerability Reporting](https://github.com/jimbo530/EARTH/security/advisories/new) — opens a private advisory thread.

**Fallback:** _Add a contact email here (e.g. `security@carbon-counting-club.com` or DM `@memefortrees.base.eth`)._

### Please include

- Affected file/function and line numbers
- Impact (severity, affected funds/users, attack precondition)
- Reproduction steps or proof-of-concept
- Suggested fix if you have one

### What to expect

- Acknowledgement within 72 hours
- Severity triage within 7 days
- Coordinated disclosure once a fix is deployed or determined infeasible

## Scope

**In scope:** `contracts/EARTH.sol`, `contracts/Reactor.sol`, anything reachable on-chain via the deployed token / Reactor address.

**Out of scope:** `contracts/DebugMint.sol` (not deployed to mainnet), the static HTML pages under `deploy/` (deployer UIs, not production code), front-end repos that consume EARTH.

## Known design tradeoffs

The following are documented design choices, not vulnerabilities:

- `Reactor.execute()` swap accepts `amountOutMinimum: 0` (MEV-sandwichable on small amounts) — see comment in `Reactor.sol`.
- `Reactor.execute()` is permissionless after a 2-hour cooldown — anyone can trigger.
- Once `setReactor` is called, the deployer is renounced and the Reactor address is locked forever.
- V3 position NFTs held by the Reactor have no withdraw path.

If you believe one of these tradeoffs is exploitable in a way that wasn't anticipated, please still report it.

## Out-of-Scope Reports

Please do not file public issues for:

- Theoretical attacks without a working PoC against the actual deployed contracts
- Best-practice / style critiques (those are fine as regular issues)
- Front-running and MEV-sandwich behavior on the `execute()` swap (acknowledged tradeoff)

Thank you for helping keep EARTH safe.
