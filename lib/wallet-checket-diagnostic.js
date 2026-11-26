'use strict';

// Runs in the normal Node.js realm even when API handlers are isolated in a
// VM-based emulator test. Prevents concurrent, costly Check.et retries.
const {COMPANY_ID}=require('./wallet-core');
async function claimDiagnosticLookup(db,{depositId,actorId,nowMs=Date.now()}){
 const ref=db.collection('walletDepositChecketDiagnostics').doc(depositId);
 await db.runTransaction(async tx=>{
  const previous=await tx.get(ref);
  if(previous.exists&&nowMs-Number(previous.data()?.lastAttemptAtMs||0)<10*60*1000)
   throw Object.assign(new Error('This deposit was checked recently. Try again after 10 minutes.'),{statusCode:429});
  tx.set(ref,{companyId:COMPANY_ID,depositId,lastAttemptAtMs:nowMs,
   lastCheckedBy:actorId,attempts:Number(previous.data()?.attempts||0)+1},{merge:true});
 });
}
module.exports={claimDiagnosticLookup};
