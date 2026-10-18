const { adminDb } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');
const { getStorage } = require('firebase-admin/storage');

const BUCKET = 'tigiray-lottery.firebasestorage.app';
const MAX_BYTES = 2 * 1024 * 1024;

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  try {
    const header = String(req.headers?.authorization || '');
    if (!header.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'Sign in is required.' });
    const db = adminDb();
    const identity = await getAuth().verifyIdToken(header.slice(7));
    const profileSnap = await db.collection('users').doc(identity.uid).get();
    if (!profileSnap.exists) return res.status(403).json({ ok: false, error: 'Access denied.' });
    const profile = profileSnap.data() || {};
    if (profile.role !== 'generalAdmin' && profile.role !== 'lotteryAdmin') {
      return res.status(403).json({ ok: false, error: 'Access denied.' });
    }
    const requestId = String(req.query?.requestId || '').trim();
    if (!/^[a-f0-9]{40}$/.test(requestId)) return res.status(400).json({ ok: false, error: 'Invalid request ID.' });
    const requestSnap = await db.collection('ticketRequests').doc(requestId).get();
    if (!requestSnap.exists) return res.status(404).json({ ok: false, error: 'Request not found.' });
    const request = requestSnap.data() || {};
    const ids = Array.isArray(profile.lotteryIds) ? profile.lotteryIds : [];
    if (profile.role === 'lotteryAdmin' && !ids.includes(String(request.lotteryId || ''))) {
      return res.status(403).json({ ok: false, error: 'Not assigned to this lottery.' });
    }
    // Only use the Firestore server-written path, never a path supplied by the browser.
    const path = String(request.proofPath || '');
    const mime = String(request.proofMime || '');
    if (!path || !path.startsWith('payment-proofs/') ||
        !['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime)) {
      return res.status(404).json({ ok: false, error: 'No uploaded receipt for this request.' });
    }
    const file = getStorage().bucket(BUCKET).file(path);
    const [buf] = await file.download();
    if (buf.length > MAX_BYTES) return res.status(413).json({ ok: false, error: 'Receipt too large.' });
    res.setHeader('Content-Type', mime);
    const ext = mime === 'application/pdf' ? 'pdf' : (mime === 'image/png' ? 'png' : (mime === 'image/webp' ? 'webp' : 'jpg'));
    // PDFs are attachments, not inline HTML viewers; do not execute embedded content.
    res.setHeader('Content-Disposition', (mime === 'application/pdf' ? 'attachment' : 'inline') +
      '; filename="payment-receipt-' + requestId + '.' + ext + '"');
    return res.status(200).send(buf);
  } catch (error) {
    console.error('admin payment-proof', error);
    return res.status(500).json({ ok: false, error: 'Could not retrieve receipt.' });
  }
};
