const crypto = require('crypto');
const { adminDb, telegram, telegramMiniAppUrl, escapeHtml, Timestamp, FieldValue } = require('./_lib');
const { getAuth } = require('firebase-admin/auth');

const COLLECTION = 'buyerNotificationQueue';
const MAX_BATCH = 100;
const LEASE_MS = 120000;

function authorizedCron(req) {
  const expected = String(process.env.BUYER_NOTIFICATION_CRON_SECRET || '');
  const supplied = String(req.headers['x-buyer-notification-secret'] || '');
  if (expected.length < 24 || !supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function renderMessage(request) {
  const lines = [];
  const lottery = escapeHtml(request.lotteryName || request.lotteryId);
  if (request.status === 'approved') {
    lines.push('🎉 <b>Your ticket request is approved!</b>', '',
      '<b>Lottery:</b> ' + lottery,
      '<b>Tickets:</b> ' + Number(request.quantity || 1),
      '<b>Ticket numbers:</b> <b>' + escapeHtml((request.ticketNumbers || []).map(n => String(n).padStart(6, '0')).join(', ')) + '</b>', '',
      'Thank you for participating.');
  } else if (request.status === 'rejected') {
    lines.push('❌ <b>Your ticket request was rejected.</b>', '',
      '<b>Lottery:</b> ' + lottery,
      '<b>Reason:</b> ' + escapeHtml(request.rejectionReason || 'Payment could not be verified.'), '',
      'Please contact the lottery administrator if you need assistance.');
  } else if (request.status === 'cancelled') {
    lines.push('⚠️ <b>Your previously approved ticket request was cancelled.</b>', '',
      '<b>Lottery:</b> ' + lottery,
      '<b>Reason:</b> ' + escapeHtml(request.cancellationReason || 'Approved in error.'), '',
      'Please check your ticket status or contact the lottery administrator.');
  }
  return lines.join('\n');
}

async function attemptDelivery(db, id) {
  const job = db.collection(COLLECTION).doc(id);
  const claim = await db.runTransaction(async tx => {
    const snap = await tx.get(job);
    if (!snap.exists) return null;
    const data = snap.data() || {};
    const due = data.nextAttemptAt?.toMillis ? data.nextAttemptAt.toMillis() : 0;
    if (data.state !== 'pending' || due > Date.now()) return null;
    const attempts = Number(data.attempts || 0) + 1;
    tx.update(job, {
      attempts,
      nextAttemptAt: Timestamp.fromMillis(Date.now() + LEASE_MS),
      lastAttemptAt: FieldValue.serverTimestamp()
    });
    return { ...data, attempts };
  });
  if (!claim) return { skipped: true };

  try {
    const snap = await db.collection('ticketRequests').doc(String(claim.requestId)).get();
    if (!snap.exists || snap.data().status !== claim.decision) {
      await job.update({ state: 'superseded', nextAttemptAt: FieldValue.delete() });
      return { superseded: true };
    }
    const request = snap.data();
    if (!request.telegramChatId) {
      await job.update({ state: 'waitingForLink', nextAttemptAt: FieldValue.delete() });
      return { waitingForLink: true };
    }
    const message = await telegram('sendMessage', {
      chat_id: String(request.telegramChatId),
      text: renderMessage(request),
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[{
        text: '🔎 Check Ticket Status', web_app: { url: telegramMiniAppUrl() }
      }]] }
    });
    await job.update({
      state: 'sent',
      telegramMessageId: message?.message_id || null,
      sentAt: FieldValue.serverTimestamp(),
      nextAttemptAt: FieldValue.delete(),
      lastError: FieldValue.delete()
    });
    return { sent: true };
  } catch (error) {
    const attempts = Number(claim.attempts);
    const exhausted = attempts >= 12;
    const backoffMs = Math.min(3600000, 20000 * Math.pow(2, Math.min(attempts - 1, 8)));
    await job.update({
      state: exhausted ? 'failed' : 'pending',
      nextAttemptAt: exhausted ? FieldValue.delete() : Timestamp.fromMillis(Date.now() + backoffMs),
      lastError: String(error?.message || 'Delivery failed').slice(0, 250),
      lastFailedAt: FieldValue.serverTimestamp()
    });
    console.error('buyer notification delivery failed', id, error?.message);
    return { failed: true, retryScheduled: !exhausted };
  }
}

async function drain(db) {
  const snap = await db.collection(COLLECTION)
    .where('nextAttemptAt', '<=', Timestamp.now())
    .orderBy('nextAttemptAt')
    .limit(MAX_BATCH).get();
  const ids = snap.docs.map(d => d.id);
  let sent = 0, failed = 0, waitingForLink = 0;
  for (let i = 0; i < ids.length; i += 8) {
    const results = await Promise.all(ids.slice(i, i + 8).map(id => attemptDelivery(db, id)));
    for (const r of results) {
      if (r.sent) sent++;
      if (r.failed) failed++;
      if (r.waitingForLink) waitingForLink++;
    }
  }
  return { examined: ids.length, sent, failed, waitingForLink };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  res.setHeader('Cache-Control', 'no-store');
  try {
    const db = adminDb();
    if (authorizedCron(req)) {
      return res.status(200).json({ ok: true, ...(await drain(db)) });
    }
    const authHeader = String(req.headers.authorization || '');
    if (!authHeader.startsWith('Bearer ')) return res.status(401).json({ ok: false, error: 'Authentication required.' });
    const identity = await getAuth().verifyIdToken(authHeader.slice(7));
    const profileSnap = await db.collection('users').doc(identity.uid).get();
    const profile = profileSnap.exists ? profileSnap.data() : {};
    if (!['generalAdmin', 'lotteryAdmin'].includes(profile.role)) {
      return res.status(403).json({ ok: false, error: 'Admin access required.' });
    }
    const requestId = String(req.body?.requestId || '');
    if (!/^[a-f0-9]{40}$/.test(requestId)) return res.status(400).json({ ok: false, error: 'Invalid request ID.' });
    const snap = await db.collection('ticketRequests').doc(requestId).get();
    if (!snap.exists) return res.status(404).json({ ok: false, error: 'Request not found.' });
    const request = snap.data() || {};
    if (profile.role === 'lotteryAdmin' &&
      !(Array.isArray(profile.lotteryIds) && profile.lotteryIds.includes(String(request.lotteryId || '')))) {
      return res.status(403).json({ ok: false, error: 'Not assigned to this lottery.' });
    }
    if (!['approved', 'rejected', 'cancelled'].includes(request.status)) {
      return res.status(409).json({ ok: false, error: 'Request is not finalized.' });
    }
    const result = await attemptDelivery(db, requestId + '_' + request.status);
    return res.status(200).json({ ok: true, ...result });
  } catch (error) {
    console.error('notify-buyer error', error);
    return res.status(500).json({ ok: false, error: 'Could not process buyer notification.' });
  }
};
