import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, isLive, defaultRoutes, saveCellJson, upsertEnvKeys, normalizeFeeSplit } from '../config.js';
import { verifyKeysMatchPubkeys } from '../wallet.js';
import {
  scaffoldSecretsFile,
  keyFileStatus,
  generateWalletKeypairs,
  existingKeysPresent,
} from '../secrets.js';
import {
  checkNodeAuth,
  passwordsMatch,
  passwordConfigured,
  createSessionToken,
  sessionCookieHeader,
  isPublicDashboardSurface,
} from '../lib/node-auth.js';
import { renderUnlock } from './pages-unlock.js';
import { buildPortfolio } from '../lib/portfolio.js';
import {
  WHITEOBER_TITLE,
  WHITEOBER_VERSION,
  PART1_FLOW,
  PART2_CUSTODY,
  SECURITY_PROTOCOLS,
  CAPITAL_POLICY,
  PARTS,
  START_LIST,
  startListFloorUsd,
  SOL_RESERVE,
  PAIR_MIN_ANSEM,
} from '../lib/whitepaper.js';
import { INDEX_NAME, NODE_MIN_USD, OLD_BOOK_WALLET, CONTROLLER_WALLET } from '../constants.js';
import { effectiveStartList, resolveHerdPool, resolveHerdMint } from '../lib/ansem-index.js';
import { getRecentTicks } from '../audit.js';
import {
  logPhase,
  logTx,
  queryTx,
  exportTxJsonl,
  exportTxCsv,
  resetTxLog,
  getTxBackend,
} from '../logger.js';
import {
  getSetupChecklist,
} from '../lib/setup-checklist.js';
import { rankPools } from '../lib/rank-pools.js';
import { buildSeedPlan } from '../lib/seed-plan.js';
import {
  buildFundSnapshot,
  buildFundPlan,
} from '../lib/fund-plan.js';
import {
  loadPoolPrefs,
  loadQueuePrefs,
  loadFundPolicy,
  saveFundPolicy,
  savePoolPref,
  savePoolPrefsBulk,
  saveQueuePrefs,
  applyBulkMode,
  poolPrefsBoard,
  flexibilityMeta,
  POOL_MODES,
  QUEUE_SORTS,
} from '../lib/pool-prefs.js';
import { renderHome } from './pages-home.js';
import { renderAnsem } from './pages-ansem.js';
import { renderWhitepaper } from './pages-whitepaper.js';
import { renderPool } from './pages-pool.js';
import { renderRun } from './pages-run.js';
import { buildPoolSnapshot, buildPoolPlan } from '../lib/pool-cockpit.js';
import { seedKeyStatus } from '../wallet.js';
import {
  runSeedOnce,
  runSeedPass,
  runContinuousSeed,
  abortSeedPass,
  isSeedRunning,
} from '../seed-loop.js';
import {
  syncStartListPools,
  loadCachedStartListPools,
  meteoraCacheStatus,
  fetchPool,
} from '../lib/meteora-api.js';
import { readRunState, writeRunState, clearRunState } from '../lib/run-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '../..');

let lastTick = null;
let tickRunner = null;
let tickInterval = null;

/** Single-flight + short cache for /api/run seed plan (stops poll stampedes). */
let _runPlanCache = null;
let _runPlanInflight = null;
const RUN_PLAN_CACHE_MS = 25_000;
const RUN_PLAN_TIMEOUT_MS = Number(process.env.SEED_PLAN_TIMEOUT_MS || 90_000);

async function getRunSeedPlan(wallet, pass) {
  const w = (wallet || '').trim() || config.lpWallet;
  const p = pass || config.seedPass || 'coverage';
  const key = `${w}|${p}`;
  if (
    _runPlanCache &&
    _runPlanCache.key === key &&
    Date.now() - _runPlanCache.at < RUN_PLAN_CACHE_MS
  ) {
    return { ..._runPlanCache.plan, cached: true };
  }
  if (_runPlanInflight && _runPlanInflight.key === key) {
    return _runPlanInflight.promise;
  }
  const promise = (async () => {
    const planPromise = buildSeedPlan({
      wallet: w,
      pass: p,
      skipControllerSync: true,
      maxActions: 6,
    });
    const plan = await Promise.race([
      planPromise,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('seed plan timeout (RPC slow / 429)')),
          RUN_PLAN_TIMEOUT_MS,
        ),
      ),
    ]);
    _runPlanCache = { key, at: Date.now(), plan };
    return plan;
  })().finally(() => {
    if (_runPlanInflight?.key === key) _runPlanInflight = null;
  });
  _runPlanInflight = { key, promise };
  return promise;
}

function logFundEvent(action, fields = {}) {
  const status = fields.status ?? 'ok';
  const row = logPhase('fund', action, {
    cell_id: config.cellId,
    level: fields.level || 'info',
    status,
    ...fields,
  });
  const isWithdraw =
    /close|withdraw|take|remove|harvest/i.test(String(action)) ||
    fields.delta === -1;
  const isDeposit = /deposit|add|cover|ape/i.test(String(action)) || fields.delta === 1;
  let kind = 'route';
  if (isWithdraw) kind = 'withdraw';
  else if (isDeposit) kind = 'deposit';
  else if (/claim/i.test(String(action))) kind = 'claim';
  else if (/buy/i.test(String(action))) kind = 'buy';
  else if (status === 'skip' || status === 'fail') kind = 'skip';
  try {
    logTx({
      kind,
      status,
      usd: fields.usd ?? null,
      ticker: fields.ticker ?? null,
      sig: fields.sig ?? null,
      delta: isWithdraw ? -1 : isDeposit ? 1 : fields.delta ?? 0,
      did:
        fields.did ||
        fields.detail ||
        `fund ${action}${fields.ticker ? ` · ${fields.ticker}` : ''}`,
      cell_id: config.cellId,
    });
  } catch (_) {}
  return row;
}

export function setTickRunner(fn) {
  tickRunner = fn;
}

export function isFeeBotTicking() {
  return Boolean(tickInterval);
}

function startFeeBotInterval() {
  if (!tickRunner) return { ok: false, error: 'tick runner not registered' };
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    tickRunner?.()
      .then((t) => {
        lastTick = t;
      })
      .catch((e) => console.error(e));
  }, config.tickMs);
  return { ok: true };
}

function stopFeeBotInterval() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

/**
 * Resume Start mission after redeploy if run-state says armed and gates allow.
 */
export async function resumeArmedMission() {
  if (config.demoPublic) {
    console.log('[run-state] skip resume — DEMO_PUBLIC');
    return { ok: false, reason: 'demo' };
  }
  const st = readRunState();
  if (!st.running) return { ok: false, reason: 'not_armed' };

  const setup = setupStatus();
  if (!setup.liveReady && isLive()) {
    console.warn('[run-state] armed but keys not liveReady — staying idle');
    return { ok: false, reason: 'keys' };
  }

  console.log('[run-state] resuming armed mission (seed + fee bot)');
  const forceDry = !isLive();

  if (st.feeBot !== false) {
    if (tickRunner) {
      try {
        lastTick = await tickRunner({ forceDry: true });
      } catch (_) {}
    }
    startFeeBotInterval();
  }

  if (st.seed !== false && !isSeedRunning()) {
    runContinuousSeed({
      forceDry,
      maxSteps: Number(process.env.SEED_MAX_STEPS || 40) || 40,
    }).catch((e) => console.error('[seed continuous]', e));
  }

  writeRunState({
    running: true,
    feeBot: st.feeBot !== false,
    seed: st.seed !== false,
    operatorMode: config.operatorMode,
  });
  return { ok: true, resumed: true };
}

export function setLastTick(t) {
  lastTick = t;
}

export function getLastTick() {
  return lastTick;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({ raw });
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function html(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function requireAuth(req, res) {
  const check = checkNodeAuth(req);
  if (!check.ok) {
    json(res, 401, {
      ok: false,
      error: check.reason || 'locked — enter DASHBOARD_PASSWORD at /unlock',
      unlock: '/unlock',
    });
    return false;
  }
  return true;
}

/** HTML pages: nothing real until DASHBOARD_PASSWORD opens a session. */
function requirePageUnlock(req, res, nextPath) {
  const check = checkNodeAuth(req);
  if (check.ok) return true;
  const q = encodeURIComponent(nextPath || '/');
  res.writeHead(302, {
    Location: `/unlock?next=${q}`,
    'Cache-Control': 'no-store',
  });
  res.end();
  return false;
}

function setupStatus() {
  return getSetupChecklist();
}

export function startDashboard({ onTick } = {}) {
  if (!config.dashboardEnabled) {
    console.log('[dashboard] disabled');
    return null;
  }

  if (onTick) tickRunner = onTick;
  scaffoldSecretsFile();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://localhost:${config.dashboardPort}`);
    const { pathname } = url;

    try {
      // —— Static public assets (favicon, HERD art) ——
      if (pathname === '/favicon.ico' || pathname === '/favicon.svg' || pathname === '/favicon-96x96.png' || pathname === '/apple-touch-icon.png' || pathname.startsWith('/ticker/')) {
        const safe = pathname.replace(/\.\./g, '');
        const filePath = path.join(ROOT, 'public', safe === '/favicon.ico' || safe === '/favicon.svg' || safe === '/favicon-96x96.png' || safe === '/apple-touch-icon.png' ? safe.slice(1) : safe.slice(1));
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const types = {
            '.ico': 'image/x-icon',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.webp': 'image/webp',
          };
          res.writeHead(200, {
            'Content-Type': types[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=86400',
          });
          fs.createReadStream(filePath).pipe(res);
          return;
        }
      }

      // —— Health ——
      if (pathname === '/health') {
        const { countDryRunTicks } = await import('../audit.js');
        const dryTicks = countDryRunTicks();
        const minDry = Number(process.env.GO_LIVE_MIN_DRY_TICKS || 0);
        const goLive = {
          allowed: isLive() ? dryTicks >= minDry || minDry === 0 : true,
          reason:
            isLive() && minDry > 0 && dryTicks < minDry
              ? `need ${minDry} dry ticks (have ${dryTicks}) — set GO_LIVE_MIN_DRY_TICKS=0 to override`
              : 'ok',
          dry_ticks: dryTicks,
          min_dry_ticks: minDry,
        };
        return json(res, 200, {
          ok: true,
          service: 'ansem-herd-node',
          cellId: config.cellId,
          dry_run: !isLive(),
          last_tick: lastTick?.finished ?? null,
          go_live: goLive,
          policy_version: (await import('../lib/node-policy.js')).NODE_POLICY_VERSION,
        });
      }

      if (pathname === '/api/gates_status') {
        const { buildGatesStatus } = await import('../lib/node-policy.js');
        const { seedKeyStatus } = await import('../wallet.js');
        const { countDryRunTicks } = await import('../audit.js');
        const wallet = config.lpWallet;
        const full = url.searchParams.get('full') === '1';
        let sol = 0;
        let census = null;
        // Light by default — avoid RPC storms (public endpoint 429 → hung UI).
        if (full) {
          try {
            const { getSolBalance } = await import('../adapters/solana.js');
            const { runWalletCensus } = await import('../lib/wallet-census.js');
            sol = wallet ? await getSolBalance(wallet) : 0;
            census = wallet ? await runWalletCensus(wallet) : null;
          } catch (_) {}
        }
        const dryTicks = countDryRunTicks();
        const minDry = Number(process.env.GO_LIVE_MIN_DRY_TICKS || 0);
        const goLive = {
          allowed: !isLive() || minDry === 0 || dryTicks >= minDry,
          reason:
            isLive() && minDry > 0 && dryTicks < minDry
              ? `need ${minDry} dry ticks (have ${dryTicks})`
              : 'ok',
          dry_ticks: dryTicks,
          min_dry_ticks: minDry,
        };
        let session = null;
        let coverage = null;
        if (full) {
          try {
            const { sessionPnl, getSessionBaseline } = await import('../lib/session-pnl.js');
            if (getSessionBaseline()) {
              const { buildFundSnapshot } = await import('../lib/fund-plan.js');
              const snap = await buildFundSnapshot({ wallet });
              session = sessionPnl(Number(snap.book?.valueUsd) || 0);
            }
          } catch {
            /* optional */
          }
          try {
            const { buildSeedPlan } = await import('../lib/seed-plan.js');
            const plan = await buildSeedPlan({
              wallet,
              skipControllerSync: true,
              maxActions: 4,
            });
            coverage = plan.coverage || null;
          } catch {
            /* optional */
          }
        }
        return json(
          res,
          200,
          buildGatesStatus({
            sol,
            census,
            keys: seedKeyStatus(),
            goLive,
            sessionPnl: session,
            coverage,
          }),
        );
      }

      // —— Unlock gate (DASHBOARD_PASSWORD) ——
      if (pathname === '/unlock') {
        const next = (url.searchParams.get('next') || '/').trim() || '/';
        const err = (url.searchParams.get('error') || '').trim();
        return html(
          res,
          200,
          renderUnlock({
            error: err,
            next,
            passwordConfigured: passwordConfigured(),
          }),
        );
      }
      if (pathname === '/api/unlock' && req.method === 'POST') {
        const body = await readBody(req);
        const pw = body.password ?? body.token ?? '';
        const next = String(body.next || '/').trim() || '/';
        if (!passwordConfigured()) {
          return json(res, 200, {
            ok: true,
            next,
            note: 'no DASHBOARD_PASSWORD set — already open',
          });
        }
        const match = passwordsMatch(pw);
        if (!match.ok) {
          return json(res, 401, { ok: false, error: 'wrong password' });
        }
        const token = createSessionToken();
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookieHeader(token),
        });
        res.end(JSON.stringify({ ok: true, next }));
        return;
      }
      if (pathname === '/api/lock' && (req.method === 'POST' || req.method === 'GET')) {
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Set-Cookie': sessionCookieHeader('', { clear: true }),
        });
        res.end(JSON.stringify({ ok: true, locked: true }));
        return;
      }

      // —— Pages (locked until DASHBOARD_PASSWORD opens a session) ——
      if (pathname === '/' || pathname === '/setup') {
        if (!requirePageUnlock(req, res, '/')) return;
        let ledger = { backend: 'sqlite', path: null, mirror: 'logs/tx.jsonl', note: 'GET /api/tx' };
        try {
          ledger = { ...getTxBackend(), note: 'GET /api/tx' };
        } catch (_) {}
        return html(
          res,
          200,
          renderHome({
            checklist: getSetupChecklist(),
            feeSplit: config.feeSplit,
            ledger,
            solReserve: config.solReserve,
            reservePct: config.reservePct,
            pairMinAnsem: config.pairMinAnsem,
            nodeActiveLimit: config.nodeActiveLimit,
            pools: effectiveStartList(START_LIST).slice(0, 25),
            poolPrefs: loadPoolPrefs(),
            ansemMint: config.ansemMint,
            lpWallet: config.lpWallet,
            controllerWallet: config.controllerWallet,
            ansemDestWallet: config.ansemDestWallet,
            herdLive: Boolean(config.herdPoolLive),
            herdPool: config.herdPool || resolveHerdPool(),
            herdMint: config.indexTokenMint || resolveHerdMint(),
          }),
        );
      }
      if (pathname === '/config' || pathname === '/manage') {
        if (!requirePageUnlock(req, res, '/#config')) return;
        // Config lives on Setup (sliders). Keep route as redirect.
        res.writeHead(302, { Location: '/#config' });
        return res.end();
      }
      if (pathname === '/run') {
        if (!requirePageUnlock(req, res, '/run')) return;
        // Browser fills mission via GET /api/run + /api/gates_status.
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const policy = {
          solReserve: config.solReserve,
          pairMinAnsem: config.pairMinAnsem,
          pairMinUsd: config.pairMinUsd,
          operatorMode: config.operatorMode || config.cell?.runtime?.operatorMode || 'cover',
          nodeActiveLimit: config.nodeActiveLimit,
          apeMaxAgeMinutes: config.apeMaxAgeMinutes,
          seedPass: config.seedPass,
          seedUniverse: config.seedUniverse,
          seedSort: config.seedSort,
          leaveInPoolPct: Number(process.env.LEAVE_IN_POOL_PCT || 10),
        };
        return html(res, 200, renderRun({
          wallet,
          balances: { sol: 0, deployableSol: 0, ansem: 0 },
          nextAction: null,
          ranking: null,
          coverage: null,
          policy,
          dryRun: !isLive(),
          lastTick,
          ticking: Boolean(tickInterval),
          seeding: isSeedRunning(),
          loading: true,
          error: null,
          setup: setupStatus(),
          seedKeys: seedKeyStatus(),
          pies: null,
          minClaimUsd: config.minClaimUsd,
        }));
      }
      if (pathname === '/reports' || pathname.startsWith('/reports/')) {
        res.writeHead(302, { Location: '/run' });
        res.end();
        return;
      }
      if (pathname === '/ansem') {
        if (!requirePageUnlock(req, res, '/ansem')) return;
        return html(res, 200, renderAnsem({
          wallet: config.trackedWallet || OLD_BOOK_WALLET,
          indexName: INDEX_NAME,
          herdLive: Boolean(config.herdPoolLive),
          herdPool: config.herdPool || resolveHerdPool(),
          herdMint: config.indexTokenMint || resolveHerdMint(),
        }));
      }
      if (pathname === '/ops' || pathname === '/pools') {
        res.writeHead(302, { Location: '/run' });
        res.end();
        return;
      }
      if (pathname === '/log' || pathname === '/seed' || pathname === '/fund') {
        res.writeHead(302, { Location: '/run' });
        res.end();
        return;
      }
      if (pathname === '/pool') {
        if (!requirePageUnlock(req, res, '/pool')) return;
        const poolKey =
          (url.searchParams.get('pool') || url.searchParams.get('ticker') || '').trim();
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        let snapshot = null;
        let error = null;
        try {
          snapshot = await buildPoolSnapshot({ pool: poolKey, wallet });
          if (snapshot.ok === false) error = snapshot.error;
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          snapshot = { ok: false, pool: { ticker: poolKey, pool: poolKey }, position: {}, pref: {}, links: {} };
        }
        return html(res, 200, renderPool({
          snapshot,
          focusAction: (url.searchParams.get('action') || '').trim(),
          error,
        }));
      }
      if (pathname === '/whitepaper') {
        if (!requirePageUnlock(req, res, '/whitepaper')) return;
        return html(res, 200, renderWhitepaper({
          title: WHITEOBER_TITLE,
          version: WHITEOBER_VERSION,
          parts: PARTS,
          flow: PART1_FLOW,
          custody: PART2_CUSTODY,
          security: SECURITY_PROTOCOLS,
          capital: CAPITAL_POLICY,
          startList: START_LIST,
          floor: startListFloorUsd(),
          nodeMin: NODE_MIN_USD,
          pairMinAnsem: config.pairMinAnsem ?? PAIR_MIN_ANSEM,
          solReserve: config.solReserve ?? SOL_RESERVE,
        }));
      }

      // —— APIs ——
      if (pathname === '/api/state') {
        const keys = verifyKeysMatchPubkeys();
        return json(res, 200, {
          config: {
            cellId: config.cellId,
            trackedWallet: config.trackedWallet,
            lpWallet: config.lpWallet,
            operatorWallet: config.operatorWallet,
            ansemDestWallet: config.ansemDestWallet,
            ansemMint: config.ansemMint,
            dryRun: config.dryRun,
            simulationMode: config.simulationMode,
            live: isLive(),
            feeSplit: config.feeSplit,
            aemonDonateWallet: config.aemonDonateWallet,
            indexTokenMint: config.indexTokenMint,
            indexTokenSymbol: config.indexTokenSymbol,
            tickMs: config.tickMs,
            demoPublic: config.demoPublic,
            solReserve: config.solReserve,
            pairMinAnsem: config.pairMinAnsem,
            seedPass: config.seedPass,
            singleWalletMode: config.singleWalletMode,
            isSingleWallet: config.isSingleWallet,
          },
          keys,
          setup: setupStatus(),
          lastTick,
        });
      }

      if (pathname === '/api/portfolio') {
        const wallet =
          url.searchParams.get('wallet') ||
          config.trackedWallet ||
          OLD_BOOK_WALLET;
        const all = url.searchParams.get('all') === '1';
        const portfolio = await buildPortfolio(wallet, config.ansemMint, {
          indexOnly: !all,
          role: wallet === config.lpWallet ? 'node' : 'tracked_ro',
        });
        return json(res, 200, portfolio);
      }

      if (pathname === '/api/portfolio-pies') {
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const { buildPortfolioPies } = await import('../lib/portfolio-pies.js');
        const pies = await buildPortfolioPies({
          wallet,
          force: url.searchParams.get('force') === '1',
        });
        return json(res, 200, pies);
      }

      if (pathname === '/api/tx') {
        const since = Number(url.searchParams.get('since') || 0);
        const limit = Number(url.searchParams.get('limit') || 80);
        const kind = url.searchParams.get('kind') || undefined;
        const tickId = url.searchParams.get('tick_id') || undefined;
        return json(res, 200, {
          ok: true,
          txs: queryTx({ since, limit, kind, tickId }),
          ...getTxBackend(),
          note: 'SQLite tx log — reset on Start',
        });
      }

      if (pathname === '/api/tx/reset' && req.method === 'POST') {
        if (!requireAuth(req, res)) return;
        const result = resetTxLog();
        logTx({ kind: 'session_start', status: 'ok', did: 'tx log reset' });
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === '/api/tx/export') {
        const format = (url.searchParams.get('format') || 'csv').toLowerCase();
        const limit = Number(url.searchParams.get('limit') || 5000);
        if (format === 'json') {
          const rows = exportTxJsonl(limit);
          return json(res, 200, { ok: true, txs: rows, count: rows.length });
        }
        if (format === 'jsonl') {
          const rows = exportTxJsonl(limit);
          res.writeHead(200, {
            'Content-Type': 'application/x-ndjson; charset=utf-8',
            'Content-Disposition': 'attachment; filename="tx.jsonl"',
          });
          res.end(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="tx.csv"',
        });
        res.end(exportTxCsv(limit));
        return;
      }

      if (pathname === '/api/events') {
        // Compat: map tx feed into legacy event shape for older clients
        const since = Number(url.searchParams.get('since') || 0);
        const limit = Number(url.searchParams.get('limit') || 100);
        const tickId = url.searchParams.get('tick_id') || undefined;
        const txs = queryTx({ since, limit, tickId });
        return json(res, 200, {
          events: txs.map((t) => ({
            ts: t.ts,
            level: t.status === 'fail' ? 'error' : 'info',
            message: t.did || t.kind,
            tick_id: t.tick_id,
            phase: t.kind,
            action: t.kind,
            status: t.status,
            usd: t.usd,
            sig: t.sig,
            detail: t.did,
            ticker: t.ticker,
            delta: t.delta,
          })),
          note: 'compat view of /api/tx — no database',
        });
      }

      if (pathname === '/api/run' && req.method === 'GET') {
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const basePolicy = {
          solReserve: config.solReserve,
          pairMinAnsem: config.pairMinAnsem,
          pairMinUsd: config.pairMinUsd,
          operatorMode: config.operatorMode || 'cover',
          nodeActiveLimit: config.nodeActiveLimit,
          apeMaxAgeMinutes: config.apeMaxAgeMinutes,
          seedPass: config.seedPass,
        };
        const light = {
          ok: true,
          wallet,
          balances: { sol: 0, deployableSol: 0, ansem: 0 },
          nextAction: null,
          coverage: null,
          ranking: null,
          policy: basePolicy,
          lastTick,
          dryRun: !isLive(),
          ticking: Boolean(tickInterval),
          seeding: isSeedRunning(),
          seedKeys: seedKeyStatus(),
          loading: true,
          minClaimUsd: config.minClaimUsd,
        };
        try {
          const { buildPortfolioPies } = await import('../lib/portfolio-pies.js');
          const piesP = buildPortfolioPies({ wallet }).catch(() => null);
          const plan = await getRunSeedPlan(wallet, url.searchParams.get('pass'));
          const pies = await piesP;
          return json(res, 200, {
            ok: true,
            wallet,
            balances: plan.balances,
            nextAction: plan.nextAction,
            coverage: plan.coverage || null,
            ranking: plan.ranking,
            policy: plan.policy || basePolicy,
            pies,
            lastTick,
            dryRun: !isLive(),
            ticking: Boolean(tickInterval),
            seeding: isSeedRunning(),
            seedKeys: seedKeyStatus(),
            loading: false,
            rpcPatient: true,
            minClaimUsd: config.minClaimUsd,
          });
        } catch (e) {
          let pies = null;
          try {
            const { buildPortfolioPies } = await import('../lib/portfolio-pies.js');
            pies = await buildPortfolioPies({ wallet });
          } catch (_) {}
          const cached = _runPlanCache?.plan;
          if (cached?.balances) {
            return json(res, 200, {
              ok: true,
              wallet,
              balances: cached.balances,
              nextAction: cached.nextAction,
              coverage: cached.coverage || null,
              ranking: cached.ranking,
              policy: cached.policy || basePolicy,
              pies,
              lastTick,
              dryRun: !isLive(),
              ticking: Boolean(tickInterval),
              seeding: isSeedRunning(),
              seedKeys: seedKeyStatus(),
              loading: false,
              stale: true,
              error: e instanceof Error ? e.message : String(e),
              hint: 'RPC still slow — showing last good plan + portfolio pies. Node paces requests; set SOLANA_RPC_URL to a paid endpoint if this persists.',
              minClaimUsd: config.minClaimUsd,
            });
          }
          return json(res, 200, {
            ...light,
            ok: false,
            loading: false,
            pies,
            error: e instanceof Error ? e.message : String(e),
            hint: 'Public RPC rate-limited — pies still load from Meteora when possible. Wait for patient backoff or set SOLANA_RPC_URL.',
            minClaimUsd: config.minClaimUsd,
          });
        }
      }

      if (pathname === '/api/ticks') {
        const limit = Number(url.searchParams.get('limit') || 20);
        return json(res, 200, {
          ticks: getRecentTicks(limit),
          note: 'logs/ticks.jsonl audit trail — money moves are GET /api/tx',
        });
      }

      if (pathname === '/api/ledger') {
        const backend = getTxBackend();
        return json(res, 200, {
          backend,
          txs: queryTx({ limit: 50 }),
          note: 'tx log is SQLite logs/tx.sqlite (+ jsonl mirror) — use GET /api/tx',
        });
      }

      if (pathname === '/api/fee-split' || pathname === '/api/config') {
        if (req.method === 'GET') {
          return json(res, 200, {
            ok: true,
            feeSplit: config.feeSplit,
            routes: defaultRoutes(),
            aemonDonateWallet: config.aemonDonateWallet,
            indexTokenMint: config.indexTokenMint,
            indexTokenSymbol: config.indexTokenSymbol,
            herdMint: config.indexTokenMint || '',
            herdPool: config.herdPool || '',
            herdPoolLive: Boolean(config.herdPoolLive),
            knobs: {
              solReserve: config.solReserve,
              pairMinAnsem: config.pairMinAnsem,
              pairMinUsd: config.pairMinUsd,
              operatorMode: config.operatorMode,
              nodeActiveLimit: config.nodeActiveLimit,
              apeMaxAgeMinutes: config.apeMaxAgeMinutes,
              seedPass: config.seedPass,
            },
          });
        }
        if (req.method === 'POST') {
          if (!requireAuth(req, res)) return;
          const body = await readBody(req);
          const feeSplit = normalizeFeeSplit(body.feeSplit || body);
          const aemonDonateWallet = (body.aemonDonateWallet || '').trim();
          const herdMintRaw =
            body.herdMint != null
              ? body.herdMint
              : body.HERD_MINT != null
                ? body.HERD_MINT
                : body.indexTokenMint;
          const herdPoolRaw =
            body.herdPool != null
              ? body.herdPool
              : body.HERD_POOL != null
                ? body.HERD_POOL
                : undefined;
          const indexTokenMint =
            herdMintRaw != null ? String(herdMintRaw).trim() : undefined;
          const herdPool =
            herdPoolRaw != null ? String(herdPoolRaw).trim() : undefined;
          const knobs = body.knobs || {};
          const patch = {
            feeSplit,
            routes: body.clearRoutes === false ? undefined : null,
            runtime: {},
          };
          if (indexTokenMint !== undefined) {
            patch.indexTokenMint = indexTokenMint;
          }
          if (herdPool !== undefined) {
            patch.herdPool = herdPool;
          }
          if (knobs.solReserve != null && Number.isFinite(Number(knobs.solReserve))) {
            patch.runtime.solReserve = Number(knobs.solReserve);
          }
          if (knobs.pairMinAnsem != null && Number.isFinite(Number(knobs.pairMinAnsem))) {
            patch.runtime.pairMinAnsem = Number(knobs.pairMinAnsem);
          }
          if (knobs.nodeActiveLimit != null && Number.isFinite(Number(knobs.nodeActiveLimit))) {
            patch.runtime.nodeActiveLimit = Math.max(10, Math.floor(Number(knobs.nodeActiveLimit)));
          }
          if (knobs.apeMaxAgeMinutes != null && Number.isFinite(Number(knobs.apeMaxAgeMinutes))) {
            patch.runtime.apeMaxAgeMinutes = Math.max(1, Math.floor(Number(knobs.apeMaxAgeMinutes)));
          }
          if (knobs.seedPass) {
            patch.runtime.seedPass = String(knobs.seedPass);
          }
          if (knobs.operatorMode) {
            const { normalizeOperatorMode, seedPassForMode } = await import(
              '../lib/operator-mode.js'
            );
            const mode = normalizeOperatorMode(knobs.operatorMode);
            patch.runtime.operatorMode = mode;
            patch.runtime.seedPass = seedPassForMode(mode);
          }
          if (knobs.pairMinUsd != null && Number.isFinite(Number(knobs.pairMinUsd))) {
            patch.runtime.pairMinUsd = Number(knobs.pairMinUsd);
          }
          if (knobs.reservePct != null && Number.isFinite(Number(knobs.reservePct))) {
            const rp = Number(knobs.reservePct);
            patch.runtime.reservePct = rp > 1 ? rp / 100 : rp;
          }
          if (!Object.keys(patch.runtime).length) delete patch.runtime;
          if (aemonDonateWallet) {
            patch.aemonDonateWallet = aemonDonateWallet;
            patch.wallets = {
              ...(config.cell?.wallets || {}),
              aemonDonate: aemonDonateWallet,
            };
          }
          if (body.clearRoutes !== false) {
            patch.routes = null;
          }
          saveCellJson(patch);
          if (body.poolToggles && typeof body.poolToggles === 'object') {
            savePoolPrefsBulk(body.poolToggles);
          }
          const envPairs = {
            FEE_SPLIT_ANSEM_SEND: String(feeSplit.ansemSend),
            FEE_SPLIT_ANSEM_HOLD: String(feeSplit.ansemHold || 0),
            FEE_SPLIT_INDEX_BURN: String(feeSplit.indexBurn || 0),
            FEE_SPLIT_AEMON_DONATE: String(feeSplit.aemonDonate || 0),
            FEE_SPLIT_RESERVE: String(feeSplit.reserve),
            FEE_SPLIT_REINVEST: String(feeSplit.reinvest),
          };
          if (knobs.solReserve != null) envPairs.SOL_RESERVE = String(Number(knobs.solReserve));
          if (knobs.pairMinAnsem != null) envPairs.PAIR_MIN_ANSEM = String(Number(knobs.pairMinAnsem));
          if (knobs.nodeActiveLimit != null) {
            envPairs.NODE_ACTIVE_LIMIT = String(Math.max(10, Math.floor(Number(knobs.nodeActiveLimit))));
          }
          if (knobs.reservePct != null && Number.isFinite(Number(knobs.reservePct))) {
            const rp = Number(knobs.reservePct);
            envPairs.RESERVE_PCT = String(rp > 1 ? rp / 100 : rp);
          }
          if (knobs.apeMaxAgeMinutes != null) {
            envPairs.APE_MAX_AGE_MINUTES = String(Math.max(1, Math.floor(Number(knobs.apeMaxAgeMinutes))));
          }
          if (knobs.seedPass) envPairs.SEED_PASS = String(knobs.seedPass);
          if (knobs.operatorMode) {
            envPairs.OPERATOR_MODE = String(knobs.operatorMode);
            const { seedPassForMode } = await import('../lib/operator-mode.js');
            envPairs.SEED_PASS = seedPassForMode(knobs.operatorMode);
          }
          if (knobs.pairMinUsd != null) envPairs.PAIR_MIN_USD = String(Number(knobs.pairMinUsd));
          if (aemonDonateWallet) envPairs.AEMON_DONATE_WALLET = aemonDonateWallet;
          if (indexTokenMint !== undefined) {
            envPairs.HERD_MINT = indexTokenMint;
            envPairs.INDEX_TOKEN_MINT = indexTokenMint;
          }
          if (herdPool !== undefined) {
            envPairs.HERD_POOL = herdPool;
            envPairs.INDEX_POOL_ADDRESS = herdPool;
          }
          upsertEnvKeys(envPairs);

          // First live HERD save → pin + equal-weight goal among active limit
          const { isHerdPoolLive } = await import('../constants.js');
          const livePool = herdPool !== undefined ? herdPool : config.herdPool;
          if (livePool && isHerdPoolLive(livePool)) {
            const existing = config.cell?.poolPrefs?.[livePool];
            const limit = Math.max(10, Number(config.nodeActiveLimit) || 10);
            const equalPct = Math.round((100 / limit) * 10) / 10;
            if (!existing || existing.targetWeightPct == null) {
              savePoolPref(livePool, {
                mode: 'active',
                pin: true,
                targetWeightPct:
                  existing?.targetWeightPct != null
                    ? existing.targetWeightPct
                    : equalPct,
              });
            } else if (!existing.pin) {
              savePoolPref(livePool, { pin: true, mode: existing.mode || 'active' });
            }
          }

          return json(res, 200, {
            ok: true,
            feeSplit: config.feeSplit,
            routes: defaultRoutes(),
            aemonDonateWallet: config.aemonDonateWallet,
            indexTokenMint: config.indexTokenMint,
            herdMint: config.indexTokenMint || '',
            herdPool: config.herdPool || '',
            herdPoolLive: Boolean(config.herdPoolLive),
            knobs: {
              solReserve: config.solReserve,
              pairMinAnsem: config.pairMinAnsem,
              pairMinUsd: config.pairMinUsd,
              operatorMode: config.operatorMode,
              nodeActiveLimit: config.nodeActiveLimit,
              apeMaxAgeMinutes: config.apeMaxAgeMinutes,
              seedPass: config.seedPass,
              reservePct: config.reservePct,
            },
          });
        }
      }


      if (pathname === '/api/fund') {
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const sync =
          url.searchParams.get('sync') === '1' ||
          url.searchParams.get('syncController') === '1';
        const snapshot = await buildFundSnapshot({
          wallet,
          syncController: sync,
        });
        return json(res, 200, snapshot);
      }

      if (pathname === '/api/fund/sync-controller' && req.method === 'POST') {
        if (!requireAuth(req, res)) return;
        const { syncControllerTargets } = await import('../lib/controller-book.js');
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        let positions = [];
        try {
          const p = await buildPortfolio(wallet, config.ansemMint);
          positions = p.positions || [];
        } catch (_) {}
        const result = await syncControllerTargets({
          nodePositions: positions,
          persistLedger: false,
          force: true,
        });
        logFundEvent('controller_sync', {
          status: result.ok ? 'ok' : 'fail',
          detail: result.skipped
            ? result.reason
            : `set=${result.set} zeroed=${result.zeroed} ctrl=$${Number(result.bookValue || 0).toFixed(0)}`,
          meta: {
            set: result.set,
            zeroed: result.zeroed,
            cleared: result.cleared,
            wallet: result.wallet,
          },
        });
        const snapshot = await buildFundSnapshot({
          wallet,
          syncController: false,
        });
        return json(res, result.ok ? 200 : 500, { ...result, snapshot });
      }

      if (pathname === '/api/operator-mode') {
        const {
          getOperatorSnapshot,
          setOperatorMode,
          OPERATOR_MODES,
          seedPassForMode,
        } = await import('../lib/operator-mode.js');
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, ...getOperatorSnapshot(), modes: OPERATOR_MODES });
        }
        if (req.method === 'POST') {
          if (!requireAuth(req, res)) return;
          let body = {};
          try {
            body = await readBody(req);
          } catch (_) {
            body = {};
          }
          const snap = setOperatorMode({
            operatorMode: body.operatorMode || body.mode,
            pairMinUsd: body.pairMinUsd,
            pairMinAnsem: body.pairMinAnsem,
          });
          const envPairs = {
            OPERATOR_MODE: snap.operatorMode,
            SEED_PASS: seedPassForMode(snap.operatorMode),
            PAIR_MIN_USD: String(snap.pairMinUsd),
          };
          if (body.pairMinAnsem != null) {
            envPairs.PAIR_MIN_ANSEM = String(Number(body.pairMinAnsem));
          }
          try {
            upsertEnvKeys(envPairs);
          } catch (_) {}
          logFundEvent('operator_mode', {
            status: 'ok',
            detail: `MODE ${snap.operatorMode} · pair≥$${snap.pairMinUsd}`,
            meta: snap,
          });
          return json(res, 200, { ok: true, ...snap, modes: OPERATOR_MODES });
        }
        return json(res, 405, { ok: false, error: 'GET or POST' });
      }

      if (pathname === '/api/pool') {
        const pool =
          (url.searchParams.get('pool') || url.searchParams.get('ticker') || '').trim();
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const snapshot = await buildPoolSnapshot({ pool, wallet });
        return json(res, snapshot.ok === false ? 400 : 200, snapshot);
      }

      if (pathname === '/api/pool-plan') {
        if (req.method === 'POST') {
          if (!requireAuth(req, res)) return;
        }
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        let body = {};
        if (req.method === 'POST') {
          try {
            body = await readBody(req);
          } catch (_) {
            body = {};
          }
        }
        const action = (body.action || url.searchParams.get('action') || 'claim').trim();
        const pool =
          (body.pool || body.ticker || url.searchParams.get('pool') || url.searchParams.get('ticker') || '').trim();
        const pct = body.pct != null ? Number(body.pct) : Number(url.searchParams.get('pct') || 0) || undefined;
        const ansemAmount =
          body.ansemAmount != null
            ? Number(body.ansemAmount)
            : Number(url.searchParams.get('ansemAmount') || 0) || undefined;
        const redirectTo =
          body.redirectTo != null
            ? body.redirectTo
            : url.searchParams.get('redirectTo') || undefined;
        const applyClose =
          req.method === 'POST' &&
          (url.searchParams.get('apply') === '1' ||
            body.applyClosePrefs === true ||
            body.apply === true);
        const plan = await buildPoolPlan({
          action,
          pool,
          wallet: body.wallet || wallet,
          pct,
          ansemAmount,
          redirectTo,
          applyClosePrefs: applyClose,
        });
        if (plan.ok) {
          logFundEvent(`pool_${plan.action}`, {
            status: plan.status || 'ok',
            detail: `${plan.action} ${plan.pool?.ticker || pool}`,
            meta: { action: plan.action, pool: plan.pool, pct: plan.pct },
          });
        }
        return json(res, plan.ok === false ? 400 : 200, plan);
      }

      if (pathname === '/api/meteora/cache') {
        return json(res, 200, {
          ok: true,
          ...meteoraCacheStatus(),
          startList: loadCachedStartListPools(),
        });
      }

      if (pathname === '/api/meteora/pool') {
        const address =
          (url.searchParams.get('address') || url.searchParams.get('pool') || '').trim();
        if (!address) return json(res, 400, { ok: false, error: 'address required' });
        const pool = await fetchPool(address);
        return json(res, 200, { ok: true, pool });
      }

      if (pathname === '/api/meteora/sync' && req.method === 'POST') {
        if (!requireAuth(req, res)) return;
        const book = await syncStartListPools();
        logFundEvent('meteora_sync', {
          status: 'ok',
          detail: `${book.count} pools`,
          meta: { count: book.count, errors: book.errors?.length || 0 },
        });
        return json(res, 200, {
          ok: true,
          count: book.count,
          errors: book.errors || [],
          fetched_at: book.fetched_at,
          cache: meteoraCacheStatus(),
        });
      }

      if (pathname === '/api/fund-plan') {
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const action = (url.searchParams.get('action') || 'take_out').trim();
        const pool =
          (url.searchParams.get('pool') || url.searchParams.get('ticker') || '').trim();
        const pct = Number(url.searchParams.get('pct') || 0) || undefined;
        const proceeds = url.searchParams.get('proceeds') || undefined;
        const redirectTo = url.searchParams.get('redirectTo') || undefined;
        const applyClose =
          req.method === 'POST' &&
          (url.searchParams.get('apply') === '1' ||
            url.searchParams.get('applyClosePrefs') === '1');

        let body = {};
        if (req.method === 'POST') {
          try {
            body = await readBody(req);
          } catch (_) {
            body = {};
          }
        }
        const plan = await buildFundPlan({
          action: body.action || action,
          pool: body.pool || body.ticker || pool,
          pct: body.pct != null ? Number(body.pct) : pct,
          proceeds: body.proceeds || proceeds,
          redirectTo: body.redirectTo != null ? body.redirectTo : redirectTo,
          wallet: body.wallet || wallet,
          applyClosePrefs:
            applyClose || body.applyClosePrefs === true || body.apply === true,
        });
        if (plan.ok) {
          const evt =
            plan.action === 'close'
              ? plan.closePrefs && (applyClose || body.applyClosePrefs)
                ? 'close_plan'
                : 'close_plan'
              : 'take_out_plan';
          logFundEvent(evt, {
            status: 'ok',
            usd: plan.estUsd,
            detail: `${plan.action} ${plan.pool?.ticker || pool} ${plan.pct}%`,
            meta: {
              action: plan.action,
              pool: plan.pool,
              pct: plan.pct,
              proceeds: plan.proceeds,
              closePrefs: plan.closePrefs,
              applied: Boolean(plan.closePrefs && (applyClose || body.applyClosePrefs)),
            },
          });
        }
        return json(res, plan.ok === false ? 400 : 200, plan);
      }

      if (pathname === '/api/fund-policy') {
        if (req.method === 'GET') {
          return json(res, 200, { ok: true, fundPolicy: loadFundPolicy() });
        }
        if (req.method === 'POST') {
          if (!requireAuth(req, res)) return;
          const body = await readBody(req);
          const fundPolicy = saveFundPolicy(body.fundPolicy || body);
          logFundEvent('set_policy', {
            status: 'ok',
            detail: JSON.stringify(fundPolicy),
            meta: { fundPolicy },
          });
          return json(res, 200, { ok: true, fundPolicy });
        }
      }

      if (pathname === '/api/seed-plan') {
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        const pass = url.searchParams.get('pass') || config.seedPass || 'coverage';
        const plan = await buildSeedPlan({ wallet, pass });
        return json(res, plan.ok === false ? 400 : 200, plan);
      }

      if (pathname === '/api/rank-pools') {
        const wallet =
          (url.searchParams.get('wallet') || '').trim() || config.lpWallet;
        let positions = [];
        if (wallet) {
          try {
            const p = await buildPortfolio(wallet, config.ansemMint);
            positions = p.positions || [];
          } catch (_) {}
        }
        const ranking = await rankPools({
          startList: START_LIST,
          w1Positions: positions,
          pass: url.searchParams.get('pass') || config.seedPass || 'coverage',
        });
        return json(res, 200, ranking);
      }

      if (pathname === '/api/pool-prefs') {
        if (req.method === 'GET') {
          return json(res, 200, {
            ok: true,
            ...flexibilityMeta(),
            prefs: loadPoolPrefs(),
            queuePrefs: loadQueuePrefs(),
            board: poolPrefsBoard(START_LIST),
            note: 'active=seed · hold=keep existing · off=skip · pin/priority/min/force/note per pool',
          });
        }
        if (req.method === 'POST') {
          if (!requireAuth(req, res)) return;
          const body = await readBody(req);

          if (body.queuePrefs && typeof body.queuePrefs === 'object') {
            const queuePrefs = saveQueuePrefs(body.queuePrefs);
            return json(res, 200, {
              ok: true,
              queuePrefs,
              prefs: loadPoolPrefs(),
              board: poolPrefsBoard(START_LIST),
            });
          }

          if (body.bulk) {
            const action = String(body.bulk);
            let mode = 'active';
            let filter = 'all';
            if (action === 'all_hold' || action === 'hold') mode = 'hold';
            else if (action === 'all_off' || action === 'off') mode = 'off';
            else if (action === 'all_seed' || action === 'seed' || action === 'all_active') mode = 'active';
            else if (action === 'hold_in') {
              mode = 'hold';
              filter = 'in';
            } else if (action === 'seed_out') {
              mode = 'active';
              filter = 'out';
            }
            const inMap = new Map();
            if (filter !== 'all' && config.lpWallet) {
              try {
                const p = await buildPortfolio(config.lpWallet, config.ansemMint);
                for (const pos of p.positions || []) {
                  if (pos.pool_address) inMap.set(pos.pool_address, true);
                }
              } catch (_) {}
            }
            const prefs = applyBulkMode(mode, filter, START_LIST, inMap);
            return json(res, 200, {
              ok: true,
              bulk: action,
              prefs,
              board: poolPrefsBoard(START_LIST),
            });
          }

          if (body.prefs && typeof body.prefs === 'object') {
            const prefs = savePoolPrefsBulk(body.prefs);
            return json(res, 200, {
              ok: true,
              prefs,
              queuePrefs: loadQueuePrefs(),
              board: poolPrefsBoard(START_LIST),
            });
          }

          const key = (body.pool || body.ticker || body.key || '').trim();
          if (!key) return json(res, 400, { ok: false, error: 'pool or ticker required' });
          let patch = {};
          if (body.pref && typeof body.pref === 'object' && Object.keys(body.pref).length) {
            patch = { ...body.pref };
          } else {
            if (body.mode != null) patch.mode = body.mode;
            if (body.pin != null) patch.pin = body.pin;
            if (body.priority != null) patch.priority = body.priority;
            if (Object.prototype.hasOwnProperty.call(body, 'pairMinAnsem')) {
              patch.pairMinAnsem = body.pairMinAnsem;
            }
            if (body.force != null) patch.force = body.force;
            if (body.note != null) patch.note = body.note;
            if (Object.prototype.hasOwnProperty.call(body, 'targetWeightPct')) {
              patch.targetWeightPct = body.targetWeightPct;
            }
            if (Object.prototype.hasOwnProperty.call(body, 'redirectTo')) {
              patch.redirectTo = body.redirectTo;
            }
            if (Object.prototype.hasOwnProperty.call(body, 'takeOutDefaultPct')) {
              patch.takeOutDefaultPct = body.takeOutDefaultPct;
            }
          }
          if (!Object.keys(patch).length) {
            return json(res, 400, { ok: false, error: 'mode or pref fields required' });
          }
          const result = savePoolPref(key, patch);
          if (
            Object.prototype.hasOwnProperty.call(patch, 'targetWeightPct') ||
            Object.prototype.hasOwnProperty.call(patch, 'redirectTo')
          ) {
            logFundEvent(
              Object.prototype.hasOwnProperty.call(patch, 'redirectTo') && patch.redirectTo
                ? 'redirect'
                : 'set_target',
              {
                status: 'ok',
                detail: `${key} target=${patch.targetWeightPct ?? '—'} redirect=${patch.redirectTo || '—'}`,
                meta: { key, patch },
              },
            );
          }
          return json(res, 200, {
            ok: true,
            ...result,
            queuePrefs: loadQueuePrefs(),
            board: poolPrefsBoard(START_LIST),
          });
        }
      }

      if (pathname === '/api/setup/keys-status') {
        return json(res, 200, keyFileStatus());
      }

      if (pathname === '/api/setup/generate-wallets' && req.method === 'POST') {
        if (config.demoPublic) {
          return json(res, 403, { ok: false, error: 'wallet generation disabled on public demo' });
        }
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const already = existingKeysPresent();
        if (already && body.confirm !== 'REGEN') {
          return json(res, 409, {
            ok: false,
            existing: true,
            error:
              'keys already exist — send {"confirm":"REGEN","force":true} to overwrite (creates .bak first; orphaning old funds is irreversible)',
          });
        }
        const result = generateWalletKeypairs({
          includeMain: body.includeMain !== false,
          force: already ? true : Boolean(body.force),
        });
        if (result.ok === false) {
          return json(res, 409, result);
        }
        return json(res, 200, { ok: true, ...result });
      }

      if (pathname === '/api/setup/wallets' && req.method === 'POST') {
        if (!requireAuth(req, res)) return;
        const body = await readBody(req);
        const lp = (body.lp || '').trim();
        let operator = (body.operator || '').trim();
        if (!operator && (body.singleWallet !== false) && lp) operator = lp;
        if (body.singleWallet && lp) operator = operator || lp;
        const wallets = {
          main: (body.main || '').trim(),
          lp,
          operator,
          ansemDest: (body.ansemDest || '').trim() || lp,
        };
        const singleWalletMode =
          body.singleWallet === true ||
          (wallets.lp && wallets.operator && wallets.lp === wallets.operator);
        saveCellJson({
          wallets,
          runtime: { singleWalletMode: Boolean(singleWalletMode) },
        });
        upsertEnvKeys({
          MAIN_WALLET: wallets.main,
          LP_WALLET: wallets.lp,
          OPERATOR_WALLET: wallets.operator,
          ANSEM_DEST_WALLET: wallets.ansemDest,
          TRACKED_WALLET: config.trackedWallet || CONTROLLER_WALLET,
          SINGLE_WALLET_MODE: singleWalletMode ? 'true' : 'false',
        });
        return json(res, 200, {
          ok: true,
          wallets,
          controllerWallet: CONTROLLER_WALLET,
          setup: setupStatus(),
        });
      }

      if (pathname === '/api/tick' && req.method === 'POST') {
        if (!requireAuth(req, res)) return;
        if (config.demoPublic && isLive()) {
          return json(res, 403, { ok: false, error: 'live ticks blocked on public demo' });
        }
        if (!tickRunner) {
          return json(res, 500, { ok: false, error: 'tick runner not registered' });
        }
        const result = await tickRunner();
        lastTick = result;
        return json(res, 200, result);
      }

      if (pathname === '/api/run' && req.method === 'POST') {
        const body = await readBody(req);
        const action = String(body.action || '').trim();

        // —— Automated seed (DASHBOARD_PASSWORD / session; LP key match when live) ——
        if (action === 'seed' || action === 'seed_once' || action === 'seed_stop') {
          if (!requireAuth(req, res)) return;
          if (config.demoPublic) {
            return json(res, 403, { ok: false, error: 'seed blocked on public demo' });
          }
          if (action === 'seed_stop') {
            abortSeedPass();
            clearRunState();
            stopFeeBotInterval();
            return json(res, 200, { ok: true, seeding: false, note: 'abort requested' });
          }
          const keys = seedKeyStatus();
          const forceDry = body.forceDry === true || !isLive();
          if (!forceDry && !keys.canLiveSeed) {
            return json(res, 400, {
              ok: false,
              error: keys.errors[0] || 'LP key mismatch — cannot live seed',
              keys,
              hint: 'Put matching LP_PRIVATE_KEY in .env (never paste in chat). Or run dry.',
            });
          }
          if (isSeedRunning()) {
            return json(res, 409, { ok: false, error: 'seed pass already running' });
          }
          if (action === 'seed_once') {
            const result = await runSeedOnce({ forceDry });
            return json(res, result.ok || result.dry_run ? 200 : 400, result);
          }
          const continuous = body.continuous !== false;
          const maxSteps = Number(body.maxSteps || process.env.SEED_MAX_STEPS || 40) || 40;
          if (continuous) {
            runContinuousSeed({ forceDry, maxSteps }).catch((e) =>
              console.error('[seed continuous]', e),
            );
            writeRunState({
              running: true,
              seed: true,
              feeBot: isFeeBotTicking(),
              operatorMode: config.operatorMode,
            });
          } else {
            runSeedPass({ forceDry, maxSteps }).catch((e) => console.error('[seed]', e));
          }
          return json(res, 200, {
            ok: true,
            seeding: true,
            continuous,
            dry_run: forceDry,
            keys: {
              canLiveSeed: keys.canLiveSeed,
              lpMatches: keys.lpMatches,
              hint: keys.hint,
            },
            note: forceDry
              ? continuous
                ? 'Dry continuous seed — no txs. Flip DRY_RUN=false for live.'
                : 'Dry seed pass started — no txs sent. Flip DRY_RUN=false for live.'
              : continuous
                ? 'Live continuous seed — runs until Shut down'
                : 'Live seed pass started — signing with LP_PRIVATE_KEY',
          });
        }

        // —— Fee bot (DASHBOARD_PASSWORD / session) ——
        const auth = checkNodeAuth(req);
        if (!auth.ok) {
          return json(res, 401, {
            ok: false,
            error:
              'Fee bot locked — open at /unlock with DASHBOARD_PASSWORD (or send X-Controller-Token).',
            reason: auth.reason,
            unlock: '/unlock',
          });
        }
        if (action === 'pause') {
          stopFeeBotInterval();
          abortSeedPass();
          clearRunState();
          return json(res, 200, { ok: true, ticking: false, seeding: false });
        }
        if (action === 'start') {
          if (config.demoPublic) {
            return json(res, 403, {
              ok: false,
              error: 'Fee bot blocked on public demo — run locally',
            });
          }
          const setup = setupStatus();
          if (!setup.liveReady) {
            const keys = setup.keys || {};
            const lpMismatch = keys.lp?.present && keys.lp?.matches === false;
            const missingKey = !keys.lp?.present;
            let error =
              'Fee bot needs matching LP_PRIVATE_KEY in .env';
            if (missingKey) {
              error = 'Fee bot disabled — no LP_PRIVATE_KEY.';
            } else if (lpMismatch) {
              error =
                'Fee bot disabled — LP_PRIVATE_KEY does not match LP_WALLET.';
            }
            return json(res, 400, {
              ok: false,
              error,
              liveReady: false,
              hint: 'Use ▶ Start for automated seed. Fee bot is claim→route only.',
            });
          }
          if (tickRunner) {
            lastTick = await tickRunner({ forceDry: true });
          }
          startFeeBotInterval();
          writeRunState({
            running: true,
            feeBot: true,
            seed: isSeedRunning() || readRunState().seed,
            operatorMode: config.operatorMode,
          });
          return json(res, 200, {
            ok: true,
            ticking: true,
            note: 'Fee bot interval armed',
          });
        }
        return json(res, 400, {
          ok: false,
          error: 'unknown action — use seed|seed_once|seed_stop|start|pause',
        });
      }

      if (pathname === '/api/cards' && req.method === 'POST') {
        if (!requireAuth(req, res)) return;
        const { spawn } = await import('child_process');
        const script = path.join(ROOT, 'scripts/token-cards.mjs');
        const child = spawn(process.execPath, [script], {
          cwd: ROOT,
          env: process.env,
        });
        let out = '';
        let err = '';
        child.stdout.on('data', (d) => (out += d));
        child.stderr.on('data', (d) => (err += d));
        child.on('close', (code) => {
          json(res, code === 0 ? 200 : 500, {
            ok: code === 0,
            code,
            stdout: out.slice(-4000),
            stderr: err.slice(-2000),
          });
        });
        return;
      }

      // Static report files (PDF/CSV under reports/) — no /reports UI
      if (pathname.startsWith('/files/reports/')) {
        const name = decodeURIComponent(pathname.slice('/files/reports/'.length));
        const file = path.join(ROOT, 'reports', name);
        if (!file.startsWith(path.join(ROOT, 'reports')) || !fs.existsSync(file)) {
          res.writeHead(404);
          return res.end('not found');
        }
        const data = fs.readFileSync(file);
        const ext = path.extname(file);
        const type =
          ext === '.pdf'
            ? 'application/pdf'
            : ext === '.csv'
              ? 'text/csv'
              : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        return res.end(data);
      }

      // Book markdown (read-only docs)
      if (pathname === '/book' || pathname === '/docs/BOOK_OF_ANSEM_PRIVATE_NODE' || pathname === '/docs/BOOK_OF_ANSEM_PRIVATE_NODE/') {
        if (!requirePageUnlock(req, res, '/book')) return;
        const readme = path.join(ROOT, 'docs/BOOK_OF_ANSEM_PRIVATE_NODE/README.md');
        const mech = path.join(
          ROOT,
          'docs/BOOK_OF_ANSEM_PRIVATE_NODE/09_HOW_IT_WORKS_MECHANICALLY.md',
        );
        const pdf = path.join(ROOT, 'reports/book_of_ansem_private_node.pdf');
        const body = fs.existsSync(mech)
            ? fs.readFileSync(mech, 'utf8')
            : fs.existsSync(readme)
              ? fs.readFileSync(readme, 'utf8')
              : 'Book missing';
        return html(
          res,
          200,
          `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Book of ANSEM Private Node</title>
          <style>body{font-family:ui-monospace,monospace;background:#0a0a0b;color:#e8e8ea;max-width:720px;margin:40px auto;padding:0 16px;line-height:1.5}
          a{color:#f0f0f0} pre{white-space:pre-wrap;background:#0c0c0c;padding:16px;border:1px solid #2a2a2a}</style></head>
          <body><p><a href="/">← Setup</a> · <a href="/run">Run</a>
          ${fs.existsSync(pdf) ? ' · <a href="/files/reports/book_of_ansem_private_node.pdf">PDF</a>' : ' · run <code>npm run book</code> for PDF'}
          </p><p class="muted">Showing Ch.9 mechanics · see also Ch.10 Fund Control in repo docs/</p>
          <pre>${body.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></body></html>`,
        );
      }

      res.writeHead(404);
      res.end('not found');
    } catch (e) {
      console.error('[dashboard]', e);
      json(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  const host = config.dashboardHost || '127.0.0.1';
  const port = config.dashboardPort || 8080;
  if ((typeof isPublicDashboardSurface === 'function' ? isPublicDashboardSurface() : (host === '0.0.0.0' || host === '::')) && !(typeof passwordConfigured === 'function' ? passwordConfigured() : false)) {
    console.error(
      '[dashboard] FATAL: refusing to bind public control surface without DASHBOARD_PASSWORD. ' +
        'Set DASHBOARD_PASSWORD (or NODE_PASSWORD), or bind DASHBOARD_HOST=127.0.0.1.',
    );
    return null;
  }
  server.listen(port, host, () => {
    console.log(`[dashboard] http://${host}:${port}/`);
    console.log(`[dashboard] /config  /run  /whitepaper  /health`);
  });
  return server;
}

export function startTicking(ms) {
  if (tickInterval) clearInterval(tickInterval);
  tickInterval = setInterval(() => {
    tickRunner?.().then((t) => {
      lastTick = t;
    }).catch((e) => console.error(e));
  }, ms || config.tickMs);
}
