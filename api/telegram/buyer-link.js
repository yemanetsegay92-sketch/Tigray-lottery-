const { adminDb, botLink } = require('./_lib');
module.exports = async (req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const requestId=String(req.body?.requestId||'');
    if(!requestId) return res.status(400).json({ok:false,error:'requestId is required.'});
    const db=adminDb();
    const snap=await db.collection('ticketRequests').doc(requestId).get();
    if(!snap.exists) return res.status(404).json({ok:false,error:'Request not found.'});
    return res.status(200).json({ok:true,url:botLink(`request_${requestId}`)});
  }catch(e){console.error(e);return res.status(500).json({ok:false,error:e.message});}
};
