const { adminDb, telegram, botLink, telegramMiniAppUrl, escapeHtml, FieldValue } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({error:'Method not allowed'});
  try {
    const expected=String(process.env.TELEGRAM_WEBHOOK_SECRET||'');
    if(expected && req.headers['x-telegram-bot-api-secret-token'] !== expected) return res.status(403).json({ok:false});
    const update = req.body || {};
    const msg = update.message;
    if (!msg?.chat?.id) return res.status(200).json({ok:true});

    const chatId = String(msg.chat.id);
    const text = String(msg.text || '');
    const db = adminDb();

    if (text.startsWith('/start')) {
      const tokens = text.trim().split(/\s+/);
      const command = String(tokens[0] || '').split('@')[0];
      const startParam = command === '/start' ? (tokens[1] || '') : '';

      if (startParam.startsWith('admin_')) {
        const token = startParam.slice(6);
        if (token) {
          const ref = db.collection('telegramAdminLinks').doc(token);
          const snap = await ref.get();
          if (snap.exists) {
            const link = snap.data();
            const expires = link.expiresAt?.toMillis?.() || 0;
            if (!link.used && expires > Date.now()) {
              await db.collection('users').doc(link.userId).set({
                telegramChatId: chatId,
                telegramUsername: msg.from?.username || '',
                telegramFirstName: msg.from?.first_name || '',
                telegramConnectedAt: FieldValue.serverTimestamp()
              }, {merge:true});
              await ref.update({used:true, usedAt:FieldValue.serverTimestamp()});
              await telegram('sendMessage', {chat_id:chatId, text:'✅ Telegram notifications are now connected to your Tigray Lottery admin account.'});
              return res.status(200).json({ok:true});
            }
          }
        }
        await telegram('sendMessage', {chat_id:chatId, text:'This admin connection link is invalid or expired. Please generate a new link from the Lottery Admin dashboard.'});
        return res.status(200).json({ok:true});
      }

      if (startParam.startsWith('request_')) {
        const requestId = startParam.slice(8);
        const reqRef = db.collection('ticketRequests').doc(requestId);
        const snap = await reqRef.get();
        if (snap.exists) {
          await reqRef.set({
            telegramChatId: chatId,
            telegramUserId: String(msg.from?.id || ''),
            telegramUsername: msg.from?.username || '',
            telegramConnectedAt: FieldValue.serverTimestamp()
          }, {merge:true});
          await telegram('sendMessage', {
            chat_id:chatId,
            text:'✅ Telegram notifications connected. We will notify you when your ticket request is approved or rejected.',
            reply_markup:{inline_keyboard:[[{text:'🎟 Open Tigray Lottery', web_app:{url:telegramMiniAppUrl()}}]]}
          });
          return res.status(200).json({ok:true});
        }
        await telegram('sendMessage', {chat_id:chatId, text:'We could not find that ticket request. Please use the latest notification link from Tigray Lottery.'});
        return res.status(200).json({ok:true});
      }

      await telegram('sendMessage', {
        chat_id:chatId,
        text:'🎟️ Welcome to Tigray Lottery\n\nBuy tickets and check your lottery status directly from Telegram.',
        reply_markup:{inline_keyboard:[
          [{text:'🎟 Buy / View Lotteries', web_app:{url:telegramMiniAppUrl()}}],
          [{text:'🌐 Open Website', url:'https://tigraylottery.com'}]
        ]}
      });
      return res.status(200).json({ok:true});
    }

    if (text === '/help') {
      await telegram('sendMessage', {chat_id:chatId,text:'Use the button below to open the Tigray Lottery Mini App.' + `\n\n${botLink()}`});
      return res.status(200).json({ok:true});
    }

    return res.status(200).json({ok:true});
  } catch (e) {
    console.error(e);
    return res.status(200).json({ok:true});
  }
};
