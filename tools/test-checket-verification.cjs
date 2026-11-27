'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyCheckEtPayment } = require('../lib/checket-verify');

function mock(status, data, onCall) {
  return async (url, options) => {
    assert.equal(url, 'https://api.check.et/api/v1/verify');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer chk_test_only');
    if (onCall) onCall(JSON.parse(options.body));
    return {status, json: async () => data};
  };
}
const base = { bank:'cbe', transactionNumber:'FTTEST12345', accountNumber:'1000123456789' };
const receipt = { status:'completed', amount:1280, currency:'ETB',
  payer_name:'Test Sender', receiver_name:'Test Receiver', receiver_account:'1000123456789'};
const official = { success:true, exists:true, duplicate:false,code:'verified',
  checks:{status:'pass',receiver:'match',amount:'match'},warnings:[],
  data:{ bank:'cbe',transaction_number:'FTTEST12345', verification_method:'official', receipt } };
const options = fetchImpl => ({apiKey:'chk_test_only', fetchImpl});

test('successful verification is read-only and reports matching account', async () => {
  const result = await verifyCheckEtPayment({...base,expectedAmount:1280}, options(mock(200, official, body => {
    assert.deepEqual(body, {bank:'cbe',transaction_number:'FTTEST12345',
      require_receiver_match:true,account_number:'1000123456789',expected_amount:1280});
  })));
  assert.equal(result.verified, true);
  assert.equal(result.amount, 1280);
  assert.equal(result.receiverAccountMatches, true);
  assert.equal(result.providerCheckStatus,'pass');
  assert.equal(result.providerReceiverCheck,'match');
  assert.equal(result.providerAmountCheck,'match');
  assert.match(result.note, /Approval requires/);
  assert.ok(!JSON.stringify(result).includes('chk_test_only'));
});

test('mismatched receiving account remains visible, never marked matching', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(200, {
    ...official, data:{...official.data,receipt:{...receipt,receiver_account:'1000999999999'}}
  })));
  assert.equal(result.verified, true);
  assert.equal(result.receiverAccountMatches, false);
});

test('missing returned receiving account produces unknown, not a false match', async () => {
  const {receiver_account, ...withoutAccount} = receipt;
  const result = await verifyCheckEtPayment(base, options(mock(200, {
    ...official,data:{...official.data,receipt:withoutAccount}
  })));
  assert.equal(result.receiverAccountMatches,null);
  assert.equal(result.receiverAccountReturned,false);
});

test('masked receiver is not incorrectly called a full mismatch or exact match', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(200, {
    ...official, data:{...official.data,receipt:{...receipt,receiver_account:'1********6789'}}
  })));
  assert.equal(result.verified, true);
  assert.equal(result.receiverAccountMatches, null);
  assert.equal(result.receiverAccountStatus, 'masked_unverifiable');
  assert.equal(result.providerCbeAccountCheck,true);
});

test('strict provider receiver match accepts an insufficient mask only for the submitted account',async()=>{
  const result=await verifyCheckEtPayment({...base,expectedAmount:1280},options(mock(200,{
    ...official,data:{...official.data,receipt:{...receipt,receiver_account:'1*********89'}}
  })));
  assert.equal(result.receiverAccountStatus,'masked_unverifiable');
  assert.equal(result.maskedReceiverSuffix,'89');
  assert.equal(result.strictReceiverMatchRequested,true);
  assert.equal(result.providerReceiverCheck,'match');
  assert.equal(result.providerCbeAccountCheck,true);
});

test('contradictory returned account defeats provider receiver match',async()=>{
  for(const receiver_account of ['1000999999999','1********9999']){
    const result=await verifyCheckEtPayment({...base,expectedAmount:1280},options(mock(200,{
      ...official,data:{...official.data,receipt:{...receipt,receiver_account}}
    })));
    assert.equal(result.providerReceiverCheck,'match');
    assert.equal(result.providerCbeAccountCheck,false);
  }
});

test('documented failed checks are parsed and preserved without approval',async()=>{
  for(const [code,receiverCheck,amountCheck] of [
    ['receiver_mismatch','mismatch','match'],['account_mismatch','mismatch','match'],
    ['receiver_unknown','unknown','match'],['amount_mismatch','match','lower']
  ]){
    const result=await verifyCheckEtPayment({...base,expectedAmount:1280},options(mock(422,{
      success:false,exists:true,duplicate:false,code,
      checks:{status:'pass',receiver:receiverCheck,amount:amountCheck},
      warnings:[],data:official.data
    })));
    assert.equal(result.verified,false);
    assert.equal(result.providerCode,code);
    assert.equal(result.providerReceiverCheck,receiverCheck);
    assert.equal(result.providerAmountCheck,amountCheck);
    assert.equal(result.providerCbeAccountCheck,false);
  }
});

test('missing provider checks never establish receiver confirmation',async()=>{
  const {checks,...withoutChecks}=official;
  const result=await verifyCheckEtPayment({...base,expectedAmount:1280},options(mock(200,withoutChecks)));
  assert.equal(result.verified,true);
  assert.equal(result.providerReceiverCheck,'unknown');
  assert.equal(result.providerCbeAccountCheck,false);
});

test('documented provider warnings are preserved and unknown values are dropped',async()=>{
  const result=await verifyCheckEtPayment({...base,expectedAmount:1280},options(mock(200,{
    ...official,warnings:['amount_higher','old_receipt','private_unrecognized_warning']
  })));
  assert.deepEqual(result.warnings,['amount_higher','old_receipt']);
});

test('a genuinely different fully specified receiver account is marked mismatch', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(200, {
    ...official, data:{...official.data,receipt:{...receipt,receiver_account:'1000123499999'}}
  })));
  assert.equal(result.receiverAccountMatches, false);
  assert.equal(result.receiverAccountStatus, 'mismatch');
});

test('provider duplicate is not silently treated as proof of ticket reuse', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(200, {...official, duplicate:true})));
  assert.equal(result.providerDuplicate,true);
  assert.match(result.note,/Approval requires/);
});

test('unconfirmed or pending receipts never report verified', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(200,{
    ...official, success:false, data:{...official.data,receipt:{...receipt,status:'pending'}}
  })));
  assert.equal(result.verified,false);
});

test('404 not-found is handled as unverified without ticket changes', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(404,{success:false,exists:false,duplicate:false,data:{}})));
  assert.equal(result.verified,false);
  assert.equal(result.exists,false);
});

test('invalid bank account is rejected before calling Check.et', async () => {
  await assert.rejects(verifyCheckEtPayment({...base, accountNumber:'ABCD'},options(() => {
    throw Error('should not request');
  })),/Receiving account/);
});

test('CBE requires an account number', async () => {
  await assert.rejects(verifyCheckEtPayment({...base,accountNumber:''},options(() => {
    throw Error('should not request');
  })),/required for this bank/);
});

test('bad API key is surfaced as a safe error with no credential leakage', async () => {
  await assert.rejects(verifyCheckEtPayment(base,options(mock(401,{message:'secret'}))), err => {
    assert.equal(err.statusCode,502);
    assert.ok(!err.message.includes('secret'));
    return true;
  });
});

test('subscription and rate limit errors have safe statuses', async () => {
  for(const [status, expected] of [[402,503],[429,429]]) {
    await assert.rejects(verifyCheckEtPayment(base,options(mock(status,{}))), err => err.statusCode === expected);
  }
});

test('CBE official first verification notes provider used full submitted account', async()=>{
  const result=await verifyCheckEtPayment(base,options(mock(200,official)));
  assert.equal(result.providerCbeAccountCheck,true);
});
test('duplicate Check.et response is not evidence the current account was checked again',async()=>{
  const result=await verifyCheckEtPayment(base,options(mock(200,{...official,duplicate:true})));
  assert.equal(result.providerCbeAccountCheck,false);
});
test('a masked receiver with wrong visible suffix is explicitly flagged',async()=>{
  const result=await verifyCheckEtPayment(base,options(mock(200,{
    ...official,data:{...official.data,receipt:{...receipt,receiver_account:'1********9999'}}
  })));
  assert.equal(result.receiverAccountMatches,null);
  assert.equal(result.receiverAccountStatus,'masked_suffix_mismatch');
});

test('409 preserves safe original fields without treating provider duplicate as a consumed ticket',async()=>{
 const r=await verifyCheckEtPayment(base,options(mock(409,{success:false,exists:true,duplicate:true,code:'duplicate',message:'PRIVATE bank details'})));
 assert.equal(r.providerHttpStatus,409);assert.equal(r.providerCode,'duplicate');
 assert.equal(r.verified,false);assert.equal(r.exists,true);assert.equal(r.providerDuplicate,true);
 assert.equal(r.providerCbeAccountCheck,false);assert.ok(!JSON.stringify(r).includes('PRIVATE'));
});
test('provider 403 shows permission/billing problem instead of unexpected response', async()=>{
  await assert.rejects(verifyCheckEtPayment(base,options(mock(403,{message:'PRIVATE bank info'}))),
    err=>err.statusCode===503 && err.providerHttpStatus===403 &&
      /denied/.test(err.message) && !err.message.includes('PRIVATE'));
});
test('unexpected provider status has numeric diagnostic but never leaks response JSON', async()=>{
  await assert.rejects(verifyCheckEtPayment(base,options(mock(418,{receipt:'secret buyer name'}))),
    err=>err.statusCode===502 && err.providerHttpStatus===418 &&
      /provider HTTP 418/.test(err.message) && !err.message.includes('secret'));
});
test('provider queue response 202 is not mistaken for a confirmed payment', async()=>{
  await assert.rejects(verifyCheckEtPayment(base,options(mock(202,{success:true,exists:true}))),
    err=>err.statusCode===502 && err.providerHttpStatus===202);
});

test('BOA reference can be checked with five-digit SENDER account suffix',async()=>{
  const body={bank:'boa',transactionNumber:'FTTESTBOA123',accountNumber:'59016'};
  const response={success:true,exists:true,duplicate:false,code:'verified',data:{
    bank:'boa',transaction_number:'FTTESTBOA123',verification_method:'official',
    receipt:{status:'completed',amount:100,currency:'ETB',
      receiver_name:'Test Recipient',receiver_account:'1********2968'}
  }};
  const result=await verifyCheckEtPayment(body,options(mock(200,response,payload=>{
    assert.equal(payload.bank,'boa');
    assert.equal(payload.account_number,'59016');
  })));
  assert.equal(result.verified,true);
  assert.equal(result.receiverAccountMatches,null);
  assert.equal(result.receiverAccountStatus,'not_checked_sender_account');
  assert.equal(result.providerCbeAccountCheck,false);
});
test('BOA sender account must be five digits or a full account',async()=>{
  await assert.rejects(verifyCheckEtPayment({
    bank:'boa',transactionNumber:'FTTESTBOA123',accountNumber:'016'
  },options(()=>{throw Error('should not be called')})),/BOA sender account/);
});
