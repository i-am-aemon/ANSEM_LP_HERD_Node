# Setup

Node ≥ 22. After `npm run start` → http://127.0.0.1:8080/

## Files

| File | What |
|------|------|
| `.env` | `LP_WALLET_PUBLIC_KEY` · `LP_PRIVATE_KEY` · `DASHBOARD_PASSWORD` · fees |
| `cell.json` | Dashboard knobs (created on first Save) |
| `data/run-state.json` | ▶ Start armed flag (survives redeploy) |
| `logs/tx.sqlite` | Tx ledger |
| `logs/tx.jsonl` | Mirror |

## Steps (stranger / download-and-run)

1. `npm install` · `cp .env.example .env` · set **real** keys + password · `chmod 600 .env`
2. **Single-wallet (recommended):** set `OPERATOR_PRIVATE_KEY` (and optional `OPERATOR_WALLET`) to the **same** values as LP
3. Optional: copy hub-exported `cell.json` from ansemlp.fun `/nodes` into this folder (wallets stay empty — keys only in `.env`)
4. `npm run doctor` · `npm run go-live-check` · `npm run dry`
5. `npm run start` → `/unlock` → Setup `/` → Save → fund LP (≥ 0.05 SOL operating)
6. `/run` → MODE → **▶ Start**
7. Live spend only after dry ticks look sane: `DRY_RUN=false` `SIMULATION_MODE=false`

HERD go-live: paste `HERD_MINT` + `HERD_POOL` on Setup → Save. Env hot-applies; HERD gets a pin + target. No restart.

## Railway

### Demo (default Dockerfile)

```bash
DEMO_PUBLIC=true
DASHBOARD_HOST=0.0.0.0
DRY_RUN=true
SIMULATION_MODE=true
DASHBOARD_PASSWORD=…   # unlock UI only — Start stays blocked
```

### Live cell (private service)

```bash
DEMO_PUBLIC=false
DASHBOARD_HOST=0.0.0.0
DASHBOARD_PASSWORD=…
LP_WALLET_PUBLIC_KEY=…
LP_PRIVATE_KEY=…
OPERATOR_PRIVATE_KEY=…   # same as LP for single-wallet
DRY_RUN=true             # flip false when ready
SIMULATION_MODE=true
```

Sync non-secret knobs without forcing demo:

```bash
RAILWAY_LIVE=yes RAILWAY_SYNC_CONFIRM=yes npm run railway:sync-env
# Keys: paste in Railway UI, or RAILWAY_SYNC_KEYS=yes (careful)
```

▶ Start writes `data/run-state.json` — redeploy resumes seed + fee bot if still armed and keys OK.

## Activity

`logs/tx.sqlite` + `logs/tx.jsonl` · `GET /api/tx` · `GET /api/tx/export`

Site thesis: [whitepaper](https://www.ansemlp.fun/whitepaper) · node flow: `/whitepaper`
