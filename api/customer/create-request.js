const crypto = require('crypto');
const { adminDb, adminBucket, validateTelegramInitData, FieldValue } = require('../telegram/_lib');

const MAX_SCREENSHOT_BYTES = 400 * 1024;

function normalizePhone(phone){
  return String(phone||'').replace(/[^0-9+]/g,'').replace(/^\+251/,'0').trim();
}

function sha256(value){
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function readBody(req){
  if(!req.body) return {};
  if(typeof req.body==='object' && !Buffer.isBuffer(req.body)) return req.body;
  try{
    return JSON.parse(Buffer.isBuffer(req.body)?req.body.toString('utf8'):String(req.body));
  }catch{
    throw new Error('Invalid request body.');
  }
}

function decodeScreenshot(dataUrl){
  const raw=String(dataUrl||'').trim();
  const match=raw.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\r\n]+)$/i);
  if(!match) throw new Error('The screenshot must be a JPEG, PNG, or WebP image.');

  const mime=match[1].toLowerCase()==='image/jpg'?'image/jpeg':match[1].toLowerCase();
  const buffer=Buffer.from(match[2].replace(/\s+/g,''),'base64');

  if(!buffer.length) throw new Error('The screenshot is empty.');
  if(buffer.length>MAX_SCREENSHOT_BYTES) {
    throw new Error('The screenshot is too large. Please choose a smaller image.');
  }

  let valid=false;
  let ext='jpg';

  if(mime==='image/jpeg'){
    valid=buffer.length>=3 && buffer[0]===0xff && buffer[1]===0xd8 && buffer[2]===0xff;
    ext='jpg';
  }else if(mime==='image/png'){
    valid=buffer.length>=8 &&
      buffer[0]===0x89 && buffer[1]===0x50 && buffer[2]===0x4e && buffer[3]===0x47 &&
      buffer[4]===0x0d && buffer[5]===0x0a && buffer[6]===0x1a && buffer[7]===0x0a;
    ext='png';
  }else if(mime==='image/webp'){
    valid=buffer.length>=12 &&
      buffer.toString('ascii',0,4)==='RIFF' &&
      buffer.toString('ascii',8,12)==='WEBP';
    ext='webp';
  }

  if(!valid) throw new Error('The screenshot file does not match its image type.');

  return { buffer, mime, ext };
}

module.exports=async(req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed.'});

  let uploadedPath='';
  let committed=false;

  try{
    const body=readBody(req);
    const lotteryId=String(body.lotteryId||'').trim();
    const name=String(body.name||'').trim();
    const phone=normalizePhone(body.phone);
    const reference=String(body.reference||'').trim();
    const quantityNumber=Number(body.quantity||1);

    if(!Number.isInteger(quantityNumber)||quantityNumber<1||quantityNumber>5) {
      return res.status(400).json({ok:false,error:'You can request a maximum of 5 tickets per purchase.'});
    }

    const quantity=quantityNumber;
    const screenshotData=String(body.screenshotData||'');
    const screenshotOriginalBytes=Number(body.screenshotOriginalBytes||0);
    const telegramInitData=String(body.telegramInitData||'');

    if(!lotteryId||!name||!phone) {
      return res.status(400).json({ok:false,error:'Please complete the required fields.'});
    }

    if(!reference&&!screenshotData) {
      return res.status(400).json({ok:false,error:'A reference number or screenshot is required.'});
    }

    const screenshot=screenshotData?decodeScreenshot(screenshotData):null;

    let telegramUser=null;
    if(telegramInitData) telegramUser=validateTelegramInitData(telegramInitData).user;

    const db=adminDb();
    const lotteryRef=db.collection('lotteries').doc(lotteryId);
    const lotterySnap=await lotteryRef.get();

    if(!lotterySnap.exists) return res.status(404).json({ok:false,error:'Lottery not found.'});

    const lottery=lotterySnap.data();
    if(lottery.status!=='active') {
      return res.status(400).json({ok:false,error:'This lottery is not currently open.'});
    }

    const price=Number(lottery.price||0);
    if(!Number.isFinite(price)||price<=0) {
      return res.status(400).json({ok:false,error:'Lottery price is not configured correctly.'});
    }

    const total=price*quantity;
    const requestId=reference?sha256(`REF:${reference.toUpperCase()}`).slice(0,40):crypto.randomUUID();
    const requestRef=db.collection('ticketRequests').doc(requestId);
    const phoneHash=sha256(phone);
    const publicRef=db.collection('publicStatus').doc(phoneHash).collection('requests').doc(requestId);

    const requestData={
      lotteryId,
      lotteryName:String(lottery.name||lotteryId),
      name,
      phone,
      reference,
      quantity,
      price,
      total,
      status:'pending',
      ticketNumbers:[],
      phoneHash,
      createdAt:FieldValue.serverTimestamp()
    };

    if(screenshot){
      const safeLotteryId=lotteryId.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,100);
      uploadedPath=`payment-screenshots/${safeLotteryId}/${requestId}-${crypto.randomUUID()}.${screenshot.ext}`;

      await adminBucket().file(uploadedPath).save(screenshot.buffer,{
        resumable:false,
        validation:'crc32c',
        metadata:{
          contentType:screenshot.mime,
          cacheControl:'private,no-store,max-age=0',
          metadata:{
            requestId,
            lotteryId
          }
        }
      });

      requestData.screenshotPath=uploadedPath;
      requestData.screenshotBytes=screenshot.buffer.length;
      requestData.screenshotOriginalBytes=Number.isFinite(screenshotOriginalBytes)&&screenshotOriginalBytes>0
        ? screenshotOriginalBytes
        : screenshot.buffer.length;
      requestData.screenshotMime=screenshot.mime;
    }

    if(telegramUser){
      requestData.telegramChatId=String(telegramUser.id);
      requestData.telegramUserId=String(telegramUser.id);
      requestData.telegramUsername=String(telegramUser.username||'');
      requestData.telegramFirstName=String(telegramUser.first_name||'');
    }

    await db.runTransaction(async tx=>{
      const existing=await tx.get(requestRef);
      if(existing.exists) throw new Error('DUPLICATE_REFERENCE');

      tx.create(requestRef,requestData);
      tx.create(publicRef,{
        lotteryId,
        lotteryName:String(lottery.name||lotteryId),
        phoneLast4:phone.slice(-4),
        quantity,
        total,
        status:'pending',
        ticketNumbers:[],
        createdAt:FieldValue.serverTimestamp()
      });
    });

    committed=true;

    return res.status(200).json({
      ok:true,
      created:true,
      requestId,
      total,
      screenshotStored:!!screenshot
    });
  }catch(error){
    if(uploadedPath&&!committed){
      try{
        await adminBucket().file(uploadedPath).delete({ignoreNotFound:true});
      }catch(cleanupError){
        console.warn('Could not remove orphaned screenshot:',cleanupError?.message||cleanupError);
      }
    }

    if(error?.message==='DUPLICATE_REFERENCE') {
      return res.status(409).json({ok:false,error:'This transaction/reference number has already been submitted.'});
    }

    console.error('create-request error:',error);
    return res.status(500).json({ok:false,error:error?.message||'Could not submit request.'});
  }
};
