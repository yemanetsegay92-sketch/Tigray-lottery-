const { validateTelegramInitData } = require('./_lib');
module.exports = async (req,res)=>{
  if(req.method!=='POST') return res.status(405).json({ok:false,error:'Method not allowed'});
  try{
    const initData=String(req.body?.initData||'');
    const result=validateTelegramInitData(initData);
    return res.status(200).json({ok:true,user:result.user});
  }catch(e){return res.status(400).json({ok:false,error:e.message});}
};
