const crypto = require('crypto');
const { getStorage } = require('firebase-admin/storage');
const { adminDb } = require('../telegram/_lib');
const { BUCKET, TYPES, POLICY_TTL_MS, FINISH_TTL_MS, readBody, badRequest,
  signToken, receiptPath } = require('./_receipt-upload');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const body = readBody(req);
    const lotteryId = String(body.lotteryId || '').trim();
    const mime = String(body.mime || '').toLowerCase().trim();
    const size = Number(body.bytes);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(lotteryId)) throw badRequest('Invalid lottery ID.');
    if (!TYPES[mime]) throw badRequest('Choose a JPG, PNG, WebP or PDF receipt.');
    if (!Number.isInteger(size) || size < 1 || size > TYPES[mime].max) {
      throw badRequest('Receipt is too large. Images: 420 KB maximum; PDF: 2 MB maximum.');
    }
    const db = adminDb();
    const snap = await db.collection('lotteries').doc(lotteryId).get();
    if (!snap.exists || snap.data()?.status !== 'active') throw badRequest('Lottery is not open.');
    const session = crypto.randomBytes(16).toString('hex');
    const path = receiptPath(lotteryId, session, TYPES[mime].ext);
    const bucket = getStorage().bucket(BUCKET);
    // A signed POST POLICY, not a signed PUT URL: GCS checks the maximum upload
    // size and exact Content-Type before accepting bytes. The bucket stays private.
    const [policy] = await bucket.file(path).generateSignedPostPolicyV4({
      expires: Date.now() + POLICY_TTL_MS,
      fields: {
        'Content-Type': mime,
        'success_action_status': '204',
        'x-goog-meta-proofsession': session
      },
      conditions: [
        // Allow multipart form overhead; the stored object's size is checked strictly on finalize.
        ['content-length-range', 1, TYPES[mime].max + 64 * 1024],
        ['eq', '$Content-Type', mime],
        ['eq', '$x-goog-meta-proofsession', session]
      ]
    });
    const proofUploadToken = signToken({
      v: 1, lotteryId, mime, session, path, exp: Date.now() + FINISH_TTL_MS
    });
    return res.status(200).json({
      ok: true, uploadUrl: policy.url, fields: policy.fields,
      proofUploadToken, expiresInSeconds: POLICY_TTL_MS / 1000
    });
  } catch (error) {
    if (error.statusCode) return res.status(error.statusCode).json({ ok: false, error: error.message });
    console.error('receipt upload authorization failed', error);
    return res.status(500).json({ ok: false, error: 'Could not prepare private receipt upload.' });
  }
};