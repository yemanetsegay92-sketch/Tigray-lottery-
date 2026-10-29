'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {makePaymentClaimId,normalizePaymentReference,
  claimSnapshotStatus,assertClaimFree,createPaymentClaim} = require('../lib/payment-claims');

test('same bank reference irrespective of case and internal whitespace maps to one immutable claim',()=>{
  const a=makePaymentClaimId('FT26303 53QXF');
  const b=makePaymentClaimId('ft2630353qxf');
  assert.equal(a,b);
  assert.match(a,/^[a-f0-9]{64}$/);
});
test('distinct references produce distinct claim identifiers',()=>{
  assert.notEqual(makePaymentClaimId('FT2630353QXF'),makePaymentClaimId('FT2630353QXG'));
});
test('no reference cannot create a claim; approval must reject it before claiming',()=>{
  assert.equal(makePaymentClaimId(''),null);
  assert.equal(normalizePaymentReference(' ft 42 '),'FT42');
});
test('used claim rejects repeat issuance, including same purchase after cancellation',()=>{
  assert.equal(claimSnapshotStatus({exists:true,data:()=>({requestId:'old-order'})},'new-order'),'used_by_another_request');
  assert.equal(claimSnapshotStatus({exists:true,data:()=>({requestId:'old-order'})},'old-order'),'already_claimed_for_this_request');
  for(const status of ['used_by_another_request','already_claimed_for_this_request']){
    assert.throws(()=>assertClaimFree(status),e=>e.statusCode===409);
  }
});
test('unused claim allows an atomic tx.create with no plain transaction reference',()=>{
  let capture;
  const tx={create:(ref,record)=>{capture={ref,record};}};
  const fakeRef={path:'paymentClaims/'+makePaymentClaimId('FTTEST12345')};
  assert.equal(createPaymentClaim(tx,fakeRef,{
    requestId:'order1',lotteryId:'lottery1',createdBy:'admin-test',
    at:'server timestamp test'
  }),true);
  assert.equal(capture.ref,fakeRef);
  assert.equal(capture.record.status,'consumed');
  assert.equal(capture.record.requestId,'order1');
  assert.equal(capture.record.retention,'keep_after_lottery_cleanup');
  assert.doesNotMatch(JSON.stringify(capture.record),/FTTEST12345/);
});
test('no claim cannot silently become permanent anti-replay protection',()=>{
  const tx={create:()=>{throw Error('Should not create claim.');}};
  assert.equal(createPaymentClaim(tx,null,{requestId:'receipt-only'}),false);
});
