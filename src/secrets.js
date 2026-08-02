import fs from 'fs';
import path from 'path';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { ENV_PATH, ROOT, loadEnvFiles } from './load-env.js';
import { reloadConfig, config, saveCellJson, upsertEnvKeys } from './config.js';

function parseKeyFromEnvValue(raw) {
  if (!raw?.trim()) return { ok: false, reason: 'empty' };
  try {
    let kp;
    if (raw.trim().startsWith('[')) {
      kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw.trim())));
    } else {
      kp = Keypair.fromSecretKey(bs58.decode(raw.trim()));
    }
    return { ok: true, keypair: kp, pubkey: kp.publicKey.toBase58() };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const out = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Keys from process.env (Railway) + .env file. */
function readEnvFileKeys() {
  const fromFile = parseEnvFile(ENV_PATH);
  const out = { ...fromFile };
  for (const k of [
    'LP_PRIVATE_KEY',
    'OPERATOR_PRIVATE_KEY',
    'DASHBOARD_PASSWORD',
    'DASHBOARD_TOKEN',
    'NODE_PASSWORD',
    'LP_WALLET_PUBLIC_KEY',
    'LP_WALLET',
  ]) {
    if (process.env[k]?.trim()) out[k] = process.env[k].trim();
  }
  return out;
}

function envFileModeOk() {
  if (!fs.existsSync(ENV_PATH)) return { ok: false, mode: null };
  const mode = fs.statSync(ENV_PATH).mode & 0o777;
  return { ok: mode <= 0o600, mode: mode.toString(8) };
}

/** Ensure .env exists (from example). Do not create a second secrets file.
 *  DASHBOARD_TOKEN is parked — not auto-scaffolded.
 */
export function scaffoldSecretsFile() {
  const example = path.join(ROOT, '.env.example');
  if (!fs.existsSync(ENV_PATH) && fs.existsSync(example)) {
    const text = fs.readFileSync(example, 'utf8');
    fs.writeFileSync(ENV_PATH, text, { mode: 0o600 });
    loadEnvFiles();
    reloadConfig();
    return { created: true, path: ENV_PATH };
  }
  return { created: false, path: ENV_PATH };
}

function statusForKey(envKey, expectedPubkey, label) {
  const keys = readEnvFileKeys();
  const raw = keys[envKey] || process.env[envKey];
  if (!raw) {
    return { label, envKey, present: false, matches: null, pubkey: null };
  }
  const parsed = parseKeyFromEnvValue(raw);
  if (!parsed.ok) {
    return { label, envKey, present: true, matches: false, error: parsed.reason };
  }
  const matches = expectedPubkey ? parsed.pubkey === expectedPubkey : null;
  return {
    label,
    envKey,
    present: true,
    matches,
    pubkey: parsed.pubkey,
    short: `${parsed.pubkey.slice(0, 4)}…${parsed.pubkey.slice(-4)}`,
  };
}

export function keyFileStatus() {
  const mode = envFileModeOk();
  return {
    path: ENV_PATH,
    exists: fs.existsSync(ENV_PATH) || Boolean(process.env.LP_PRIVATE_KEY),
    modeOk: mode.ok || Boolean(process.env.LP_PRIVATE_KEY),
    mode: mode.mode,
    lp: statusForKey('LP_PRIVATE_KEY', config.lpWallet, 'W1 LP'),
    operator: statusForKey(
      'OPERATOR_PRIVATE_KEY',
      config.operatorWallet,
      'W2 Operator',
    ),
    hasDashboardToken: Boolean(
      readEnvFileKeys().DASHBOARD_PASSWORD ||
        readEnvFileKeys().DASHBOARD_TOKEN ||
        process.env.DASHBOARD_PASSWORD ||
        process.env.DASHBOARD_TOKEN,
    ),
  };
}

/** True when a non-placeholder private key already exists for LP or operator. */
export function existingKeysPresent() {
  const keys = readEnvFileKeys();
  for (const k of ['LP_PRIVATE_KEY', 'OPERATOR_PRIVATE_KEY']) {
    const raw = keys[k] || process.env[k];
    if (raw && String(raw).trim() && !/^X{8,}/i.test(String(raw).trim())) return true;
  }
  const secretsDir = path.join(ROOT, 'secrets');
  for (const role of ['lp', 'operator', 'main']) {
    const p = path.join(secretsDir, `${role}.json`);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) return true;
  }
  return false;
}

function backupFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${filePath}.${stamp}.bak`;
  fs.copyFileSync(filePath, bak);
  try {
    fs.chmodSync(bak, 0o600);
  } catch (_) {}
  return bak;
}

/**
 * Generate new Phantom-compatible W1 + W2 (+ optional W0 main).
 * Writes keys into .env only — HTTP response returns pubkeys only.
 * Refuses to overwrite existing keys unless force=true (backs up first).
 */
export function generateWalletKeypairs({ includeMain = true, force = false } = {}) {
  if (existingKeysPresent() && !force) {
    return {
      ok: false,
      error:
        'keys already exist — refusing overwrite (would orphan funds). Pass force:true and confirm REGEN to proceed; a .bak is written first.',
      existing: true,
    };
  }

  const secretsDir = path.join(ROOT, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true, mode: 0o700 });

  const roles = [
    ...(includeMain ? [['main', 'W0 main']] : []),
    ['lp', 'W1 LP'],
    ['operator', 'W2 operator'],
  ];

  const backups = [];
  if (fs.existsSync(ENV_PATH)) {
    const bak = backupFileIfExists(ENV_PATH);
    if (bak) backups.push(bak);
  }

  const wallets = { ...(config.cell?.wallets || {}) };
  const keyPairs = {};

  for (const [role] of roles) {
    const kp = Keypair.generate();
    wallets[role] = kp.publicKey.toBase58();
    const secretPath = path.join(secretsDir, `${role}.json`);
    const bak = backupFileIfExists(secretPath);
    if (bak) backups.push(bak);
    fs.writeFileSync(
      secretPath,
      JSON.stringify(Array.from(kp.secretKey)) + '\n',
      { mode: 0o600 },
    );
    keyPairs[role] = bs58.encode(kp.secretKey);
  }

  if (!wallets.ansemDest) wallets.ansemDest = config.ansemDestWallet || '';

  saveCellJson({ wallets });
  upsertEnvKeys({
    MAIN_WALLET: wallets.main || '',
    LP_WALLET_PUBLIC_KEY: wallets.lp || '',
    LP_WALLET: wallets.lp || '',
    OPERATOR_WALLET: wallets.operator || '',
    LP_PRIVATE_KEY: keyPairs.lp || '',
    OPERATOR_PRIVATE_KEY: keyPairs.operator || '',
  });
  try {
    fs.chmodSync(ENV_PATH, 0o600);
  } catch (_) {}

  loadEnvFiles();
  reloadConfig();

  return {
    ok: true,
    wallets: {
      main: wallets.main || null,
      lp: wallets.lp,
      operator: wallets.operator,
      ansemDest: wallets.ansemDest || null,
    },
    secretsPath: ENV_PATH,
    secretsDir,
    backups,
    note: 'Private keys written to .env and secrets/*.json only. Never commit .env.',
  };
}
