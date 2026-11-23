'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
if(!process.env.FIRESTORE_EMULATOR_HOST || !/^demo-/.test(process.env.GCLOUD_PROJECT||''))
  throw Error('Run only with isolated demo Firestore emulator');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {createDepositRequest,claimAutomaticDepositVerification,finishAutomaticDepositVerification,
 creditDeposit,purchaseWithWallet,settleObligation,refundWalletPurchase,COMPANY_ID,MIN_DEPOSIT_SANTIM}=require('../lib/wallet-core');
const {paymentClaimRef}=require('../lib/payment-claims');
const app=initializeApp({projectId:process.env.GCLOUD_PROJECT});
const db=getFirestore(app);
after(()=>deleteApp(app));
const evidence=(amount,reference,uid)=>({
 bank:'cbe',completed:true,receiverVerified:true,customerOwnershipVerified:true,
 referenceVerified:true,verifiedAmountSantim:amount,currency:'ETB',reference,
 verificationMethod:'gm_manual_review',customerUid:uid,ownershipMethod:'gm_reviewed_identity',
 transactionDate:new Date().toISOString(),payerName:'Synthetic Owner',reviewedBy:'generalAdmin',
 receivingAccount:'1000000000000',receivingOwner:'Tigray Lottery',reviewNote:'Reviewed official CBE transfer and customer identity.'
});
const settlementEvidence=(amount,reference)=>({mode:'gm_manual_review',reviewedBy:'generalAdmin',
 amountSantim:amount,reference,receivingAccount:'1000000000001',receivingOwner:'Lottery Owner',
 transactionDate:new Date().toISOString(),reviewNote:'Reviewed completed owner bank transfer evidence.'});
const deposit=(id,uid,amount,ref)=>db.collection('depositRequests').doc(id).set({
 companyId:COMPANY_ID,uid,amountSantim:amount,reference:ref,status:'pending',
 legalName:'Synthetic Owner',createdAtMs:Date.now()
});
test('GM deposits: 100 ETB minimum, one permanent reference, immutable ledger and idempotent repeat',async()=>{
 const uid='wallet-d1',id='wallet-test-deposit1',ref='FTWALLETEMULATOR01';
 await deposit(id,uid,MIN_DEPOSIT_SANTIM,ref);
 await assert.rejects(creditDeposit(db,{depositId:id,evidence:evidence(MIN_DEPOSIT_SANTIM,ref,uid),actorId:'lotteryAdmin',actorRole:'lotteryAdmin'}),/Only General Manager/);
 const a=await creditDeposit(db,{depositId:id,evidence:evidence(MIN_DEPOSIT_SANTIM,ref,uid),actorId:'generalAdmin',actorRole:'generalAdmin'});
 assert.equal(a.credited,true);assert.equal(a.alreadyProcessed,false);
 assert.equal((await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim,MIN_DEPOSIT_SANTIM);
 assert.equal((await db.collection('walletLedger').doc(id+'_credit').get()).data().amountSantim,MIN_DEPOSIT_SANTIM);
 assert.equal((await db.collection('walletFinancialAudits').doc('deposit_'+id+'_credit').get()).data().verificationMethod,'gm_manual_review');
 assert.equal((await paymentClaimRef(db,ref).get()).exists,true);
 const second=await creditDeposit(db,{depositId:id,evidence:evidence(MIN_DEPOSIT_SANTIM,ref,uid),actorId:'generalAdmin',actorRole:'generalAdmin'});
 assert.equal(second.alreadyProcessed,true);
 assert.equal((await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim,MIN_DEPOSIT_SANTIM);
 await deposit('wallet-test-deposit2','wallet-d2',MIN_DEPOSIT_SANTIM,ref);
 await assert.rejects(creditDeposit(db,{depositId:'wallet-test-deposit2',evidence:evidence(MIN_DEPOSIT_SANTIM,ref,'wallet-d2'),actorId:'generalAdmin',actorRole:'generalAdmin'}),/already been used/);
 await deposit('wallet-test-small','wallet-d3',9900,'FTWALLETEMULATOR02');
 await assert.rejects(creditDeposit(db,{depositId:'wallet-test-small',evidence:evidence(9900,'FTWALLETEMULATOR02','wallet-d3'),actorId:'generalAdmin',actorRole:'generalAdmin'}),/Minimum wallet deposit/);
});
test('deposit submissions and provider attempts are rate limited and one RF can trigger only one durable attempt',async()=>{
 const uid='wallet-rate-user',auth={uid,phone_number:'+251911111112',phone_number_verified:true};
 await db.collection('customerProfiles').doc(uid).set({uid,companyId:COMPANY_ID,phone:'0911111112',phoneVerified:true,name:'Rate User'});
 const first=await createDepositRequest(db,{uid,auth,amountEtb:'100',reference:'FTRATELIMIT0001',legalName:'Rate User'});
 assert.equal(first.created,true);
 const duplicate=await createDepositRequest(db,{uid,auth,amountEtb:'100',reference:'FTRATELIMIT0001',legalName:'Rate User'});
 assert.equal(duplicate.created,false);
 assert.equal((await claimAutomaticDepositVerification(db,{depositId:first.depositId,uid})).claimed,true);
 assert.equal((await claimAutomaticDepositVerification(db,{depositId:first.depositId,uid})).claimed,false);
 await finishAutomaticDepositVerification(db,{depositId:first.depositId,state:'manual_review',reasons:['payer_ownership_unverified']});
 for(let i=2;i<=6;i++)await createDepositRequest(db,{uid,auth,amountEtb:'100',reference:'FTRATELIMIT000'+i,legalName:'Rate User'});
 await assert.rejects(createDepositRequest(db,{uid,auth,amountEtb:'100',reference:'FTRATELIMIT0007',legalName:'Rate User'}),/Too many/);
 const attempt=(await db.collection('walletDepositVerificationAttempts').doc(first.depositId).get()).data();
 assert.equal(attempt.attempts,1);assert.equal(attempt.state,'manual_review');
});
test('bank claim from direct purchase prevents wallet credit for the same RF',async()=>{
 const ref='FTDIRECTALREADY01';
 await paymentClaimRef(db,ref).set({requestId:'direct-approved',lotteryId:'lottery-other',status:'consumed'});
 await deposit('wallet-test-direct-reuse','wallet-d4',15000,ref);
 await assert.rejects(creditDeposit(db,{depositId:'wallet-test-direct-reuse',evidence:evidence(15000,ref,'wallet-d4'),actorId:'generalAdmin',actorRole:'generalAdmin'}),/already been used/);
 assert.equal((await db.collection('walletLedger').doc('wallet-test-direct-reuse_credit').get()).exists,false);
});
test('partial settlements are append-only, idempotent, and cannot exceed the obligation',async()=>{
 const id='wallet-obligation-settle';
 await db.collection('walletObligations').doc(id).set({companyId:COMPANY_ID,lotteryId:'wallet-lotto-a',requestId:id,amountSantim:10000,settledSantim:0,refundedSantim:0});
 await assert.rejects(settleObligation(db,{obligationId:id,amountSantim:4000,actorId:'lotteryAdmin',actorRole:'lotteryAdmin',reference:'SETTLE01',evidence:settlementEvidence(4000,'SETTLE01')}),/Only General Manager/);
 await assert.rejects(settleObligation(db,{obligationId:id,amountSantim:4000,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLE01',evidence:{completed:true,amountSantim:4000,referenceVerified:true}}),/securely recorded/);
 const first=await settleObligation(db,{obligationId:id,amountSantim:4000,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLE01',evidence:settlementEvidence(4000,'SETTLE01')});
 assert.equal(first.remainingSantim,6000);
 const repeat=await settleObligation(db,{obligationId:id,amountSantim:4000,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLE01',evidence:settlementEvidence(4000,'SETTLE01')});
 assert.equal(repeat.alreadyProcessed,true);
 await db.collection('walletObligations').doc('wallet-obligation-other').set({companyId:COMPANY_ID,lotteryId:'wallet-lotto-b',requestId:'wallet-obligation-other',amountSantim:4000,settledSantim:0,refundedSantim:0});
 await assert.rejects(settleObligation(db,{obligationId:'wallet-obligation-other',amountSantim:4000,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLE01',evidence:settlementEvidence(4000,'SETTLE01')}),/already been used/);
 await paymentClaimRef(db,'SETTLECLAIMED').set({requestId:'other-financial-flow',status:'consumed'});
 await assert.rejects(settleObligation(db,{obligationId:'wallet-obligation-other',amountSantim:4000,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLECLAIMED',evidence:settlementEvidence(4000,'SETTLECLAIMED')}),/already been used/);
 const second=await settleObligation(db,{obligationId:id,amountSantim:2500,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLE02',evidence:settlementEvidence(2500,'SETTLE02')});
 assert.equal(second.remainingSantim,3500);
 await assert.rejects(settleObligation(db,{obligationId:id,amountSantim:3501,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLE03',evidence:settlementEvidence(3501,'SETTLE03')}),/exceeds/);
 assert.equal((await db.collection('walletSettlements').where('obligationId','==',id).get()).size,2);
 assert.equal((await db.collection('walletFinancialAudits').doc('settlement_'+first.settlementId).get()).data().receivingOwner,'Lottery Owner');
});
test('wallet refund is atomic and idempotent and settled sales cannot be refunded',async()=>{
 const uid='wallet-refund-user',lotteryId='wallet-refund-lottery',requestKey='refundRequest';
 await db.collection('customerProfiles').doc(uid).set({uid,companyId:COMPANY_ID,phone:'0911111111',phoneVerified:true,name:'Refund User'});
 await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).set({uid,companyId:COMPANY_ID,balanceSantim:10000});
 await db.collection('lotteries').doc(lotteryId).set({status:'active',price:50,min:1,max:30,nextTicketNumber:1});
 const purchase=await purchaseWithWallet(db,{uid,lotteryId,requestKey,quantity:1});
 const refunded=await refundWalletPurchase(db,{requestId:purchase.requestId,actorId:'generalAdmin',actorRole:'generalAdmin',reason:'Customer cancellation'});
 assert.equal(refunded.refundedSantim,5000);assert.equal(refunded.balanceSantim,10000);
 assert.equal((await refundWalletPurchase(db,{requestId:purchase.requestId,actorId:'generalAdmin',actorRole:'generalAdmin',reason:'Repeat'})).alreadyProcessed,true);
 const cancelledTicket=(await db.collection('tickets').doc(lotteryId+'_1').get());
 assert.equal(cancelledTicket.exists,true);assert.equal(cancelledTicket.data().status,'cancelled');
 assert.equal((await db.collection('publicStatus').doc((await db.collection('ticketRequests').doc(purchase.requestId).get()).data().phoneHash).collection('requests').doc(purchase.requestId).get()).data().status,'cancelled');
 assert.equal((await db.collection('buyerNotificationQueue').doc(purchase.requestId+'_cancelled').get()).exists,true);
 assert.equal((await db.collection('walletFinancialAudits').doc('refund_'+purchase.requestId).get()).data().operation,'wallet_refund');
});
test('drawn lotteries and partially settled owner obligations cannot be refunded',async()=>{
 for(const suffix of ['drawn','settled']){
  const uid='wallet-refund-'+suffix,lotteryId='wallet-refund-'+suffix+'-lottery';
  await db.collection('customerProfiles').doc(uid).set({uid,companyId:COMPANY_ID,phone:suffix==='drawn'?'0911111113':'0911111114',phoneVerified:true,name:'Protected Refund'});
  await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).set({uid,companyId:COMPANY_ID,balanceSantim:10000});
  await db.collection('lotteries').doc(lotteryId).set({status:'active',price:50,min:1,max:30,nextTicketNumber:1});
  const purchase=await purchaseWithWallet(db,{uid,lotteryId,requestKey:'protectedRefund',quantity:1});
  if(suffix==='drawn')await db.collection('lotteries').doc(lotteryId).update({status:'drawn',drawnNumber:7});
  else await settleObligation(db,{obligationId:purchase.requestId,amountSantim:1000,actorId:'generalAdmin',actorRole:'generalAdmin',reference:'SETTLEPROTECT01',evidence:settlementEvidence(1000,'SETTLEPROTECT01')});
  await assert.rejects(refundWalletPurchase(db,{requestId:purchase.requestId,actorId:'generalAdmin',actorRole:'generalAdmin',reason:'Must be blocked'}),suffix==='drawn'?/Drawn or finalized/:/settled owner/);
  assert.equal((await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim,5000);
  assert.equal((await db.collection('tickets').doc(lotteryId+'_1').get()).exists,true);
  assert.equal((await db.collection('walletLedger').doc(purchase.requestId+'_refund').get()).exists,false);
 }
});
test('parallel wallet purchases across two lotteries never overspend or duplicate tickets',async()=>{
 const uid='wallet-buyer-parallel';
 await db.collection('customerProfiles').doc(uid).set({uid,companyId:COMPANY_ID,phone:'0912345678',phoneVerified:true,name:'Wallet synthetic buyer'});
 await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).set({uid,companyId:COMPANY_ID,balanceSantim:10000});
 for(const id of ['wallet-lotto-a','wallet-lotto-b'])
   await db.collection('lotteries').doc(id).set({status:'active',price:40,min:1,max:30,nextTicketNumber:1});
 const both=await Promise.allSettled([
   purchaseWithWallet(db,{uid,lotteryId:'wallet-lotto-a',requestKey:'simultaneousA',quantity:2}),
   purchaseWithWallet(db,{uid,lotteryId:'wallet-lotto-b',requestKey:'simultaneousB',quantity:2})
 ]);
 const winners=both.filter(x=>x.status==='fulfilled');
 assert.equal(winners.length,1,'Only one 80 ETB purchase should fit in 100 ETB wallet');
 assert.equal(both.filter(x=>x.status==='rejected').length,1);
 const balance=(await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim;
 assert.equal(balance,2000);
 const win=winners[0].value;
 assert.equal(win.ticketNumbers.length,2);
 const req=(await db.collection('ticketRequests').doc(win.requestId).get()).data();
 assert.equal(req.status,'approved');assert.equal(req.paymentMethod,'wallet');
 assert.equal((await db.collection('walletObligations').doc(win.requestId).get()).data().amountSantim,8000);
 assert.equal((await db.collection('walletLedger').doc(win.requestId+'_debit').get()).data().amountSantim,-8000);
 assert.equal((await db.collection('buyerNotificationQueue').doc(win.requestId+'_approved').get()).exists,true);
 const again=await purchaseWithWallet(db,{uid,lotteryId:req.lotteryId,requestKey:req.lotteryId==='wallet-lotto-a'?'simultaneousA':'simultaneousB',quantity:2});
 assert.equal(again.alreadyProcessed,true);
 assert.equal((await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim,2000);
 await assert.rejects(purchaseWithWallet(db,{uid,lotteryId:req.lotteryId,requestKey:req.lotteryId==='wallet-lotto-a'?'simultaneousA':'simultaneousB',quantity:1}),/already used/);
});
test('RF-only checkout rejects upload authorizations and accepts valid reference-only request',async()=>{
 const handler=require('../api/customer/create-request');
 const lotId='wallet-rf-only-example';
 await db.collection('lotteries').doc(lotId).set({status:'active',price:20,min:1,max:100,nextTicketNumber:1,paymentEvidenceMode:'reference_only'});
 const send=async body=>{
  let status=0,data;const res={setHeader(){},status(v){status=v;return this},json(v){data=v;return this}};
  await handler({method:'POST',headers:{},body:{lotteryId:lotId,...body}},res);
  return {status,data};
 };
 const upload=await send({action:'authorize-receipt-upload',mime:'image/jpeg',bytes:500});
 assert.equal(upload.status,400);assert.match(upload.data.error,/references only/);
 const order=await send({name:'Test Buyer',phone:'0912345678',reference:'FTRFONLYEMU1234',quantity:1});
 assert.equal(order.status,200);
 assert.equal((await db.collection('ticketRequests').doc(order.data.requestId).get()).data().status,'pending');
});
