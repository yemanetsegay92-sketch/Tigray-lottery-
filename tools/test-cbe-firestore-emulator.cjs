'use strict';
// Real Firestore Admin transaction tests against the local emulator only.
// No cloud credentials, payments, Check.et calls, buyers, or production writes.
const {test,after}=require('node:test');
const assert=require('node:assert/strict');
const {initializeApp,deleteApp}=require('firebase-admin/app');
const {getFirestore,Timestamp}=require('firebase-admin/firestore');
const {makePaymentClaimId}=require('../lib/payment-claims');
const {paymentFingerprint,verifiedSubset}=require('../lib/cbe-verification-evidence');
const {cutoverMs}=require('../lib/cbe-auto-cutover');

if(!process.env.FIRESTORE_EMULATOR_HOST ||
   !/^demo-/.test(String(process.env.GCLOUD_PROJECT||''))){
  throw new Error('This test MUST run only against an isolated demo- Firestore emulator.');
}
const app=initializeApp({projectId:process.env.GCLOUD_PROJECT});
const db=getFirestore(app);
after(async()=>{await deleteApp(app);});
const { _approveRequestForEmulator:approve }=require('../api/admin/approvals');
assert.equal(typeof approve,'function');
const account='1000123452968';
const holder='MAHLIET TSEGAY GIDEY';
const now=Date.now();
const lotteryBase={name:'TEST ONLY: CBE automatic approval',status:'active',price:100,
  min:1,max:1000,nextTicketNumber:1,cleanupInProgress:false,approvalMode:'automatic',
  paymentAccounts:[{bank:'CBE',number:account,holderName:holder}]};
const bankTime=new Date(now-50000).toISOString();
const orderTime=Timestamp.fromMillis(now-65000);
const cutoff=new Date(now-5*60000).toISOString();
Object.assign(process.env,{
  VERCEL_ENV:'production',LOTTERY_CBE_AUTO_APPROVAL_ENABLED:'true',
  LOTTERY_CBE_AUTO_APPROVAL_START_AT:cutoff,
  LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS:'emul-same,emul-different,emul-proof,emul-forged,emul-missing',
  LOTTERY_CBE_AUTO_APPROVAL_ACCOUNT_BINDINGS:JSON.stringify({
    'emul-same':account,'emul-different':account,'emul-proof':account,
    'emul-forged':account,'emul-missing':account
  }),
  LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET:'A'.repeat(45),
  CHECK_ET_API_KEY:'FAKE_NON_NETWORK_KEY'
});
const verified=(ref)=>({
  verified:true,bank:'cbe',reportedBank:'cbe',status:'completed',
  verificationMethod:'official',amount:100,currency:'ETB',
  providerDuplicate:false,providerCbeAccountCheck:true,
  receiverAccountStatus:'masked_unverifiable',maskedReceiverSuffix:'2968',
  receiverName:holder,reportedTransactionNumber:ref,transactionDate:bankTime
});
async function setup(lotteryId,orders) {
  await db.collection('lotteries').doc(lotteryId).set(lotteryBase);
  for(const [id,ref,overrides] of orders){
    const order={
      lotteryId,status:'pending',quantity:1,total:100,price:100,
      reference:ref,name:'Synthetic Test Customer',phone:'0911000000',
      createdAt:orderTime,...overrides
    };
    await db.collection('ticketRequests').doc(id).set(order);
    const p=verified(ref||('FTEMULATOR'+id.replace(/[^A-Z0-9]/gi,'').toUpperCase()));
    const chosenRef=ref||p.reportedTransactionNumber;
    const bank=verified(chosenRef);
    await db.collection('autoPaymentQueue').doc(id).set({
      requestId:id,lotteryId,state:'processing',attempts:1,
      verifiedEvidence:{version:1,
        fingerprint:paymentFingerprint(id,order,account),
        verifiedAt:Timestamp.fromMillis(now),
        payment:verifiedSubset(bank)}
    });
  }
}
async function run(id,lotteryId,ref,extraGuard={}){
  const snap=await db.collection('ticketRequests').doc(id).get();
  const request=snap.data();
  const queue=await db.collection('autoPaymentQueue').doc(id).get();
  const ev=queue.data().verifiedEvidence;
  const guard={
    requestId:id,lotteryId,reference:ref,account,
    expectedAmount:request.total,transactionDate:bankTime,
    verifiedAt:now,fingerprint:ev?.fingerprint||'evidence-missing',
    cutoffMs:cutoverMs(),policy:'CBE_UNATTENDED_V1',
    bankMethod:'official',receiveName:holder,...extraGuard
  };
  return approve(db,{uid:'system:checket-cbe'},{role:'generalAdmin'},
    id,lotteryId,ref,guard);
}
async function rows(coll,lotteryId){
  return (await db.collection(coll).where('lotteryId','==',lotteryId).get()).docs.map(x=>x.data());
}
test('two simultaneous approvals with one payment result in ONE ticket, ONE claim, ONE notification',async()=>{
  const lot='emul-same',ref='FTEMULATORSAME911';
  await setup(lot,[['same-a',ref],['same-b',ref]]);
  const result=await Promise.allSettled([run('same-a',lot,ref),run('same-b',lot,ref)]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,1);
  assert.equal(result.filter(x=>x.status==='rejected').length,1);
  const claim=await db.collection('paymentClaims').doc(makePaymentClaimId(ref)).get();
  assert.equal(claim.exists,true);
  const approved=(await rows('ticketRequests',lot)).filter(x=>x.status==='approved');
  assert.equal(approved.length,1);
  assert.equal((await rows('tickets',lot)).length,1);
  assert.equal((await rows('buyerNotificationQueue',lot)).length,1);
  assert.equal((await db.collection('lotteries').doc(lot).get()).data().nextTicketNumber,2);
  assert.equal(claim.data().requestId=== 'same-a' || claim.data().requestId==='same-b',true);
  await assert.rejects(run(claim.data().requestId,lot,ref),/already been reviewed/);
});
test('simultaneous DISTINCT payments allocate unique sequential numbers and atomic claims',async()=>{
  const lot='emul-different',a='FTEMULATOR121212A',b='FTEMULATOR121212B';
  await setup(lot,[['different-a',a],['different-b',b]]);
  const result=await Promise.allSettled([run('different-a',lot,a),run('different-b',lot,b)]);
  assert.equal(result.filter(x=>x.status==='fulfilled').length,2);
  assert.deepEqual((await rows('tickets',lot)).map(x=>x.number).sort((x,y)=>x-y),[1,2]);
  assert.equal((await rows('buyerNotificationQueue',lot)).length,2);
  assert.equal((await db.collection('lotteries').doc(lot).get()).data().nextTicketNumber,3);
  assert.equal((await db.collection('paymentClaims').doc(makePaymentClaimId(a)).get()).exists,true);
  assert.equal((await db.collection('paymentClaims').doc(makePaymentClaimId(b)).get()).exists,true);
});
test('receipt-only purchase consumes VERIFIED extracted reference within atomic Firestore transaction',async()=>{
  const lot='emul-proof',ref='FTEMULATORPROOF11';
  await setup(lot,[['proof-a','',{proofPath:'payment-proofs/emul-proof/fake.png',proofMd5:'fake-md5'}]]);
  const qref=db.collection('autoPaymentQueue').doc('proof-a');
  const order=(await db.collection('ticketRequests').doc('proof-a').get()).data();
  await qref.update({'verifiedEvidence.payment.reportedTransactionNumber':ref,
    'verifiedEvidence.fingerprint':paymentFingerprint('proof-a',order,account)});
  const result=await run('proof-a',lot,ref);
  assert.equal(result.reference,ref);
  const updated=(await db.collection('ticketRequests').doc('proof-a').get()).data();
  assert.equal(updated.reference,ref);
  assert.deepEqual(updated.ticketNumbers,[1]);
  assert.equal((await db.collection('paymentClaims').doc(makePaymentClaimId(ref)).get()).exists,true);
});
test('tampered receiver evidence or wrong amount blocks issuance atomically',async()=>{
  const lot='emul-forged',ref='FTEMULATORFORGED19';
  await setup(lot,[['forged-a',ref]]);
  const qref=db.collection('autoPaymentQueue').doc('forged-a');
  await qref.update({'verifiedEvidence.payment.maskedReceiverSuffix':'9999'});
  await assert.rejects(run('forged-a',lot,ref),/guard did not pass/);
  assert.equal((await rows('tickets',lot)).length,0);
  assert.equal((await db.collection('paymentClaims').doc(makePaymentClaimId(ref)).get()).exists,false);
  await qref.update({'verifiedEvidence.payment.maskedReceiverSuffix':'2968',
    'verifiedEvidence.payment.amount':99});
  await assert.rejects(run('forged-a',lot,ref),/guard did not pass/);
  assert.equal((await rows('buyerNotificationQueue',lot)).length,0);
});
test('missing persisted evidence must not approve or consume claim',async()=>{
  const lot='emul-missing',ref='FTEMULATORMISSING19';
  await setup(lot,[['missing-a',ref]]);
  await db.collection('autoPaymentQueue').doc('missing-a').update({verifiedEvidence:null});
  await assert.rejects(run('missing-a',lot,ref),/guard did not pass/);
  assert.equal((await rows('tickets',lot)).length,0);
  assert.equal((await db.collection('paymentClaims').doc(makePaymentClaimId(ref)).get()).exists,false);
});
