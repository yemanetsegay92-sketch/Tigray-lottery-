const crypto = require('crypto');
const { getStorage } = require('firebase-admin/storage');
const { adminDb, validateTelegramInitData, FieldValue } = require('../telegram/_lib');

const BUCKET = 'tigiray-lottery.firebasestorage.app';

// Shadow traffic uses the same cloud services, but NEVER live ticket, public-status,
// approval, Telegram queue, or ticket-number collections. Disabled unless explicitly armed.
const SHADOW_PROJECT = 'tigiray-lottery';
const SHADOW_LOTTERY = 'loadtest-buys';
function sameSecret(a, b) {
  const aa = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  return aa.length === bb.length && aa.length >= 32 && crypto.timingSafeEqual(aa, bb);
}
function liveShadowConfig(req) {
  if (process.env.LIVE_SHADOW_TEST_ENABLED !== 'true') return null;
  const secret = process.env.LIVE_SHADOW_TEST_SECRET;
  if (!sameSecret(req.headers?.['x-tigray-shadow-secret'], secret)) return null;
  const runId = String(process.env.LIVE_SHADOW_RUN_ID || '');
  const expires = Date.parse(String(process.env.LIVE_SHADOW_EXPIRES_AT || ''));
  const max = Number(process.env.LIVE_SHADOW_MAX_PURCHASES || 0);
  if (!/^shadow-[a-z0-9-]{6,40}$/.test(runId) ||
      !Number.isFinite(expires) || expires <= Date.now() ||
      expires > Date.now() + 24 * 60 * 60 * 1000 ||
      !Number.isInteger(max) || max < 1 || max > 20000 ||
      !secret || String(secret).length < 32) return null;
  let project;
  try { project = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}').project_id; }
  catch { return null; }
  if (project !== SHADOW_PROJECT) return null;
  return { runId, max, expires, project };
}
function assertShadowBody(body, proof, config, quantity, phone, name, reference) {
  const seq = Number(body.shadowSequence);
  if (!Number.isInteger(seq) || seq < 1 || seq > config.max ||
      String(body.lotteryId) !== SHADOW_LOTTERY ||
      name !== 'LOAD TEST BUYER ' + seq || phone !== '0999999999' ||
      reference !== 'LOADTEST-' + config.runId + '-' + seq ||
      quantity !== 1 || !proof || proof.mime !== 'image/jpeg' ||
      proof.bytes.length < 100 * 1024 || String(body.telegramInitData || '') !== '') {
    throw badRequest('Invalid synthetic shadow purchase, sequence, or receipt.');
  }
  return seq;
}

const MAX_IMAGE_BYTES = 420 * 1024;
const MAX_PDF_BYTES = 2 * 1024 * 1024;

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9+]/g, '').replace(/^\+251/, '0').trim();
}
function sha256(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); }
  catch { throw Object.assign(new Error('Invalid request body.'), { statusCode: 400 }); }
}
function badRequest(message) {
  return Object.assign(new Error(message), { statusCode: 400 });
}
function decodePaymentProof(dataUrl) {
  if (!dataUrl) return null;
  if (typeof dataUrl !== 'string' || dataUrl.length > 3 * 1024 * 1024) {
    throw badRequest('Payment receipt exceeds the upload size limit.');
  }
  const match = dataUrl.match(/^data:(image\/jpeg|image\/png|image\/webp|application\/pdf);base64,([A-Za-z0-9+/=]+)$/i);
  if (!match) throw badRequest('Upload a JPG, PNG, WebP or PDF receipt.');
  const mime = match[1].toLowerCase();
  const encoded = match[2];
  const bytes = Buffer.from(encoded, 'base64');
  if (!bytes.length || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw badRequest('Receipt data is invalid.');
  }
  const max = mime === 'application/pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (bytes.length > max) throw badRequest(mime === 'application/pdf' ?
    'PDF receipt is too large (maximum 2 MB).' : 'Compressed image is too large (maximum 420 KB).');
  let valid = false;
  let ext = 'jpg';
  if (mime === 'application/pdf') {
    valid = bytes.subarray(0, 5).toString('latin1') === '%PDF-' &&
      bytes.subarray(Math.max(0, bytes.length - 2048)).includes(Buffer.from('%%EOF'));
    ext = 'pdf';
  } else if (mime === 'image/jpeg') {
    valid = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  } else if (mime === 'image/png') {
    valid = bytes.length >= 8 &&
      bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    ext = 'png';
  } else if (mime === 'image/webp') {
    valid = bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' &&
      bytes.toString('ascii', 8, 12) === 'WEBP';
    ext = 'webp';
  }
  if (!valid) throw badRequest('Receipt file does not match its declared format.');
  return { bytes, mime, ext, digest: sha256(bytes) };
}

module.exports = async (req, res) => {
  try {
    const hasShadowHeader = Object.prototype.hasOwnProperty.call(req.headers || {}, 'x-tigray-shadow-secret');
    const probe = req.method === 'GET' && String(req.query?.shadowProbe || '') === '1';
    const wantsShadow = hasShadowHeader || probe;
    const shadow = wantsShadow ? liveShadowConfig(req) : null;
    if (wantsShadow && !shadow) return res.status(404).json({ ok: false, error: 'Test mode unavailable.' });
    if (probe) {
      const exists = await adminDb().collection('loadTestLotteries').doc(SHADOW_LOTTERY).get();
      if (!exists.exists || exists.data()?.status !== 'active' || Number(exists.data()?.price) <= 0) {
        return res.status(409).json({ ok: false, error: 'Test lottery configuration missing.' });
      }
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({
        ok: true, mode: 'live-shadow-isolated', projectId: shadow.project,
        bucket: BUCKET, lotteryId: SHADOW_LOTTERY,
        runId: shadow.runId, maxPurchases: shadow.max,
        expiresAt: new Date(shadow.expires).toISOString(), telegramDisabled: true
      });
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
    // On a guarded preview, refuse all ordinary customer submissions. The
    // production website remains unaffected because only Preview enables this.
    if (process.env.LIVE_SHADOW_TEST_ENABLED === 'true' && !shadow)
      return res.status(404).json({ ok: false, error: 'Test-only preview.' });
    const body = readBody(req);
    const lotteryId = String(body.lotteryId || '').trim();
    const name = String(body.name || '').trim();
    const phone = normalizePhone(body.phone);
    const reference = String(body.reference || '').trim();
    const quantity = Number(body.quantity || 1);
    const proof = decodePaymentProof(body.paymentProofData);
    const shadowSequence = shadow ? assertShadowBody(body, proof, shadow, quantity, phone, name, reference) : 0;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 5) {
      throw badRequest('You can request a maximum of 5 tickets per purchase.');
    }
    if (!lotteryId || !name || !phone || name.length > 150 || phone.length > 24) {
      throw badRequest('Please complete the required fields.');
    }
    if (reference.length > 180) throw badRequest('Transaction reference is too long.');
    if (!reference && !proof) throw badRequest('Enter a transaction reference OR upload a receipt.');
    const telegramInitData = String(body.telegramInitData || '');
    let telegramUser = null;
    if (telegramInitData) telegramUser = validateTelegramInitData(telegramInitData).user;

    const db = adminDb();
    const lotterySnap = await db.collection(shadow ? 'loadTestLotteries' : 'lotteries').doc(lotteryId).get();
    if (!lotterySnap.exists) return res.status(404).json({ ok: false, error: 'Lottery not found.' });
    const lottery = lotterySnap.data();
    if (lottery.status !== 'active') throw badRequest('This lottery is not currently open.');
    const price = Number(lottery.price || 0);
    if (!Number.isFinite(price) || price <= 0) throw badRequest('Lottery price is not configured correctly.');
    const total = price * quantity;
    // Preserve existing reference-based duplicate detection, while allowing proof-only requests.
    const requestId = shadow
      ? sha256('SHADOW:' + shadow.runId + ':' + shadowSequence).slice(0, 40)
      : (reference
        ? sha256('REF:' + reference.toUpperCase()).slice(0, 40)
        : sha256('PROOF:' + proof.digest).slice(0, 40));
    const proofUploadToken = crypto.randomBytes(32).toString('hex');
    // Short, single-use secret for a Telegram deep link (64-character start-parameter limit).
    const buyerLinkToken = crypto.randomBytes(10).toString('hex');
    const requestRef = db.collection(shadow ? 'loadTestRequests' : 'ticketRequests').doc(requestId);
    const phoneHash = sha256(phone);
    const publicRef = db.collection(shadow ? 'loadTestPublicStatus' : 'publicStatus').doc(phoneHash).collection('requests').doc(requestId);
    const requestData = {
      lotteryId, lotteryName: String(lottery.name || lotteryId), name, phone, reference,
      ...(shadow ? { loadTest: true, loadTestRunId: shadow.runId, loadTestSequence: shadowSequence } : {}),
      quantity, price, total, status: 'pending', ticketNumbers: [],
      phoneHash, proofUploadTokenHash: sha256(proofUploadToken),
      buyerLinkTokenHash: sha256(buyerLinkToken),
      createdAt: FieldValue.serverTimestamp()
    };
    if (telegramUser) {
      requestData.telegramChatId = String(telegramUser.id);
      requestData.telegramUserId = String(telegramUser.id);
      requestData.telegramUsername = String(telegramUser.username || '');
      requestData.telegramFirstName = String(telegramUser.first_name || '');
    }
    let file = null;
    if (proof) {
      // Always store private proofs server-side; Firebase Storage client rules stay deny-all.
      const safeLotteryId = encodeURIComponent(lotteryId);
      const path = (shadow
        ? 'load-test-proofs/' + shadow.runId + '/'
        : 'payment-proofs/' + safeLotteryId + '/') + requestId + '-' +
        crypto.randomBytes(8).toString('hex') + '.' + proof.ext;
      file = getStorage().bucket(BUCKET).file(path);
      await file.save(proof.bytes, {
        resumable: false,
        contentType: proof.mime,
        metadata: {
          cacheControl: 'private, no-store',
          metadata: { requestId, lotteryId }
        },
        preconditionOpts: { ifGenerationMatch: 0 }
      });
      Object.assign(requestData, {
        proofPath: path,
        proofMime: proof.mime,
        proofBytes: proof.bytes.length,
        proofOriginalBytes: Number(body.paymentProofOriginalBytes) || proof.bytes.length,
        proofSha256: proof.digest,
        proofUploadedAt: FieldValue.serverTimestamp()
      });
    }
    try {
      await db.runTransaction(async tx => {
        const existing = await tx.get(requestRef);
        if (existing.exists) throw new Error('DUPLICATE_REFERENCE');
        tx.create(requestRef, requestData);
        tx.create(publicRef, {
          lotteryId, lotteryName: String(lottery.name || lotteryId),
          phoneLast4: phone.slice(-4), quantity, total, status: 'pending',
          ticketNumbers: [], createdAt: FieldValue.serverTimestamp()
        });
      });
    } catch (error) {
      if (file) { try { await file.delete({ ignoreNotFound: true }); } catch (cleanupError) { console.error('proof cleanup failed', cleanupError); } }
      throw error;
    }
    return res.status(200).json(shadow
      ? { ok: true, created: true, mode: 'live-shadow-isolated', requestId, total, sequence: shadowSequence }
      : { ok: true, created: true, requestId, total, proofUploadToken, buyerLinkToken });
  } catch (error) {
    if (error?.message === 'DUPLICATE_REFERENCE') {
      return res.status(409).json({ ok: false, error: 'This payment reference or receipt has already been submitted.' });
    }
    if (error?.statusCode === 400) return res.status(400).json({ ok: false, error: error.message });
    console.error('create-request error:', error);
    return res.status(500).json({ ok: false, error: 'Could not submit request. Please try again.' });
  }
};
