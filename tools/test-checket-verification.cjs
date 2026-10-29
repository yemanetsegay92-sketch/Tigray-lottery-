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
const official = { success:true, exists:true, duplicate:false,
  data:{ transaction_number:'FTTEST12345', verification_method:'official', receipt } };
const options = fetchImpl => ({apiKey:'chk_test_only', fetchImpl});

test('successful verification is read-only and reports matching account', async () => {
  const result = await verifyCheckEtPayment(base, options(mock(200, official, body => {
    assert.deepEqual(body, {bank:'cbe',transaction_number:'FTTEST12345',account_number:'1000123456789'});
  })));
  assert.equal(result.verified, true);
  assert.equal(result.amount, 1280);
  assert.equal(result.receiverAccountMatches, true);
  assert.match(result.note, /No tickets approved/);
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
  assert.match(result.note,/No tickets approved/);
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
