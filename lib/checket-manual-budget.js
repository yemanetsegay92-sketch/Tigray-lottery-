'use strict';

// Keep a small operator budget to limit accidental or compromised repeated
// calls to the paid Check.et API. Server-side only, one record per admin.
const MAX_CALLS = 6;
const WINDOW_MS = 5 * 60 * 1000;

async function enforceReadOnlyCheckEtBudget(db, uid, now = Date.now()) {
  const id = String(uid || '').trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw Object.assign(new Error('Administrator identity is missing.'), {statusCode:403});
  }
  const ref = db.collection('checketManualRateLimits').doc(id);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const data = snap.exists ? (snap.data() || {}) : {};
    const start = Number(data.windowStartMs);
    const valid = Number.isSafeInteger(start) && start > 0 &&
      now >= start && now < start + WINDOW_MS;
    const current = valid ? Number(data.count) || 0 : 0;
    if (current >= MAX_CALLS) {
      throw Object.assign(new Error('Too many Check.et verification attempts. Try again after five minutes.'), {
        statusCode:429
      });
    }
    tx.set(ref, {
      windowStartMs:valid ? start : now,
      count:current + 1,
      updatedAtMs:now
    });
  });
}

module.exports = { enforceReadOnlyCheckEtBudget, MAX_CALLS, WINDOW_MS };
