const { telegram, telegramMiniAppUrl, botUsername } = require('./_lib');
module.exports = async (req,res)=>{
  if(req.method!=='GET') return res.status(405).send('Method not allowed');
  if(String(req.query?.key||'') !== String(process.env.TELEGRAM_SETUP_SECRET||'')) return res.status(403).send('Forbidden');
  try{
    const webhookUrl='https://tigraylottery.com/api/telegram/webhook';
    const webhookSecret=String(process.env.TELEGRAM_WEBHOOK_SECRET||'');
    const a=await telegram('setWebhook',{url:webhookUrl,drop_pending_updates:true,...(webhookSecret?{secret_token:webhookSecret}:{})});
    const info=await telegram('getWebhookInfo',{});
    await telegram('setMyCommands',{commands:[{command:'start',description:'Open Tigray Lottery'},{command:'help',description:'Help'},{command:'link',description:'Connect admin Telegram'}]});
    await telegram('setChatMenuButton',{menu_button:{type:'web_app',text:'🎟 Buy Ticket',web_app:{url:telegramMiniAppUrl()}}});
    return res.status(200).json({ok:true,bot:botUsername(),webhook:a,webhookInfo:{url:info?.url||'',pendingUpdateCount:Number(info?.pending_update_count||0),lastErrorDate:info?.last_error_date||null,lastErrorMessage:info?.last_error_message||'',maxConnections:info?.max_connections||null},miniApp:telegramMiniAppUrl()});
  }catch(e){console.error(e);return res.status(500).json({ok:false,error:e.message});}
};
