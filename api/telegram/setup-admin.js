const { adminTelegram, adminBotUsername, adminTelegramWebhookUrl } = require('./_lib');

module.exports = async (req,res)=>{
  if(req.method!=='GET') return res.status(405).send('Method not allowed');

  const provided=String(req.query?.key||'').trim();
  const expected=String(process.env.TELEGRAM_ADMIN_SETUP_SECRET||'').trim();
  if(!expected || provided!==expected) return res.status(403).send('Forbidden');

  try{
    const webhookUrl=adminTelegramWebhookUrl();
    const webhookSecret=String(process.env.TELEGRAM_ADMIN_WEBHOOK_SECRET||'').trim();

    await adminTelegram('setWebhook',{
      url:webhookUrl,
      drop_pending_updates:true,
      ...(webhookSecret?{secret_token:webhookSecret}: {})
    });

    const info=await adminTelegram('getWebhookInfo',{});
    await adminTelegram('setMyCommands',{
      commands:[
        {command:'start',description:'Connect Telegram / help'},
        {command:'link',description:'Connect your admin account'},
        {command:'help',description:'Admin Telegram help'}
      ]
    });

    return res.status(200).json({
      ok:true,
      bot:adminBotUsername(),
      webhook:true,
      webhookInfo:{
        url:info?.url||'',
        pendingUpdateCount:Number(info?.pending_update_count||0),
        lastErrorDate:info?.last_error_date||null,
        lastErrorMessage:info?.last_error_message||'',
        maxConnections:info?.max_connections||null
      }
    });
  }catch(e){
    console.error('Admin bot setup error:',e);
    return res.status(500).json({ok:false,error:e.message});
  }
};
