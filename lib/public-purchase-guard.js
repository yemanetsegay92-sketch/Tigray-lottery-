'use strict';

// Server-side backstop, not a substitute for Vercel Firewall/WAF.
// OFF unless explicitly enabled on production after shadow-testing WAF.
const crypto = require('node:crypto');
const net = require('node:net');

const WINDOW_MS = 60 * 1000;
const LIMITS = Object.freeze({ submit: 15, upload: 30 });

function httpError(statusCode, message, retryAfterSeconds) {
  return Object.assign(new Error(message), { statusCode, retryAfterSeconds });
}

function isEnforced(env = process.env) {
  return env.VERCEL_ENV === 'production' &&
    env.LOTTERY_PUBLIC_RATE_LIMIT_MODE === 'enforce';
}

function readVercelClientIp(req) {
  // Vercel overwrites x-forwarded-for for its Functions. Never trust user-
  // controlled x-client-ip, cf-connecting-ip, or an arbitrary forwarded chain.
  // Refuse multi-hop headers rather than selecting a spoofable address.
  const raw = req?.headers?.['x-forwarded-for'];
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value && !value.includes(',') && net.isIP(value) ? value : null;
}

function assertReasonableBody(req, body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.getPrototypeOf(body) !== Object.prototype) {
    throw httpError(400, 'Invalid purchase request.');
  }
  const reportedBytes = Number(req?.headers?.['content-length'] || 0);
  if (Number.isFinite(reportedBytes) && reportedBytes > 16 * 1024) {
    throw httpError(413, 'Purchase request is too large.');
  }
  // The existing public checkout sends a small JSON body, never file bytes.
  // Check the parsed body as well; content-length can be absent/unreliable.
  if (Buffer.byteLength(JSON.stringify(body)) > 16 * 1024) {
    throw httpError(413, 'Purchase request is too large.');
  }
  if (body.telegramInitData != null &&
      (typeof body.telegramInitData !== 'string' ||
       Buffer.byteLength(body.telegramInitData) > 4096)) {
    throw httpError(400, 'Telegram authorization data is invalid.');
  }
}

async function enforcePublicPurchaseLimit(req, action, getDb, opts = {}) {
  const env = opts.env || process.env;
  if (!isEnforced(env)) return { enforced: false };
  if (!Object.hasOwn(LIMITS, action)) {
    throw new Error('Invalid public purchase rate-limit action.');
  }
  const pepper = String(env.LOTTERY_PUBLIC_RATE_LIMIT_PEPPER || '');
  if (Buffer.byteLength(pepper) < 32) {
    // Fail closed if an operator enables the limit without configuring it.
    throw httpError(503, 'Purchase protection is not available. Please try again later.');
  }
  const ip = readVercelClientIp(req);
  if (!ip) {
    throw httpError(503, 'Purchase protection could not verify the connection.');
  }
  const db = getDb();
  const now = opts.now === undefined ? Date.now() : opts.now;
  const bucket = Math.floor(now / WINDOW_MS);
  const end = (bucket + 1) * WINDOW_MS;
  const key = crypto.createHmac('sha256', pepper)
    .update('lottery-public-rate-limit-v1:' + action + ':' + ip + ':' + bucket)
    .digest('hex');
  const ref = db.collection('publicPurchaseRateLimits').doc(key);
  const limit = LIMITS[action];
  const allowed = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const count = snap.exists ? Number(snap.data()?.count || 0) : 0;
    if (!Number.isInteger(count) || count < 0 || count >= limit) return false;
    // Never store customer IP, phone, reference, or secret. A Firestore TTL
    // policy on expiresAt can remove these small counter documents later.
    tx.set(ref, {
      count: count + 1,
      expiresAt: new Date(end + WINDOW_MS),
      updatedAt: new Date(now)
    }, { merge: true });
    return true;
  });
  if (!allowed) {
    throw httpError(429,
      'Too many requests from this connection. Please try again shortly.',
      Math.max(1, Math.ceil((end - now) / 1000)));
  }
  return { enforced: true };
}

module.exports = {
  LIMITS, WINDOW_MS, isEnforced, readVercelClientIp,
  assertReasonableBody, enforcePublicPurchaseLimit
};
