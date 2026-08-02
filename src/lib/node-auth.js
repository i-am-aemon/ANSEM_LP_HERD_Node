/**
 * Dashboard password + session cookie.
 *
 * Env (any one — same secret):
 *   DASHBOARD_PASSWORD     — preferred
 *   NODE_PASSWORD          — legacy alias
 *   DASHBOARD_TOKEN        — legacy alias
 *
 * Browser: POST /api/unlock → Set-Cookie ansem_session=…
 * APIs also accept X-Controller-Token / Bearer.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { config } from '../config.js';

export const SESSION_COOKIE = 'ansem_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function getDashboardPassword() {
  return (
    String(config.dashboardToken || '').trim() ||
    String(process.env.DASHBOARD_PASSWORD || '').trim() ||
    String(process.env.NODE_PASSWORD || '').trim() ||
    String(process.env.DASHBOARD_TOKEN || '').trim() ||
    ''
  );
}

export function passwordConfigured() {
  return Boolean(getDashboardPassword());
}

/** True when dashboard is (or will be) reachable beyond loopback. */
export function isPublicDashboardSurface(cfg = config) {
  const host = String(cfg.dashboardHost || process.env.DASHBOARD_HOST || '127.0.0.1').trim();
  if (host === '0.0.0.0' || host === '::' || host === '[::]') return true;
  if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return true;
  if (process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID) return true;
  const lock = String(process.env.CONTROL_LOCK || '').toLowerCase();
  if (lock === '1' || lock === 'true' || lock === 'yes' || lock === 'on') return true;
  return false;
}

function signingSecret() {
  return getDashboardPassword() || 'ansem-unlocked';
}

function b64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(String(s).replace(/-/g, '+').replace(/\//g, '/') + pad, 'base64');
}

function sign(payloadB64) {
  return b64url(
    createHmac('sha256', signingSecret()).update(payloadB64).digest(),
  );
}

export function createSessionToken() {
  const exp = Date.now() + SESSION_TTL_MS;
  const nonce = randomBytes(16).toString('hex');
  const payloadB64 = b64url(JSON.stringify({ exp, nonce }));
  return `${payloadB64}.${sign(payloadB64)}`;
}

export function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payloadB64, sig] = parts;
  const expect = sign(payloadB64);
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expect);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const payload = JSON.parse(fromB64url(payloadB64).toString('utf8'));
    if (!payload?.exp || Date.now() > Number(payload.exp)) return false;
    return true;
  } catch {
    return false;
  }
}

export function passwordsMatch(input) {
  const expected = getDashboardPassword();
  if (!expected) return { ok: true, reason: 'no password configured' };
  const got = String(input || '');
  try {
    const a = Buffer.from(got);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return { ok: false, reason: 'wrong password' };
    if (!timingSafeEqual(a, b)) return { ok: false, reason: 'wrong password' };
    return { ok: true, reason: 'ok' };
  } catch {
    return { ok: false, reason: 'wrong password' };
  }
}

export function parseCookies(req) {
  const raw = req.headers?.cookie || '';
  const out = {};
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    out[k] = decodeURIComponent(v);
  }
  return out;
}

export function getHeaderToken(req) {
  const h = req.headers['x-controller-token'] || req.headers['authorization'] || '';
  if (typeof h === 'string' && h.toLowerCase().startsWith('bearer ')) {
    return h.slice(7).trim();
  }
  return String(h || '').trim();
}

/**
 * Session cookie OR header matching DASHBOARD_PASSWORD.
 * Fail-closed on public surfaces: no password ⇒ locked (not everyone authorized).
 * Local loopback with no password still auto-unlocks for operator convenience.
 */
export function checkNodeAuth(req) {
  const expected = getDashboardPassword();
  if (!expected) {
    if (isPublicDashboardSurface()) {
      return {
        ok: false,
        reason: 'locked — set DASHBOARD_PASSWORD (required on public hosts)',
        unlocked: false,
        passwordRequired: true,
      };
    }
    return {
      ok: true,
      reason: 'no password configured (loopback)',
      unlocked: true,
      passwordRequired: false,
    };
  }

  const cookies = parseCookies(req);
  if (verifySessionToken(cookies[SESSION_COOKIE])) {
    return { ok: true, reason: 'session', unlocked: true, passwordRequired: true };
  }

  const header = getHeaderToken(req);
  if (header) {
    const m = passwordsMatch(header);
    if (m.ok) {
      return { ok: true, reason: 'header', unlocked: true, passwordRequired: true };
    }
  }

  return {
    ok: false,
    reason: 'locked — enter DASHBOARD_PASSWORD',
    unlocked: false,
    passwordRequired: true,
  };
}

export function sessionCookieHeader(token, { clear = false, secure } = {}) {
  const useSecure =
    secure != null
      ? Boolean(secure)
      : Boolean(process.env.RAILWAY_ENVIRONMENT) ||
        String(process.env.FORCE_SECURE_COOKIES || '').toLowerCase() === 'true';
  if (clear) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${useSecure ? '; Secure' : ''}`;
  }
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${useSecure ? '; Secure' : ''}`;
}
