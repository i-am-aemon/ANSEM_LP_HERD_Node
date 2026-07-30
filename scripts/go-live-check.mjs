#!/usr/bin/env node
/**
 * Stranger go-live gate for public ANSEM_LP_HERD_Node.
 * No Pump/creator-fees/Imperial — LP + doctor + dry ticks + SOL floor only.
 */
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.log(`✗ ${msg}`);
  return false;
}
function ok(msg) {
  console.log(`✓ ${msg}`);
}

async function main() {
  console.log('ANSEM Herd Node — go-live check (public OSS)\n');
  let ready = true;

  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    ready = fail('Missing .env — run: cp .env.example .env && chmod 600 .env') && ready;
  } else {
    ok('.env present');
  }

  const doctor = spawnSync('node', ['src/doctor.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });
  if (doctor.status !== 0) {
    console.log('\n✗ doctor failed — fix hard issues above');
    process.exit(1);
  }
  ok('doctor exited 0');

  // Import after doctor so load-env has run via doctor path; reload for balances
  const { loadEnvFiles } = await import('../src/load-env.js');
  loadEnvFiles();
  const { config } = await import('../src/config.js');
  const { loadLpKeypair, loadOperatorKeypair } = await import('../src/wallet.js');
  const { getSolBalance } = await import('../src/adapters/solana.js');

  if (!config.lpPrivateKey) {
    ready = fail('LP_PRIVATE_KEY required in .env') && ready;
  } else {
    ok('LP_PRIVATE_KEY loaded');
  }

  const lpKp = loadLpKeypair();
  const opKp = loadOperatorKeypair();
  if (!opKp && !lpKp) {
    ready = fail('No operator key — set OPERATOR_PRIVATE_KEY=LP_PRIVATE_KEY for single-wallet') && ready;
  } else if (config.isSingleWallet || (lpKp && opKp && lpKp.publicKey.equals(opKp.publicKey))) {
    ok('Single-wallet mode (LP = operator)');
  } else if (opKp) {
    ok('Separate operator key loaded');
  } else {
    ready = fail('OPERATOR_PRIVATE_KEY missing — set equal to LP_PRIVATE_KEY for single-wallet') && ready;
  }

  if (config.lpWallet) {
    try {
      const lpSol = await getSolBalance(config.lpWallet);
      if (lpSol < 0.02) ready = fail(`LP needs ≥ 0.02 SOL for gas (have ${lpSol.toFixed(4)})`) && ready;
      else ok(`LP gas: ${lpSol.toFixed(4)} SOL`);
    } catch (e) {
      fail(`SOL balance check: ${e.message || e}`);
      ready = false;
    }
  }

  if (config.demoMode) ready = fail('Set DEMO_MODE=false before live') && ready;
  else ok('DEMO_MODE off (or unset)');

  console.log('\nNext: run at least one dry tick before live spend:');
  console.log('  npm run dry');
  console.log('Then: DRY_RUN=false SIMULATION_MODE=false && npm run once\n');

  if (ready) {
    console.log('✓ Go-live structural checks passed (still run npm run dry first).');
    process.exit(0);
  }
  console.log('✗ Not ready for live mode.');
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
