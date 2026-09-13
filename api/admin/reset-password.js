const { adminDb } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');

function readBearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const idToken = readBearer(req);
    if (!idToken) return res.status(401).json({ ok: false, error: 'Missing Firebase ID token.' });

    const db = adminDb();
    const adminAuth = getAuth();
    const caller = await adminAuth.verifyIdToken(idToken);
    const callerSnap = await db.collection('users').doc(caller.uid).get();
    if (!callerSnap.exists || callerSnap.data().role !== 'generalAdmin') {
      return res.status(403).json({ ok: false, error: 'Only General Admin can reset a Lottery Admin password.' });
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    if (!email || password.length < 6) {
      return res.status(400).json({ ok: false, error: 'Provide an admin email and a password of at least 6 characters.' });
    }

    let target;
    try {
      target = await adminAuth.getUserByEmail(email);
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        return res.status(404).json({ ok: false, error: 'No Firebase account was found for this email.' });
      }
      throw e;
    }

    const targetSnap = await db.collection('users').doc(target.uid).get();
    if (!targetSnap.exists || targetSnap.data().role !== 'lotteryAdmin') {
      return res.status(400).json({ ok: false, error: 'This account is not a Lottery Admin.' });
    }

    await adminAuth.updateUser(target.uid, { password });
    await db.collection('auditLogs').add({
      action: 'resetLotteryAdminPassword',
      adminId: caller.uid,
      targetUserId: target.uid,
      targetEmail: email,
      createdAt: new Date()
    });

    return res.status(200).json({ ok: true, email, displayName: targetSnap.data().displayName || '' });
  } catch (e) {
    console.error('reset-password error:', e);
    return res.status(500).json({ ok: false, error: e.message || 'Could not reset password.' });
  }
};
