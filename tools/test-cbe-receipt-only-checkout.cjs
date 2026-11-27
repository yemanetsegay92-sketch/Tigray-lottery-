'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');

test('customer checkout obtains a server policy, hides reference-only entry, and requires a receipt',()=>{
  const js=readFileSync('js/buy.js','utf8');
  const api=readFileSync('api/customer/create-request.js','utf8');
  assert.match(js,/action:'purchase-evidence-policy'/);
  assert.match(js,/referenceLabel\.hidden=receipt/);
  assert.match(js,/referenceLabel\.style\.display=receipt\?'none':''/);
  assert.match(js,/\$\('screenshot'\)\.required=receipt/);
  assert.match(api,/mode:customerEvidenceMode\(snap\.data\(\)\)/);
  assert.match(api,/assertPurchaseEvidence\(lottery,reference,proof\)/);
});

test('receipt verification continues to omit transaction_number when a file exists',()=>{
  const worker=readFileSync('lib/cbe-auto-worker.js','utf8');
  assert.match(worker,/purchase\.proofPath\?\{receiptFile\}:\{transactionNumber:ref\}/);
});
