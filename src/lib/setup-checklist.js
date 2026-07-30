/**
 * Readiness checklist (env keys — no Phantom connect).
 */
import { config, isLive } from '../config.js';
import { keyFileStatus } from '../secrets.js';
import {
  START_LIST,
  startListFloorUsd,
  SOL_RESERVE,
  SOL_OPERATING_FLOOR,
  PAIR_MIN_ANSEM,
} from '../lib/whitepaper.js';
import { NODE_MIN_USD, OLD_BOOK_WALLET } from '../constants.js';

export function getSetupChecklist() {
  const keys = keyFileStatus();
  const hasLp = Boolean(config.lpWallet);
  const hasOp = Boolean(config.operatorWallet);
  const hasDest = Boolean(config.ansemDestWallet);
  const lpKeyOk = keys.lp?.present && keys.lp?.matches !== false;
  const opKeyOk = keys.operator?.present && keys.operator?.matches !== false;
  const dry = !isLive();
  const single =
    config.isSingleWallet ||
    (hasLp && hasOp && config.lpWallet === config.operatorWallet);
  const solReserve = config.solReserve ?? SOL_RESERVE;
  const opFloor = config.solOperatingFloor ?? SOL_OPERATING_FLOOR;
  const pairMin = config.pairMinAnsem ?? PAIR_MIN_ANSEM;

  const steps = [
    {
      n: 1,
      id: 'env-keys',
      title: 'Set LP_WALLET_PUBLIC_KEY + LP_PRIVATE_KEY in env',
      done: hasLp && lpKeyOk,
      hint: 'Railway Variables or local .env. Never paste a private key in the browser.',
    },
    {
      n: 1.5,
      id: 'single-wallet',
      title: 'Single-wallet: OPERATOR_PRIVATE_KEY = LP_PRIVATE_KEY',
      done: single || (!hasLp && !keys.lp?.present),
      hint: 'Stranger path: one key does LP + operator. Copy both lines in .env.example.',
    },
    {
      n: 2,
      id: 'controller',
      title: 'Controller = @i_am_aemon map book (hardcoded)',
      done: true,
      hint: 'HpJbzE… in src/constants.js — RO reference. Never import its private key.',
    },
    {
      n: 3,
      id: 'herd-pool',
      title: config.herdPoolLive
        ? 'Join HERD–ANSEM pool (required to run a node)'
        : 'HERD–ANSEM pool (set HERD_POOL when live — v2)',
      done: config.herdPoolLive
        ? false // filled at runtime via positions when we can; optional until live
        : true,
      optional: !config.herdPoolLive,
      hint: config.herdPoolLive
        ? `Pin + cover ${config.herdPool.slice(0, 8)}… — every node LPs the HERD market.`
        : 'Paste HERD_MINT + HERD_POOL at launch (same as hub NEXT_PUBLIC_HERD_CA / NEXT_PUBLIC_HERD_POOL). Optional until then — node runs TOKEN–ANSEM only.',
    },
    {
      n: 4,
      id: 'dest',
      title: 'HERD Token stays on HERD LP (no dest wallet)',
      done: true,
      hint: 'Fee-loop $ANSEM is bought and left on the node wallet.',
    },
    {
      n: 5,
      id: 'fund',
      title: `Fund ~$10 · keep ≥${opFloor} SOL operating`,
      done: false,
      optional: true,
      hint: `Gas floor ${solReserve}◎ · never dump all SOL into ANSEM (ATA/NFT rent). Capped buy_ansem; if stuck low, auto topup_sol or send ~0.05–0.1 SOL. Then cover top ${config.nodeActiveLimit ?? 10} dip (+ APE <${config.apeMaxAgeMinutes ?? 15}m). Controller dust (<$1) drops from active 10 — your LP stays on hold to grow.`,
    },
    {
      n: 6,
      id: 'seed',
      title: 'Seed APE then top-10 dip',
      done: false,
      optional: true,
      hint: `Open /run — APE jumps queue; else buy-the-dip top ${config.nodeActiveLimit ?? 10}. Full ${START_LIST.length}-name list is the index gate. One focus token at a time; add-only.`,
    },
    {
      n: 7,
      id: 'fee-pct',
      title: 'Set your fee % on /config',
      done: true,
      optional: true,
      hint: 'Controller is fixed; your ANSEM / burn / aemon / gas / reinvest mix is yours.',
    },
    {
      n: 8,
      id: 'dry',
      title: 'Keep dry-run until proven',
      done: dry,
      hint: 'DRY_RUN on until claims look right. npm run doctor · npm run dry.',
    },
  ];

  const requiredDone = steps.filter((s) => !s.optional).every((s) => s.done);
  return {
    trackedWallet: config.trackedWallet || OLD_BOOK_WALLET,
    controllerWallet: config.controllerWallet || config.trackedWallet || OLD_BOOK_WALLET,
    wallets: {
      main: config.mainWallet,
      lp: config.lpWallet,
      operator: config.operatorWallet,
      ansemDest: config.ansemDestWallet,
      controller: config.controllerWallet,
    },
    keys,
    dryRun: dry,
    live: isLive(),
    singleWallet: single,
    nodeActiveLimit: config.nodeActiveLimit ?? 10,
    apeMaxAgeMinutes: config.apeMaxAgeMinutes ?? 15,
    solReserve,
    pairMinAnsem: pairMin,
    nodeMin: NODE_MIN_USD,
    startListCount: START_LIST.length,
    floorUsd: startListFloorUsd(),
    steps,
    requiredDone,
    /** Env LP pubkey + matching private key — no Phantom connect. */
    phantomReady: hasLp && lpKeyOk,
    liveReady: hasLp && hasOp && (hasDest || hasLp) && lpKeyOk && (single || opKeyOk),
  };
}
