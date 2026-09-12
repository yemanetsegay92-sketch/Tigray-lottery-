const crypto = require('crypto');
const { getAuth } = require('firebase-admin/auth');
const { adminDb, FieldValue, botLink } = require('./_lib');

module.exports = async (req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const authz=req.headers.authorization||'';
    if(!authz.startsWith('Bearer ')) return res.status(401).json({ok:false,error:'Missing Firebase ID token.'});
    const db=adminDb();
    const uid=(await getAuth().verifyIdToken(authz.slice(7))).uid;
    const profileSnap=await db.collection('users').doc(uid).get();
    if(!profileSnap.exists || profileSnap.data().role!=='lotteryAdmin') return res.status(403).json({ok:false,error:'Only a Lottery Admin can connect Telegram.'});
    const token=crypto.randomBytes(18).toString('base64url');
    await db.collection('telegramAdminLinks').doc(token).set({userId:uid,createdAt:FieldValue.serverTimestamp(),expiresAt:new Date(Date.now()+10*60*1000),used:false});
    return res.status(200).json({ok:true,url:botLink(`admin_${token}`)});
  }catch(e){console.error(e);return res.status(500).json({ok:false,error:e.message});}
};
