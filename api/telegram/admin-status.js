const { adminDb } = require('./_lib');
const { getAuth } = require('firebase-admin/auth');

module.exports = async (req,res)=>{
  if(req.method!=='GET') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const authz=req.headers.authorization||'';
    if(!authz.startsWith('Bearer ')) return res.status(401).json({ok:false,error:'Missing Firebase ID token.'});
    const db=adminDb();
    const uid=(await getAuth().verifyIdToken(authz.slice(7))).uid;
    const p=await db.collection('users').doc(uid).get();
    if(!p.exists || p.data().role!=='lotteryAdmin') return res.status(403).json({ok:false,error:'Only a Lottery Admin can use this endpoint.'});
    const d=p.data();
    return res.status(200).json({ok:true,connected:!!d.telegramChatId,username:d.telegramUsername||'',firstName:d.telegramFirstName||''});
  }catch(e){
    console.error(e);
    return res.status(500).json({ok:false,error:e.message});
  }
};
