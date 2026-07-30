```
        ^__^                 $HERD
        (oo)\_______         ANSEM Liquidity Pool Herd
        (__)\       )\/\     a rising tide lifts all bulls
            ||----w |
            ||     ||
```

# ANSEM Herd Node

You keep the key. No bot required — [site](https://www.ansemlp.fun) · [whitepaper](https://www.ansemlp.fun/whitepaper). This node = advanced multi-pool cell.

**Fork:** [ANSEM_LP_HERD_Node](https://github.com/i-am-aemon/ANSEM_LP_HERD_Node) · private working cell is not a fork target.  
**v2 plan:** [V2.md](./V2.md) — download-and-run private node goals.

## Start

Node ≥ 22.

```bash
npm install
cp .env.example .env
# Fill real LP_WALLET_PUBLIC_KEY + LP_PRIVATE_KEY + DASHBOARD_PASSWORD
# Single-wallet live: also set OPERATOR_PRIVATE_KEY=same as LP_PRIVATE_KEY
chmod 600 .env
npm run start          # → http://127.0.0.1:8080/
npm run doctor         # after keys are real
```

1. `/unlock` → password  
2. `/` Setup → fee mix → Save → fund LP (keep operating SOL)  
3. `/run` → set **MODE** → **▶ Start** (continuous seed + fee bot until Shut down)  
4. Live spend: `DRY_RUN=false` `SIMULATION_MODE=false`  
5. Paste `HERD_MINT` + `HERD_POOL` on Setup when live — Save pins HERD with a target (no restart)

Headless one-tick dry (no UI): `npm run dry`

## Math

| | |
|--|--|
| Site pool fees | **90%** stay in pool · **10%** claimable — site thesis, **not** the node fee split |
| Node take-out leave | ~**10%** stub (`LEAVE_IN_POOL_PCT`) when trimming LP |
| Fee split (node) | **5 / 5 / 5 / 85** — Buy ANSEM / Reserve ANSEM / Reserve SOL / Pools |
| Pair min | **5** ANSEM · also `max(5, $1/(2×price))` |
| SOL | **0.02** gas · **0.05** operating · **0.08** target · ~**0.008** rent/pair |
| Shares | **Creator** = % of book · **Holder** = % of pool TVL |

Cover mins → deepen by rank (MODE mirror). Live → join `HERD_POOL`.

## Refs

| | |
|--|--|
| `$ANSEM` | `9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump` |
| Controller | `HpJbzERP44V21mKGRDDUArb9JJaL9NdPSgXzZ9uyieVB` (RO) |
| `$HERD` | paste `HERD_MINT` + `HERD_POOL` at launch |

[SETUP](docs/SETUP.md) · [SECURITY](docs/SECURITY.md) · [Book](docs/BOOK_OF_ANSEM_PRIVATE_NODE/README.md) · [SEED_POOLS](docs/SEED_POOLS.md)

**Railway demo:** `DEMO_PUBLIC=true` — Start blocked (UI only).  
**Railway live:** Variables with keys + `DEMO_PUBLIC=false` · `RAILWAY_LIVE=yes npm run railway:sync-env` (still skips keys unless `RAILWAY_SYNC_KEYS=yes`).
