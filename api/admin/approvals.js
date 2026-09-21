const crypto = require('crypto');
const { adminDb, telegram, escapeHtml, telegramMiniAppUrl, FieldValue } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');

function readBearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body));
  } catch {
    throw new Error('Invalid request body.');
  }
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^0-9+]/g, '').replace(/^\+251/, '0').trim();
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

async function authenticateAdmin(req, db) {
  const token = readBearer(req);
  if (!token) throw Object.assign(new Error('Missing Firebase ID token.'), { statusCode: 401 });

  const caller = await getAuth().verifyIdToken(token);
  const callerSnap = await db.collection('users').doc(caller.uid).get();

  if (!callerSnap.exists) {
    throw Object.assign(new Error('Admin profile not found.'), { statusCode: 403 });
  }

  const profile = callerSnap.data() || {};
  if (profile.role !== 'generalAdmin' && profile.role !== 'lotteryAdmin') {
    throw Object.assign(new Error('Not authorized.'), { statusCode: 403 });
  }

  return { caller, profile };
}

function assertLotteryAccess(profile, lotteryId) {
  if (profile.role !== 'lotteryAdmin') return;
  const ids = Array.isArray(profile.lotteryIds) ? profile.lotteryIds : [];
  if (!ids.includes(lotteryId)) {
    throw new Error('You are not assigned to this lottery.');
  }
}

async function approveRequest(db, caller, profile, requestId, requestedLotteryId) {
  let result = null;

  await db.runTransaction(async tx => {
    const requestRef = db.collection('ticketRequests').doc(requestId);
    const requestSnap = await tx.get(requestRef);

    if (!requestSnap.exists) throw new Error('Request not found.');

    const request = requestSnap.data() || {};
    const lotteryId = String(request.lotteryId || requestedLotteryId || '').trim();

    if (!lotteryId) throw new Error('This request has no lottery ID.');
    if (requestedLotteryId && requestedLotteryId !== lotteryId) {
      throw new Error('Request does not belong to the selected lottery.');
    }
    if (request.status !== 'pending') {
      throw new Error('This request has already been reviewed.');
    }

    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const lotterySnap = await tx.get(lotteryRef);

    if (!lotterySnap.exists) throw new Error('Lottery not found.');

    const lottery = lotterySnap.data() || {};
    assertLotteryAccess(profile, lotteryId);

    const min = Number(lottery.min);
    const max = Number(lottery.max);
    const quantity = Number(request.quantity);

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
      throw new Error('Invalid ticket quantity.');
    }

    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error('Lottery ticket range is not configured correctly.');
    }

    const currentRaw = Number(lottery.nextTicketNumber);
    const next = Number.isFinite(currentRaw) ? Math.max(min, currentRaw) : min;
    const last = next + quantity - 1;

    if (next > max || last > max) {
      throw new Error('There are not enough remaining ticket numbers in this lottery.');
    }

    const ticketNumbers = Array.from({ length: quantity }, (_, index) => next + index);
    const phone = normalizePhone(request.phone);
    const phoneHash = String(request.phoneHash || '') || sha256(phone);
    const now = FieldValue.serverTimestamp();

    // The lottery counter is the sole allocator for new approvals.
    // tx.create prevents an unexpected stale-counter collision from overwriting a ticket.
    for (const number of ticketNumbers) {
      const ticketRef = db.collection('tickets').doc(`${lotteryId}_${number}`);
      tx.create(ticketRef, {
        lotteryId,
        number,
        requestId,
        assignedAt: now,
        assignedBy: caller.uid
      });
    }

    tx.update(requestRef, {
      status: 'approved',
      ticketNumbers,
      reviewedBy: caller.uid,
      reviewedAt: now,
      lotteryName: String(lottery.name || lotteryId),
      phoneHash
    });

    tx.update(lotteryRef, {
      nextTicketNumber: last + 1
    });

    const publicRef = db
      .collection('publicStatus')
      .doc(phoneHash)
      .collection('requests')
      .doc(requestId);

    tx.set(publicRef, {
      lotteryId,
      lotteryName: String(lottery.name || lotteryId),
      phoneLast4: phone.slice(-4),
      quantity,
      total: Number(request.total || Number(request.price || lottery.price || 0) * quantity),
      status: 'approved',
      ticketNumbers,
      reviewedAt: now
    }, { merge: true });

    tx.set(db.collection('auditLogs').doc(), {
      action: 'approveRequest',
      lotteryId,
      requestId,
      adminId: caller.uid,
      ticketNumbers,
      quantity,
      createdAt: now
    });

    result = {
      lotteryId,
      lotteryName: String(lottery.name || lotteryId),
      name: String(request.name || ''),
      phone: String(request.phone || ''),
      reference: String(request.reference || ''),
      quantity,
      total: Number(request.total || 0),
      phoneHash,
      ticketNumbers
    };
  });

  return result;
}

async function cancelApproval(db, caller, profile, requestId, reason) {
  let notification = null;

  await db.runTransaction(async tx => {
    const requestRef = db.collection('ticketRequests').doc(requestId);
    const requestSnap = await tx.get(requestRef);

    if (!requestSnap.exists) throw new Error('Request not found.');

    const request = requestSnap.data() || {};
    if (request.status !== 'approved') {
      throw new Error('Only approved requests can be cancelled.');
    }

    const lotteryId = String(request.lotteryId || '');
    if (!lotteryId) throw new Error('This request has no lottery ID.');

    const lotteryRef = db.collection('lotteries').doc(lotteryId);
    const lotterySnap = await tx.get(lotteryRef);

    if (!lotterySnap.exists) throw new Error('Lottery not found.');

    const lottery = lotterySnap.data() || {};
    assertLotteryAccess(profile, lotteryId);

    if (lottery.status === 'drawn') {
      throw new Error('This lottery has already been drawn. Approved tickets cannot be cancelled now.');
    }

    const numbers = Array.isArray(request.ticketNumbers) ? request.ticketNumbers : [];
    const phoneHash = String(request.phoneHash || '');
    const now = FieldValue.serverTimestamp();

    // Deletes are safe without reads: ticket document IDs are deterministic,
    // and cancellation never moves the lottery counter backwards or reuses numbers.
    for (const number of numbers) {
      tx.delete(
        db.collection('tickets').doc(`${lotteryId}_${number}`)
      );
    }

    tx.update(requestRef, {
      status: 'cancelled',
      cancelledAt: now,
      cancelledBy: caller.uid,
      cancellationReason: reason,
      cancelledTicketNumbers: numbers
    });

    if (phoneHash) {
      const publicRef = db
        .collection('publicStatus')
        .doc(phoneHash)
        .collection('requests')
        .doc(requestId);

      tx.set(publicRef, {
        status: 'cancelled',
        cancellationReason: reason,
        cancelledAt: now,
        cancelledTicketNumbers: numbers
      }, { merge: true });
    }

    tx.set(db.collection('auditLogs').doc(), {
      action: 'cancelApproval',
      lotteryId,
      requestId,
      adminId: caller.uid,
      cancellationReason: reason,
      cancelledTicketNumbers: numbers,
      createdAt: now
    });

    notification = {
      chatId: String(request.telegramChatId || ''),
      lottery: String(request.lotteryName || lottery.name || lotteryId),
      numbers
    };
  });

  if (notification?.chatId) {
    try {
      const formattedNumbers = notification.numbers
        .map(n => String(n).padStart(6, '0'))
        .join(', ');

      await telegram('sendMessage', {
        chat_id: notification.chatId,
        text: [
          '⚠️ <b>Your previously approved ticket request has been cancelled.</b>',
          '',
          `<b>Lottery:</b> ${escapeHtml(notification.lottery)}`,
          `<b>Ticket numbers:</b> <b>${escapeHtml(formattedNumbers)}</b>`,
          '',
          `Reason: ${escapeHtml(reason)}`,
          '',
          'Please check your ticket status for details.'
        ].join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        reply_markup: {
          inline_keyboard: [[{
            text: '🔎 Check Ticket Status',
            web_app: { url: telegramMiniAppUrl() }
          }]]
        }
      });
    } catch (error) {
      console.warn('Cancellation buyer Telegram notification failed:', error.message);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const body = readBody(req);
    const action = String(body.action || '').trim().toLowerCase();
    const requestId = String(body.requestId || '').trim();
    const requestedLotteryId = String(body.lotteryId || '').trim();

    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'requestId is required.' });
    }

    if (!['approve', 'cancel'].includes(action)) {
      return res.status(400).json({ ok: false, error: 'action must be approve or cancel.' });
    }

    const db = adminDb();
    const { caller, profile } = await authenticateAdmin(req, db);

    if (action === 'approve') {
      const result = await approveRequest(
        db,
        caller,
        profile,
        requestId,
        requestedLotteryId
      );

      return res.status(200).json({
        ok: true,
        approved: true,
        request: result
      });
    }

    const reason = String(
      body.reason || 'Approved in error.'
    ).trim().slice(0, 300) || 'Approved in error.';

    await cancelApproval(
      db,
      caller,
      profile,
      requestId,
      reason
    );

    return res.status(200).json({
      ok: true,
      cancelled: true
    });
  } catch (error) {
    console.error('admin approvals error:', error);

    const message = String(
      error?.message || 'Could not complete the approval action.'
    );

    const status = Number(error?.statusCode || 0);
    if (status >= 400 && status < 500) {
      return res.status(status).json({ ok: false, error: message });
    }

    if (
      error?.code === 8 ||
      message.includes('RESOURCE_EXHAUSTED') ||
      message.includes('Quota exceeded')
    ) {
      return res.status(429).json({
        ok: false,
        error: 'Firestore is temporarily out of quota or capacity. Please try the approval again after the Firestore quota window resets.'
      });
    }

    if (
      message.includes('Already exists') ||
      error?.code === 6 ||
      error?.code === 'already-exists'
    ) {
      return res.status(409).json({
        ok: false,
        error: 'A ticket-number collision was detected. No existing ticket was overwritten. Please repair the lottery counter before approving this request.'
      });
    }

    if (
      message === 'Request not found.' ||
      message === 'Lottery not found.' ||
      message === 'This request has already been reviewed.' ||
      message === 'Only approved requests can be cancelled.'
    ) {
      return res.status(409).json({ ok: false, error: message });
    }

    return res.status(500).json({
      ok: false,
      error: message
    });
  }
};
