# LP Strategy Card Game — Design Document
## "Track Wars" (working title)

Date: 2026-05-15
Status: Concept / brainstorm — NOT in development yet

---

## Core Concept

Positive-sum PvP LP strategy game. Players build reactor networks on a map, lay LP "tracks" between them, and compete to route the most fuel flow through their stations. Every action creates real on-chain LP. The game is disposable but the results are permanent.

Think: Train Nation board game meets DeFi infrastructure building.

## Players

- Minimum 3 players (creates alliances/politics/kingmaking)
- Up to 10 players
- NPCs as "city hubs" that generate volume (not competing players — they're terrain)
- More players = shorter rounds but bigger board

## The Board

- Hex map that starts mostly empty
- NPC hubs placed at fixed points generating token volume
- Players BUILD the map by placing reactors and tracks
- The board IS the game — no fixed layout

## Tokens & Factions

- Each player chooses a token to play for (their "faction")
- Multiple players can choose the same token (shown in different colors)
- Every track/LP you build pairs your faction token with another asset
- The deck of available tokens = the live Unruggable ecosystem (grows as tokens launch)

## Actions & Costs

- Every action costs $0.01
- Play a card (lay a track/LP): $0.01
- Place a reactor on the map: $0.01
- Buy a hex/land: $0.01
- All payments become MfT LP deposits (the infrastructure underlying the game)
- Revenue split: ~70% to LP, ~30% platform revenue

## Core Mechanics

### Reactor Placement
- Players place reactors on the hex map as a strategic move
- Reactors have limited slots (6) for LP pairs
- A player can deploy multiple reactors — building a personal network
- Placement IS the strategy: intercept fuel lines, block opponents, create junctions

### Fuel Flow & Siphon
- Fee flow is directional — flows UPSTREAM through reactor chains
- Siphon rate: 25-30% per station (cranked up from real 5% for fast gameplay)
- Insert your reactor into someone's line = you tax their flow
- Chain your own reactors = stack siphon cuts

### Track Building
- Match two token cards = an LP pair = a track on the map
- Tracks connect reactors to each other and to NPC hubs
- Every track is a real V3 LP position deposited on-chain

### Strategic Plays
- Terminus play: be at the END of a line, no one siphons above you
- Junction play: sit in the middle of multiple lines, take cuts from everything
- Extension attack: extend opponent's line through YOUR reactor, parasitize their flow
- Chain play: line up your own reactors, stack siphon on your own highway
- Counter-extend: build above opponent on a different line, siphon back
- Sandbagging: let others build, then place reactors in perfect positions late

## Game Flow

### Variable by player count:
- 3 players: 5 rounds, ~10 min
- 5 players: 4 rounds, ~15 min
- 10 players: 3 rounds, ~30-40 min

### Each round:
1. Draw cards
2. Place reactors (optional)
3. Play LP pairs into reactor slots
4. See fuel flow update on the board

### Final round:
- All reactors fire
- Fees flow through the network
- Burns happen
- Scores calculated

## Winning & Rewards

### Winner takes all
- ONLY the winner gets a tracking token (soulbound ERC-1155)
- No second place, no consolation prizes
- Creates ruthless gameplay — no permanent alliances
- Kingmaking in final rounds is real strategy

### The tracking token
- Records: game ID, winner address, score, LP value created, timestamp
- Is a permanent claim on that game's rewards contract
- Non-transferable (soulbound)

### Rewards structure
- Rewards contract sits at TOP of each game's reactor chain
- All upstream fee flow from every reactor in that game accumulates there
- Winner claims a scattershot of ALL tokens in the game (not just their faction)
- 50% to winner's wallet
- 50% goes back into LP in the game's reactors (deepens liquidity, increases future rewards)

### The value proposition
- $10 buy-in, 10 players = $100 LP position
- Winner paid $10, owns claim on $100 of permanent LP
- That LP generates fees every 2 hours, forever
- 50% reinvestment means it compounds
- Win 50 games = 50 tracking tokens, each dripping micro-rewards from different token baskets

## Economics

### Per game (10 players, $10 buy-in):
- Total pot: $100
- ~$70 becomes LP (permanent infrastructure)
- ~$30 platform revenue
- Winner's claim: all upstream fees from $70+ of LP, growing via 50% reinvestment

### At scale:
- 100 games/day = $7,000/day in LP created, $3,000/day revenue
- LP network grows autonomously through gameplay
- Older games compound as winners claim and reinvest

### Positive-sum mechanics:
- Losers built LP that deepens their faction token's liquidity
- Every action creates real infrastructure regardless of outcome
- The competition is about WHO benefits most, not who loses
- Even spite plays (blocking the leader) create permanent LP

## The Flywheel

```
Play game ($0.01/move)
  -> Creates real LP on-chain
    -> LP generates fees every 2 hours
      -> Fees flow to game rewards contract
        -> Winner claims (50% wallet / 50% back to LP)
          -> LP grows, generates more fees
            -> Players play more to build + win claims
              -> More LP created across more tokens
```

## Architecture (high level — not built yet)

### On-chain:
- Game reactor factory (clones reactors cheaply)
- Game rewards contract (per-game, sits atop reactor chain)
- Tracking token contract (ERC-1155 soulbound, minted to winner)
- Claim contract (distributes 50/50, handles multi-token claims)

### Off-chain:
- Game lobby / matchmaking
- Hex map UI with animated fuel flow
- Card dealing / hand management
- Turn timer

### Ties into existing infra:
- Uses same SporeReactorV4 clones as adoption/launches
- LPs are standard Uniswap V3 positions
- Reactors fire on same 2-hour cycle as everything else
- Cards in the deck = tokens in the Unruggable ecosystem

## Open Questions

- Exact siphon rate for gameplay (25%? 30%? configurable per lobby?)
- How many NPC hubs on the map? Fixed or random placement?
- Can players trade cards with each other? (removes positive negotiation if no)
- Hex adjacency rules — free placement or must connect?
- Minimum viable version scope
- Working title / branding

## Marketing Angle

"$10 game. 10 players. Winner walks away with a $100 position that pays forever. Losers built the LP that makes their own tokens stronger. No bad outcomes — just one great one."

---

## Related Files
- UnruggableAdoptionV2.sol — adoption contract (creates reactors + LP, needs same patterns)
- MycoPadV5_2.sol — launch factory (pool creation patterns)
- SporeReactorV4 — reactor implementation (clone target)
