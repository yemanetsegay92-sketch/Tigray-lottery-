'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {assessAutomaticDeposit}=require('../lib/wallet-deposit-verification');
const deposit={uid:'customer-1',reference:'FTOWNERSHIP001',amountSantim:10000};
const provider={verified:true,providerDuplicate:false,bank:'cbe',reportedBank:'cbe',status:'completed',
 verificationMethod:'official',reportedTransactionNumber:deposit.reference,amount:100,currency:'ETB',
 providerCbeAccountCheck:true,receiverAccountStatus:'exact_match',receiverName:'Tigray Lottery PLC',
 transactionDate:new Date().toISOString(),payerName:'Customer One',payerIdentityVerified:true,payerCustomerUid:'customer-1'};
const input={deposit,provider,receiver:{holderName:'Tigray Lottery PLC'},providerReceiverAccountAssurance:true};
test('automatic deposit requires provider-bound payer ownership',()=>{
 assert.equal(assessAutomaticDeposit(input).eligible,true);
 for(const change of [{payerIdentityVerified:false},{payerCustomerUid:'customer-2'}]){
  const result=assessAutomaticDeposit({...input,provider:{...provider,...change}});
  assert.equal(result.eligible,false);assert.ok(result.reasons.includes('payer_ownership_unverified'));
 }
});
test('failed, duplicate, wrong receiver, amount, reference, or stale deposits never auto credit',()=>{
 const cases=[
  {verified:false},{providerDuplicate:true},{amount:99},{reportedTransactionNumber:'FTOTHER001'},
  {receiverName:'Attacker'},{providerCbeAccountCheck:false},{transactionDate:'2020-01-01T00:00:00Z'}
 ];
 for(const change of cases)assert.equal(assessAutomaticDeposit({...input,provider:{...provider,...change}}).eligible,false);
 assert.equal(assessAutomaticDeposit({...input,providerReceiverAccountAssurance:false}).eligible,false);
});
