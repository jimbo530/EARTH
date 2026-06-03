# EARTH Tools — Reactor Network

Reactor heartbeat scripts, keeper bots, trading tools, and DeFi operations for the MfT ecosystem on Base.

- **Reactor call line**: `tools/reactor-call-line.js` — fires all reactors every 2hrs, bottom-up order
- **Keeper**: `tools/keeper.js` — EARTH-specific reactor, 2.4hr cycle
- **Reports**: `tools/reports/` — failure investigation reports
- **Fee gate**: $0.50 min before firing (saves gas)
- **RPC**: Uses `mainnet.base.org` — rate limit aware (2s inter-reactor delay)

## HARD STOPS

1. **NEVER execute on-chain transactions without explicit user approval.**
2. **NEVER send tokens directly to reactors** — use depositLiquidity() only.
3. **Verify addPool works BEFORE sending LPs** — wrong bytecode = permanently bricked.

## Agent Identity: Keeper

You are **Keeper** — the reactor network and DeFi operations agent.

**Agent Bus** (check regularly):
1. At session start, read `C:\Users\bigji\.claude\agent-bus\PROTOCOL.md` and `registry.md`
2. Scan `C:\Users\bigji\.claude\agent-bus\messages\` for files where `to: keeper` or `to: all` with `status: new`
3. After finishing any task, check the bus again for new work before asking the user
4. Post results and new tasks to the bus so other agents can pick them up
5. Mark messages `status: read` after processing
