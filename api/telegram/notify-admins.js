const crypto = require('crypto');
const { adminDb, adminTelegram, escapeHtml } = require('./_lib');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }
  try {
    const requestId = String(req.body?.requestId || '').trim();
    const proofUploadToken = String(req.body?.proofUploadToken || '').trim();
    if (!requestId) return res.status(400).json({ ok: false, error: 'requestId is required.' });
    if (!proofUploadToken) return res.status(401).json({ ok: false, error: 'Payment notification token is required.' });

    const db = adminDb();
    const rs = await db.collection('ticketRequests').doc(requestId).get();
    if (!rs.exists) return res.status(404).json({ ok: false, error: 'Request not found.' });

    const request = rs.data() || {};
    if (request.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Request is no longer pending.' });
    }
    if (!safeEqualHex(String(request.proofUploadTokenHash || ''), sha256(proofUploadToken))) {
      return res.status(403).json({ ok: false, error: 'Invalid payment notification token.' });
    }

    const userSnaps = await db.collection('users')
      .where('lotteryIds', 'array-contains', String(request.lotteryId))
      .get();
    const recipients = userSnaps.docs
      .filter(d => d.data().role === 'lotteryAdmin' && d.data().telegramChatId)
      .map(d => String(d.data().telegramChatId));

    // Preserve an existing private notification-channel destination if configured.
    // Never attach the receipt or send a private Firebase Storage URL to Telegram.
    const backupChat = String(process.env.TELEGRAM_PAYMENT_PROOF_CHAT_ID || '').trim();
    const chats = [...new Set([...recipients, ...(backupChat ? [backupChat] : [])])];
    const evidence = request.proofPath
      ? (request.proofMime === 'application/pdf' ? 'PDF receipt uploaded' : 'Screenshot uploaded')
      : (request.reference ? 'Transaction reference provided' : 'Not provided');
    const message =
      '🎟️ <b>New payment request</b>\n\n' +
      '<b>Lottery:</b> ' + escapeHtml(request.lotteryName || request.lotteryId) + '\n' +
      '<b>Buyer:</b> ' + escapeHtml(request.name) + '\n' +
      '<b>Tickets:</b> ' + Number(request.quantity || 1) + '\n' +
      '<b>Total:</b> ' + Number(request.total || 0) + ' Birr\n' +
      '<b>Payment evidence:</b> ' + escapeHtml(evidence) + '\n' +
      '<b>Request:</b> <code>' + escapeHtml(requestId) + '</code>\n\n' +
      'Open the secure admin dashboard to review the receipt and verify payment.';

    let notified = 0;
    for (const chatId of chats) {
      try {
        await adminTelegram('sendMessage', {
          chat_id: chatId,
          text: message,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: [[{
              text: '🔐 Open Admin Dashboard',
              url: 'https://tigraylottery.com/admin/login.html'
            }]]
          }
        });
        notified++;
      } catch (error) {
        console.error('admin notification', chatId, error.message);
      }
    }
    return res.status(200).json({ ok: true, notified, proofSent: 0 });
  } catch (error) {
    console.error('notify-admins error:', error);
    return res.status(500).json({ ok: false, error: 'Could not send admin notification.' });
  }
};
