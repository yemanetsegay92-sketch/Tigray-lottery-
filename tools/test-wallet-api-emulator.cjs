'use strict';
// Isolated API integration: real Firestore emulator, synthetic Firebase tokens and
// synthetic provider responses; no production credentials, SMS or Check.et calls.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const {createRequire}=require('node:module');
if(!process.env.FIRESTORE_EMULATOR_HOST||!/^demo-[a-z0-9-]+$/i.test(process.env.GCLOUD_PROJECT||''))
 throw Error('Requires an isolated demo-* Firestore emulator');
if(process.env.VERCEL_ENV==='production')throw Error('Production tests are prohibited');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore}=require('firebase-admin/firestore');
const app=initializeApp({projectId:process.env.GCLOUD_PROJECT},'wallet-api-synthetic-test');
const db=getFirestore(app);
after(()=>deleteApp(app));
process.env.WALLET_AUTO_DEPOSITS_ENABLED='false';
process.env.CBE_WALLET_RECEIVING_ACCOUNT='1000000000000';
process.env.CBE_WALLET_RECEIVER_NAME='Synthetic Company';
const profiles={
 buyer:{uid:'api-test-buyer',phone_number:'+251911111115'},
 other:{uid:'api-test-other',phone_number:'+251911111116'},
 noPhone:{uid:'api-test-no-phone'},
 general:{uid:'api-test-gm'},
 assigned:{uid:'api-test-assigned'},
 unrelated:{uid:'api-test-unrelated'}
};
const authApi={verifyIdToken:async token=>{
 if(!profiles[token])throw Object.assign(new Error('Invalid test token'),{statusCode:401});
 return profiles[token];
}};
let providerCalls=0;
function loadRoute(relative){
 const filename=require.resolve('../'+relative);
 const realRequire=createRequire(filename),module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{
  module,exports:module.exports,Buffer,console,process,setTimeout,clearTimeout,
  require:spec=>{
   if(spec==='firebase-admin/auth')return {getAuth:()=>authApi};
   if(spec==='../telegram/_lib')return {...realRequire(spec),adminDb:()=>db};
   if(spec==='../../lib/checket-verify')return {verifyCheckEtPayment:async ({transactionNumber})=>{
    providerCalls++;
    return {verified:true,providerDuplicate:false,bank:'cbe',reportedBank:'cbe',
      status:'completed',verificationMethod:'official',reportedTransactionNumber:transactionNumber,
      amount:100,currency:'ETB',providerCbeAccountCheck:true,receiverAccountStatus:'exact_match',
      receiverName:'Synthetic Company',transactionDate:new Date().toISOString(),
      payerName:'Synthetic Other',payerIdentityVerified:false};
   }};
   return realRequire(spec);
  }
 },{filename});
 return module.exports;
}
const customer=loadRoute('api/customer/create-request.js');
const admin=loadRoute('api/admin/approvals.js');
async function send(handler,token,body){
 let status=0,result;
 const res={setHeader(){},status(n){status=n;return this},json(x){result=x;return this}};
 await handler({method:'POST',headers:token?{authorization:'Bearer '+token}:{},body},res);
 return {status,result};
}
const customerAction=(token,action,body={})=>send(customer,token,{action,...body});
const adminAction=(token,action,body={})=>send(admin,token,{action,...body});
let depositId,firstPurchase,secondPurchase;
test('wallet status is public but contains only server-authorized capability booleans',async()=>{
 const status=await customerAction('','wallet-status');
 assert.equal(status.status,200);
 assert.deepEqual(JSON.parse(JSON.stringify(status.result)),{ok:true,capabilities:{registration:true,deposits:true,purchases:true}});
});
test('synthetic wallet API setup',async()=>{
 await Promise.all([
  db.collection('users').doc(profiles.general.uid).set({role:'generalAdmin',lotteryIds:[]}),
  db.collection('users').doc(profiles.assigned.uid).set({role:'lotteryAdmin',lotteryIds:['api-test-lottery']}),
  db.collection('users').doc(profiles.unrelated.uid).set({role:'lotteryAdmin',lotteryIds:['other-lottery']}),
  db.collection('lotteries').doc('api-test-lottery').set({
   status:'active',price:25,min:1,max:50,nextTicketNumber:1
  })
 ]);
});
test('registration requires a verified phone token, then initializes exactly one wallet',async()=>{
 const anonymous=await customerAction('', 'wallet-register',{name:'Synthetic One'});
 assert.equal(anonymous.status,401);
 const noPhone=await customerAction('noPhone','wallet-register',{name:'Synthetic One'});
 assert.equal(noPhone.status,403);
 const a=await customerAction('buyer','wallet-register',{name:'Synthetic One'});
 assert.equal(a.status,200,JSON.stringify(a.result));assert.equal(a.result.customer.balanceSantim,0);
 const again=await customerAction('buyer','wallet-register',{name:'Synthetic One'});
 assert.equal(again.status,200);assert.equal(again.result.customer.balanceSantim,0);
 const other=await customerAction('other','wallet-register',{name:'Synthetic Other'});
 assert.equal(other.status,200);
 assert.equal((await db.collection('walletAccounts').where('uid','==',profiles.buyer.uid).get()).size,1);
});
test('100 ETB minimum, pending deposit, repeat RF idempotency and customer separation',async()=>{
 const small=await customerAction('buyer','wallet-deposit',{amountEtb:'99.99',reference:'FTAPIEMUTOOLOW01'});
 assert.equal(small.status,400);
 const accepted=await customerAction('buyer','wallet-deposit',{
  amountEtb:'100',reference:'FTAPIEMUPENDING01',legalName:'Synthetic One'
 });
 assert.equal(accepted.status,202,JSON.stringify(accepted.result));
 depositId=accepted.result.depositId;
 assert.equal(accepted.result.automaticCredit,false);
 const repeated=await customerAction('buyer','wallet-deposit',{
  amountEtb:'100',reference:'FTAPIEMUPENDING01',legalName:'Synthetic One'
 });
 assert.equal(repeated.status,202);assert.equal(repeated.result.created,false);
 const stolen=await customerAction('other','wallet-deposit',{
  amountEtb:'100',reference:'FTAPIEMUPENDING01',legalName:'Synthetic Other'
 });
 assert.equal(stolen.status,409);
 const summary=await customerAction('buyer','wallet-summary');
 assert.equal(summary.status,200);assert.equal(summary.result.balanceSantim,0);
 assert.ok(summary.result.deposits.some(x=>x.id===depositId&&x.status==='pending'));
 const otherSummary=await customerAction('other','wallet-summary');
 assert.equal(otherSummary.status,200);
 assert.ok(!otherSummary.result.deposits.some(x=>x.id===depositId));
});
test('admin HTTP routes allow GM review, deny lottery admin and require matching reviewed receiver',async()=>{
 const anon=await adminAction('','wallet-finance-summary');
 assert.equal(anon.status,401);
 const lotteryAdmin=await adminAction('assigned','wallet-finance-summary');
 assert.equal(lotteryAdmin.status,200);
 assert.equal(lotteryAdmin.result.deposits.length,0);
 const adminApproval=await adminAction('assigned','wallet-deposit-approve',{depositId});
 assert.equal(adminApproval.status,403);
 const review={depositId,reviewAttestation:'gm_independent_review',
   receivingAccount:'1000000000000',receivingOwner:'Synthetic Company',
   payerName:'Synthetic One',transactionDate:new Date().toISOString(),
   reviewNote:'Independently reviewed synthetic bank evidence against customer identity'};
 const wrong=await adminAction('general','wallet-deposit-approve',{...review,receivingAccount:'9999999999999'});
 assert.equal(wrong.status,409);
 const wrongName=await adminAction('general','wallet-deposit-approve',{...review,payerName:'Wrong Owner'});
 assert.equal(wrongName.status,409);
 const approved=await adminAction('general','wallet-deposit-approve',review);
 assert.equal(approved.status,200,JSON.stringify(approved.result));assert.equal(approved.result.credited,true);
 const repeated=await adminAction('general','wallet-deposit-approve',review);
 assert.equal(repeated.status,200);assert.equal(repeated.result.alreadyProcessed,true);
 const summary=await customerAction('buyer','wallet-summary');
 assert.equal(summary.result.balanceSantim,10000);
 assert.equal(summary.result.ledger.filter(x=>x.type==='deposit_credit').length,1);
 assert.equal((await db.collection('walletFinancialAudits').doc('deposit_'+depositId+'_credit').get()).exists,true);
});
test('HTTP wallet purchase is atomic and idempotent, rejects insufficient funds',async()=>{
 const insufficient=await customerAction('buyer','wallet-purchase',{
  lotteryId:'api-test-lottery',requestKey:'too-expensive',quantity:5
 });
 assert.equal(insufficient.status,409);
 const a=await customerAction('buyer','wallet-purchase',{
  lotteryId:'api-test-lottery',requestKey:'order-one',quantity:2
 });
 assert.equal(a.status,200,JSON.stringify(a.result));firstPurchase=a.result.requestId;
 assert.equal(a.result.ticketNumbers.length,2);assert.equal(a.result.balanceSantim,5000);
 const repeated=await customerAction('buyer','wallet-purchase',{
  lotteryId:'api-test-lottery',requestKey:'order-one',quantity:2
 });
 assert.equal(repeated.status,200);assert.equal(repeated.result.alreadyProcessed,true);
 const mismatched=await customerAction('buyer','wallet-purchase',{
  lotteryId:'api-test-lottery',requestKey:'order-one',quantity:3
 });
 assert.equal(mismatched.status,409);
 const b=await customerAction('buyer','wallet-purchase',{
  lotteryId:'api-test-lottery',requestKey:'order-two',quantity:1
 });
 assert.equal(b.status,200);secondPurchase=b.result.requestId;
 assert.equal((await customerAction('buyer','wallet-summary')).result.balanceSantim,2500);
});
test('assigned Lottery Admin sees only assigned finances and cannot record settlements',async()=>{
 const assigned=await adminAction('assigned','wallet-finance-summary');
 assert.equal(assigned.status,200);
 assert.ok(assigned.result.obligations.some(x=>x.requestId===firstPurchase));
 const unrelated=await adminAction('unrelated','wallet-finance-summary');
 assert.equal(unrelated.status,200);assert.equal(unrelated.result.obligations.length,0);
 const denied=await adminAction('assigned','wallet-settle',{obligationId:firstPurchase,amountSantim:2000});
 assert.equal(denied.status,403);
});
test('GM partial settlement is audited; refunds are denied after partial settlement',async()=>{
 const transfer={obligationId:firstPurchase,amountSantim:2000,reference:'SETTLEAPIEMUL01',
  reviewAttestation:'gm_independent_review',receivingAccount:'1000000000001',
  receivingOwner:'Synthetic Lottery Owner',transactionDate:new Date().toISOString(),
  reviewNote:'Independent synthetic transfer review for lottery owner'};
 const settle=await adminAction('general','wallet-settle',transfer);
 assert.equal(settle.status,200,JSON.stringify(settle.result));assert.equal(settle.result.remainingSantim,3000);
 const retry=await adminAction('general','wallet-settle',transfer);
 assert.equal(retry.status,200);assert.equal(retry.result.alreadyProcessed,true);
 const cannotRefund=await adminAction('general','wallet-refund',{
  requestId:firstPurchase,reason:'Attempt post-settlement cancellation'
 });
 assert.equal(cannotRefund.status,409);
 const wallet=(await customerAction('buyer','wallet-summary')).result;
 assert.equal(wallet.balanceSantim,2500);
});
test('a separate unsettled purchase is refunded once, preserving cancelled ticket records',async()=>{
 const cancelled=await adminAction('general','wallet-refund',{
  requestId:secondPurchase,reason:'Synthetic buyer cancellation'
 });
 assert.equal(cancelled.status,200,JSON.stringify(cancelled.result));
 const replay=await adminAction('general','wallet-refund',{
  requestId:secondPurchase,reason:'Synthetic buyer cancellation'
 });
 assert.equal(replay.status,200);assert.equal(replay.result.alreadyProcessed,true);
 const req=(await db.collection('ticketRequests').doc(secondPurchase).get()).data();
 assert.equal(req.status,'cancelled');
 const ticket=(await db.collection('tickets').doc('api-test-lottery_'+req.ticketNumbers[0]).get()).data();
 assert.equal(ticket.status,'cancelled');
 assert.equal((await customerAction('buyer','wallet-summary')).result.balanceSantim,5000);
});
test('mock Check.et cannot auto-credit a reference when payer ownership is missing',async()=>{
 process.env.WALLET_AUTO_DEPOSITS_ENABLED='true';
 process.env.CHECK_ET_CBE_RECEIVER_ASSURANCE='authorized';
 try{
  const first=await customerAction('other','wallet-deposit',{
   amountEtb:'100',reference:'FTAPIEMUOWNERSHIP01',legalName:'Synthetic Other'
  });
  assert.equal(first.status,202,JSON.stringify(first.result));
  assert.equal(first.result.automaticCredit,false);
  assert.ok(first.result.automaticReviewReasons.includes('payer_ownership_unverified'));
  const second=await customerAction('other','wallet-deposit',{
   amountEtb:'100',reference:'FTAPIEMUOWNERSHIP01',legalName:'Synthetic Other'
  });
  assert.equal(second.status,202);assert.equal(second.result.created,false);
  assert.equal(providerCalls,1,'Duplicate RF must not invoke Check.et twice');
  assert.equal((await db.collection('walletAccounts').doc('tigray-lottery_'+profiles.other.uid).get()).data().balanceSantim,0);
  assert.equal((await db.collection('walletDepositVerificationAttempts').doc(first.result.depositId).get()).data().state,'manual_review');
 }finally{
  process.env.WALLET_AUTO_DEPOSITS_ENABLED='false';
  delete process.env.CHECK_ET_CBE_RECEIVER_ASSURANCE;
 }
});
