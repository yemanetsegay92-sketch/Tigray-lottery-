const { adminDb, telegram, telegramMiniAppUrl, escapeHtml } = require('./_lib');
const { getAuth } = require('firebase-admin/auth');
module.exports = async (req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const authz=req.headers.authorization||'';
    if(!authz.startsWith('Bearer ')) return res.status(401).json({ok:false,error:'Missing Firebase ID token.'});
    const db=adminDb();
    await getAuth().verifyIdToken(authz.slice(7));
    const requestId=String(req.body?.requestId||'');
    if(!requestId) return res.status(400).json({ok:false,error:'requestId is required.'});
    const rs=await db.collection('ticketRequests').doc(requestId).get();
    if(!rs.exists) return res.status(404).json({ok:false,error:'Request not found.'});
    const x=rs.data();
    if(x.status!=='approved' && x.status!=='rejected') return res.status(400).json({ok:false,error:'Request is not finalized.'});
    if(!x.telegramChatId) return res.status(200).json({ok:true,sent:false,reason:'Buyer has not connected Telegram.'});
    const lines=[];
    if(x.status==='approved'){
      lines.push('🎉 <b>Your ticket request is approved!</b>');
      lines.push('');
      lines.push(`<b>Lottery:</b> ${escapeHtml(x.lotteryName||x.lotteryId)}`);
      lines.push(`<b>Tickets:</b> ${Number(x.quantity||1)}`);
      lines.push(`<b>Ticket numbers:</b> <b>${escapeHtml((x.ticketNumbers||[]).join(', '))}</b>`);
      lines.push('');
      lines.push('Thank you for participating.');
    }else{
      lines.push('❌ <b>Your ticket request was rejected.</b>');
      lines.push('');
      lines.push(`<b>Lottery:</b> ${escapeHtml(x.lotteryName||x.lotteryId)}`);
      lines.push(`<b>Reason:</b> ${escapeHtml(x.rejectionReason||'Payment could not be verified.')}`);
      lines.push('');
      lines.push('Please contact the lottery administrator if you need assistance.');
    }
    await telegram('sendMessage',{chat_id:x.telegramChatId,text:lines.join('\n'),parse_mode:'HTML',disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'🔎 Check Ticket Status',web_app:{url:telegramMiniAppUrl()}}]]}});
    return res.status(200).json({ok:true,sent:true});
  }catch(e){console.error(e);return res.status(500).json({ok:false,error:e.message});}
};
