const { adminDb, adminTelegram, adminBotUsername, FieldValue } = require('./_lib');

function headerValue(req,name){
  const headers=req?.headers||{};
  const v=headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()] ?? '';
  return Array.isArray(v)?String(v[0]||''):String(v||'');
}

async function readBody(req){
  if(req?.body!==undefined && req.body!==null){
    if(typeof req.body==='object' && !Buffer.isBuffer(req.body) && !(req.body instanceof Uint8Array)) return req.body;
    if(Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8')||'{}');
    if(req.body instanceof Uint8Array) return JSON.parse(Buffer.from(req.body).toString('utf8')||'{}');
    if(typeof req.body==='string') return JSON.parse(req.body||'{}');
  }
  if(req && typeof req.on==='function'){
    const chunks=[];
    for await(const chunk of req) chunks.push(Buffer.from(chunk));
    const raw=Buffer.concat(chunks).toString('utf8');
    return raw?JSON.parse(raw):{};
  }
  return {};
}

async function connectAdmin(db,token,chatId,msg){
  const ref=db.collection('telegramAdminLinks').doc(token);
  const snap=await ref.get();
  if(!snap.exists) return {ok:false,reason:'missing'};
  const link=snap.data();
  const expires=typeof link.expiresAt?.toMillis==='function'?link.expiresAt.toMillis():0;
  if(link.used || (expires && expires<=Date.now())) return {ok:false,reason:'expired'};
  const uid=String(link.userId||'');
  if(!uid) return {ok:false,reason:'missing-user'};

  await db.collection('users').doc(uid).set({
    telegramChatId:String(chatId),
    telegramUserId:String(msg?.from?.id||''),
    telegramUsername:String(msg?.from?.username||''),
    telegramFirstName:String(msg?.from?.first_name||''),
    telegramBot:'admin',
    telegramConnectedAt:FieldValue.serverTimestamp()
  },{merge:true});

  await ref.update({
    used:true,
    usedAt:FieldValue.serverTimestamp(),
    telegramChatId:String(chatId),
    telegramUserId:String(msg?.from?.id||''),
    bot:'admin'
  });

  return {ok:true,userId:uid};
}

async function reply(chatId,text,reply_markup){
  const body={chat_id:chatId,text};
  if(reply_markup) body.reply_markup=reply_markup;
  return adminTelegram('sendMessage',body);
}

module.exports=async(req,res)=>{
  if(req.method==='GET') return res.status(200).json({ok:true,endpoint:'telegram-admin-webhook',bot:adminBotUsername()});
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});

  try{
    const expected=String(process.env.TELEGRAM_ADMIN_WEBHOOK_SECRET||'').trim();
    const provided=headerValue(req,'x-telegram-bot-api-secret-token').trim();
    if(expected && provided!==expected) return res.status(403).json({ok:false,error:'Admin webhook secret mismatch'});

    const update=await readBody(req);
    console.log('Telegram ADMIN update:',JSON.stringify({
      update_id:update?.update_id??null,
      text:update?.message?.text||null,
      chat_id:update?.message?.chat?.id||null,
      username:update?.message?.from?.username||null
    }));

    const msg=update?.message||update?.edited_message||null;
    if(!msg?.chat?.id) return res.status(200).json({ok:true,ignored:true});

    const chatId=String(msg.chat.id);
    const text=String(msg.text||'').trim();
    const parts=text.split(/\s+/).filter(Boolean);
    const raw=String(parts[0]||'');
    const command=raw.split('@')[0].toLowerCase();
    const parameter=String(parts[1]||'');
    const db=adminDb();

    if(command==='/start' || command==='/link' || command==='/connect'){
      const token = command==='/start'
        ? (parameter.startsWith('admin_')?parameter.slice(6):'')
        : (parameter.startsWith('admin_')?parameter.slice(6):parameter);

      if(!token){
        await reply(chatId,'Tigray Lottery Admin Bot\n\nUse the Connect Telegram button in your Lottery Admin dashboard, then open this bot with the connection link.');
        return res.status(200).json({ok:true,type:'admin_help'});
      }

      const result=await connectAdmin(db,token,chatId,msg);
      await reply(chatId,result.ok
        ? '✅ <b>Telegram connected successfully.</b>\n\nYou can return to the Lottery Admin dashboard. You will now receive notifications for lotteries assigned to your admin account.'
        : '⚠️ <b>This connection code is invalid or expired.</b>\n\nReturn to the Lottery Admin dashboard and generate a new connection link.',
        undefined
      );
      return res.status(200).json({ok:true,type:'admin_connect',connected:result.ok});
    }

    if(command==='/help'){
      await reply(chatId,'Use the Connect Telegram button inside the Lottery Admin dashboard to connect this Telegram account.');
      return res.status(200).json({ok:true,type:'help'});
    }

    await reply(chatId,'Please use the Connect Telegram button in the Lottery Admin dashboard.');
    return res.status(200).json({ok:true,type:'fallback'});
  }catch(e){
    console.error('Telegram ADMIN webhook error:',e);
    return res.status(500).json({ok:false,error:e.message});
  }
};
