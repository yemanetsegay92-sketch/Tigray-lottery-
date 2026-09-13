const { adminDb, telegram, botLink, telegramMiniAppUrl, FieldValue } = require('./_lib');

function headerValue(req, name){
  const v=req.headers?.[name] ?? req.headers?.[name.toLowerCase()] ?? '';
  return Array.isArray(v) ? String(v[0] || '') : String(v || '');
}

function getBody(req){
  if(!req.body) return {};
  if(typeof req.body === 'object') return req.body;
  if(typeof req.body === 'string'){
    try{return JSON.parse(req.body);}catch{return {};}
  }
  return {};
}

async function connectAdmin(db, token, chatId, msg){
  const ref=db.collection('telegramAdminLinks').doc(token);
  const snap=await ref.get();
  if(!snap.exists) return {ok:false,reason:'missing'};
  const link=snap.data();
  const expires=link.expiresAt?.toMillis?.() || 0;
  if(link.used || expires <= Date.now()) return {ok:false,reason:'expired'};

  await db.collection('users').doc(link.userId).set({
    telegramChatId:chatId,
    telegramUserId:String(msg.from?.id||''),
    telegramUsername:msg.from?.username||'',
    telegramFirstName:msg.from?.first_name||'',
    telegramConnectedAt:FieldValue.serverTimestamp()
  },{merge:true});

  await ref.update({
    used:true,
    usedAt:FieldValue.serverTimestamp(),
    telegramChatId:chatId,
    telegramUserId:String(msg.from?.id||'')
  });
  return {ok:true,userId:link.userId};
}

async function sendWelcome(chatId){
  await telegram('sendMessage',{
    chat_id:chatId,
    text:'🎟️ Welcome to Tigray Lottery\n\nBuy tickets and check your lottery status directly from Telegram.',
    reply_markup:{inline_keyboard:[
      [{text:'🎟 Buy / View Lotteries',web_app:{url:telegramMiniAppUrl()}}],
      [{text:'🌐 Open Website',url:'https://tigraylottery.com'}]
    ]}
  });
}

module.exports=async(req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const expected=String(process.env.TELEGRAM_WEBHOOK_SECRET||'');
    const provided=headerValue(req,'x-telegram-bot-api-secret-token');
    if(expected && provided!==expected){
      console.error('Telegram webhook secret mismatch.');
      return res.status(403).json({ok:false,error:'Webhook secret mismatch'});
    }

    const update=getBody(req);
    const msg=update?.message;
    if(!msg?.chat?.id) return res.status(200).json({ok:true,ignored:true});

    const chatId=String(msg.chat.id);
    const text=String(msg.text||'').trim();
    const db=adminDb();

    const parts=text.split(/\s+/).filter(Boolean);
    const rawCommand=String(parts[0]||'');
    const command=rawCommand.split('@')[0].toLowerCase();
    const parameter=parts[1]||'';

    if(command==='/start'){
      if(parameter.startsWith('admin_')){
        const result=await connectAdmin(db,parameter.slice(6),chatId,msg);
        await telegram('sendMessage',{
          chat_id:chatId,
          text:result.ok
            ? '✅ Telegram notifications are now connected to your Tigray Lottery admin account.\n\nYou can return to the admin dashboard.'
            : '⚠️ This admin connection link is invalid or expired. Please generate a new connection code from the Lottery Admin dashboard.'
        });
        return res.status(200).json({ok:true,type:'admin_start',connected:result.ok});
      }

      if(parameter.startsWith('request_')){
        const requestId=parameter.slice(8);
        const reqRef=db.collection('ticketRequests').doc(requestId);
        const snap=await reqRef.get();
        if(snap.exists){
          await reqRef.set({
            telegramChatId:chatId,
            telegramUserId:String(msg.from?.id||''),
            telegramUsername:msg.from?.username||'',
            telegramConnectedAt:FieldValue.serverTimestamp()
          },{merge:true});
          await telegram('sendMessage',{
            chat_id:chatId,
            text:'✅ Telegram notifications connected. We will notify you when your ticket request is approved or rejected.',
            reply_markup:{inline_keyboard:[[{text:'🎟 Open Tigray Lottery',web_app:{url:telegramMiniAppUrl()}}]]}
          });
        }else{
          await telegram('sendMessage',{chat_id:chatId,text:'We could not find that ticket request. Please use the latest notification link from Tigray Lottery.'});
        }
        return res.status(200).json({ok:true,type:'buyer_start'});
      }

      await sendWelcome(chatId);
      return res.status(200).json({ok:true,type:'welcome'});
    }

    if(command==='/link' || command==='/connect'){
      const token=parameter.startsWith('admin_') ? parameter.slice(6) : parameter;
      const result=await connectAdmin(db,token,chatId,msg);
      await telegram('sendMessage',{
        chat_id:chatId,
        text:result.ok
          ? '✅ Telegram notifications are now connected to your Tigray Lottery admin account.\n\nYou can return to the admin dashboard.'
          : '⚠️ That admin connection code is invalid or expired. Generate a new code from the Lottery Admin dashboard.'
      });
      return res.status(200).json({ok:true,type:'admin_link',connected:result.ok});
    }

    if(text.startsWith('admin_')){
      const result=await connectAdmin(db,text.slice(6),chatId,msg);
      if(result.ok){
        await telegram('sendMessage',{chat_id:chatId,text:'✅ Telegram notifications are now connected to your Tigray Lottery admin account.\n\nYou can return to the admin dashboard.'});
      }
      return res.status(200).json({ok:true,type:'admin_token',connected:result.ok});
    }

    if(command==='/help'){
      await telegram('sendMessage',{
        chat_id:chatId,
        text:'Use the button below to open the Tigray Lottery Mini App.',
        reply_markup:{inline_keyboard:[[{text:'🎟 Open Lottery',web_app:{url:telegramMiniAppUrl()}}]]}
      });
      return res.status(200).json({ok:true,type:'help'});
    }

    await sendWelcome(chatId);
    return res.status(200).json({ok:true,type:'fallback'});
  }catch(e){
    console.error('Telegram webhook error:',e);
    return res.status(500).json({ok:false,error:e.message||'Webhook error'});
  }
};
