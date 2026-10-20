const crypto = require('crypto');
const { adminDb, botLink } = require('./_lib');

function digest(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  try {
    const id = String(req.body?.requestId || '');
    const token = String(req.body?.buyerLinkToken || '');
    if (!/^[a-f0-9]{40}$/.test(id) || !/^[a-f0-9]{20}$/.test(token)) {
      return res.status(400).json({ ok: false, error: 'Invalid buyer link credentials.' });
    }
    const snap = await adminDb().collection('ticketRequests').doc(id).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Request not found.' });
    const stored = String(snap.data().buyerLinkTokenHash || '');
    const provided = digest(token);
    if (stored.length !== provided.length ||
        !crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(provided))) {
      return res.status(403).json({ ok: false, error: 'Buyer link expired or invalid.' });
    }
    // r_ + 40-digit id + _ + 20-digit secret = 63 characters (Telegram max: 64).
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ ok: true, url: botLink('r_' + id + '_' + token) });
  } catch (error) {
    console.error('buyer-link error', error);
    return res.status(500).json({ ok: false, error: 'Could not generate buyer link.' });
  }
};
