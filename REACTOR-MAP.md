# Reactor Network Map (Base)

```
                              MfT Reactor (ROW 1 — PRIME)
                              0xed3aE91b2bb22307c07438EEebA2500C18EABcFE
                              token: MfT | 10 pools | has fuel() intake
                              pools: AZUSD, TGN, cbBTC, ecowealth, CHAR, axlREGEN, BURGERS, EGP, POOP
                                            |
               ┌──────────────┬─────────────┼──────────────┐
               |              |             |              |
      fuel() — 10%    fuel() — 10%   fuel() — 10%   fuel() — 10%
               |              |             |              |
      EGP Reactor      CHAR Reactor   BURGERS V2     AZUSD V2 (ROW 3)   BOMI V2 (ROW 3)
      0x10A710...3819  0xc2eBe9...397A 0xc85802...CA  0xD8AFb7...9281    0x409009...fFF0
      token: EGP | 7p  token: CHAR|6p token: BURG|7p token: AZUSD|4p    token: BOMI | 1p
      CHAR,BURGERS,    AZUSD,POOP,    AZUSD,POOP,    MfT/AZUSD,         USDC/BOMI
      TGN,AZUSD,       BURGERS,TGN,   CHAR,TGN,      POOP/AZUSD,
      POOP,cbBTC,      EGP,cbBTC      EGP,cbBTC,     cbBTC/AZUSD,
      MfT                              MfT            USDC/AZUSD
                                                            |
                                                     fuel() — 10%
                                                            |
                                                     TGN SporeV2 (ROW 4)
                                                     0xc3f09dAE...989D
                                                     token: TGN | 2 pools
                                                     MfT/TGN, POOP/TGN
```

**Execution order (bottom-up):** TGN (Row 4) -> AZUSD, BOMI (Row 3) -> BURGERS -> CHAR -> EGP (Row 2) -> MfT Prime (Row 1)

## Addresses

| Contract | Address | Token | Pools | Status |
|----------|---------|-------|-------|--------|
| MfT Reactor (Prime) | 0xed3aE91b2bb22307c07438EEebA2500C18EABcFE | MfT | 10 | Active |
| EGP Chain Reactor | 0x10A710fced92eB096F796F43BCCFb60884c13819 | EGP | 7 | Active |
| CHAR Chain Reactor | 0xc2eBe90fB9bC7897f06DC00666951Fa9a49A397A | CHAR | 6 | Active |
| BURGERS Reactor V2 | 0xc858026Ec5D30280137032BC6EA86F46ea23C2CA | BURGERS | 7 | Active |
| AZUSD Reactor V2 | 0xD8AFb7caD1f8A3Ddc4E16c1516a94949eb119281 | AZUSD | 4 | Active |
| BOMI Reactor V2 | 0x409009453Ce04Bc5ac936bA6FbE42dd04971fFF0 | BOMI | 1 | Active |
| TGN SporeReactorV2 | 0xc3f09dAEF814177E52B4C04ec2872B564a36989D | TGN | 2 | Active |

## Key Tokens

| Token | Address |
|-------|---------|
| MfT | 0x8FB87d13B40B1A67B22ED1a17e2835fe7e3a9bA3 |
| EGP | 0xc1BA76771bbF0dD841347630E57c793F9d5ACcEe |
| CHAR | 0x20b048fA035D5763685D695e66aDF62c5D9F5055 |
| BURGERS | 0x06A05043eb2C1691b19c2C13219dB9212269dDc5 |
| POOP | 0x126555aecBAC290b25644e4b7f29c016aE95f4dc |
| TGN | 0xD75dfa972C6136f1c594Fec1945302f885E1ab29 |
| AZUSD | 0x3595ca37596D5895B70EFAB592ac315D5B9809B2 |
| cbBTC | 0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf |
| BOMI | 0x46D8f8Ba030c1D09ae17d2B5107dfef4B331fe0d |

## Shared Infrastructure

- Admin (all reactors): 0xE2a4A8b9d77080c57799A94BA8eDeb2Dd6e0aC10
- Burn address: 0xfd780B0aE569e15e514B819ecFDF46f804953a4B
- V3 Position Manager: 0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1
- V3 Router: 0x2626664c2603336E57B271c5C0b26F421741e481
- V3 Factory: 0x33128a8fC17869897dcE68Ed026d694621f6FDfD
- Chain: Base (8453)
