'use strict';

// Firebase only signals that work exists. Vercel remains the sole owner of
// CBE verification, durable bank evidence and atomic ticket issuance.
const PRODUCTION_URL = 'https://www.tigraylottery.com/api/admin/approvals';
const REQUEST_ID = /^[a-f0-9]{40}$/;
const TIMEOUT_MS = 90000;

async function dispatchQueuedCbePayment(requestId, secret, fetchImpl = globalThis.fetch) {
  if (!REQUEST_ID.test(String(requestId || ''))) throw new Error('Invalid queue request ID.');
  if (Buffer.byteLength(String(secret || '')) < 32) throw new Error('Missing CBE worker secret.');
  if (typeof fetchImpl !== 'function') throw new Error('Fetch is unavailable.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(PRODUCTION_URL, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + secret,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ action: 'cbe-auto-worker-one', requestId }),
      signal: controller.signal
    });
    if (!response.ok) {
      // Never print response body: it might contain sensitive payment data.
      throw new Error('CBE worker returned HTTP ' + response.status);
    }
    const result = await response.json();
    if (!result || result.ok !== true) throw new Error('CBE worker did not confirm success.');
    return {
      processed: Number(result.processed) || 0,
      approved: Number(result.approved) || 0,
      manual_review: Number(result.manual_review) || 0,
      retry: Number(result.retry) || 0
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { dispatchQueuedCbePayment, PRODUCTION_URL };
