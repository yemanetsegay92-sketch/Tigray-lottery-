'use strict';
// Wallet transaction service. Production mutations remain controlled by server-side feature flags.
// The trusted caller MUST authenticate a verified phone/email customer or General Manager and verify bank evidence.
const crypto=require('node:crypto');
const {paymentClaimRef,claimSnapshotStatus,assertClaimFree,createPaymentClaim,normalizePaymentReference}=require('./payment-claims');
const {assertWalletMutationAllowed}=require('./wallet-runtime-policy');
const {FieldValue}=require('firebase-admin/firestore');
const COMPANY_ID='tigray-lottery';
const MIN_DEPOSIT_SANTIM=10000;
const MAX_SANTIM=Number.MAX_SAFE_INTEGER;
const DEPOSIT_RATE_WINDOW_MS=10*60*1000;
const DEPOSIT_SUBMISSION_LIMIT=6;
const DEPOSIT_VERIFICATION_LIMIT=3;
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
function normalizeContactPhone(value){
 const digits=String(value||'').replace(/\D/g,'');
 if(/^0[79]\d{8}$/.test(digits))return digits;
 if(/^251[79]\d{8}$/.test(digits))return '0'+digits.slice(3);
 throw problem('Enter a valid Ethiopian contact phone number beginning with 09 or 07.');
}
function verifiedCustomerIdentity(auth){
 const phone=String(auth?.phone_number||'').replace(/^\+251/,'0');
 if(/^0[79]\d{8}$/.test(phone)&&auth?.phone_number_verified!==false)
  return {type:'phone',key:phone,phone,email:''};
 const email=String(auth?.email||'').trim().toLowerCase();
 if(email&&auth?.email_verified===true)
  return {type:'email',key:email,phone:'',email};
 throw problem('A verified phone number or verified email address is required.',403);
}
function identityClaimRef(db,identity){
 const id=crypto.createHash('sha256').update('TIGRAY:WALLET:IDENTITY:v1:'+identity.type+':'+identity.key).digest('hex');
 return db.collection('walletCustomerIdentityClaims').doc(id);
}
function profileMatchesIdentity(profile,identity){
 if(identity.type==='phone')return profile.phoneVerified===true&&profile.phone===identity.phone;
 return profile.emailVerified===true&&String(profile.email||'').toLowerCase()===identity.email;
}
function purchaseId(uid,key){
 if(!validId(uid)||!validId(key))throw problem('Invalid purchase request key.');
 return crypto.createHash('sha256').update('TIGRAY:WALLET:BUY:v1:'+uid+':'+key).digest('hex').slice(0,40);
}
function verifiedEvidence(evidence,expectedAmount,deposit,{actorId,actorRole}={}){
 if(!evidence||evidence.bank!=='cbe'||evidence.completed!==true||
   evidence.receiverVerified!==true||evidence.customerOwnershipVerified!==true||
   evidence.referenceVerified!==true||evidence.verifiedAmountSantim!==expectedAmount ||
   evidence.currency!=='ETB'||!['official','gm_manual_review'].includes(evidence.verificationMethod))
   throw problem('Deposit requires trusted completed CBE and payer-ownership verification.',409);
 if(deposit){
  if(evidence.customerUid!==deposit.uid)throw problem('Verified payer does not own this customer account.',409);
  if(evidence.verificationMethod==='official'&&evidence.ownershipMethod!=='provider_verified_identity')
   throw problem('Automatic deposits require provider-bound payer ownership.',409);
  if(evidence.verificationMethod==='gm_manual_review'&&(
    actorRole!=='generalAdmin'||evidence.ownershipMethod!=='gm_reviewed_identity'||
    evidence.reviewedBy!==actorId||String(evidence.reviewNote||'').trim().length<10||
    !/^\d{8,30}$/.test(String(evidence.receivingAccount||''))||
    String(evidence.receivingOwner||'').trim().length<2))
   throw problem('Manual deposit requires securely recorded General Manager review evidence.',409);
  const paidAt=Date.parse(String(evidence.transactionDate||''));
  const submittedAt=deposit.createdAt?.toMillis?.()||Number(deposit.createdAtMs)||NaN;
  if(!Number.isFinite(paidAt)||paidAt>Date.now()+5*60000||
    (Number.isFinite(submittedAt)&&paidAt<submittedAt-7*86400000))
   throw problem('Verified CBE transaction date is missing or outside the accepted window.',409);
  if(deposit.legalName&&normalizeName(evidence.payerName)!==normalizeName(deposit.legalName))
   throw problem('Verified CBE payer name does not match the registered wallet owner.',409);
 }
}
async function registerCustomer(db,{uid,auth,name,contactPhone}){
 assertWalletMutationAllowed('registration');
 if(!validId(uid)||uid!==auth?.uid)throw problem('Customer identity mismatch.',403);
 const identity=verifiedCustomerIdentity(auth);
 const phone=identity.type==='phone'?identity.phone:normalizeContactPhone(contactPhone);
 const displayName=String(name||auth.name||'').trim();
 if(displayName.length<2||displayName.length>120)throw problem('Enter the customer legal name.');
 const customerRef=db.collection('customerProfiles').doc(uid),wRef=walletRef(db,uid),claimRef=identityClaimRef(db,identity);
 return db.runTransaction(async tx=>{
  const [customer,wallet,claim]=await Promise.all([tx.get(customerRef),tx.get(wRef),tx.get(claimRef)]);
  const now=FieldValue.serverTimestamp();
  if(claim.exists&&claim.data()?.uid!==uid)throw problem('This verified sign-in identity already belongs to another wallet.',409);
  if(customer.exists&&customer.data()?.phone!==phone)throw problem('The registered contact phone cannot be replaced.',409);
  if(customer.exists&&!profileMatchesIdentity(customer.data()||{},identity))throw problem('Wallet sign-in identity mismatch.',409);
  if(wallet.exists&&(wallet.data()?.uid!==uid||wallet.data()?.companyId!==COMPANY_ID))throw problem('Wallet identity mismatch.',409);
  if(!claim.exists)tx.create(claimRef,{uid,companyId:COMPANY_ID,identityType:identity.type,createdAt:now});
  tx.set(customerRef,{uid,companyId:COMPANY_ID,phone,phoneVerified:identity.type==='phone',
    email:identity.email,emailVerified:identity.type==='email',identityType:identity.type,name:displayName,updatedAt:now,
    ...(customer.exists?{}:{createdAt:now})},{merge:true});
  if(!wallet.exists)tx.create(wRef,{uid,companyId:COMPANY_ID,balanceSantim:0,createdAt:now,updatedAt:now});
  return {uid,companyId:COMPANY_ID,phone,email:identity.email,identityType:identity.type,
    balanceSantim:wallet.exists?checkedBalance(wallet.data()?.balanceSantim):0};
 });
}
async function createDepositRequest(db,{uid,auth,amountEtb,reference,legalName,receiver}){
 assertWalletMutationAllowed('deposit');
 if(uid!==auth?.uid)throw problem('Customer identity mismatch.',403);
 const identity=verifiedCustomerIdentity(auth),amountSantim=santimFromEtb(amountEtb);
 const receivingAccount=String(receiver?.account||'').replace(/\D/g,''),receivingOwner=String(receiver?.holderName||'').trim();
 if(!/^\d{8,30}$/.test(receivingAccount)||receivingOwner.length<2)throw problem('Wallet deposits are unavailable until the official CBE receiving account is configured.',503);
 if(amountSantim<MIN_DEPOSIT_SANTIM)throw problem('Minimum wallet deposit is 100 ETB.');
 const normalized=normalizePaymentReference(reference);
 if(!/^FT[A-Z0-9]{8,30}$/.test(normalized))throw problem('Enter a valid CBE transaction reference.');
 const requestId=crypto.createHash('sha256').update('TIGRAY:WALLET:DEPOSIT:v1:'+normalized).digest('hex').slice(0,40);
 const profileRef=db.collection('customerProfiles').doc(uid),ref=db.collection('depositRequests').doc(requestId);
 const nowMs=Date.now(),bucket=Math.floor(nowMs/DEPOSIT_RATE_WINDOW_MS);
 const rateId='submission_'+crypto.createHash('sha256').update(uid+':'+bucket).digest('hex');
 const rateRef=db.collection('walletDepositRateLimits').doc(rateId);
 return db.runTransaction(async tx=>{
  const [profile,snap,rate]=await Promise.all([tx.get(profileRef),tx.get(ref),tx.get(rateRef)]);
  if(!profile.exists||!profileMatchesIdentity(profile.data()||{},identity))throw problem('Register the verified customer first.',403);
  if(snap.exists){
   const data=snap.data()||{};
   if(data.uid!==uid||data.amountSantim!==amountSantim)throw problem('Transaction reference has already been submitted.',409);
   return {depositId:requestId,status:data.status,amountSantim,created:false};
  }
  const count=rate.exists?Number(rate.data()?.count||0):0;
  if(!Number.isInteger(count)||count<0||count>=DEPOSIT_SUBMISSION_LIMIT)
   throw problem('Too many wallet deposit submissions. Please try again later.',429);
  const now=FieldValue.serverTimestamp();
  tx.set(rateRef,{count:count+1,expiresAt:new Date((bucket+2)*DEPOSIT_RATE_WINDOW_MS),updatedAt:now},{merge:true});
  tx.create(ref,{uid,companyId:COMPANY_ID,amountSantim,reference:normalized,status:'pending',
   phoneLast4:String(profile.data()?.phone||'').slice(-4),legalName:String(legalName||profile.data()?.name||'').trim().slice(0,120),
   receivingAccount,receivingOwner,
   createdAt:now,createdAtMs:nowMs});
  return {depositId:requestId,status:'pending',amountSantim,created:true};
 });
}
async function claimAutomaticDepositVerification(db,{depositId,uid}){
 assertWalletMutationAllowed('deposit');
 if(!validId(depositId)||!validId(uid))throw problem('Invalid automatic verification request.');
 const nowMs=Date.now(),bucket=Math.floor(nowMs/DEPOSIT_RATE_WINDOW_MS);
 const attemptRef=db.collection('walletDepositVerificationAttempts').doc(depositId);
 const depositRef=db.collection('depositRequests').doc(depositId);
 const rateId='verification_'+crypto.createHash('sha256').update(uid+':'+bucket).digest('hex');
 const rateRef=db.collection('walletDepositRateLimits').doc(rateId);
 return db.runTransaction(async tx=>{
  const [deposit,attempt,rate]=await Promise.all([tx.get(depositRef),tx.get(attemptRef),tx.get(rateRef)]);
  if(!deposit.exists||deposit.data()?.uid!==uid||deposit.data()?.status!=='pending')throw problem('Deposit is not eligible for verification.',409);
  if(attempt.exists)return {claimed:false,state:String(attempt.data()?.state||'started')};
  const count=rate.exists?Number(rate.data()?.count||0):0;
  if(!Number.isInteger(count)||count<0||count>=DEPOSIT_VERIFICATION_LIMIT)
   throw problem('Automatic deposit verification rate limit reached.',429);
  const now=FieldValue.serverTimestamp();
  tx.set(rateRef,{count:count+1,expiresAt:new Date((bucket+2)*DEPOSIT_RATE_WINDOW_MS),updatedAt:now},{merge:true});
  tx.create(attemptRef,{companyId:COMPANY_ID,depositId,uid,state:'started',attempts:1,createdAt:now,updatedAt:now});
  tx.update(depositRef,{automaticVerificationState:'started',automaticVerificationAttemptId:depositId,updatedAt:now});
  return {claimed:true,state:'started'};
 });
}
async function finishAutomaticDepositVerification(db,{depositId,state,reasons=[]}){
 assertWalletMutationAllowed('deposit');
 if(!validId(depositId)||!['credited','manual_review'].includes(state))throw problem('Invalid verification result.');
 const now=FieldValue.serverTimestamp(),safeReasons=Array.isArray(reasons)?reasons.map(String).slice(0,10):[];
 const attemptRef=db.collection('walletDepositVerificationAttempts').doc(depositId);
 await db.runTransaction(async tx=>{
  const attempt=await tx.get(attemptRef);
  if(!attempt.exists)throw problem('Verification attempt was not claimed.',409);
  if(attempt.data()?.state!=='started')return;
  tx.update(attemptRef,{state,reasons:safeReasons,updatedAt:now});
  tx.update(db.collection('depositRequests').doc(depositId),{automaticVerificationState:state,automaticVerificationReasons:safeReasons,updatedAt:now});
 });
}
// Trusted server action. depositRequests/{depositId} is created by a separate verified-customer flow.
// Never derive "verifiedEvidence" from the browser; sender ownership must be provable.
async function creditDeposit(db,{depositId,evidence,actorId,actorRole}){
 assertWalletMutationAllowed('deposit');
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
  verifiedEvidence(evidence,amountSantim,deposit,{actorId,actorRole});
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
  const evidenceId='deposit_'+depositId+'_credit';
  createPaymentClaim(tx,claimRef,{requestId:depositId,lotteryId:'WALLET_DEPOSIT',createdBy:actorId,at:now,reference,bankCategory:'cbe'});
  tx.set(wRef,{uid:deposit.uid,companyId:COMPANY_ID,balanceSantim:previous+amountSantim,updatedAt:now},{merge:true});
  tx.create(db.collection('walletLedger').doc(depositId+'_credit'),{
    companyId:COMPANY_ID,uid:deposit.uid,type:'deposit_credit',amountSantim,depositId,actorId,evidenceId,createdAt:now
  });
  tx.create(db.collection('walletFinancialAudits').doc(evidenceId),{
   companyId:COMPANY_ID,operation:'deposit_credit',depositId,uid:deposit.uid,actorId,
   actorRole,reference,amountSantim,verificationMethod:evidence.verificationMethod,
   ownershipMethod:evidence.ownershipMethod,payerName:String(evidence.payerName||'').slice(0,120),
   transactionDate:String(evidence.transactionDate||''),receivingAccount:String(evidence.receivingAccount||''),
   receivingOwner:String(evidence.receivingOwner||'').slice(0,120),reviewNote:String(evidence.reviewNote||'').slice(0,300),createdAt:now
  });
  tx.update(dRef,{status:'credited',creditedAt:now,creditedBy:actorId,evidenceId});
  return {credited:true,alreadyProcessed:false,depositId,balanceSantim:previous+amountSantim};
 });
}
// Atomic purchase. This service must be invoked only after verifying Firebase Auth phone claim.
// One wallet and lottery counter are read inside the same Firestore transaction.
async function purchaseWithWallet(db,{uid,lotteryId,requestKey,quantity}){
 assertWalletMutationAllowed('purchase');
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
  if(!cSnap.exists||cSnap.data()?.companyId!==COMPANY_ID||
    (cSnap.data()?.phoneVerified!==true&&cSnap.data()?.emailVerified!==true))
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
 assertWalletMutationAllowed('settlement');
 if(actorRole!=='generalAdmin')throw problem('Only General Manager may record owner settlements.',403);
 if(!validId(obligationId)||!validId(actorId))throw problem('Invalid settlement data.');
 const amount=requireSantim(amountSantim),bankReference=normalizePaymentReference(reference);
 if(!/^[A-Z0-9_-]{5,80}$/.test(bankReference))throw problem('Settlement bank reference is required.');
 const transferDate=Date.parse(String(evidence?.transactionDate||''));
 if(!evidence||evidence.mode!=='gm_manual_review'||evidence.reviewedBy!==actorId||
   evidence.amountSantim!==amount||normalizePaymentReference(evidence.reference)!==bankReference||
   !/^\d{8,30}$/.test(String(evidence.receivingAccount||''))||
   String(evidence.receivingOwner||'').trim().length<2||String(evidence.reviewNote||'').trim().length<10||
   !Number.isFinite(transferDate)||transferDate>Date.now()+5*60000)
  throw problem('Settlement requires securely recorded completed-transfer evidence.',409);
 // A bank reference represents one transfer, so its claim must be global rather
 // than scoped to an obligation. This prevents one transfer settling two owners.
 const settlementId=crypto.createHash('sha256').update('TIGRAY:SETTLEMENT:v1:'+bankReference).digest('hex').slice(0,40);
 return db.runTransaction(async tx=>{
  const obligationRef=db.collection('walletObligations').doc(obligationId);
  const settlementRef=db.collection('walletSettlements').doc(settlementId);
  const claimRef=paymentClaimRef(db,bankReference);
  const [obligationSnap,settlementSnap,claimSnap]=await Promise.all([tx.get(obligationRef),tx.get(settlementRef),tx.get(claimRef)]);
  if(settlementSnap.exists){
   const previous=settlementSnap.data()||{};
   if(previous.obligationId!==obligationId||previous.amountSantim!==amount||previous.reference!==bankReference)
    throw problem('Settlement reference has already been used.',409);
   return {settlementId,alreadyProcessed:true,...previous};
  }
  if(!obligationSnap.exists)throw problem('Owner obligation not found.',404);
  assertClaimFree(claimSnapshotStatus(claimSnap,settlementId));
  const obligation=obligationSnap.data()||{},total=requireSantim(obligation.amountSantim);
  const settled=Number(obligation.settledSantim||0),refunded=Number(obligation.refundedSantim||0);
  if(!Number.isSafeInteger(settled)||!Number.isSafeInteger(refunded)||settled<0||refunded<0)throw problem('Invalid obligation totals.',409);
  const remaining=total-settled-refunded;
  if(amount>remaining)throw problem('Settlement exceeds the outstanding owner balance.',409);
  const now=FieldValue.serverTimestamp(),nextSettled=settled+amount;
  tx.create(settlementRef,{companyId:COMPANY_ID,obligationId,lotteryId:obligation.lotteryId,
   requestId:obligation.requestId,amountSantim:amount,reference:bankReference,actorId,
   evidenceMode:'gm_manual_review',receivingAccount:String(evidence.receivingAccount),
   receivingOwner:String(evidence.receivingOwner).trim().slice(0,120),transactionDate:String(evidence.transactionDate),
   reviewNote:String(evidence.reviewNote).trim().slice(0,300),createdAt:now});
  createPaymentClaim(tx,claimRef,{requestId:settlementId,lotteryId:obligation.lotteryId,
   createdBy:actorId,at:now,reference:bankReference,bankCategory:'owner_settlement'});
  tx.create(db.collection('walletFinancialAudits').doc('settlement_'+settlementId),{
   companyId:COMPANY_ID,operation:'owner_settlement',settlementId,obligationId,
   lotteryId:obligation.lotteryId,requestId:obligation.requestId,amountSantim:amount,
   reference:bankReference,actorId,receivingAccount:String(evidence.receivingAccount),
   receivingOwner:String(evidence.receivingOwner).trim().slice(0,120),transactionDate:String(evidence.transactionDate),
   reviewNote:String(evidence.reviewNote).trim().slice(0,300),createdAt:now
  });
  tx.update(obligationRef,{settledSantim:nextSettled,status:nextSettled+refunded===total?'settled':'partially_settled',updatedAt:now});
  return {settlementId,alreadyProcessed:false,amountSantim:amount,remainingSantim:remaining-amount};
 });
}
async function refundWalletPurchase(db,{requestId,actorId,actorRole,reason}){
 assertWalletMutationAllowed('refund');
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
  const amount=requireSantim(obligation.amountSantim),wRef=walletRef(db,request.uid);
  const lotteryRef=db.collection('lotteries').doc(request.lotteryId);
  const ticketRefs=(Array.isArray(request.ticketNumbers)?request.ticketNumbers:[])
   .map(number=>db.collection('tickets').doc(request.lotteryId+'_'+number));
  const [wallet,lottery,...tickets]=await Promise.all([tx.get(wRef),tx.get(lotteryRef),...ticketRefs.map(ref=>tx.get(ref))]);
  if(!wallet.exists)throw problem('Wallet not found.',404);
  if(!lottery.exists)throw problem('Lottery not found.',404);
  const lotteryData=lottery.data()||{};
  if(lotteryData.status==='drawn'||lotteryData.status==='finalized'||lotteryData.drawnAt||lotteryData.drawnNumber!=null)
   throw problem('Drawn or finalized lottery purchases cannot be refunded.',409);
  if(tickets.some(ticket=>!ticket.exists))throw problem('Ticket history is incomplete; refund stopped.',409);
  const balance=checkedBalance(wallet.data()?.balanceSantim),now=FieldValue.serverTimestamp();
  if(balance>MAX_SANTIM-amount)throw problem('Wallet balance exceeds the supported limit.',409);
  tx.update(wRef,{balanceSantim:balance+amount,updatedAt:now});
  tx.create(refundRef,{companyId:COMPANY_ID,uid:request.uid,type:'ticket_refund',amountSantim:amount,
   requestId,actorId,reason:String(reason).trim().slice(0,300),createdAt:now});
  tx.update(obligationRef,{refundedSantim:amount,status:'refunded',updatedAt:now});
  tx.update(requestRef,{status:'cancelled',cancelReason:String(reason).trim().slice(0,300),cancelledBy:actorId,cancelledAt:now});
  for(const ticketRef of ticketRefs)tx.update(ticketRef,{status:'cancelled',cancelledAt:now,cancelledBy:actorId,refundLedgerId:requestId+'_refund'});
  tx.create(db.collection('walletFinancialAudits').doc('refund_'+requestId),{
   companyId:COMPANY_ID,operation:'wallet_refund',requestId,lotteryId:request.lotteryId,
   uid:request.uid,amountSantim:amount,actorId,reason:String(reason).trim().slice(0,300),createdAt:now
  });
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
 normalizeContactPhone,verifiedCustomerIdentity,
 registerCustomer,createDepositRequest,claimAutomaticDepositVerification,finishAutomaticDepositVerification,
 creditDeposit,purchaseWithWallet,settleObligation,refundWalletPurchase};
