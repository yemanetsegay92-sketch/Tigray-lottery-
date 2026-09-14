const {
  adminDb,
  telegram,
  escapeHtml,
  telegramMiniAppUrl,
  FieldValue
} = require('../telegram/_lib');

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
    // =====================================================
    // 1. VERIFY LOGGED-IN ADMIN
    // =====================================================

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

    // =====================================================
    // 2. READ REQUEST ID / REASON
    // =====================================================

    const body =
      req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const requestId = String(
      body.requestId || ''
    ).trim();

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

    let buyerNotification = null;

    // =====================================================
    // 3. FIRESTORE TRANSACTION
    // =====================================================

    await db.runTransaction(async tx => {

      // -----------------------------------------------
      // READ REQUEST FIRST
      // -----------------------------------------------

      const reqRef = db
        .collection('ticketRequests')
        .doc(requestId);

      const reqSnap = await tx.get(reqRef);

      if (!reqSnap.exists) {
        throw new Error(
          'Request not found.'
        );
      }

      const requestData = reqSnap.data();

      if (requestData.status !== 'approved') {
        throw new Error(
          'Only approved requests can be cancelled.'
        );
      }

      const lotteryId =
        String(requestData.lotteryId || '');

      if (!lotteryId) {
        throw new Error(
          'This request has no lottery ID.'
        );
      }

      // -----------------------------------------------
      // READ LOTTERY
      // -----------------------------------------------

      const lotteryRef = db
        .collection('lotteries')
        .doc(lotteryId);

      const lotterySnap = await tx.get(
        lotteryRef
      );

      if (!lotterySnap.exists) {
        throw new Error(
          'Lottery not found.'
        );
      }

      const lottery = lotterySnap.data();

      // -----------------------------------------------
      // CHECK ADMIN AUTHORIZATION
      // -----------------------------------------------

      if (
        callerProfile.role ===
        'lotteryAdmin'
      ) {

        const assignedIds =
          Array.isArray(
            callerProfile.lotteryIds
          )
            ? callerProfile.lotteryIds
            : [];

        if (
          !assignedIds.includes(
            lotteryId
          )
        ) {
          throw new Error(
            'You are not assigned to this lottery.'
          );
        }
      }

      // -----------------------------------------------
      // DON'T ALLOW CANCELLATION AFTER DRAW
      // -----------------------------------------------

      if (
        lottery.status === 'drawn'
      ) {
        throw new Error(
          'This lottery has already been drawn. Approved tickets cannot be cancelled now.'
        );
      }

      // -----------------------------------------------
      // TICKET NUMBERS
      // -----------------------------------------------

      const numbers =
        Array.isArray(
          requestData.ticketNumbers
        )
          ? requestData.ticketNumbers
          : [];

      // -----------------------------------------------
      // READ ALL TICKETS BEFORE ANY WRITES
      // -----------------------------------------------

      const ticketRefs = numbers.map(
        number =>
          db
            .collection('tickets')
            .doc(
              `${lotteryId}_${number}`
            )
      );

      const ticketSnaps = [];

      for (const ref of ticketRefs) {
        ticketSnaps.push(
          await tx.get(ref)
        );
      }

      // -----------------------------------------------
      // READ PUBLIC STATUS
      // -----------------------------------------------

      let publicRef = null;
      let publicSnap = null;

      const phoneHash =
        String(
          requestData.phoneHash || ''
        );

      if (phoneHash) {

        publicRef = db
          .collection('publicStatus')
          .doc(phoneHash)
          .collection('requests')
          .doc(requestId);

        publicSnap =
          await tx.get(publicRef);
      }

      // =================================================
      // ALL READS ARE NOW FINISHED
      // WRITES START HERE
      // =================================================

      const now =
        FieldValue.serverTimestamp();

      // -----------------------------------------------
      // DELETE ASSIGNED TICKET DOCUMENTS
      // -----------------------------------------------

      for (
        let i = 0;
        i < ticketRefs.length;
        i++
      ) {

        // IMPORTANT:
        // Admin SDK DocumentSnapshot.exists
        // is a boolean property, NOT a function.

        if (
          ticketSnaps[i].exists
        ) {
          tx.delete(
            ticketRefs[i]
          );
        }
      }

      // -----------------------------------------------
      // MARK REQUEST CANCELLED
      // -----------------------------------------------

      tx.update(
        reqRef,
        {
          status: 'cancelled',

          cancelledAt: now,

          cancelledBy:
            caller.uid,

          cancellationReason:
            reason,

          cancelledTicketNumbers:
            numbers
        }
      );

      // -----------------------------------------------
      // UPDATE PUBLIC STATUS
      // -----------------------------------------------

      if (
        publicSnap &&
        publicSnap.exists
      ) {

        tx.update(
          publicRef,
          {
            status: 'cancelled',

            cancellationReason:
              reason,

            cancelledAt: now,

            cancelledTicketNumbers:
              numbers
          }
        );
      }

      // -----------------------------------------------
      // AUDIT LOG
      // -----------------------------------------------

      const auditRef =
        db
          .collection('auditLogs')
          .doc();

      tx.set(
        auditRef,
        {
          action:
            'cancelApproval',

          lotteryId,

          requestId,

          adminId:
            caller.uid,

          cancellationReason:
            reason,

          cancelledTicketNumbers:
            numbers,

          createdAt:
            now
        }
      );

      // -----------------------------------------------
      // PREPARE TELEGRAM NOTIFICATION
      // -----------------------------------------------

      buyerNotification = {
        chatId: String(
          requestData.telegramChatId ||
          ''
        ),

        lottery:
          String(
            requestData.lotteryName ||
            lottery.name ||
            lotteryId
          ),

        numbers
      };
    });

    // =====================================================
    // 4. TELEGRAM NOTIFICATION
    // =====================================================

    if (
      buyerNotification &&
      buyerNotification.chatId
    ) {

      try {

        const formattedNumbers =
          buyerNotification.numbers
            .map(
              n =>
                String(n)
                  .padStart(6, '0')
            )
            .join(', ');

        await telegram(
          'sendMessage',
          {
            chat_id:
              buyerNotification.chatId,

            text: [
              '⚠️ <b>Your previously approved ticket request has been cancelled.</b>',
              '',
              `<b>Lottery:</b> ${escapeHtml(
                buyerNotification.lottery
              )}`,
              `<b>Ticket numbers:</b> <b>${escapeHtml(
                formattedNumbers
              )}</b>`,
              '',
              `<b>Reason:</b> ${escapeHtml(
                reason
              )}`,
              '',
              'Please check your ticket status for details.'
            ].join('\n'),

            parse_mode: 'HTML',

            disable_web_page_preview:
              true,

            reply_markup: {
              inline_keyboard: [
                [
                  {
                    text:
                      '🔎 Check Ticket Status',

                    web_app: {
                      url:
                        telegramMiniAppUrl()
                    }
                  }
                ]
              ]
            }
          }
        );

      } catch (telegramError) {

        // The cancellation itself succeeded.
        // A Telegram failure should NOT undo it.

        console.warn(
          'Cancellation buyer Telegram notification failed:',
          telegramError.message
        );
      }
    }

    // =====================================================
    // 5. SUCCESS
    // =====================================================

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
