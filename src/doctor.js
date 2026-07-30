import { config, isLive, defaultRoutes } from './config.js';
import { verifyKeysMatchPubkeys } from './wallet.js';
import { listOpenPositions } from './adapters/meteora.js';
import { getSolBalance } from './adapters/solana.js';
import { getOpenPositions } from './lib/portfolio.js';

async function main() {
  console.log('ANSEM Herd Node doctor\n');
  const checks = [];

  checks.push({
    name: 'TRACKED_WALLET (RO)',
    ok: Boolean(config.trackedWallet),
    detail: config.trackedWallet || 'missing',
  });
  checks.push({
    name: 'CONTROLLER_WALLET (RO · hardcoded)',
    ok: Boolean(config.controllerWallet),
    detail: config.controllerWallet
      ? `${config.controllerWallet} (@i_am_aemon map · constants.js)${
          config.controllerWallet === config.trackedWallet ? ' (=tracked)' : ''
        }`
      : 'missing — check src/constants.js CONTROLLER_WALLET',
  });
  checks.push({
    name: 'LP_WALLET (W1 node)',
    ok: true,
    detail: config.lpWallet || 'unset — generate on / or npm run init -- --keys',
  });
  checks.push({
    name: 'OPERATOR_WALLET (W2)',
    ok:
      Boolean(config.operatorWallet) ||
      !config.lpPrivateKey ||
      !isLive(),
    detail: config.operatorWallet
      ? config.isSingleWallet
        ? `${config.operatorWallet} (single-wallet = LP)`
        : config.operatorWallet
      : config.lpPrivateKey
        ? isLive()
          ? 'FAIL — set OPERATOR_PRIVATE_KEY=LP_PRIVATE_KEY (single-wallet) before live'
          : 'unset — before live set OPERATOR_PRIVATE_KEY=LP_PRIVATE_KEY (see .env.example)'
        : 'unset — for live, set OPERATOR_* = LP (see .env.example)',
  });
  checks.push({
    name: 'seeder policy',
    ok: true,
    detail: `SOL_RESERVE=${config.solReserve} operating=${config.solOperatingFloor} target=${config.solTargetReserve} rent/pair=${config.solRentPerPair} PAIR_MIN_ANSEM=${config.pairMinAnsem} SEED_PASS=${config.seedPass} NODE_ACTIVE_LIMIT=${config.nodeActiveLimit} APE<${config.apeMaxAgeMinutes}m universe=${process.env.SEED_UNIVERSE || 'tracked_top10'} sort=${process.env.SEED_SORT || 'dip24'}`,
  });
  try {
    const { INDEX_CONSTITUENT_COUNT, INDEX_VISION } = await import('./lib/ansem-index.js');
    checks.push({
      name: 'ANSEM index universe',
      ok: INDEX_CONSTITUENT_COUNT > 0,
      detail: `${INDEX_CONSTITUENT_COUNT} TOKEN–ANSEM pools · active≤${config.nodeActiveLimit} · ${INDEX_VISION.headline}`,
    });
  } catch (e) {
    checks.push({
      name: 'ANSEM index universe',
      ok: false,
      detail: String(e.message || e),
    });
  }
  try {
    const { getTxBackend, TX_PATH } = await import('./logger.js');
    const backend = getTxBackend();
    checks.push({
      name: 'activity log',
      ok: true,
      detail: `${backend.backend} · ${backend.path} · mirror ${TX_PATH} · GET /api/tx`,
    });
  } catch (e) {
    checks.push({
      name: 'activity log',
      ok: false,
      detail: String(e.message || e),
    });
  }
  try {
    const { meteoraCacheStatus, loadCachedStartListPools } = await import('./lib/meteora-api.js');
    const st = meteoraCacheStatus();
    const start = loadCachedStartListPools();
    checks.push({
      name: 'Meteora datapi cache',
      ok: Boolean(start?.count),
      detail: start?.count
        ? `${start.count} start-list pools @ ${start.fetched_at} (${st.dir})`
        : `empty — run npm run meteora:sync (${st.base})`,
    });
  } catch (e) {
    checks.push({
      name: 'Meteora datapi cache',
      ok: false,
      detail: String(e.message || e),
    });
  }
  checks.push({
    name: 'ANSEM_DEST_WALLET',
    ok: true,
    detail: config.ansemDestWallet || 'unset — creator fee destination',
  });
  checks.push({
    name: 'mode',
    ok: true,
    detail: isLive() ? 'LIVE' : 'DRY_RUN (safe)',
  });

  const keys = verifyKeysMatchPubkeys();
  checks.push({
    name: 'keys',
    ok: keys.ok,
    detail: keys.ok
      ? `lp=${Boolean(config.lpPrivateKey)} op=${Boolean(config.operatorPrivateKey)}`
      : keys.errors.join('; ') || 'no keys loaded (ok for read-only)',
  });

  try {
    const { seedKeyStatus } = await import('./wallet.js');
    const seed = seedKeyStatus();
    checks.push({
      name: 'seed auto (LP key match)',
      ok: seed.canLiveSeed || (!isLive() && seed.hasLpKey && seed.lpMatches),
      detail: seed.canLiveSeed
        ? `ready · LP key matches ${config.lpWallet?.slice(0, 8)}…`
        : seed.errors.join('; ') || seed.hint,
    });
  } catch (e) {
    checks.push({
      name: 'seed auto (LP key match)',
      ok: false,
      detail: String(e.message || e),
    });
  }

  try {
    const routes = defaultRoutes();
    const sum = routes.reduce((s, r) => s + r.pct, 0);
    checks.push({
      name: 'routes',
      ok: Math.abs(sum - 1) < 1e-6,
      detail: routes.map((r) => `${r.id}:${r.pct}`).join(' + ') + ` = ${sum}`,
    });
  } catch (e) {
    checks.push({ name: 'routes', ok: false, detail: String(e.message || e) });
  }

  // Controller book — informational (copycat reference)
  if (config.controllerWallet) {
    try {
      const { filterToIndex } = await import('./lib/ansem-index.js');
      const open = await getOpenPositions(config.controllerWallet);
      const all = open.positions || [];
      const indexed = filterToIndex(all);
      const fees = indexed.reduce((s, p) => {
        const f = p.current_position?.unclaimed_fees;
        return s + (f?.amount_x_usd ?? 0) + (f?.amount_y_usd ?? 0);
      }, 0);
      checks.push({
        name: 'controller book (index)',
        ok: true,
        detail: `${indexed.length} index / ${all.length} total · $${fees.toFixed(2)} fees (RO · never claim)`,
      });
    } catch (e) {
      checks.push({
        name: 'controller book (index)',
        ok: false,
        detail: String(e.message || e),
      });
    }
  }

  try {
    const { rankPools } = await import('./lib/rank-pools.js');
    const ranking = await rankPools({
      pass: config.seedPass || 'coverage',
      w1Positions: [],
    });
    const apeTickers = (ranking.ape || []).map((r) => r.ticker).join(',') || 'none';
    const activeTickers = (ranking.active || [])
      .slice(0, 10)
      .map((r) => r.ticker)
      .join(',');
    checks.push({
      name: 'ranker APE+dip',
      ok: true,
      detail: `active=${ranking.activeCount}/${ranking.nodeActiveLimit} ape=${ranking.apeCount} [${apeTickers}] top=${activeTickers}`,
    });
  } catch (e) {
    checks.push({
      name: 'ranker APE+dip',
      ok: false,
      detail: String(e.message || e),
    });
  }

  // Old book — informational (index-filtered by default)
  if (config.trackedWallet) {
    try {
      const { filterToIndex } = await import('./lib/ansem-index.js');
      const open = await getOpenPositions(config.trackedWallet);
      const all = open.positions || [];
      const indexed = filterToIndex(all);
      const fees = indexed.reduce((s, p) => {
        const f = p.current_position?.unclaimed_fees;
        return s + (f?.amount_x_usd ?? 0) + (f?.amount_y_usd ?? 0);
      }, 0);
      checks.push({
        name: 'old book (index slice)',
        ok: indexed.length > 0 || all.length === 0,
        detail: `${indexed.length} index / ${all.length} total · $${fees.toFixed(2)} unclaimed (RO)`,
      });
    } catch (e) {
      checks.push({
        name: 'old book (index slice)',
        ok: false,
        detail: String(e.message || e),
      });
    }
  }

  // Node LP positions (may be empty until funded)
  if (config.lpWallet) {
    try {
      const positions = await listOpenPositions(config.lpWallet);
      const fees = positions.reduce((s, p) => {
        const f = p.current_position?.unclaimed_fees;
        return s + (f?.amount_x_usd ?? 0) + (f?.amount_y_usd ?? 0);
      }, 0);
      checks.push({
        name: 'node W1 positions',
        ok: true,
        detail: `${positions.length} open · $${fees.toFixed(2)} unclaimed`,
      });
      try {
        const { buildFundSnapshot } = await import('./lib/fund-plan.js');
        const snap = await buildFundSnapshot({
          wallet: config.lpWallet,
          positions: positions.map((p) => ({
            ...p,
            position_value_usd:
              (p.current_position?.current_deposits?.amount_x_usd ?? 0) +
              (p.current_position?.current_deposits?.amount_y_usd ?? 0),
            unclaimed_fees_usd:
              (p.current_position?.unclaimed_fees?.amount_x_usd ?? 0) +
              (p.current_position?.unclaimed_fees?.amount_y_usd ?? 0),
          })),
        });
        const uw = (snap.book?.underweight || []).slice(0, 3);
        checks.push({
          name: 'fund book',
          ok: true,
          detail: `$${Number(snap.book?.valueUsd || 0).toFixed(2)} · gaps: ${
            uw.length ? uw.map((r) => `${r.ticker}+${r.gapPct.toFixed(1)}%`).join(', ') : 'none'
          }`,
        });
      } catch (e) {
        checks.push({
          name: 'fund book',
          ok: false,
          detail: String(e.message || e),
        });
      }
    } catch (e) {
      checks.push({
        name: 'node W1 positions',
        ok: false,
        detail: String(e.message || e),
      });
    }

    const sol = await getSolBalance(config.lpWallet);
    const { operatingFloor, targetReserve, lowSolBlocks } = await import(
      './lib/sol-reserve.js'
    );
    const block = lowSolBlocks(sol);
    checks.push({
      name: 'LP SOL',
      ok: sol >= 0,
      detail: block.blocked
        ? `${sol.toFixed(4)} SOL · LOW (need ≥${operatingFloor().toFixed(4)} operating / target ${targetReserve().toFixed(4)}) — seed will topup_sol`
        : `${sol.toFixed(4)} SOL · ok (≥${operatingFloor().toFixed(4)} operating)`,
    });
    try {
      const { runWalletCensus } = await import('./lib/wallet-census.js');
      const census = await runWalletCensus(config.lpWallet);
      const dust = (census.indexDust || [])
        .map((h) => `${h.ticker}:${h.ui.toFixed(2)}`)
        .join(', ');
      checks.push({
        name: 'wallet census (dust→LP)',
        ok: true,
        detail: `positions=${census.positions} · ANSEM=${(census.ansem?.ui || 0).toFixed(2)} · index dust=[${dust || 'none'}] · orphans=${(census.orphans || []).length}`,
      });
    } catch (e) {
      checks.push({
        name: 'wallet census (dust→LP)',
        ok: false,
        detail: String(e.message || e),
      });
    }
    try {
      const { getSessionBaseline, printSessionPnl, startSession } = await import(
        './lib/session-pnl.js'
      );
      const { buildFundSnapshot } = await import('./lib/fund-plan.js');
      const snap = await buildFundSnapshot({ wallet: config.lpWallet });
      const mark = Number(snap.book?.valueUsd) || 0;
      if (!getSessionBaseline() && mark > 0) {
        startSession(mark, { source: 'doctor' });
      }
      const s = printSessionPnl(mark);
      checks.push({
        name: 'session PnL',
        ok: true,
        detail:
          s.code === 'NO_BASELINE'
            ? 'no baseline yet'
            : `$${s.pnl.toFixed(2)} · mark $${s.current.toFixed(2)} vs start $${s.baseline.totalUsd.toFixed(2)}`,
      });
    } catch (e) {
      checks.push({
        name: 'session PnL',
        ok: true,
        detail: `n/a (${String(e.message || e).slice(0, 60)})`,
      });
    }
  }

  if (config.operatorWallet) {
    const sol = await getSolBalance(config.operatorWallet);
    checks.push({
      name: 'Operator SOL',
      ok: sol >= 0,
      detail: `${sol.toFixed(4)} SOL`,
    });
  }

  for (const c of checks) {
    console.log(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  }

  // Coverage board — day-1 goal in one place
  try {
    const { buildSeedPlan } = await import('./lib/seed-plan.js');
    const { getOperatorSnapshot } = await import('./lib/operator-mode.js');
    const plan = await buildSeedPlan({
      wallet: config.lpWallet,
      maxActions: 4,
      skipControllerSync: true,
    });
    const op = getOperatorSnapshot({
      ansemPriceUsd: plan.balances?.ansemPriceUsd,
    });
    if (plan.coverage) {
      console.log(`\nMODE ${op.operatorMode} · ${plan.coverage.line}`);
      console.log(`PAIR min ${op.pairMinRule}`);
      if (plan.coverage.atMin?.length) {
        console.log(`   Have: ${plan.coverage.atMin.join(', ')}`);
      }
      if (plan.coverage.needMin?.length) {
        console.log(`   Need: ${plan.coverage.needMin.join(', ')}`);
      }
      console.log(`NEXT ${plan.coverage.operatorHint}`);
    } else {
      console.log(`\nMODE ${op.operatorMode} · pair ${op.pairMinRule}`);
    }
  } catch (e) {
    console.log(`\n📊 coverage: n/a (${String(e.message || e).slice(0, 80)})`);
  }

  // Soft fail: only hard-fail on routes / tracked wallet / key mismatch
  // Soft: old book / SOL balances are informational. Hard: routes, tracked wallet, key mismatch.
  const hard = checks.filter(
    (c) =>
      !c.ok &&
      ['routes', 'TRACKED_WALLET (RO)', 'keys', 'OPERATOR_WALLET (W2)'].includes(
        c.name,
      ),
  );
  const failed = hard.length;
  console.log(
    `\n${failed === 0 ? 'Ready for dry ticks / /ansem tracker.' : `${failed} issue(s) — fix before go-live.`}`,
  );
  console.log('\nController = RO reference. Node LP = hands (fees claim here only).');
  console.log('Keys: put LP_PRIVATE_KEY in .env yourself — never paste in chat/UI.');
  console.log('Go live: DRY_RUN=false SIMULATION_MODE=false after keys + dest wired (local only).');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
