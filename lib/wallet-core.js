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
function normalizeName(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase();}
function requireVerifiedPhone(auth){
 const phone=String(auth?.phone_number||'').replace(/^\+251/,'0');
 if(auth?.phone_number_verified===false||!/^0\d{9}$/.test(phone))throw problem('A verified Ethiopian phone number is required.',403);
 return phone;
}
function purchaseId(uid,key){
 if(!validId(uid)||!validId(key))throw problem('Invalid purchase request key.');
 return crypto.createHash('sha256').update('TIGRAY:WALLET:BUY:v1:'+uid+':'+key).digest('hex').slice(0,40);
}
function verifiedEvidence(evidence,expectedAmount,deposit){
 if(!evidence||evidence.bank!=='cbe'||evidence.completed!==true||
   evidence.receiverVerified!==true||evidence.customerOwnershipVerified!==true||
   evidence.referenceVerified!==true||evidence.verifiedAmountSantim!==expectedAmount ||
   evidence.currency!=='ETB'||evidence.verificationMethod!=='official')
   throw problem('Deposit requires trusted completed CBE and payer-ownership verification.',409);
 if(deposit){
  if(evidence.customerUid!==deposit.uid)throw problem('Verified payer does not own this customer account.',409);
  if(!['provider_verified_identity','gm_reviewed_identity'].includes(evidence.ownershipMethod))
   throw problem('Payer ownership was not established by an approved identity method.',409);
  const paidAt=Date.parse(String(evidence.transactionDate||''));
  const submittedAt=deposit.createdAt?.toMillis?.()||Number(deposit.createdAtMs)||NaN;
  if(!Number.isFinite(paidAt)||paidAt>Date.now()+5*60000||
    (Number.isFinite(submittedAt)&&paidAt<submittedAt-7*86400000))
   throw problem('Verified CBE transaction date is missing or outside the accepted window.',409);
  if(deposit.legalName&&normalizeName(evidence.payerName)!==normalizeName(deposit.legalName))
   throw problem('Verified CBE payer name does not match the registered wallet owner.',409);
 }
}
async function registerCustomer(db,{uid,auth,name}){
 if(!validId(uid)||uid!==auth?.uid)throw problem('Customer identity mismatch.',403);
 const phone=requireVerifiedPhone(auth);
 const displayName=String(name||auth.name||'').trim();
 if(displayName.length<2||displayName.length>120)throw problem('Enter the customer legal name.');
 const customerRef=db.collection('customerProfiles').doc(uid),wRef=walletRef(db,uid);
 return db.runTransaction(async tx=>{
  const [customer,wallet]=await Promise.all([tx.get(customerRef),tx.get(wRef)]);
  const now=FieldValue.serverTimestamp();
  if(customer.exists&&customer.data()?.phone!==phone)throw problem('Verified phone cannot be replaced.',409);
  if(wallet.exists&&(wallet.data()?.uid!==uid||wallet.data()?.companyId!==COMPANY_ID))throw problem('Wallet identity mismatch.',409);
  tx.set(customerRef,{uid,companyId:COMPANY_ID,phone,phoneVerified:true,name:displayName,updatedAt:now,
    ...(customer.exists?{}:{createdAt:now})},{merge:true});
  if(!wallet.exists)tx.create(wRef,{uid,companyId:COMPANY_ID,balanceSantim:0,createdAt:now,updatedAt:now});
  return {uid,companyId:COMPANY_ID,phone,balanceSantim:wallet.exists?checkedBalance(wallet.data()?.balanceSantim):0};
 });
}
async function createDepositRequest(db,{uid,auth,amountEtb,reference,legalName}){
 if(uid!==auth?.uid)throw problem('Customer identity mismatch.',403);
 const phone=requireVerifiedPhone(auth),amountSantim=santimFromEtb(amountEtb);
 if(amountSantim<MIN_DEPOSIT_SANTIM)throw problem('Minimum wallet deposit is 100 ETB.');
 const normalized=normalizePaymentReference(reference);
 if(!/^FT[A-Z0-9]{8,30}$/.test(normalized))throw problem('Enter a valid CBE transaction reference.');
 const profile=await db.collection('customerProfiles').doc(uid).get();
 if(!profile.exists||profile.data()?.phone!==phone||profile.data()?.phoneVerified!==true)throw problem('Register the verified customer first.',403);
 const requestId=crypto.createHash('sha256').update('TIGRAY:WALLET:DEPOSIT:v1:'+normalized).digest('hex').slice(0,40);
 const ref=db.collection('depositRequests').doc(requestId);
 try{await ref.create({uid,companyId:COMPANY_ID,amountSantim,reference:normalized,status:'pending',
   phoneLast4:phone.slice(-4),legalName:String(legalName||profile.data()?.name||'').trim().slice(0,120),createdAt:FieldValue.serverTimestamp()});}
 catch(error){if(error.code!==6&&error.code!=='already-exists')throw error;}
 const snap=await ref.get(),data=snap.data()||{};
 if(data.uid!==uid||data.amountSantim!==amountSantim)throw problem('Transaction reference has already been submitted.',409);
 return {depositId:requestId,status:data.status,amountSantim};
}
// Trusted server action. depositRequests/{depositId} is created by a separate verified-customer flow.
// Never derive "verifiedEvidence" from the browser; sender ownership must be provable.
async function creditDeposit(db,{depositId,evidence,actorId,actorRole}){
 if(!['generalAdmin','trustedAutoWorker'].includes(actorRole))throw problem('Only General Manager or trusted automatic verifier may credit wallets.',403);
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
  verifiedEvidence(evidence,amountSantim,deposit);
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
    if(existing.uid===uid&&existing.companyId===COMPANY_ID&&
       existing.lotteryId===lotteryId&&Number(existing.quantity)===quantity&&
       existing.paymentMethod==='wallet'&&existing.status==='approved')
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
  if(lottery.companyId&&lottery.companyId!==COMPANY_ID)throw problem('Lottery belongs to another company.',403);
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
    ticketNumbers,requestId:id,createdAt:now,updatedAt:now
  });
  tx.create(db.collection('buyerNotificationQueue').doc(id+'_approved'),{
    requestId:id,lotteryId,decision:'approved',state:'pending',attempts:0,nextAttemptAt:now,createdAt:now
  });
  return {requestId:id,ticketNumbers,alreadyProcessed:false,balanceSantim:balance-totalSantim};
 });
}
async function settleObligation(db,{obligationId,amountSantim,actorId,actorRole,reference,evidence}){
 if(actorRole!=='generalAdmin')throw problem('Only General Manager may record owner settlements.',403);
 if(!validId(obligationId)||!validId(actorId))throw problem('Invalid settlement data.');
 const amount=requireSantim(amountSantim),bankReference=normalizePaymentReference(reference);
 if(!/^[A-Z0-9_-]{5,80}$/.test(bankReference))throw problem('Settlement bank reference is required.');
 if(!evidence||evidence.completed!==true||evidence.amountSantim!==amount||evidence.referenceVerified!==true)
  throw problem('Settlement requires completed bank-transfer evidence.',409);
 // A bank reference represents one transfer, so its claim must be global rather
 // than scoped to an obligation. This prevents one transfer settling two owners.
 const settlementId=crypto.createHash('sha256').update('TIGRAY:SETTLEMENT:v1:'+bankReference).digest('hex').slice(0,40);
 return db.runTransaction(async tx=>{
  const obligationRef=db.collection('walletObligations').doc(obligationId);
  const settlementRef=db.collection('walletSettlements').doc(settlementId);
  const [obligationSnap,settlementSnap]=await Promise.all([tx.get(obligationRef),tx.get(settlementRef)]);
  if(settlementSnap.exists){
   const previous=settlementSnap.data()||{};
   if(previous.obligationId!==obligationId||previous.amountSantim!==amount||previous.reference!==bankReference)
    throw problem('Settlement reference has already been used.',409);
   return {settlementId,alreadyProcessed:true,...previous};
  }
  if(!obligationSnap.exists)throw problem('Owner obligation not found.',404);
  const obligation=obligationSnap.data()||{},total=requireSantim(obligation.amountSantim);
  const settled=Number(obligation.settledSantim||0),refunded=Number(obligation.refundedSantim||0);
  if(!Number.isSafeInteger(settled)||!Number.isSafeInteger(refunded)||settled<0||refunded<0)throw problem('Invalid obligation totals.',409);
  const remaining=total-settled-refunded;
  if(amount>remaining)throw problem('Settlement exceeds the outstanding owner balance.',409);
  const now=FieldValue.serverTimestamp(),nextSettled=settled+amount;
  tx.create(settlementRef,{companyId:COMPANY_ID,obligationId,lotteryId:obligation.lotteryId,
   requestId:obligation.requestId,amountSantim:amount,reference:bankReference,actorId,createdAt:now});
  tx.update(obligationRef,{settledSantim:nextSettled,status:nextSettled+refunded===total?'settled':'partially_settled',updatedAt:now});
  return {settlementId,alreadyProcessed:false,amountSantim:amount,remainingSantim:remaining-amount};
 });
}
async function refundWalletPurchase(db,{requestId,actorId,actorRole,reason}){
 if(actorRole!=='generalAdmin')throw problem('Only General Manager may refund wallet purchases.',403);
 if(!validId(requestId)||!validId(actorId)||String(reason||'').trim().length<3)throw problem('Refund reason is required.');
 return db.runTransaction(async tx=>{
  const requestRef=db.collection('ticketRequests').doc(requestId),obligationRef=db.collection('walletObligations').doc(requestId);
  const refundRef=db.collection('walletLedger').doc(requestId+'_refund');
  const [requestSnap,obligationSnap,refundSnap]=await Promise.all([tx.get(requestRef),tx.get(obligationRef),tx.get(refundRef)]);
  if(refundSnap.exists)return {requestId,alreadyProcessed:true};
  if(!requestSnap.exists||!obligationSnap.exists)throw problem('Wallet purchase not found.',404);
  const request=requestSnap.data()||{},obligation=obligationSnap.data()||{};
  if(request.paymentMethod!=='wallet'||request.status!=='approved')throw problem('Purchase is not refundable.',409);
  if(Number(obligation.settledSantim||0)>0)throw problem('A settled owner obligation cannot be refunded.',409);
  const amount=requireSantim(obligation.amountSantim),wRef=walletRef(db,request.uid),wallet=await tx.get(wRef);
  if(!wallet.exists)throw problem('Wallet not found.',404);
  const balance=checkedBalance(wallet.data()?.balanceSantim),now=FieldValue.serverTimestamp();
  if(balance>MAX_SANTIM-amount)throw problem('Wallet balance exceeds the supported limit.',409);
  tx.update(wRef,{balanceSantim:balance+amount,updatedAt:now});
  tx.create(refundRef,{companyId:COMPANY_ID,uid:request.uid,type:'ticket_refund',amountSantim:amount,
   requestId,actorId,reason:String(reason).trim().slice(0,300),createdAt:now});
  tx.update(obligationRef,{refundedSantim:amount,status:'refunded',updatedAt:now});
  tx.update(requestRef,{status:'cancelled',cancelReason:String(reason).trim().slice(0,300),cancelledBy:actorId,cancelledAt:now});
  for(const number of request.ticketNumbers||[])tx.delete(db.collection('tickets').doc(request.lotteryId+'_'+number));
  if(request.phoneHash)tx.set(db.collection('publicStatus').doc(request.phoneHash).collection('requests').doc(requestId),{
   status:'cancelled',cancellationReason:String(reason).trim().slice(0,300),cancelledAt:now,
   cancelledTicketNumbers:Array.isArray(request.ticketNumbers)?request.ticketNumbers:[]
  },{merge:true});
  tx.create(db.collection('buyerNotificationQueue').doc(requestId+'_cancelled'),{
   requestId,lotteryId:request.lotteryId,decision:'cancelled',state:'pending',attempts:0,
   nextAttemptAt:now,createdAt:now
  });
  return {requestId,alreadyProcessed:false,refundedSantim:amount,balanceSantim:balance+amount};
 });
}
module.exports={COMPANY_ID,MIN_DEPOSIT_SANTIM,santimFromEtb,requireSantim,verifiedEvidence,purchaseId,
 registerCustomer,createDepositRequest,creditDeposit,purchaseWithWallet,settleObligation,refundWalletPurchase};
