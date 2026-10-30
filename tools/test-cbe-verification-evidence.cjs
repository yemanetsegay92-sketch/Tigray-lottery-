'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {MAX_AGE_MS,paymentFingerprint,checkSavedEvidence,verifiedSubset,
  readSavedEvidence,markProviderAttempt,saveVerifiedEvidence}=require('../lib/cbe-verification-evidence');
const now=Date.now();
const purchase={lotteryId:'lot1',reference:'',proofPath:'payment-proofs/lot1/abc.jpg',
  proofMd5:'md5-synthetic',quantity:1,total:1000,createdAt:new Date(now-80000)};
const verified={verified:true,reportedBank:'cbe',bank:'cbe',verificationMethod:'official',
  status:'completed',amount:1000,currency:'ETB',providerDuplicate:false,
  providerCbeAccountCheck:true,receiverAccountStatus:'masked_unverifiable',
  maskedReceiverSuffix:'2968',receiverName:'Mahliet Tsegay Gidey',
  reportedTransactionNumber:'FTTESTIMAGE89',transactionDate:new Date(now-65000).toISOString(),
  apiKey:'SECRET_MUST_NOT_PERSIST',receiptBuffer:'not-permitted'};
function store(){
  const order={...purchase,status:'pending'};
  const queue={state:'processing'};
  return {
    order,queue,
    collection(name){
      return {doc:()=>({
        async get(){return name==='autoPaymentQueue'?{exists:true,data:()=>queue}
          :{exists:true,data:()=>order};}
      })};
    },
    async runTransaction(fn){
      const tx={get:async ref=>ref.get(),update:(_ref,data)=>Object.assign(
        data.verifiedEvidence || data.verificationAttemptStartedAt? queue:order,data)};
      await fn(tx);
    }
  };
}
test('fingerprint binds order, proof, expected amount and full receiving account',()=>{
  const original=paymentFingerprint('request',purchase,'1000000002968');
  assert.match(original,/^[a-f0-9]{64}$/);
  assert.equal(original,paymentFingerprint('request',purchase,'1000000002968'));
  assert.notEqual(original,paymentFingerprint('request',purchase,'1000000009999'));
  assert.notEqual(original,paymentFingerprint('request',{...purchase,total:1001},'1000000002968'));
  assert.notEqual(original,paymentFingerprint('request',{...purchase,proofPath:'replaced'},'1000000002968'));
  assert.notEqual(original,paymentFingerprint('request2',purchase,'1000000002968'));
});
test('stored verification drops API secrets, raw receipts, and any undeclared fields',()=>{
  const safe=verifiedSubset(verified);
  assert.equal(safe.reportedTransactionNumber,'FTTESTIMAGE89');
  assert.equal(safe.apiKey,undefined);
  assert.equal(safe.receiptBuffer,undefined);
});
test('cached evidence expires and cannot survive a changed bank account or purchase',()=>{
  const fingerprint=paymentFingerprint('r1',purchase,'1000000002968');
  const evidence={version:1,fingerprint,verifiedAt:new Date(now-1000),payment:verifiedSubset(verified)};
  assert.equal(checkSavedEvidence(evidence,'r1',purchase,'1000000002968',now).status,'usable');
  assert.equal(checkSavedEvidence(evidence,'r1',purchase,'1000000001111',now).status,'changed');
  assert.equal(checkSavedEvidence(evidence,'r1',{...purchase,total:1001},'1000000002968',now).status,'changed');
  assert.equal(checkSavedEvidence(evidence,'r1',purchase,'1000000002968',now+MAX_AGE_MS+5000).status,'expired');
  assert.equal(checkSavedEvidence({...evidence,payment:{...verifiedSubset(verified),providerDuplicate:true}},
    'r1',purchase,'1000000002968',now).status,'invalid');
});
test('a pre-provider attempt marker prevents accidental second Check.et call on a crash',async()=>{
  const db=store();
  assert.equal((await readSavedEvidence(db,'r1',db.order,'1000000002968')).status,'absent');
  await markProviderAttempt(db,'r1',db.order,'1000000002968',now);
  assert.equal((await readSavedEvidence(db,'r1',db.order,'1000000002968')).status,'attempted_without_saved_response');
  await assert.rejects(markProviderAttempt(db,'r1',db.order,'1000000002968',now+10),
    /already attempted/);
});
test('verified Check.et evidence is durable and never overwritten',async()=>{
  const db=store();
  await markProviderAttempt(db,'r1',db.order,'1000000002968',now);
  await saveVerifiedEvidence(db,'r1',db.order,'1000000002968',verified,now+100);
  const saved=await readSavedEvidence(db,'r1',db.order,'1000000002968',now+200);
  assert.equal(saved.status,'usable');
  assert.equal(saved.payment.verified,true);
  assert.equal(saved.payment.reportedTransactionNumber,'FTTESTIMAGE89');
  await assert.rejects(saveVerifiedEvidence(db,'r1',db.order,'1000000002968',verified,now+500),
    /already recorded/);
});
test('unverified or provider-duplicate results must never be cached',async()=>{
  const db=store();
  for(const changes of [{verified:false},{providerDuplicate:true},{providerCbeAccountCheck:false}]){
    await assert.rejects(saveVerifiedEvidence(db,'r1',db.order,'1000000002968',
      {...verified,...changes},now),/Only a fresh/);
  }
});
