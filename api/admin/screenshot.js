const { adminDb, adminBucket } = require('../telegram/_lib');
const { getAuth } = require('firebase-admin/auth');

function readBearer(req){
  const h=String(req.headers?.authorization||'');
  return h.startsWith('Bearer ')?h.slice(7):'';
}

function canAccess(profile,lotteryId){
  if(profile?.role==='generalAdmin') return true;
  if(profile?.role!=='lotteryAdmin') return false;
  const ids=Array.isArray(profile.lotteryIds)?profile.lotteryIds:[];
  return ids.includes(lotteryId);
}

module.exports=async(req,res)=>{
  if(req.method!=='GET') return res.status(405).json({ok:false,error:'Method not allowed.'});

  try{
    const token=readBearer(req);
    if(!token) return res.status(401).json({ok:false,error:'Missing Firebase ID token.'});

    const db=adminDb();
    const caller=await getAuth().verifyIdToken(token);
    const profileSnap=await db.collection('users').doc(caller.uid).get();

    if(!profileSnap.exists) return res.status(403).json({ok:false,error:'Admin profile not found.'});

    const requestId=String(req.query?.requestId||'').trim();
    if(!requestId) return res.status(400).json({ok:false,error:'requestId is required.'});

    const requestSnap=await db.collection('ticketRequests').doc(requestId).get();
    if(!requestSnap.exists) return res.status(404).json({ok:false,error:'Request not found.'});

    const request=requestSnap.data()||{};
    const lotteryId=String(request.lotteryId||'');

    if(!canAccess(profileSnap.data()||{},lotteryId)) {
      return res.status(403).json({ok:false,error:'Not authorized for this lottery.'});
    }

    const path=String(request.screenshotPath||'').trim();
    if(!path) return res.status(404).json({ok:false,error:'This request has no stored screenshot.'});

    const file=adminBucket().file(path);
    const [exists]=await file.exists();
    if(!exists) return res.status(404).json({ok:false,error:'Screenshot file was not found.'});

    const [buffer]=await file.download();
    const mime=String(request.screenshotMime||'image/jpeg');

    res.setHeader('Content-Type',mime);
    res.setHeader('Content-Length',String(buffer.length));
    res.setHeader('Cache-Control','private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Disposition',`inline; filename="payment-screenshot-${requestId}.jpg"`);
    return res.status(200).send(buffer);
  }catch(error){
    console.error('admin screenshot error:',error);
    return res.status(500).json({ok:false,error:error?.message||'Could not load screenshot.'});
  }
};
