'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {MIN_DEPOSIT_SANTIM,santimFromEtb,verifiedEvidence,purchaseId}=require('../lib/wallet-core');
test('wallet monetary values use integer santim',()=>{
 assert.equal(MIN_DEPOSIT_SANTIM,10000);
 assert.equal(santimFromEtb('100'),10000);
 assert.equal(santimFromEtb('100.01'),10001);
 assert.equal(santimFromEtb('0.01'),1);
 for(const input of ['0','-5','1.234','1e3','NaN','12.','100,000'])
  assert.throws(()=>santimFromEtb(input),/Invalid/);
});
test('deposit approval requires receiver and ownership verification',()=>{
 const e={bank:'cbe',completed:true,receiverVerified:true,customerOwnershipVerified:true,
  referenceVerified:true,verifiedAmountSantim:10000,currency:'ETB',verificationMethod:'official',
  customerUid:'customer1',ownershipMethod:'provider_verified_identity',transactionDate:new Date().toISOString(),payerName:'Customer One'};
 const deposit={uid:'customer1',legalName:'Customer One',createdAtMs:Date.now()};
 assert.doesNotThrow(()=>verifiedEvidence(e,10000,deposit,{actorId:'system_auto_deposit',actorRole:'trustedAutoWorker'}));
 assert.throws(()=>verifiedEvidence({...e,customerOwnershipVerified:false},10000),/payer-ownership/);
 assert.throws(()=>verifiedEvidence({...e,verifiedAmountSantim:9999},10000),/payer-ownership/);
 assert.throws(()=>verifiedEvidence({...e,ownershipMethod:'gm_reviewed_identity'},10000,deposit,{actorId:'generalAdmin',actorRole:'generalAdmin'}),/provider-bound/);
 const manual={...e,verificationMethod:'gm_manual_review',ownershipMethod:'gm_reviewed_identity',
  reviewedBy:'generalAdmin',receivingAccount:'1000000000000',receivingOwner:'Tigray Lottery',reviewNote:'Independently reviewed official transfer evidence.'};
 assert.doesNotThrow(()=>verifiedEvidence(manual,10000,deposit,{actorId:'generalAdmin',actorRole:'generalAdmin'}));
 assert.throws(()=>verifiedEvidence({...manual,reviewNote:''},10000,deposit,{actorId:'generalAdmin',actorRole:'generalAdmin'}),/securely recorded/);
});
test('repeat request key derives one stable id and is customer isolated',()=>{
 assert.equal(purchaseId('user01','purchase01'),purchaseId('user01','purchase01'));
 assert.notEqual(purchaseId('user01','purchase01'),purchaseId('user02','purchase01'));
 assert.throws(()=>purchaseId('user01','bad key'),/Invalid/);
});
