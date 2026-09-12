const { adminDb, telegram, telegramMiniAppUrl, escapeHtml } = require('./_lib');
module.exports = async (req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const requestId=String(req.body?.requestId||'');
    if(!requestId) return res.status(400).json({ok:false,error:'requestId is required.'});
    const db=adminDb();
    const rs=await db.collection('ticketRequests').doc(requestId).get();
    if(!rs.exists) return res.status(404).json({ok:false,error:'Request not found.'});
    const x=rs.data();
    if(x.status!=='pending') return res.status(400).json({ok:false,error:'Request is no longer pending.'});
    const users=await db.collection('users').where('lotteryIds','array-contains',String(x.lotteryId)).get();
    const recipients=users.docs.filter(d=>d.data().role==='lotteryAdmin'&&d.data().telegramChatId).map(d=>d.data());
    let sent=0;
    const text=`🎟️ <b>New payment request</b>\n\n`+
      `<b>Lottery:</b> ${escapeHtml(x.lotteryName||x.lotteryId)}\n`+
      `<b>Buyer:</b> ${escapeHtml(x.name)}\n`+
      `<b>Phone:</b> ${escapeHtml(x.phone)}\n`+
      `<b>Tickets:</b> ${Number(x.quantity||1)}\n`+
      `<b>Total:</b> ${Number(x.total||0)} Birr\n`+
      `<b>Reference:</b> ${escapeHtml(x.reference||'Not provided')}\n\n`+
      `Please open the admin dashboard to verify and approve or reject this request.`;
    for(const a of recipients){
      try{
        await telegram('sendMessage',{chat_id:a.telegramChatId,text,parse_mode:'HTML',disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'🔐 Open Admin Dashboard',url:'https://tigraylottery.com/admin/login.html'}]]}});
        sent++;
      }catch(e){console.error('admin notification',a.telegramChatId,e.message)}
    }
    return res.status(200).json({ok:true,sent});
  }catch(e){console.error(e);return res.status(500).json({ok:false,error:e.message});}
};
