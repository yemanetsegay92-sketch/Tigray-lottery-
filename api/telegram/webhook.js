const crypto = require('crypto');
const { adminDb, telegram, telegramMiniAppUrl, FieldValue } = require('./_lib');

function headerValue(req, name) {
  const headers = req?.headers || {};
  const v = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? '';
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

async function readBody(req) {
  // Vercel Node functions normally provide req.body.
  if (req?.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body) && !(req.body instanceof Uint8Array)) {
      return req.body;
    }
    if (Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
    if (req.body instanceof Uint8Array) return JSON.parse(Buffer.from(req.body).toString('utf8') || '{}');
    if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  }

  // Fallback for environments exposing the raw request stream.
  if (req && typeof req.on === 'function') {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString('utf8');
    return raw ? JSON.parse(raw) : {};
  }

  return {};
}

async function connectAdmin(db, token, chatId, msg) {
  const ref = db.collection('telegramAdminLinks').doc(token);
  const snap = await ref.get();
  if (!snap.exists) return { ok: false, reason: 'missing' };

  const link = snap.data();
  const expires = typeof link.expiresAt?.toMillis === 'function' ? link.expiresAt.toMillis() : 0;
  if (link.used || (expires && expires <= Date.now())) return { ok: false, reason: 'expired' };

  const uid = String(link.userId || '');
  if (!uid) return { ok: false, reason: 'missing-user' };

  await db.collection('users').doc(uid).set({
    telegramChatId: String(chatId),
    telegramUserId: String(msg?.from?.id || ''),
    telegramUsername: String(msg?.from?.username || ''),
    telegramFirstName: String(msg?.from?.first_name || ''),
    telegramConnectedAt: FieldValue.serverTimestamp()
  }, { merge: true });

  await ref.update({
    used: true,
    usedAt: FieldValue.serverTimestamp(),
    telegramChatId: String(chatId),
    telegramUserId: String(msg?.from?.id || '')
  });

  return { ok: true, userId: uid };
}

async function sendWelcome(chatId) {
  return telegram('sendMessage', {
    chat_id: chatId,
    text: '🎟️ Welcome to Tigray Lottery\n\nBuy tickets and check your lottery status directly from Telegram.',
    reply_markup: {
      inline_keyboard: [
        [{ text: '🎟 ቲኬት ይግዙ', web_app: { url: telegramMiniAppUrl() } }],
        [{ text: '🌐 Open Website', url: 'https://tigraylottery.com' }]
      ]
    }
  });
}

async function sendText(chatId, text, reply_markup) {
  const body = { chat_id: chatId, text };
  if (reply_markup) body.reply_markup = reply_markup;
  return telegram('sendMessage', body);
}

module.exports = async function webhook(req, res) {
  // Simple health check. This does NOT contact Telegram or Firebase.
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'telegram-webhook', method: 'GET' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  try {
    const expected = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    const provided = headerValue(req, 'x-telegram-bot-api-secret-token').trim();
    if (expected && provided !== expected) {
      console.error('Telegram webhook secret mismatch.');
      return res.status(403).json({ ok: false, error: 'Webhook secret mismatch' });
    }

    const update = await readBody(req);
    console.log('Telegram update:', JSON.stringify({
      update_id: update?.update_id ?? null,
      keys: Object.keys(update || {}),
      text: update?.message?.text || null,
      chat_id: update?.message?.chat?.id || null
    }));

    const msg = update?.message || update?.edited_message || null;
    if (!msg?.chat?.id) {
      return res.status(200).json({ ok: true, ignored: true, reason: 'No supported message update' });
    }

    const chatId = String(msg.chat.id);
    const text = String(msg.text || '').trim();

    // IMPORTANT: initialize Firebase only after we've confirmed we received a message.
    // Plain /start can therefore respond even if Firebase has a temporary problem.
    const parts = text.split(/\s+/).filter(Boolean);
    const rawCommand = String(parts[0] || '');
    const command = rawCommand.split('@')[0].toLowerCase();
    const parameter = String(parts[1] || '');

    if (command === '/start' && !parameter) {
      await sendWelcome(chatId);
      return res.status(200).json({ ok: true, type: 'welcome' });
    }

    const db = adminDb();

    if (command === '/start') {
      if (parameter.startsWith('admin_')) {
        const result = await connectAdmin(db, parameter.slice(6), chatId, msg);
        await sendText(chatId, result.ok
          ? '✅ Telegram notifications are now connected to your Tigray Lottery admin account.\n\nYou can return to the admin dashboard.'
          : '⚠️ This admin connection link is invalid or expired. Please generate a new connection code from the Lottery Admin dashboard.');
        return res.status(200).json({ ok: true, type: 'admin_start', connected: result.ok });
      }

      // Do not link Telegram accounts using a publicly guessable request ID.
      if (parameter.startsWith('r_')) {
        const match = /^r_([a-f0-9]{40})_([a-f0-9]{20})$/.exec(parameter);
        if (!match) {
          await sendText(chatId, 'Invalid ticket notification link.');
          return res.status(200).json({ ok: true, type: 'buyer_start', linked: false });
        }
        const requestId = match[1];
        const secretHash = crypto.createHash('sha256').update(match[2]).digest('hex');
        const reqRef = db.collection('ticketRequests').doc(requestId);
        const outcome = await db.runTransaction(async tx => {
          const snap = await tx.get(reqRef);
          if (!snap.exists) return { linked: false };
          const x = snap.data() || {};
          const stored = String(x.buyerLinkTokenHash || '');
          if (stored.length !== secretHash.length ||
              !crypto.timingSafeEqual(Buffer.from(stored), Buffer.from(secretHash))) {
            return { linked: false };
          }
          if (x.telegramChatId && String(x.telegramChatId) !== chatId) return { linked: false };
          let jobRef = null, jobSnap = null;
          if (['approved', 'rejected', 'cancelled'].includes(x.status)) {
            jobRef = db.collection('buyerNotificationQueue').doc(requestId + '_' + x.status);
            jobSnap = await tx.get(jobRef);
          }
          tx.update(reqRef, {
            telegramChatId: chatId,
            telegramUserId: String(msg.from?.id || ''),
            telegramUsername: String(msg.from?.username || ''),
            telegramConnectedAt: FieldValue.serverTimestamp(),
            buyerLinkTokenHash: FieldValue.delete()
          });
          if (jobRef) {
            if (!jobSnap.exists) {
              tx.create(jobRef, {
                requestId, lotteryId: String(x.lotteryId || ''), decision: x.status,
                state: 'pending', attempts: 0,
                nextAttemptAt: FieldValue.serverTimestamp(),
                createdAt: FieldValue.serverTimestamp()
              });
            } else if (jobSnap.data().state === 'waitingForLink') {
              tx.update(jobRef, {
                state: 'pending', nextAttemptAt: FieldValue.serverTimestamp()
              });
            }
          }
          return { linked: true };
        });
        await sendText(chatId, outcome.linked
          ? '✅ Ticket notifications connected. We will message you when your payment is approved or rejected. If it has already been reviewed, your update is on its way.'
          : '⚠️ This notification link is invalid, expired or already used.');
        return res.status(200).json({ ok: true, type: 'buyer_start', linked: outcome.linked });
      }

      if (parameter.startsWith('request_')) {
        await sendText(chatId, 'For security, older notification links are no longer accepted. Please generate a new ticket request on the website if you need to connect Telegram.');
        return res.status(200).json({ ok: true, type: 'buyer_start', linked: false, reason: 'legacy_link_disabled' });
      }

      await sendWelcome(chatId);
      return res.status(200).json({ ok: true, type: 'welcome' });
    }

    if (command === '/link' || command === '/connect') {
      if (!parameter) {
        await sendText(chatId, 'Please use the admin connection code supplied by the Tigray Lottery admin dashboard.');
        return res.status(200).json({ ok: true, type: 'admin_link', connected: false, reason: 'missing_code' });
      }
      const token = parameter.startsWith('admin_') ? parameter.slice(6) : parameter;
      const result = await connectAdmin(db, token, chatId, msg);
      await sendText(chatId, result.ok
        ? '✅ Telegram notifications are now connected to your Tigray Lottery admin account.\n\nYou can return to the admin dashboard.'
        : '⚠️ That admin connection code is invalid or expired. Generate a new code from the Lottery Admin dashboard.');
      return res.status(200).json({ ok: true, type: 'admin_link', connected: result.ok });
    }

    if (text.startsWith('admin_')) {
      const result = await connectAdmin(db, text.slice(6), chatId, msg);
      await sendText(chatId, result.ok
        ? '✅ Telegram notifications are now connected to your Tigray Lottery admin account.\n\nYou can return to the admin dashboard.'
        : '⚠️ That admin connection code is invalid or expired. Generate a new code from the Lottery Admin dashboard.');
      return res.status(200).json({ ok: true, type: 'admin_token', connected: result.ok });
    }

    if (command === '/help') {
      await sendText(chatId, 'Use the button below to open the Tigray Lottery Mini App.', {
        inline_keyboard: [[{ text: '🎟 ቲኬት ይግዙ', web_app: { url: telegramMiniAppUrl() } }]]
      });
      return res.status(200).json({ ok: true, type: 'help' });
    }

    await sendWelcome(chatId);
    return res.status(200).json({ ok: true, type: 'fallback' });
  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(500).json({ ok: false, error: error?.message || 'Webhook error' });
  }
};
