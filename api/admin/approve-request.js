const crypto = require('crypto');
const { adminDb, FieldValue } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');

function readBearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

function readBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  try {
    return JSON.parse(
      Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body)
    );
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }

  try {
    const idToken = readBearer(req);
    if (!idToken) {
      return res.status(401).json({ ok: false, error: 'Missing Firebase ID token.' });
    }

    const body = readBody(req);
    const requestId = String(body.requestId || '').trim();
    const requestedLotteryId = String(body.lotteryId || '').trim();

    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'requestId is required.' });
    }

    const adminAuth = getAuth();
    const caller = await adminAuth.verifyIdToken(idToken);
    const db = adminDb();

    const callerSnap = await db.collection('users').doc(caller.uid).get();
    if (!callerSnap.exists) {
      return res.status(403).json({ ok: false, error: 'Admin profile not found.' });
    }

    const callerProfile = callerSnap.data() || {};
    if (callerProfile.role !== 'generalAdmin' && callerProfile.role !== 'lotteryAdmin') {
      return res.status(403).json({ ok: false, error: 'Not authorized.' });
    }

    let result = null;

    await db.runTransaction(async tx => {
      const requestRef = db.collection('ticketRequests').doc(requestId);
      const requestSnap = await tx.get(requestRef);

      if (!requestSnap.exists) {
        throw new Error('Request not found.');
      }

      const request = requestSnap.data() || {};
      const lotteryId = String(request.lotteryId || requestedLotteryId || '').trim();

      if (!lotteryId) {
        throw new Error('This request has no lottery ID.');
      }

      if (requestedLotteryId && requestedLotteryId !== lotteryId) {
        throw new Error('Request does not belong to the selected lottery.');
      }

      if (request.status !== 'pending') {
        throw new Error('This request has already been reviewed.');
      }

      const lotteryRef = db.collection('lotteries').doc(lotteryId);
      const lotterySnap = await tx.get(lotteryRef);

      if (!lotterySnap.exists) {
        throw new Error('Lottery not found.');
      }

      const lottery = lotterySnap.data() || {};

      if (callerProfile.role === 'lotteryAdmin') {
        const ids = Array.isArray(callerProfile.lotteryIds)
          ? callerProfile.lotteryIds
          : [];

        if (!ids.includes(lotteryId)) {
          throw new Error('You are not assigned to this lottery.');
        }
      }

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
      const next = Number.isFinite(currentRaw)
        ? Math.max(min, currentRaw)
        : min;

      const last = next + quantity - 1;

      if (next > max || last > max) {
        throw new Error('There are not enough remaining ticket numbers in this lottery.');
      }

      const ticketNumbers = Array.from(
        { length: quantity },
        (_, index) => next + index
      );

      const phone = normalizePhone(request.phone);
      const phoneHash = String(request.phoneHash || '') || sha256(phone);

      const now = FieldValue.serverTimestamp();

      for (const number of ticketNumbers) {
        const ticketRef = db
          .collection('tickets')
          .doc(`${lotteryId}_${number}`);

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

      tx.set(
        publicRef,
        {
          lotteryId,
          lotteryName: String(lottery.name || lotteryId),
          phoneLast4: phone.slice(-4),
          quantity,
          total: Number(request.total || Number(request.price || lottery.price || 0) * quantity),
          status: 'approved',
          ticketNumbers,
          reviewedAt: now
        },
        { merge: true }
      );

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

    return res.status(200).json({
      ok: true,
      approved: true,
      request: result
    });
  } catch (error) {
    console.error('approve-request error:', error);

    const message = String(error?.message || 'Could not approve this request.');

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
      message === 'You are not assigned to this lottery.'
    ) {
      return res.status(409).json({ ok: false, error: message });
    }

    return res.status(500).json({
      ok: false,
      error: message
    });
  }
};
