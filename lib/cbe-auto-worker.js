'use strict';

const crypto=require('node:crypto');
const {getStorage}=require('firebase-admin/storage');
const {paymentClaimRef,claimSnapshotStatus,normalizePaymentReference}=require('./payment-claims');
const {cbeAccounts,evaluateAutoPayment}=require('./cbe-auto-eligibility');
const {verifyCheckEtPayment}=require('./checket-verify');
const {readFinalReceipt}=require('./checket-private-receipt');

function enabledFor(lotteryId, env=process.env) {
  const permitted=String(env.LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS||'')
    .split(',').map(x=>x.trim()).filter(Boolean);
  return env.VERCEL_ENV==='production' &&
    env.LOTTERY_CBE_AUTO_APPROVAL_ENABLED==='true' &&
    env.LOTTERY_CBE_PAYMENT_CLAIMS_BACKFILLED==='true' &&
    permitted.includes(String(lotteryId)) && Boolean(env.CHECK_ET_API_KEY);
}
function checkWorkerSecret(req, env=process.env) {
  const expected=String(env.LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET||'');
  const supplied=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  if(expected.length<32 || supplied.length!==expected.length)return false;
  return crypto.timingSafeEqual(Buffer.from(expected),Buffer.from(supplied));
}
function ts(value) {
  if(value&&typeof value.toMillis==='function')return value.toMillis();
  if(value&&typeof value.seconds==='number')return value.seconds*1000;
  return NaN;
}
async function leaseQueueItem(db,entry,now=Date.now()) {
  const qRef=db.collection('autoPaymentQueue').doc(entry.id);
  return db.runTransaction(async tx=>{
    const snap=await tx.get(qRef);
    if(!snap.exists)return false;
    const v=snap.data()||{};
    const state=String(v.state||'');
    const leaseUntil=ts(v.leaseUntil), retryAt=ts(v.nextAttemptAt);
    if(v.attempts>=3 || !['pending','processing'].includes(state) ||
      (state==='processing' && (!Number.isFinite(leaseUntil)||leaseUntil>now)) ||
      (Number.isFinite(retryAt)&&retryAt>now))return false;
    tx.update(qRef,{
      state:'processing',leaseUntil:new Date(now+90000),
      attempts:Number(v.attempts||0)+1,updatedAt:new Date(now)
    });
    return true;
  });
}
async function complete(db,requestId,state,reason='',nextMs=0) {
  const ref=db.collection('autoPaymentQueue').doc(requestId);
  await ref.update({
    state, reasonCode:reason||null,updatedAt:new Date(),
    leaseUntil:null,
    nextAttemptAt:nextMs?new Date(nextMs):null
  });
}
async function inspectRequest(db,requestId, deps={}) {
  const snap=await db.collection('ticketRequests').doc(requestId).get();
  if(!snap.exists)return {decision:'manual_review',reasons:['request_missing']};
  const purchase=snap.data()||{};
  const lotto=await db.collection('lotteries').doc(String(purchase.lotteryId||'')).get();
  if(!lotto.exists)return {decision:'manual_review',reasons:['lottery_missing']};
  const lottery=lotto.data()||{};
  if(!enabledFor(purchase.lotteryId,deps.env||process.env)){
    return {decision:'disabled',reasons:['auto_approval_not_activated']};
  }
  const accounts=cbeAccounts(lottery);
  if(purchase.status!=='pending'||lottery.status!=='active'||accounts.length!==1||
    !String(accounts[0].holderName||'').trim()) {
    return {decision:'manual_review',reasons:['purchase_lottery_or_receiver_not_eligible']};
  }
  let verification;
  try {
    const ref=String(purchase.reference||'').trim();
    const input={bank:'cbe',accountNumber:String(accounts[0].number||'').replace(/\s/g,'')};
    if(purchase.proofPath && (!ref || !/^FT[A-Z0-9]{8,30}$/i.test(ref))){
      input.receiptFile=await (deps.readReceipt||readFinalReceipt)(purchase);
    } else if(/^FT[A-Z0-9]{8,30}$/i.test(ref)){
      input.transactionNumber=ref;
    } else {
      return {decision:'manual_review',reasons:['no_verifiable_reference_or_receipt']};
    }
    verification=await (deps.verify||verifyCheckEtPayment)(input);
  }catch(err){
    // Provider transport or rate limit failures are retried by the worker.
    if([429,502,503].includes(Number(err.statusCode)))return {decision:'retry',reasons:['provider_temporarily_unavailable']};
    return {decision:'manual_review',reasons:['receipt_or_reference_unverifiable']};
  }
  const reference=normalizePaymentReference(verification.reportedTransactionNumber);
  if(!/^FT[A-Z0-9]{8,30}$/.test(reference))return {decision:'manual_review',reasons:['no_verified_reference']};
  const ledger=paymentClaimRef(db,reference);
  const [claimSnap,exactMatches]=await Promise.all([
    ledger.get(),db.collection('ticketRequests').where('reference','==',reference).limit(21).get()
  ]);
  const other=exactMatches.docs.filter(d=>d.id!==requestId);
  const duplicate={
    claimStatus:claimSnapshotStatus(claimSnap,requestId),
    otherCount:other.length,otherApprovedCount:other.filter(d=>d.data().status==='approved').length,
    truncated:exactMatches.size===21
  };
  const assessment=evaluateAutoPayment({purchase,lottery,verification,duplicate});
  if(!assessment.eligible)return {
    decision:'manual_review',reasons:assessment.reasons,verification,
    reference,lotteryId:purchase.lotteryId
  };
  return {
    decision:'eligible',reasons:[],verification,reference,lotteryId:purchase.lotteryId,
    immutableGuard:{
      requestId,lotteryId:purchase.lotteryId,reference,
      account:String(accounts[0].number||'').replace(/\s/g,''),
      expectedAmount:Number(purchase.total),
      transactionDate:verification.transactionDate,
      verifiedAt:Date.now(),
      policy:assessment.policy,
      bankMethod:'official',
      receiveName:String(verification.receiverName||'')
    }
  };
}
async function processOne(db,requestId,{approve,env=process.env,verify,readReceipt}={}){
  const result=await inspectRequest(db,requestId,{env,verify,readReceipt});
  if(result.decision==='disabled') {
    await complete(db,requestId,'manual_review','disabled');return 'manual_review';
  }
  if(result.decision==='retry') {
    const snap=await db.collection('autoPaymentQueue').doc(requestId).get();
    const attempts=Number(snap.data()?.attempts||1);
    if(attempts>=3){await complete(db,requestId,'manual_review','verification_failed_after_retries');return 'manual_review';}
    await complete(db,requestId,'pending','retry_provider',Date.now()+Math.min(900000,60000*2**(attempts-1)));
    return 'retry';
  }
  if(result.decision!=='eligible') {
    await complete(db,requestId,'manual_review',(result.reasons||[]).slice(0,4).join(','));
    return 'manual_review';
  }
  try {
    if(typeof approve!=='function')throw new Error('approval_callback_not_configured');
    await approve(requestId,result.lotteryId,result.reference,result.immutableGuard);
    await complete(db,requestId,'approved','official_cbe');
    return 'approved';
  }catch(err){
    if(/already been reviewed/i.test(String(err.message)) ||
       /PAYMENT_REFERENCE_CLAIMED/.test(String(err.code))){
      await complete(db,requestId,'manual_review','already_handled_or_claimed');return 'manual_review';
    }
    // Never automatically retry an approval with uncertain status. On transaction
    // retries or a crash, a human can reconcile the persisted ticket and claim.
    await complete(db,requestId,'manual_review','approval_uncertain_reconcile');
    return 'manual_review';
  }
}
async function runBatch(db,{approve,env=process.env,verify,readReceipt}={}){
  if(env.VERCEL_ENV!=='production' || env.LOTTERY_CBE_AUTO_APPROVAL_ENABLED!=='true' ||
    env.LOTTERY_CBE_PAYMENT_CLAIMS_BACKFILLED!=='true') {
    return {disabled:true,processed:0};
  }
  const snap=await db.collection('autoPaymentQueue').where('state','==','pending').limit(12).get();
  const report={processed:0,approved:0,manual_review:0,retry:0};
  // Limit external verification concurrency and avoid expensive overlapping calls.
  for(const doc of snap.docs.slice(0,3)){
    if(!await leaseQueueItem(db,doc))continue;
    report.processed++;
    const result=await processOne(db,doc.id,{approve,env,verify,readReceipt});
    report[result]=(report[result]||0)+1;
  }
  return report;
}
module.exports={enabledFor,checkWorkerSecret,leaseQueueItem,inspectRequest,processOne,runBatch};
