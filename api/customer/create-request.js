const crypto = require('crypto');
const { adminDb, validateTelegramInitData, FieldValue } = require('../telegram/_lib');

function normalizePhone(phone){
  return String(phone||'').replace(/[^0-9+]/g,'').replace(/^\+251/,'0').trim();
}
function sha256(value){ return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function readBody(req){
  if(!req.body) return {};
  if(typeof req.body==='object' && !Buffer.isBuffer(req.body)) return req.body;
  try{return JSON.parse(Buffer.isBuffer(req.body)?req.body.toString('utf8'):String(req.body));}
  catch{throw new Error('Invalid request body.');}
}
module.exports=async(req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed.'});
  try{
    const body=readBody(req);
    const lotteryId=String(body.lotteryId||'').trim();
    const name=String(body.name||'').trim();
    const phone=normalizePhone(body.phone);
    const reference=String(body.reference||'').trim();
    const quantityNumber=Number(body.quantity||1);
    if(!Number.isInteger(quantityNumber)||quantityNumber<1||quantityNumber>5) return res.status(400).json({ok:false,error:'You can request a maximum of 5 tickets per purchase.'});
    const quantity=quantityNumber;
    const screenshotData=String(body.screenshotData||'');
    const screenshotBytes=Number(body.screenshotBytes||0);
    const screenshotOriginalBytes=Number(body.screenshotOriginalBytes||0);
    const screenshotMime=String(body.screenshotMime||'');
    const telegramInitData=String(body.telegramInitData||'');
    if(!lotteryId||!name||!phone||!Number.isInteger(quantity)) return res.status(400).json({ok:false,error:'Please complete the required fields.'});
    if(!reference&&!screenshotData) return res.status(400).json({ok:false,error:'A reference number or screenshot is required.'});
    if(screenshotData.length>520000) return res.status(400).json({ok:false,error:'The screenshot is too large. Please choose a smaller image.'});
    let telegramUser=null;
    if(telegramInitData) telegramUser=validateTelegramInitData(telegramInitData).user;
    const db=adminDb();
    const lotteryRef=db.collection('lotteries').doc(lotteryId);
    const lotterySnap=await lotteryRef.get();
    if(!lotterySnap.exists) return res.status(404).json({ok:false,error:'Lottery not found.'});
    const lottery=lotterySnap.data();
    if(lottery.status!=='active') return res.status(400).json({ok:false,error:'This lottery is not currently open.'});
    const price=Number(lottery.price||0);
    if(!Number.isFinite(price)||price<=0) return res.status(400).json({ok:false,error:'Lottery price is not configured correctly.'});
    const total=price*quantity;
    const requestId=reference?sha256(`REF:${reference.toUpperCase()}`).slice(0,40):crypto.randomUUID();
    const requestRef=db.collection('ticketRequests').doc(requestId);
    const phoneHash=sha256(phone);
    const publicRef=db.collection('publicStatus').doc(phoneHash).collection('requests').doc(requestId);
    const requestData={lotteryId,lotteryName:String(lottery.name||lotteryId),name,phone,reference,quantity,price,total,status:'pending',ticketNumbers:[],phoneHash,createdAt:FieldValue.serverTimestamp()};
    if(screenshotData){requestData.screenshotData=screenshotData;requestData.screenshotBytes=screenshotBytes;requestData.screenshotOriginalBytes=screenshotOriginalBytes;requestData.screenshotMime=screenshotMime||'image/jpeg';}
    if(telegramUser){requestData.telegramChatId=String(telegramUser.id);requestData.telegramUserId=String(telegramUser.id);requestData.telegramUsername=String(telegramUser.username||'');requestData.telegramFirstName=String(telegramUser.first_name||'');}
    await db.runTransaction(async tx=>{
      const existing=await tx.get(requestRef);
      if(existing.exists) throw new Error('DUPLICATE_REFERENCE');
      tx.create(requestRef,requestData);
      tx.create(publicRef,{lotteryId,lotteryName:String(lottery.name||lotteryId),phoneLast4:phone.slice(-4),quantity,total,status:'pending',ticketNumbers:[],createdAt:FieldValue.serverTimestamp()});
    });
    return res.status(200).json({ok:true,created:true,requestId,total});
  }catch(error){
    if(error?.message==='DUPLICATE_REFERENCE') return res.status(409).json({ok:false,error:'This transaction/reference number has already been submitted.'});
    console.error('create-request error:',error);
    return res.status(500).json({ok:false,error:error?.message||'Could not submit request.'});
  }
};
