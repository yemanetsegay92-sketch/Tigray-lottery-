'use strict';
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
if(!process.env.FIRESTORE_EMULATOR_HOST || !/^demo-/.test(process.env.GCLOUD_PROJECT||''))
  throw Error('Run only with isolated demo Firestore emulator');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const {creditDeposit,purchaseWithWallet,COMPANY_ID,MIN_DEPOSIT_SANTIM}=require('../lib/wallet-core');
const {paymentClaimRef}=require('../lib/payment-claims');
const app=initializeApp({projectId:process.env.GCLOUD_PROJECT});
const db=getFirestore(app);
after(()=>deleteApp(app));
const evidence=(amount,reference)=>({
 bank:'cbe',completed:true,receiverVerified:true,customerOwnershipVerified:true,
 referenceVerified:true,verifiedAmountSantim:amount,currency:'ETB',reference
});
const deposit=(id,uid,amount,ref)=>db.collection('depositRequests').doc(id).set({
 companyId:COMPANY_ID,uid,amountSantim:amount,reference:ref,status:'pending'
});
test('GM deposits: 100 ETB minimum, one permanent reference, immutable ledger and idempotent repeat',async()=>{
 const uid='wallet-d1',id='wallet-test-deposit1',ref='FTWALLETEMULATOR01';
 await deposit(id,uid,MIN_DEPOSIT_SANTIM,ref);
 await assert.rejects(creditDeposit(db,{depositId:id,evidence:evidence(MIN_DEPOSIT_SANTIM,ref),actorId:'lotteryAdmin',actorRole:'lotteryAdmin'}),/Only General Manager/);
 const a=await creditDeposit(db,{depositId:id,evidence:evidence(MIN_DEPOSIT_SANTIM,ref),actorId:'generalAdmin',actorRole:'generalAdmin'});
 assert.equal(a.credited,true);assert.equal(a.alreadyProcessed,false);
 assert.equal((await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim,MIN_DEPOSIT_SANTIM);
 assert.equal((await db.collection('walletLedger').doc(id+'_credit').get()).data().amountSantim,MIN_DEPOSIT_SANTIM);
 assert.equal((await paymentClaimRef(db,ref).get()).exists,true);
 const second=await creditDeposit(db,{depositId:id,evidence:evidence(MIN_DEPOSIT_SANTIM,ref),actorId:'generalAdmin',actorRole:'generalAdmin'});
 assert.equal(second.alreadyProcessed,true);
 assert.equal((await db.collection('walletAccounts').doc(COMPANY_ID+'_'+uid).get()).data().balanceSantim,MIN_DEPOSIT_SANTIM);
 await deposit('wallet-test-deposit2','wallet-d2',MIN_DEPOSIT_SANTIM,ref);
 await assert.rejects(creditDeposit(db,{depositId:'wallet-test-deposit2',evidence:evidence(MIN_DEPOSIT_SANTIM,ref),actorId:'generalAdmin',actorRole:'generalAdmin'}),/already been used/);
 await deposit('wallet-test-small','wallet-d3',9900,'FTWALLETEMULATOR02');
 await assert.rejects(creditDeposit(db,{depositId:'wallet-test-small',evidence:evidence(9900,'FTWALLETEMULATOR02'),actorId:'generalAdmin',actorRole:'generalAdmin'}),/Minimum wallet deposit/);
});
test('bank claim from direct purchase prevents wallet credit for the same RF',async()=>{
 const ref='FTDIRECTALREADY01';
 await paymentClaimRef(db,ref).set({requestId:'direct-approved',lotteryId:'lottery-other',status:'consumed'});
 await deposit('wallet-test-direct-reuse','wallet-d4',15000,ref);
 await assert.rejects(creditDeposit(db,{depositId:'wallet-test-direct-reuse',evidence:evidence(15000,ref),actorId:'generalAdmin',actorRole:'generalAdmin'}),/already been used/);
 assert.equal((await db.collection('walletLedger').doc('wallet-test-direct-reuse_credit').get()).exists,false);
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
