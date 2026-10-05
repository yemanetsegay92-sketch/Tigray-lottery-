const crypto = require('crypto');
const { adminDb, adminTelegram, adminBotToken, escapeHtml, FieldValue } = require('./_lib');

const MAX_PROOF_BYTES = 400 * 1024;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeEqualHex(a, b) {
  const left = Buffer.from(String(a || ''), 'hex');
  const right = Buffer.from(String(b || ''), 'hex');
  return left.length === right.length && left.length > 0 && crypto.timingSafeEqual(left, right);
}

function decodeProof(dataUrl) {
  const raw = String(dataUrl || '').trim();
  const match = raw.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if (!match) throw new Error('Payment screenshot must be a JPEG, PNG, or WebP image.');

  const mime = match[1].toLowerCase();
  const buffer = Buffer.from(match[2].replace(/\s+/g, ''), 'base64');
  if (!buffer.length) throw new Error('Payment screenshot is empty.');
  if (buffer.length > MAX_PROOF_BYTES) throw new Error('Payment screenshot is too large.');

  let valid = false;
  let ext = 'jpg';

  if (mime === 'image/jpeg') {
    valid = buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    ext = 'jpg';
  } else if (mime === 'image/png') {
    valid = buffer.length >= 8 &&
      buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
      buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a;
    ext = 'png';
  } else if (mime === 'image/webp') {
    valid = buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP';
    ext = 'webp';
  }

  if (!valid) throw new Error('Payment screenshot does not match its image type.');
  return { buffer, mime, ext };
}

function multipartField(boundary, name, value) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${String(value)}\r\n`
  );
}

async function sendPhoto(chatId, proof, caption) {
  const boundary = `----TigrayLottery${crypto.randomBytes(12).toString('hex')}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="photo"; filename="payment-proof.${proof.ext}"\r\n` +
    `Content-Type: ${proof.mime}\r\n\r\n`
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat([
    multipartField(boundary, 'chat_id', chatId),
    multipartField(boundary, 'caption', caption),
    multipartField(boundary, 'parse_mode', 'HTML'),
    head,
    proof.buffer,
    tail
  ]);

  const response = await fetch(
    `https://api.telegram.org/bot${adminBotToken()}/sendPhoto`,
    {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': String(body.length)
      },
      body
    }
  );

  let data = {};
  try { data = await response.json(); } catch {}

  if (!response.ok || !data.ok) {
    const error = new Error(data.description || 'Telegram sendPhoto failed.');
    error.retryAfter = Number(data?.parameters?.retry_after || 0);
    throw error;
  }

  return data.result;
}

async function sendPhotoWithOneRetry(chatId, proof, caption) {
  try {
    return await sendPhoto(chatId, proof, caption);
  } catch (error) {
    const wait = Number(error?.retryAfter || 0);
    if (!wait || wait > 5) throw error;
    await new Promise(resolve => setTimeout(resolve, wait * 1000));
    return sendPhoto(chatId, proof, caption);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const requestId = String(req.body?.requestId || '').trim();
    const proofUploadToken = String(req.body?.proofUploadToken || '').trim();
    const screenshotData = String(req.body?.screenshotData || '');
    const screenshotOriginalBytes = Number(req.body?.screenshotOriginalBytes || 0);

    if (!requestId) {
      return res.status(400).json({ ok: false, error: 'requestId is required.' });
    }
    if (!proofUploadToken) {
      return res.status(401).json({ ok: false, error: 'Payment proof token is required.' });
    }

    const db = adminDb();
    const rs = await db.collection('ticketRequests').doc(requestId).get();
    if (!rs.exists) {
      return res.status(404).json({ ok: false, error: 'Request not found.' });
    }

    const x = rs.data() || {};
    if (x.status !== 'pending') {
      return res.status(400).json({ ok: false, error: 'Request is no longer pending.' });
    }

    const expectedHash = String(x.proofUploadTokenHash || '');
    const suppliedHash = sha256(proofUploadToken);
    if (!safeEqualHex(expectedHash, suppliedHash)) {
      return res.status(403).json({ ok: false, error: 'Invalid payment proof token.' });
    }

    const users = await db.collection('users')
      .where('lotteryIds', 'array-contains', String(x.lotteryId))
      .get();

    const recipients = users.docs
      .filter(d => d.data().role === 'lotteryAdmin' && d.data().telegramChatId)
      .map(d => d.data());

    const text =
      `🎟️ <b>New payment request</b>\n\n` +
      `<b>Lottery:</b> ${escapeHtml(x.lotteryName || x.lotteryId)}\n` +
      `<b>Buyer:</b> ${escapeHtml(x.name)}\n` +
      `<b>Phone:</b> ${escapeHtml(x.phone)}\n` +
      `<b>Tickets:</b> ${Number(x.quantity || 1)}\n` +
      `<b>Total:</b> ${Number(x.total || 0)} Birr\n` +
      `<b>Reference:</b> ${escapeHtml(x.reference)}\n` +
      `<b>Request:</b> <code>${escapeHtml(requestId)}</code>\n\n` +
      `Please open the admin dashboard to verify and approve or reject this request.`;

    let proofSent = 0;
    const messageIds = [];
    const proof = screenshotData ? decodeProof(screenshotData) : null;
    const configuredBackupChat = String(process.env.TELEGRAM_PAYMENT_PROOF_CHAT_ID || '').trim();

    if (proof) {
      const targets = configuredBackupChat
        ? [configuredBackupChat]
        : [...new Set(recipients.map(a => String(a.telegramChatId)))];

      for (const chatId of targets) {
        try {
          const message = await sendPhotoWithOneRetry(chatId, proof, text);
          proofSent++;
          if (message?.message_id != null) messageIds.push(Number(message.message_id));
        } catch (error) {
          console.error('payment proof backup', chatId, error.message);
        }
      }

      await rs.ref.set({
        screenshotSelected: true,
        screenshotBytes: proof.buffer.length,
        screenshotOriginalBytes:
          Number.isFinite(screenshotOriginalBytes) && screenshotOriginalBytes > 0
            ? screenshotOriginalBytes
            : proof.buffer.length,
        screenshotMime: proof.mime,
        telegramProofSent: proofSent > 0,
        telegramProofSentAt: proofSent > 0 ? FieldValue.serverTimestamp() : null,
        telegramProofMessageIds: messageIds,
        telegramProofTarget: configuredBackupChat ? 'private-channel' : 'lottery-admin-chat'
      }, { merge: true });
    }

    let notified = 0;

    // If the proof was sent to a dedicated backup channel, admins still get their
    // normal lightweight notification. Without a dedicated channel, the photo
    // itself is the admin notification, so avoid sending a duplicate message.
    if (!proof || configuredBackupChat) {
      for (const a of recipients) {
        try {
          await adminTelegram('sendMessage', {
            chat_id: a.telegramChatId,
            text,
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
          console.error('admin notification', a.telegramChatId, error.message);
        }
      }
    } else {
      notified = proofSent;
    }

    return res.status(200).json({
      ok: true,
      notified,
      proofSent,
      proofStoredInFirestore: false
    });
  } catch (error) {
    console.error('notify-admins error:', error);
    return res.status(500).json({ ok: false, error: error.message });
  }
};
