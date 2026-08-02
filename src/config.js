import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import './load-env.js';
import { ANSEM_MINT, ROUTE_TYPES, OLD_BOOK_WALLET, CONTROLLER_WALLET, AEMON_DONATE_WALLET, INDEX_TOKEN_MINT, INDEX_TOKEN_SYMBOL, INDEX_POOL_ADDRESS, isHerdPoolLive } from './constants.js';
import {
  SOL_RESERVE,
  SOL_OPERATING_FLOOR,
  SOL_TARGET_RESERVE,
  SOL_RENT_PER_PAIR,
  RESERVE_PCT,
  PAIR_MIN_ANSEM,
} from './lib/whitepaper.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function str(key, fallback = '') {
  const v = process.env[key];
  return v != null && String(v).trim() !== '' ? String(v).trim() : fallback;
}

function num(key, fallback) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bool(key, fallback = false) {
  const v = process.env[key];
  if (v == null || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function loadCellJson() {
  const p = path.join(ROOT, 'cell.json');
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

let cell = loadCellJson();

/** Local normalizer used inside buildConfig (before export). */
function normalizeFeeSplitInline(input = {}) {
  const keys = [
    'ansemSend',
    'ansemHold',
    'indexBurn',
    'aemonDonate',
    'reserve',
    'reinvest',
  ];
  const raw = {};
  for (const k of keys) {
    const n = Number(input[k] ?? 0);
    raw[k] = Number.isFinite(n) && n > 0 ? n : 0;
  }
  let sum = keys.reduce((s, k) => s + raw[k], 0);
  if (sum > 1.0001 && sum <= 100.0001) {
    for (const k of keys) raw[k] = raw[k] / 100;
    sum = keys.reduce((s, k) => s + raw[k], 0);
  }
  if (sum <= 0) {
    return {
      ansemSend: 0.05,
      ansemHold: 0.05,
      indexBurn: 0,
      aemonDonate: 0,
      reserve: 0.05,
      reinvest: 0.85,
    };
  }
  if (Math.abs(sum - 1) > 1e-6) {
    for (const k of keys) raw[k] = raw[k] / sum;
  }
  return raw;
}

/**
 * Creator fee wallet structure:
 *   W0 MAIN_WALLET        — fund source (never signs)
 *   W1 LP_WALLET          — owns Meteora positions, claims fees (Phantom node)
 *   W2 OPERATOR_WALLET    — Jupiter buy + SPL send (may equal W1 in single-wallet mode)
 *   ANSEM_DEST_WALLET     — receives bought ANSEM (replaces burn)
 *   CONTROLLER_WALLET     — hardcoded @i_am_aemon map book (constants.js; never env)
 *   TRACKED_WALLET        — /ansem eyes (defaults to CONTROLLER_WALLET)
 *
 * Testground default: single-wallet — LP_WALLET === OPERATOR_WALLET (sweep no-op).
 */
function buildConfig() {
  cell = loadCellJson();
  const lpWallet = str(
    'LP_WALLET_PUBLIC_KEY',
    str('LP_WALLET', cell.wallets?.lp || ''),
  );
  const operatorRaw = str('OPERATOR_WALLET', cell.wallets?.operator || '');
  const singleWalletMode = bool(
    'SINGLE_WALLET_MODE',
    cell.runtime?.singleWalletMode ?? true,
  );
  const operatorWallet =
    operatorRaw || (singleWalletMode && lpWallet ? lpWallet : '');
  const trackedWallet = str(
    'TRACKED_WALLET',
    cell.trackedWallet || CONTROLLER_WALLET,
  );
  /** Always the hardcoded @i_am_aemon map book — ignore env / cell overrides. */
  const controllerWallet = CONTROLLER_WALLET;

  return {
    cellId: str('CELL_ID', cell.cellId || 'ansem-herd'),
    rpcUrl: str('SOLANA_RPC_URL', 'https://api.mainnet-beta.solana.com'),
    ansemMint: str('ANSEM_MINT', cell.ansemMint || ANSEM_MINT),

    trackedWallet,
    /** Copycat reference — RO snapshots as controller_ro. Falls back to tracked/old book. */
    controllerWallet,

    mainWallet: str('MAIN_WALLET', cell.wallets?.main || ''),
    lpWallet,
    operatorWallet,
    ansemDestWallet: str('ANSEM_DEST_WALLET', cell.wallets?.ansemDest || ''),
    aemonDonateWallet: str(
      'AEMON_DONATE_WALLET',
      cell.wallets?.aemonDonate || AEMON_DONATE_WALLET,
    ),
    indexTokenMint: str(
      'INDEX_TOKEN_MINT',
      str('HERD_MINT', cell.indexTokenMint || INDEX_TOKEN_MINT || ''),
    ),
    indexTokenSymbol: str(
      'INDEX_TOKEN_SYMBOL',
      str('HERD_SYMBOL', cell.indexTokenSymbol || INDEX_TOKEN_SYMBOL),
    ),
    /** HERD–ANSEM pool — every node should join when live (v2). */
    herdPool: str(
      'HERD_POOL',
      str('INDEX_POOL_ADDRESS', cell.herdPool || INDEX_POOL_ADDRESS || ''),
    ),
    herdPoolLive: isHerdPoolLive(
      str(
        'HERD_POOL',
        str('INDEX_POOL_ADDRESS', cell.herdPool || INDEX_POOL_ADDRESS || ''),
      ),
    ),
    singleWalletMode,
    /** Same pubkey for LP + operator (testground). */
    isSingleWallet:
      Boolean(lpWallet) &&
      Boolean(operatorWallet) &&
      lpWallet === operatorWallet,

    lpPrivateKey: str('LP_PRIVATE_KEY'),
    operatorPrivateKey: str('OPERATOR_PRIVATE_KEY'),
    /** Prefer DASHBOARD_PASSWORD; legacy DASHBOARD_TOKEN / NODE_PASSWORD still work. */
    dashboardToken: str(
      'DASHBOARD_PASSWORD',
      str('DASHBOARD_TOKEN', str('NODE_PASSWORD')),
    ),

    dryRun: bool('DRY_RUN', cell.runtime?.dryRun ?? true),
    simulationMode: bool('SIMULATION_MODE', cell.runtime?.simulationMode ?? true),
    manual: bool('MANUAL', false),
    demoPublic: bool('DEMO_PUBLIC', false),
    dashboardEnabled: bool('DASHBOARD_ENABLED', true),
    dashboardHost: str('DASHBOARD_HOST', '127.0.0.1'),
    dashboardPort: num('DASHBOARD_PORT', num('PORT', 8080)),

    tickMs: num('TICK_MS', 60_000),
    minClaimUsd: num('MIN_CLAIM_USD', 1),
    minRouteUsd: num('MIN_ROUTE_USD', 1),
    minReserveUsd: num('MIN_RESERVE_USD', 5),
    maxBuyUsdPerRun: num('MAX_BUY_USD_PER_RUN', 50),
    ansemSendCapUsd: num('ANSEM_SEND_CAP_USD', 0),
    slippageBps: num('SLIPPAGE_BPS', 250),
    /** Gas floor left on LP after sweep; also seeder SOL reserve default. */
    lpReserveSol: num('LP_RESERVE_SOL', num('SOL_RESERVE', SOL_RESERVE)),
    solReserve: num('SOL_RESERVE', cell.runtime?.solReserve ?? SOL_RESERVE),
    /** Block new ATA/buys below this; trigger ANSEM→SOL top-up. */
    solOperatingFloor: num(
      'SOL_OPERATING_FLOOR',
      cell.runtime?.solOperatingFloor ?? SOL_OPERATING_FLOOR,
    ),
    /** Target after topup_sol recovery. */
    solTargetReserve: num(
      'SOL_TARGET_RESERVE',
      cell.runtime?.solTargetReserve ?? SOL_TARGET_RESERVE,
    ),
    solRentPerPair: num(
      'SOL_RENT_PER_PAIR',
      cell.runtime?.solRentPerPair ?? SOL_RENT_PER_PAIR,
    ),
    reservePct: num('RESERVE_PCT', cell.runtime?.reservePct ?? RESERVE_PCT),
    pairMinAnsem: num('PAIR_MIN_ANSEM', cell.runtime?.pairMinAnsem ?? PAIR_MIN_ANSEM),
    /** Smoke capital: Pass 1 covers at most this many dip-ranked pools (+ APE overrides). Min 10. */
    nodeActiveLimit: Math.max(
      10,
      num('NODE_ACTIVE_LIMIT', cell.runtime?.nodeActiveLimit ?? 10) || 10,
    ),
    /** TOKEN–ANSEM pairs younger than this (minutes) jump the queue (APE lane). */
    apeMaxAgeMinutes: num(
      'APE_MAX_AGE_MINUTES',
      cell.runtime?.apeMaxAgeMinutes ?? 15,
    ),
    apeMinLiqUsd: num('APE_MIN_LIQ_USD', cell.runtime?.apeMinLiqUsd ?? 500),
    /** coverage = Pass 1 mins; depth = Pass 2+ top-ups (derived from operatorMode when set) */
    seedPass: str('SEED_PASS', cell.runtime?.seedPass || 'coverage'),
    /** cover | mirror | ape | hold — holder-based what's-next */
    operatorMode: str(
      'OPERATOR_MODE',
      cell.runtime?.operatorMode || '',
    ),
    /** Dual-sided USD floor for new pairs (~$1 default). */
    pairMinUsd: num('PAIR_MIN_USD', cell.runtime?.pairMinUsd ?? 1),
    maxClaimPerTick: num('MAX_CLAIM_PER_TICK', 20),

    feeSplit: normalizeFeeSplitInline({
      ansemSend: num('FEE_SPLIT_ANSEM_SEND', cell.feeSplit?.ansemSend ?? 0.05),
      ansemHold: num('FEE_SPLIT_ANSEM_HOLD', cell.feeSplit?.ansemHold ?? 0.05),
      indexBurn: num('FEE_SPLIT_INDEX_BURN', cell.feeSplit?.indexBurn ?? 0),
      aemonDonate: num('FEE_SPLIT_AEMON_DONATE', cell.feeSplit?.aemonDonate ?? 0),
      reserve: num('FEE_SPLIT_RESERVE', cell.feeSplit?.reserve ?? 0.05),
      reinvest: num('FEE_SPLIT_REINVEST', cell.feeSplit?.reinvest ?? 0.85),
    }),

    routes: cell.routes || null,

    cell,
    root: ROOT,
  };
}

export let config = buildConfig();

export function reloadConfig() {
  config = buildConfig();
  return config;
}

export function defaultRoutes() {
  if (config.routes?.length) return config.routes;
  const fs = config.feeSplit;
  const routes = [];
  if (fs.ansemSend > 0) {
    const dest = (config.ansemDestWallet || '').trim();
    const leaveOnNode =
      !dest ||
      dest === config.lpWallet ||
      dest === config.operatorWallet;
    if (leaveOnNode) {
      // No dest wallet — buy $ANSEM and leave on HERD LP
      routes.push({
        id: 'ansem_herd',
        pct: fs.ansemSend,
        type: ROUTE_TYPES.JUPITER_BUY_HOLD,
        mint: config.ansemMint,
        note: 'HERD Token — buy ANSEM, leave on HERD LP',
      });
    } else {
      routes.push({
        id: 'ansem_send',
        pct: fs.ansemSend,
        type: ROUTE_TYPES.JUPITER_BUY_SEND,
        mint: config.ansemMint,
        recipient: dest,
        note: 'HERD — buy ANSEM, send to dest',
      });
    }
  }
  if (fs.ansemHold > 0) {
    routes.push({
      id: 'ansem_hold',
      pct: fs.ansemHold,
      type: ROUTE_TYPES.JUPITER_BUY_HOLD,
      mint: config.ansemMint,
      note: 'Reserve ANSEM — buy and hold on operator',
    });
  }
  if (fs.indexBurn > 0) {
    routes.push({
      id: 'index_burn',
      pct: fs.indexBurn,
      type: ROUTE_TYPES.JUPITER_BURN,
      mint: config.indexTokenMint || '',
      note: `Buy $${config.indexTokenSymbol} → burn (needs INDEX_TOKEN_MINT)`,
    });
  }
  if (fs.aemonDonate > 0) {
    routes.push({
      id: 'aemon_donate',
      pct: fs.aemonDonate,
      type: ROUTE_TYPES.DONATE_SOL,
      recipient: config.aemonDonateWallet,
      note: 'Donate SOL to aemon / creator fam',
    });
  }
  if (fs.reserve > 0) {
    routes.push({
      id: 'reserve',
      pct: fs.reserve,
      type: ROUTE_TYPES.SOL_RESERVE,
      note: 'Keep SOL on operator for gas / future reinvest',
    });
  }
  if (fs.reinvest > 0) {
    routes.push({
      id: 'reinvest',
      pct: fs.reinvest,
      type: ROUTE_TYPES.METEORA_REINVEST,
      note: 'Phase C — add liquidity back to pools',
    });
  }
  return routes;
}

/** Normalize fee-split object so portions sum to 1.0 (caller may pass %). */
export function normalizeFeeSplit(input = {}) {
  return normalizeFeeSplitInline(input);
}

export function isLive() {
  return !config.dryRun && !config.simulationMode && !config.demoPublic;
}

export function saveCellJson(patch) {
  const current = loadCellJson();
  const next = { ...current, ...patch };
  if (patch.wallets) {
    next.wallets = { ...(current.wallets || {}), ...patch.wallets };
  }
  if (patch.runtime) {
    next.runtime = { ...(current.runtime || {}), ...patch.runtime };
  }
  if (patch.poolPrefs) {
    next.poolPrefs = { ...(current.poolPrefs || {}), ...patch.poolPrefs };
    // Allow explicit deletes via null
    for (const [k, v] of Object.entries(patch.poolPrefs)) {
      if (v == null) delete next.poolPrefs[k];
    }
  }
  if (patch.queuePrefs) {
    next.queuePrefs = { ...(current.queuePrefs || {}), ...patch.queuePrefs };
  }
  if (patch.fundPolicy) {
    next.fundPolicy = { ...(current.fundPolicy || {}), ...patch.fundPolicy };
  }
  if (patch.feeSplit) {
    next.feeSplit = { ...(current.feeSplit || {}), ...patch.feeSplit };
  }
  if (patch.routes !== undefined) {
    next.routes = patch.routes;
  }
  if (patch.indexTokenMint !== undefined) {
    next.indexTokenMint = patch.indexTokenMint;
  }
  if (patch.herdPool !== undefined) {
    next.herdPool = patch.herdPool;
  }
  if (patch.wallets?.aemonDonate !== undefined || patch.aemonDonateWallet !== undefined) {
    next.wallets = {
      ...(next.wallets || current.wallets || {}),
      aemonDonate:
        patch.aemonDonateWallet ??
        patch.wallets?.aemonDonate ??
        next.wallets?.aemonDonate,
    };
  }
  fs.writeFileSync(path.join(ROOT, 'cell.json'), JSON.stringify(next, null, 2) + '\n');
  reloadConfig();
  return next;
}

/** Reject newline injection and non-env key names before writing .env. */
export function assertSafeEnvPair(key, value) {
  const k = String(key || '');
  if (!/^[A-Z][A-Z0-9_]*$/.test(k)) {
    throw new Error(`unsafe env key rejected: ${k}`);
  }
  const v = value == null ? '' : String(value);
  if (v.includes('\n') || v.includes('\r')) {
    throw new Error(`unsafe env value for ${k}: newlines not allowed`);
  }
  return { key: k, value: v };
}

export function upsertEnvKeys(pairs) {
  const envPath = path.join(ROOT, '.env');
  let text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [rawKey, rawValue] of Object.entries(pairs)) {
    const { key, value } = assertSafeEnvPair(rawKey, rawValue);
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) {
      text = text.replace(re, line);
    } else {
      text = text.trimEnd() + `\n${line}\n`;
    }
    // Hot-apply so ranking/seed see CA without restart
    process.env[key] = value;
  }
  fs.writeFileSync(envPath, text.endsWith('\n') ? text : text + '\n', { mode: 0o600 });
  reloadConfig();
}
