'use strict';

const crypto=require('node:crypto');
const {paymentClaimRef,claimSnapshotStatus,normalizePaymentReference}=require('./payment-claims');
const {cbeAccounts,evaluateAutoPayment}=require('./cbe-auto-eligibility');
const {verifyCheckEtPayment}=require('./checket-verify');
const {readFinalReceipt}=require('./checket-private-receipt');
const {cutoverMs,timeMs,isAfterCutover}=require('./cbe-auto-cutover');
const evidenceStore=require('./cbe-verification-evidence');
const {usesAutomaticApproval}=require('./lottery-approval-mode');

function productionAccountFor(lotteryId, env=process.env) {
  const raw=String(env.LOTTERY_CBE_AUTO_APPROVAL_ACCOUNT_BINDINGS||'').trim();
  if(!raw)return null;
  try{
    const bindings=JSON.parse(raw);
    if(!bindings || Array.isArray(bindings) || typeof bindings!=='object')return null;
    const account=String(bindings[String(lotteryId)]||'').replace(/\s+/g,'');
    return /^\d{8,30}$/.test(account) ? account : null;
  }catch{
    return null;
  }
}
function enabledFor(lotteryId, env=process.env) {
  const permitted=String(env.LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS||'')
    .split(',').map(x=>x.trim()).filter(Boolean);
  return env.VERCEL_ENV==='production' &&
    env.LOTTERY_CBE_AUTO_APPROVAL_ENABLED==='true' &&
    Number.isFinite(cutoverMs(env)) && Date.now()>=cutoverMs(env) &&
    permitted.includes(String(lotteryId)) && Boolean(env.CHECK_ET_API_KEY) &&
    productionAccountFor(lotteryId,env)!==null &&
    Buffer.byteLength(String(env.LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET||''))>=32;
}
function checkWorkerSecret(req, env=process.env) {
  const expected=String(env.LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET||'');
  const supplied=String(req.headers?.authorization||'').replace(/^Bearer\s+/i,'');
  const expectedBytes=Buffer.from(expected),suppliedBytes=Buffer.from(supplied);
  if(expectedBytes.length<32 || suppliedBytes.length!==expectedBytes.length)return false;
  return crypto.timingSafeEqual(expectedBytes,suppliedBytes);
}
// Firestore Timestamp and native Date must both preserve lease expiry.
function ts(value) { return timeMs(value); }
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
  if(purchase.status==='approved')return {decision:'already_approved',reasons:[]};
  // Missing mode is intentionally manual for every pre-feature lottery.
  if(!usesAutomaticApproval(lottery)){
    return {decision:'manual_review',reasons:['lottery_uses_manual_approval']};
  }
  if(!enabledFor(purchase.lotteryId,deps.env||process.env)){
    return {decision:'disabled',reasons:['auto_approval_not_activated']};
  }
  // Skip old test purchases before paying for another provider verification.
  if(!Number.isFinite(cutoverMs(deps.env||process.env)) ||
     !(timeMs(purchase.createdAt)>=cutoverMs(deps.env||process.env))) {
    return {decision:'manual_review',reasons:['purchase_before_go_live_cutover']};
  }
  const accounts=cbeAccounts(lottery);
  const productionAccount=productionAccountFor(purchase.lotteryId,deps.env||process.env);
  if(purchase.status!=='pending'||lottery.status!=='active'||accounts.length!==1||
    !String(accounts[0].holderName||'').trim() ||
    String(accounts[0]?.number||'').replace(/\s/g,'')!==productionAccount) {
    return {decision:'manual_review',reasons:['purchase_lottery_or_receiver_not_eligible']};
  }
  const store=deps.evidenceStore||evidenceStore;
  const receivingAccount=String(accounts[0].number||'').replace(/\s/g,'');
  // Resume from server-owned evidence before considering a provider call.
  // An earlier Check.et verification is never spent again on a retry.
  const saved=await store.readSavedEvidence(db,requestId,purchase,receivingAccount);
  if(saved.status!=='usable' && saved.status!=='absent'){
    return {decision:'manual_review',reasons:['verification_cache_'+saved.status]};
  }
  let verification;
  let verifiedAt;
  if(saved.status==='usable'){
    verification=saved.payment;
    verifiedAt=saved.verifiedAt;
  }else{
    // Durable marker precedes the external call. If Check.et succeeds but our
    // function crashes before persistence, the request goes to manual review
    // instead of submitting a second verification for the same transaction.
    try{
      await store.markProviderAttempt(db,requestId,purchase,receivingAccount);
    }catch(error){
      return {decision:'manual_review',reasons:['verification_attempt_cannot_be_safely_started']};
    }
    try {
      const ref=String(purchase.reference||'').trim();
      const input={bank:'cbe',accountNumber:receivingAccount};
      if(purchase.proofPath && (!ref || !/^FT[A-Z0-9]{8,30}$/i.test(ref))){
        input.receiptFile=await (deps.readReceipt||readFinalReceipt)(purchase);
      } else if(/^FT[A-Z0-9]{8,30}$/i.test(ref)){
        input.transactionNumber=ref;
      } else {
        return {decision:'manual_review',reasons:['no_verifiable_reference_or_receipt']};
      }
      verification=await (deps.verify||verifyCheckEtPayment)(input);
    }catch(err){
      // Do not blindly retry. Check.et may already have recorded verification,
      // and returning 409/503 does not prove it did not process the payment.
      return {decision:'manual_review',reasons:['provider_result_uncertain_check_dashboard']};
    }
  }
  // Historical purchases and transfers were deliberately used for test runs.
  // A fresh launch only permits BOTH the purchase and the bank transfer
  // to occur on/after the explicitly configured cutover timestamp.
  if(!isAfterCutover(purchase.createdAt,verification.transactionDate,deps.env||process.env)){
    return {decision:'manual_review',reasons:['purchase_or_bank_transfer_before_go_live_cutover']};
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
  let savedFingerprint=saved.fingerprint;
  if(saved.status==='absent'){
    try{
      const written=await store.saveVerifiedEvidence(
        db,requestId,purchase,receivingAccount,verification);
      verifiedAt=written.verifiedAt;
      savedFingerprint=written.fingerprint;
    }catch(err){
      // A provider response without a durable record is not safe to consume.
      // Do not call Check.et again; send to a human for reconciliation.
      return {decision:'manual_review',reasons:['could_not_persist_verified_payment']};
    }
  }
  return {
    decision:'eligible',reasons:[],verification,reference,lotteryId:purchase.lotteryId,
    immutableGuard:{
      requestId,lotteryId:purchase.lotteryId,reference,
      account:String(accounts[0].number||'').replace(/\s/g,''),
      expectedAmount:Number(purchase.total),
      transactionDate:verification.transactionDate,
      verifiedAt,
      fingerprint:savedFingerprint,
      policy:assessment.policy,
      cutoffMs:cutoverMs(deps.env||process.env),
      bankMethod:'official',
      receiveName:String(verification.receiverName||'')
    }
  };
}
async function processOne(db,requestId,{approve,env=process.env,verify,readReceipt}={}){
  const result=await inspectRequest(db,requestId,{env,verify,readReceipt});
  if(result.decision==='already_approved'){
    await complete(db,requestId,'approved','approved_before_queue_recovery');
    return 'approved';
  }
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
    // Approval may have committed while the response was lost. On next run
    // inspectRequest first checks purchase.status; if still pending it reuses
    // the SAVED provider evidence and retries the atomic Firestore issuance.
    // Do not call Check.et a second time.
    const snap=await db.collection('autoPaymentQueue').doc(requestId).get();
    if(Number(snap.data()?.attempts||0)<3){
      await complete(db,requestId,'pending','approval_uncertain_reuse_saved_evidence',Date.now()+30000);
      return 'retry';
    }
    await complete(db,requestId,'manual_review','approval_uncertain_reconcile');
    return 'manual_review';
  }
}
async function runBatch(db,{approve,env=process.env,verify,readReceipt}={}){
  if(env.VERCEL_ENV!=='production' || env.LOTTERY_CBE_AUTO_APPROVAL_ENABLED!=='true' ||
    !Number.isFinite(cutoverMs(env)) || Date.now()<cutoverMs(env)) {
    return {disabled:true,processed:0};
  }
  const [pending,processing]=await Promise.all([
    db.collection('autoPaymentQueue').where('state','==','pending').limit(12).get(),
    db.collection('autoPaymentQueue').where('state','==','processing').limit(6).get()
  ]);
  const report={processed:0,approved:0,manual_review:0,retry:0};
  // Resume expired leases; processOne is idempotent and approved requests cannot
  // get new tickets twice because of the request status and atomic claim ledger.
  const queued=[...processing.docs,...pending.docs];
  for(const doc of queued.slice(0,6)){
    if(report.processed>=3)break;
    if(!await leaseQueueItem(db,doc))continue;
    report.processed++;
    const result=await processOne(db,doc.id,{approve,env,verify,readReceipt});
    report[result]=(report[result]||0)+1;
  }
  return report;
}
// Used by a Firestore create event. Process ONLY this request; never scan
// or take another buyer's queued payment during an event dispatch.
async function runQueueItem(db,requestId,{approve,env=process.env,verify,readReceipt}={}){
  const report={processed:0,approved:0,manual_review:0,retry:0};
  if(!/^[a-f0-9]{40}$/.test(String(requestId||'')))return report;
  if(env.VERCEL_ENV!=='production' || env.LOTTERY_CBE_AUTO_APPROVAL_ENABLED!=='true' ||
     !Number.isFinite(cutoverMs(env)) || Date.now()<cutoverMs(env)){
    return {...report,disabled:true};
  }
  const queue=await db.collection('autoPaymentQueue').doc(requestId).get();
  if(!queue.exists || !await leaseQueueItem(db,{id:requestId}))return report;
  report.processed=1;
  const state=await processOne(db,requestId,{approve,env,verify,readReceipt});
  if(Object.prototype.hasOwnProperty.call(report,state))report[state]++;
  return report;
}
module.exports={productionAccountFor,enabledFor,checkWorkerSecret,leaseQueueItem,inspectRequest,processOne,runBatch,runQueueItem};
