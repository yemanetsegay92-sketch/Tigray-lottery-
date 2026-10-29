'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {comparePaymentToRequest} = require('../lib/checket-request-match');
const now = Date.now();
const purchase = Object.freeze({
  lotteryId:'lot-001', reference:'FTTEST12345', total:1280,
  createdAt:new Date(now - 60*60*1000).toISOString()
});
const lottery = Object.freeze({id:'lot-001'});
const bank = Object.freeze({
  verified:true, amount:1280, currency:'ETB', receiverAccountStatus:'exact_match',
  transactionDate:new Date(now - 45*60*1000).toISOString(),
  reportedTransactionNumber:'FTTEST12345', bank:'cbe',
  verificationMethod:'official', providerDuplicate:false
});
const none = {otherCount:0,truncated:false};
function match(overrides={}, p=purchase, duplicate=none) {
  return comparePaymentToRequest(p,{...bank,...overrides},lottery,duplicate);
}
test('full exact match is only a read-only match for review, never approval',()=>{
  const result=match();
  assert.equal(result.recommendation,'MATCHED_FOR_REVIEW');
  assert.equal(result.concerns.length,0);
  assert.match(result.note,/No ticket approval/i);
});
test('masked receiving account is always manual review, even with same last digits',()=>{
  const result=match({receiverAccountStatus:'masked_unverifiable'});
  assert.equal(result.recommendation,'MANUAL_REVIEW');
  assert.match(result.concerns.join(' '),/full receiving account/i);
});
test('wrong amount and missing amount fail',()=>{
  for(const amount of [1200,null]) {
    const result=match({amount});
    assert.equal(result.checks.amountMatch,false);
    assert.equal(result.recommendation,'MANUAL_REVIEW');
  }
});
test('old CBE receipt predating a request by 16 days is flagged',()=>{
  const result=match({transactionDate:new Date(now-16*86400000).toISOString()});
  assert.equal(result.checks.dateStatus,'older_than_request');
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
test('missing bank transaction date is manual review',()=>{
  const result=match({transactionDate:null});
  assert.equal(result.checks.dateStatus,'missing');
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
test('conflicting provider reference cannot be a clean match',()=>{
  assert.equal(match({reportedTransactionNumber:'FTSOMEOTHER'}).checks.referenceMatch,false);
});
test('provider omitting transaction reference requires review',()=>{
  const result=match({reportedTransactionNumber:''});
  assert.equal(result.checks.referenceMatch,null);
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
test('duplicate ticket requests and branch duplicate are flagged separately',()=>{
  const result=match({providerDuplicate:true},purchase,{otherCount:1,truncated:false});
  assert.equal(result.checks.otherRequestsWithExactReference,1);
  assert.equal(result.checks.providerReportedDuplicate,true);
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
test('provider unverified never matches',()=>{
  const result=match({verified:false});
  assert.equal(result.checks.paymentConfirmed,false);
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
test('wrong lottery is a manual review concern',()=>{
  const result=match({}, {...purchase,lotteryId:'other-lottery'});
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
test('non-official verification method is flagged',()=>{
  const result=match({verificationMethod:'parsed'});
  assert.equal(result.recommendation,'MANUAL_REVIEW');
});
