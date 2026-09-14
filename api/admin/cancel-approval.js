const { adminDb, telegram, escapeHtml, telegramMiniAppUrl, FieldValue } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');

function readBearer(req) {
  const h = String(req.headers?.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({
      ok: false,
      error: 'Method not allowed'
    });
  }

  try {
    const idToken = readBearer(req);

    if (!idToken) {
      return res.status(401).json({
        ok: false,
        error: 'Missing Firebase ID token.'
      });
    }

    const db = adminDb();
    const adminAuth = getAuth();
    const caller = await adminAuth.verifyIdToken(idToken);

    const callerSnap = await db
      .collection('users')
      .doc(caller.uid)
      .get();

    if (!callerSnap.exists) {
      return res.status(403).json({
        ok: false,
        error: 'Admin profile not found.'
      });
    }

    const callerProfile = callerSnap.data();

    if (
      callerProfile.role !== 'generalAdmin' &&
      callerProfile.role !== 'lotteryAdmin'
    ) {
      return res.status(403).json({
        ok: false,
        error: 'Not authorized.'
      });
    }

    const body =
      req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const requestId = String(body.requestId || '').trim();

    const reason =
      String(
        body.reason ||
        'Approved in error.'
      )
        .trim()
        .slice(0, 300) ||
      'Approved in error.';

    if (!requestId) {
      return res.status(400).json({
        ok: false,
        error: 'requestId is required.'
      });
    }

    let notification = null;

    await db.runTransaction(async tx => {

      // =====================================================
      // 1. READ REQUEST AND LOTTERY FIRST
      // =====================================================

      const reqRef = db
        .collection('ticketRequests')
        .doc(requestId);

      const reqSnap = await tx.get(reqRef);

      if (!reqSnap.exists) {
        throw new Error('Request not found.');
      }

      const x = reqSnap.data();

      if (x.status !== 'approved') {
        throw new Error(
          'Only approved requests can be cancelled.'
        );
      }

      const lotteryId = String(x.lotteryId || '');

      if (!lotteryId) {
        throw new Error(
          'This request has no lottery ID.'
        );
      }

      const lotteryRef = db
        .collection('lotteries')
        .doc(lotteryId);

      const lotterySnap = await tx.get(lotteryRef);

      if (!lotterySnap.exists) {
        throw new Error('Lottery not found.');
      }

      const lot = lotterySnap.data();

      // Lottery Admin can cancel only an assigned lottery.
      if (callerProfile.role === 'lotteryAdmin') {

        const ids = Array.isArray(callerProfile.lotteryIds)
          ? callerProfile.lotteryIds
          : [];

        if (!ids.includes(lotteryId)) {
          throw new Error(
            'You are not assigned to this lottery.'
          );
        }
      }

      if (lot.status === 'drawn') {
        throw new Error(
          'This lottery has already been drawn. Approved tickets cannot be cancelled now.'
        );
      }

      // =====================================================
      // 2. READ ALL TICKET DOCUMENTS BEFORE ANY WRITES
      // =====================================================

      const numbers = Array.isArray(x.ticketNumbers)
        ? x.ticketNumbers
        : [];

      const ticketRefs = numbers.map(number =>
        db
          .collection('tickets')
          .doc(`${lotteryId}_${number}`)
      );

      const ticketSnaps = [];

      for (const ref of ticketRefs) {
        ticketSnaps.push(await tx.get(ref));
      }

      // =====================================================
      // 3. READ PUBLIC STATUS BEFORE ANY WRITES
      // =====================================================

      let publicRef = null;
      let publicSnap = null;

      const phoneHash = String(x.phoneHash || '');

      if (phoneHash) {
        publicRef = db
          .collection('publicStatus')
          .doc(phoneHash)
          .collection('requests')
          .doc(requestId);

        publicSnap = await tx.get(publicRef);
      }

      // =====================================================
      // 4. ALL WRITES START HERE
      // =====================================================

      const now = FieldValue.serverTimestamp();

      // Release the assigned ticket records.
      // NOTE: Firebase Admin DocumentSnapshot uses
      // `.exists` (boolean), not `.exists()`.
      for (let i = 0; i < ticketRefs.length; i++) {

        if (ticketSnaps[i].exists) {
          tx.delete(ticketRefs[i]);
        }
      }

      // Mark request as cancelled.
      tx.update(reqRef, {
        status: 'cancelled',
        cancelledAt: now,
        cancelledBy: caller.uid,
        cancellationReason: reason,
        cancelledTicketNumbers: numbers
      });

      // Update customer public status if it exists.
      if (publicSnap && publicSnap.exists) {
        tx.update(publicRef, {
          status: 'cancelled',
          cancellationReason: reason,
          cancelledAt: now,
          cancelledTicketNumbers: numbers
        });
      }

      // Audit trail.
      tx.set(
        db.collection('auditLogs').doc(),
        {
          action: 'cancelApproval',
          lotteryId,
          requestId,
          adminId: caller.uid,
          cancellationReason: reason,
          cancelledTicketNumbers: numbers,
          createdAt: now
        }
      );

      notification = {
        chatId: String(x.telegramChatId || ''),
        lottery: String(
          x.lotteryName ||
          lot.name ||
          lotteryId
        ),
        numbers
      };
    });

    // =======================================================
    // 5. TELEGRAM NOTIFICATION AFTER SUCCESSFUL TRANSACTION
    // =======================================================

    if (notification?.chatId) {
      try {

        const formattedNumbers =
          notification.numbers
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
            inline_keyboard: [
              [
                {
                  text: '🔎 Check Ticket Status',
                  web_app: {
                    url: telegramMiniAppUrl()
                  }
                }
              ]
            ]
          }
        });

      } catch (e) {
        // Do not fail the cancellation after the
        // Firestore transaction has already succeeded.
        console.warn(
          'Cancellation buyer Telegram notification failed:',
          e.message
        );
      }
    }

    return res.status(200).json({
      ok: true,
      cancelled: true
    });

  } catch (e) {

    console.error(
      'cancel-approval error:',
      e
    );

    return res.status(500).json({
      ok: false,
      error:
        e.message ||
        'Could not cancel approval.'
    });
  }
};
