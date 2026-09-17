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

      if (parameter.startsWith('request_')) {
        const requestId = parameter.slice(8);
        const reqRef = db.collection('ticketRequests').doc(requestId);
        const snap = await reqRef.get();
        if (!snap.exists) {
          await sendText(chatId, 'We could not find that ticket request. Please use the latest notification link from Tigray Lottery.');
          return res.status(200).json({ ok: true, type: 'buyer_start', found: false });
        }
        await reqRef.set({
          telegramChatId: chatId,
          telegramUserId: String(msg.from?.id || ''),
          telegramUsername: String(msg.from?.username || ''),
          telegramConnectedAt: FieldValue.serverTimestamp()
        }, { merge: true });
        await sendText(chatId, '✅ Telegram notifications connected. We will notify you when your ticket request is approved or rejected.', {
          inline_keyboard: [[{ text: '🎟 ቲኬት ይግዙ', web_app: { url: telegramMiniAppUrl() } }]]
        });
        return res.status(200).json({ ok: true, type: 'buyer_start', found: true });
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
