'use strict';
// Server-side, private durable evidence: this receipt has been validated by
// Check.et for this exact pending order and configured CBE receiving account.
// Never expose this document to clients or trust customer-supplied evidence.
const crypto=require('node:crypto');
const {timeMs}=require('./cbe-auto-cutover');
const MAX_AGE_MS=30*60*1000;
const FIELDS=['verified','bank','reportedBank','verificationMethod','status','amount','currency',
  'providerDuplicate','providerCbeAccountCheck','receiverAccountStatus',
  'maskedReceiverSuffix','receiverName','reportedTransactionNumber','transactionDate'];

function paymentFingerprint(requestId,purchase,account) {
  const canonical=JSON.stringify({
    requestId:String(requestId||''),lotteryId:String(purchase.lotteryId||''),
    reference:String(purchase.reference||'').trim().toUpperCase(),
    proofPath:String(purchase.proofPath||''),
    proofMd5:String(purchase.proofMd5||''),
    quantity:Number(purchase.quantity),total:Number(purchase.total),
    createdAt:timeMs(purchase.createdAt),
    receiverAccount:String(account||'').replace(/\s+/g,'')
  });
  return crypto.createHash('sha256').update('TIGRAY-CBE-RECEIPT-V1:'+canonical).digest('hex');
}
function verifiedSubset(verification) {
  const result={};
  for(const key of FIELDS){
    const v=verification?.[key];
    if(v!==undefined && v!==null)result[key]=v;
  }
  return result;
}
function checkSavedEvidence(doc,requestId,purchase,account,now=Date.now()){
  if(!doc)return {status:'absent'};
  const verifiedAt=timeMs(doc.verifiedAt);
  if(doc.version!==1||doc.fingerprint!==paymentFingerprint(requestId,purchase,account))
    return {status:'changed'};
  if(!Number.isFinite(verifiedAt)||verifiedAt>now+5000||now-verifiedAt>MAX_AGE_MS)
    return {status:'expired'};
  if(doc.payment?.verified!==true||doc.payment?.providerDuplicate===true||
    doc.payment?.providerCbeAccountCheck!==true) return {status:'invalid'};
  return {status:'usable',verifiedAt,payment:verifiedSubset(doc.payment),fingerprint:doc.fingerprint};
}
async function readSavedEvidence(db,requestId,purchase,account,now=Date.now()){
  const snap=await db.collection('autoPaymentQueue').doc(requestId).get();
  if(!snap.exists)return {status:'missing_queue'};
  return checkSavedEvidence(snap.data()?.verifiedEvidence,requestId,purchase,account,now);
}
async function saveVerifiedEvidence(db,requestId,purchase,account,verification,now=Date.now()){
  if(verification?.verified!==true || verification.providerDuplicate===true ||
    verification.providerCbeAccountCheck!==true)
    throw new Error('Only a fresh, official, account-verified Check.et response may be cached.');
  const fingerprint=paymentFingerprint(requestId,purchase,account);
  const queueRef=db.collection('autoPaymentQueue').doc(requestId);
  const reqRef=db.collection('ticketRequests').doc(requestId);
  const evidence={version:1,fingerprint,verifiedAt:new Date(now),payment:verifiedSubset(verification)};
  await db.runTransaction(async tx=>{
    const [queueSnap,requestSnap]=await Promise.all([tx.get(queueRef),tx.get(reqRef)]);
    if(!queueSnap.exists || !requestSnap.exists ||
      requestSnap.data()?.status!=='pending' ||
      paymentFingerprint(requestId,requestSnap.data(),account)!==fingerprint) {
      throw new Error('Purchase changed or is no longer pending. No verification evidence saved.');
    }
    const queue=queueSnap.data()||{};
    if(queue.state!=='processing')throw new Error('Payment queue was not leased for processing.');
    if(queue.verifiedEvidence){
      // Never overwrite an earlier successful verification with a newer one.
      throw new Error('Payment verification evidence already recorded. Reconcile the saved result.');
    }
    tx.update(queueRef,{verifiedEvidence:evidence,updatedAt:new Date(now)});
  });
  return {verifiedAt:now,fingerprint,payment:evidence.payment};
}
module.exports={MAX_AGE_MS,paymentFingerprint,verifiedSubset,checkSavedEvidence,readSavedEvidence,saveVerifiedEvidence};
