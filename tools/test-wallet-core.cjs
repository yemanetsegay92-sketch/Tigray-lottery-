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
  referenceVerified:true,verifiedAmountSantim:10000,currency:'ETB',verificationMethod:'official'};
 assert.doesNotThrow(()=>verifiedEvidence(e,10000));
 assert.throws(()=>verifiedEvidence({...e,customerOwnershipVerified:false},10000),/payer-ownership/);
 assert.throws(()=>verifiedEvidence({...e,verifiedAmountSantim:9999},10000),/payer-ownership/);
});
test('repeat request key derives one stable id and is customer isolated',()=>{
 assert.equal(purchaseId('user01','purchase01'),purchaseId('user01','purchase01'));
 assert.notEqual(purchaseId('user01','purchase01'),purchaseId('user02','purchase01'));
 assert.throws(()=>purchaseId('user01','bad key'),/Invalid/);
});
