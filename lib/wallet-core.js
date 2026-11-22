'use strict';
// Draft wallet transaction service. No HTTP route calls this module and no live deposits are enabled.
// The trusted caller MUST authenticate an SMS-verified customer or General Manager and verify bank evidence.
const crypto=require('node:crypto');
const {paymentClaimRef,claimSnapshotStatus,assertClaimFree,createPaymentClaim,normalizePaymentReference}=require('./payment-claims');
const {FieldValue}=require('firebase-admin/firestore');
const COMPANY_ID='tigray-lottery';
const MIN_DEPOSIT_SANTIM=10000;
const MAX_SANTIM=Number.MAX_SAFE_INTEGER;
function problem(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function validId(v){return typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);}
function santimFromEtb(value){
 const s=String(value??'').trim();
 if(!/^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/.test(s))throw problem('Invalid ETB amount.');
 const [whole,fraction='']=s.split('.');
 const num=Number(whole)*100+Number((fraction+'00').slice(0,2));
 if(!Number.isSafeInteger(num)||num<=0)throw problem('Invalid monetary amount.');
 return num;
}
function requireSantim(value){
 if(!Number.isSafeInteger(value)||value<=0||value>MAX_SANTIM)throw problem('Invalid amount in santim.');
 return value;
}
function checkedBalance(balance){
 if(!Number.isSafeInteger(balance)||balance<0)throw problem('Invalid wallet balance.',409);
 return balance;
}
function walletRef(db,uid){if(!validId(uid))throw problem('Invalid customer ID.');return db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid);}
function purchaseId(uid,key){
 if(!validId(uid)||!validId(key))throw problem('Invalid purchase request key.');
 return crypto.createHash('sha256').update('TIGRAY:WALLET:BUY:v1:'+uid+':'+key).digest('hex').slice(0,40);
}
function verifiedEvidence(evidence,expectedAmount){
 if(!evidence||evidence.bank!=='cbe'||evidence.completed!==true||
   evidence.receiverVerified!==true||evidence.customerOwnershipVerified!==true||
   evidence.referenceVerified!==true||evidence.verifiedAmountSantim!==expectedAmount ||
   evidence.currency!=='ETB')throw problem('Deposit requires trusted completed CBE and payer-ownership verification.',409);
}
// Trusted server action. depositRequests/{depositId} is created by a separate verified-customer flow.
// Never derive "verifiedEvidence" from the browser; sender ownership must be provable.
async function creditDeposit(db,{depositId,evidence,actorId}){
 if(!validId(depositId)||!validId(actorId))throw problem('Invalid deposit or approving actor.');
 return db.runTransaction(async tx=>{
  const dRef=db.collection('depositRequests').doc(depositId);
  const dSnap=await tx.get(dRef);
  if(!dSnap.exists)throw problem('Deposit not found.',404);
  const deposit=dSnap.data()||{};
  if(deposit.companyId!==COMPANY_ID||!validId(deposit.uid))throw problem('Deposit company or customer mismatch.',403);
  if(deposit.status==='credited')return {credited:true,alreadyProcessed:true,depositId};
  if(deposit.status!=='pending')throw problem('Deposit is not awaiting verification.',409);
  const amountSantim=requireSantim(deposit.amountSantim);
  if(amountSantim<MIN_DEPOSIT_SANTIM)throw problem('Minimum wallet deposit is 100 ETB.');
  verifiedEvidence(evidence,amountSantim);
  const reference=normalizePaymentReference(deposit.reference);
  if(!/^FT[A-Z0-9]{8,30}$/.test(reference)||reference!==normalizePaymentReference(evidence.reference))
    throw problem('CBE reference does not match verified evidence.',409);
  const claimRef=paymentClaimRef(db,reference);
  if(!claimRef)throw problem('Invalid bank reference.');
  const wRef=walletRef(db,deposit.uid);
  const [claimSnap,wSnap,ledgerSnap]=await Promise.all([
    tx.get(claimRef),tx.get(wRef),tx.get(db.collection('walletLedger').doc(depositId+'_credit'))
  ]);
  assertClaimFree(claimSnapshotStatus(claimSnap,depositId));
  if(ledgerSnap.exists)throw problem('Deposit ledger already exists.',409);
  const previous=wSnap.exists?checkedBalance(wSnap.data()?.balanceSantim):0;
  if(wSnap.exists&&wSnap.data()?.companyId!==COMPANY_ID)throw problem('Wrong company wallet.',403);
  if(previous+amountSantim>MAX_SANTIM)throw problem('Wallet balance limit exceeded.');
  const now=FieldValue.serverTimestamp();
  createPaymentClaim(tx,claimRef,{requestId:depositId,lotteryId:'WALLET_DEPOSIT',createdBy:actorId,at:now,reference,bankCategory:'cbe'});
  tx.set(wRef,{uid:deposit.uid,companyId:COMPANY_ID,balanceSantim:previous+amountSantim,updatedAt:now},{merge:true});
  tx.create(db.collection('walletLedger').doc(depositId+'_credit'),{
    companyId:COMPANY_ID,uid:deposit.uid,type:'deposit_credit',amountSantim,depositId,actorId,createdAt:now
  });
  tx.update(dRef,{status:'credited',creditedAt:now,creditedBy:actorId});
  return {credited:true,alreadyProcessed:false,depositId,balanceSantim:previous+amountSantim};
 });
}
// Atomic purchase. This service must be invoked only after verifying Firebase Auth phone claim.
// One wallet and lottery counter are read inside the same Firestore transaction.
async function purchaseWithWallet(db,{uid,lotteryId,requestKey,quantity}){
 if(!validId(uid)||!validId(lotteryId)||!validId(requestKey))throw problem('Invalid purchase data.');
 if(!Number.isInteger(quantity)||quantity<1||quantity>5)throw problem('Choose 1–5 tickets.');
 const id=purchaseId(uid,requestKey);
 return db.runTransaction(async tx=>{
  const customerRef=db.collection('customerProfiles').doc(uid);
  const wRef=walletRef(db,uid);
  const lottoRef=db.collection('lotteries').doc(lotteryId);
  const requestRef=db.collection('ticketRequests').doc(id);
  const [cSnap,wSnap,lSnap,rSnap]=await Promise.all([
    tx.get(customerRef),tx.get(wRef),tx.get(lottoRef),tx.get(requestRef)
  ]);
  if(rSnap.exists){
    const existing=rSnap.data()||{};
    if(existing.uid===uid&&existing.paymentMethod==='wallet'&&existing.status==='approved')
      return {requestId:id,ticketNumbers:existing.ticketNumbers,alreadyProcessed:true,balanceSantim:null};
    throw problem('Purchase reference already used.',409);
  }
  if(!cSnap.exists||cSnap.data()?.companyId!==COMPANY_ID||cSnap.data()?.phoneVerified!==true)
    throw problem('A verified customer account is required.',403);
  const customer=cSnap.data();
  if(!/^0\d{9}$/.test(String(customer.phone||'')))throw problem('Verified phone is missing.',403);
  if(!wSnap.exists||wSnap.data()?.companyId!==COMPANY_ID)throw problem('Wallet is not yet funded.',409);
  if(!lSnap.exists)throw problem('Lottery not found.',404);
  const lottery=lSnap.data()||{};
  if(lottery.status!=='active'||lottery.cleanupInProgress)throw problem('Lottery is not open.',409);
  const ticketSantim=santimFromEtb(lottery.price);
  const totalSantim=ticketSantim*quantity;
  if(!Number.isSafeInteger(totalSantim))throw problem('Invalid ticket total.');
  const balance=checkedBalance(wSnap.data()?.balanceSantim);
  if(balance<totalSantim)throw problem('Insufficient wallet balance.',409);
  const min=Number(lottery.min),max=Number(lottery.max),next=Number(lottery.nextTicketNumber);
  if(!Number.isSafeInteger(min)||!Number.isSafeInteger(max)||!Number.isSafeInteger(next)||
    min<0||max<min||next<min||next+quantity-1>max)throw problem('Not enough tickets remain.',409);
  const ticketNumbers=Array.from({length:quantity},(_,i)=>next+i);
  const now=FieldValue.serverTimestamp();
  const phone=String(customer.phone),phoneHash=crypto.createHash('sha256').update(phone).digest('hex');
  tx.update(wRef,{balanceSantim:balance-totalSantim,updatedAt:now});
  tx.update(lottoRef,{nextTicketNumber:next+quantity});
  tx.create(db.collection('walletLedger').doc(id+'_debit'),{
    companyId:COMPANY_ID,uid,type:'ticket_purchase',amountSantim:-totalSantim,lotteryId,requestId:id,createdAt:now
  });
  tx.create(db.collection('walletObligations').doc(id),{
    companyId:COMPANY_ID,lotteryId,requestId:id,amountSantim:totalSantim,
    settledSantim:0,createdAt:now
  });
  for(const number of ticketNumbers)
    tx.create(db.collection('tickets').doc(lotteryId+'_'+number),{lotteryId,number,requestId:id,assignedAt:now,assignedBy:'wallet'});
  tx.create(requestRef,{
    companyId:COMPANY_ID,uid,lotteryId,lotteryName:String(lottery.name||lotteryId),
    name:String(customer.name||''),phone,phoneHash,quantity,price:Number(lottery.price),
    total:totalSantim/100,reference:'',paymentMethod:'wallet',status:'approved',
    ticketNumbers,createdAt:now,reviewedAt:now,reviewedBy:'wallet'
  });
  tx.set(db.collection('publicStatus').doc(phoneHash).collection('requests').doc(id),{
    lotteryId,lotteryName:String(lottery.name||lotteryId),
    phoneLast4:phone.slice(-4),quantity,total:totalSantim/100,status:'approved',
    ticketNumbers,requestId:id,updatedAt:now
  });
  tx.create(db.collection('buyerNotificationQueue').doc(id+'_approved'),{
    requestId:id,lotteryId,decision:'approved',state:'pending',attempts:0,nextAttemptAt:now,createdAt:now
  });
  return {requestId:id,ticketNumbers,alreadyProcessed:false,balanceSantim:balance-totalSantim};
 });
}
module.exports={COMPANY_ID,MIN_DEPOSIT_SANTIM,santimFromEtb,requireSantim,verifiedEvidence,purchaseId,creditDeposit,purchaseWithWallet};
