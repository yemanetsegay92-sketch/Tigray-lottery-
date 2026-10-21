'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');
let role = 'lotteryAdmin';
let lotteries = ['lotA'];
let saved = null;
const originalLoad = Module._load;
const fakeDb = {
  collection(name) {
    if (name === 'users') return { doc: () => ({ get: async () => ({
      exists: true, data: () => ({ role, lotteryIds: lotteries })
    }) }) };
    if (name === 'ticketRequests') return { doc: id => ({ get: async () => {
      const correctId = crypto.createHash('sha256').update('REF:ABC-123').digest('hex').slice(0,40);
      return id === correctId && saved
        ? { exists: true, data: () => saved }
        : { exists: false };
    } }) };
    throw new Error('Unexpected Firestore collection: ' + name);
  }
};
Module._load = function(spec,parent,isMain) {
  if (spec === 'firebase-admin/auth') return { getAuth: () => ({
    verifyIdToken: async () => ({ uid: 'test-admin' })
  }) };
  if (spec === 'firebase-admin/storage') return { getStorage: () => ({}) };
  if (spec === '../telegram/_lib' && parent?.filename?.endsWith('approvals.js'))
    return { adminDb: () => fakeDb, FieldValue: {} };
  return originalLoad.call(this,spec,parent,isMain);
};
const approvals = require('../api/admin/approvals.js');
Module._load = originalLoad;
const requestBody = reference => ({
  action: 'lookup-reference', lotteryId:'lotA',reference
});
async function invoke(body) {
  const result = { code: 200, json: null, headers:{} };
  const req={method:'POST', headers:{ authorization:'Bearer test-token' }, body};
  const res={
    setHeader(k,v){result.headers[k]=v;return this},
    status(code){result.code=code;return this},
    json(payload){result.json=payload;return this}
  };
  await approvals(req,res);
  return result;
}
async function test() {
  saved = null;
  const missing = await invoke(requestBody('NOT-A-REAL-REFERENCE'));
  assert.equal(missing.code,404);
  assert.equal(missing.json.code,'PAYMENT_NOT_FOUND');
  assert.match(missing.json.error,/No payment found/);
  assert.equal(missing.headers['Cache-Control'],'no-store');
  saved={
    lotteryId:'lotA',name:'Example Buyer',phone:'0912345678',
    reference:'ABC-123',quantity:3,total:300,status:'pending',
    proofPath:'payment-proofs/lotA/secret.pdf',proofMime:'application/pdf',
    createdAt:{toDate:()=>new Date('2026-10-21T20:00:00Z')}
  };
  const found=await invoke(requestBody('abc-123'));
  assert.equal(found.code,200);
  assert.equal(found.json.request.name,'Example Buyer');
  assert.equal(found.json.request.hasProof,true);
  assert.equal(found.json.request.createdAt,'2026-10-21T20:00:00.000Z');
  assert.equal(Object.hasOwn(found.json.request,'proofPath'),false);
  lotteries=['anotherLot'];
  const forbidden=await invoke(requestBody('ABC-123'));
  assert.equal(forbidden.code,403);
  assert.match(forbidden.json.error,/not assigned/);
  role='generalAdmin';
  const general=await invoke(requestBody('ABC-123'));
  assert.equal(general.code,200);
  console.log('PASS: missing payment (404), found (200), unauthorized (403), general admin (200)');
}
test().catch(error=>{ console.error(error); process.exitCode=1; });
