const crypto = require('crypto');

const BUCKET = 'tigiray-lottery.firebasestorage.app';
const MAX_IMAGE_BYTES = 420 * 1024;
const MAX_PDF_BYTES = 2 * 1024 * 1024;
const POLICY_TTL_MS = 10 * 60 * 1000;
const FINISH_TTL_MS = 20 * 60 * 1000;

const TYPES = Object.freeze({
  'image/jpeg': { ext: 'jpg', max: MAX_IMAGE_BYTES },
  'image/png': { ext: 'png', max: MAX_IMAGE_BYTES },
  'image/webp': { ext: 'webp', max: MAX_IMAGE_BYTES },
  'application/pdf': { ext: 'pdf', max: MAX_PDF_BYTES }
});
function badRequest(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try { return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)); }
  catch { throw badRequest('Invalid request body.'); }
}
function signingKey() {
  const raw = process.env.PAYMENT_PROOF_TOKEN_SECRET ||
    (() => {
      const account = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || '{}');
      return account.private_key || '';
    })();
  if (raw.length < 32) throw new Error('Receipt token signing secret is not configured.');
  return crypto.createHmac('sha256', raw).update('tigray-lottery/receipt-uploads/v1').digest();
}
function signToken(data) {
  const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
  const mac = crypto.createHmac('sha256', signingKey()).update(payload).digest('base64url');
  return payload + '.' + mac;
}
function verifyToken(token, lotteryId) {
  if (typeof token !== 'string' || token.length > 1600 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw badRequest('Receipt upload authorization is invalid.');
  }
  const [payload, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', signingKey()).update(payload).digest();
  const supplied = Buffer.from(mac, 'base64url');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw badRequest('Receipt upload authorization is invalid.');
  }
  let d;
  try { d = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { throw badRequest('Receipt upload authorization is invalid.'); }
  const info = TYPES[d?.mime];
  if (d?.v !== 1 || !info || d.lotteryId !== lotteryId ||
    typeof d.session !== 'string' || !/^[a-f0-9]{32}$/.test(d.session) ||
    typeof d.path !== 'string' || d.path !== receiptPath(lotteryId, d.session, info.ext) ||
    !Number.isInteger(d.exp) || Date.now() > d.exp || Date.now() < d.exp - FINISH_TTL_MS - 60000) {
    throw badRequest('Receipt upload authorization has expired or is invalid.');
  }
  return d;
}
function receiptPath(lotteryId, session, ext) {
  return 'payment-proofs/' + encodeURIComponent(lotteryId) + '/incoming/' + session + '.' + ext;
}
function confirmFileHeader(mime, head, tail) {
  if (mime === 'image/jpeg') return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (mime === 'image/png') return head.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (mime === 'image/webp') return head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP';
  return mime === 'application/pdf' && head.toString('latin1', 0, 5) === '%PDF-' &&
    tail.includes(Buffer.from('%%EOF'));
}
async function validateStagedFile(bucket, token) {
  const file = bucket.file(token.path);
  let meta;
  try { [meta] = await file.getMetadata(); }
  catch (error) {
    if (error.code === 404) throw badRequest('The receipt has not finished uploading.', 409);
    throw error;
  }
  const info = TYPES[token.mime];
  const bytes = Number(meta.size);
  if (!Number.isSafeInteger(bytes) || bytes < 1 || bytes > info.max ||
      meta.contentType !== token.mime || meta.metadata?.proofsession !== token.session) {
    throw badRequest('The uploaded receipt is invalid or exceeds its size limit.');
  }
  const [head] = await file.download({ start: 0, end: Math.min(bytes - 1, 15) });
  const tail = token.mime === 'application/pdf'
    ? (await file.download({ start: Math.max(0, bytes - 2048), end: bytes - 1 }))[0]
    : Buffer.alloc(0);
  if (!confirmFileHeader(token.mime, head, tail)) {
    throw badRequest('Receipt data does not match the selected format.');
  }
  return { file, bytes, md5: String(meta.md5Hash || ''), generation: String(meta.generation || '') };
}
module.exports = { BUCKET, TYPES, POLICY_TTL_MS, FINISH_TTL_MS, readBody, badRequest,
  sha256, signToken, verifyToken, receiptPath, validateStagedFile };