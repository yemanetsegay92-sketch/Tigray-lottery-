const test=require('node:test'),assert=require('node:assert/strict');
const {paymentEvidenceMode,customerEvidenceMode,assertUploadAllowed,assertPurchaseEvidence}=require('../lib/payment-evidence-mode');
test('old lotteries remain standard',()=>{assert.equal(paymentEvidenceMode({}),'standard');assert.doesNotThrow(()=>assertUploadAllowed({}));assert.doesNotThrow(()=>assertPurchaseEvidence({},'',{}));assert.throws(()=>assertPurchaseEvidence({},'',null),/reference OR upload/);});
test('reference-only rules are server enforced',()=>{const l={paymentEvidenceMode:'reference_only'};assert.throws(()=>assertUploadAllowed(l),/references only/);assert.throws(()=>assertPurchaseEvidence(l,'',null),/Enter a transaction reference/);assert.throws(()=>assertPurchaseEvidence(l,'FT123',{}),/disabled/);assert.doesNotThrow(()=>assertPurchaseEvidence(l,'FT123',null));});
test('CBE checkout requires an original receipt until the server flag enables reference-only purchases',()=>{
 const l={paymentEvidenceMode:'reference_only',paymentAccounts:[{bank:'CBE',number:'1000123456789'}]};
 const disabled={LOTTERY_CBE_TRANSACTION_NUMBER_ONLY_ENABLED:'false'};
 assert.equal(customerEvidenceMode(l,disabled),'receipt_required');
 assert.doesNotThrow(()=>assertUploadAllowed(l,disabled));
 assert.throws(()=>assertPurchaseEvidence(l,'FTTEST12345',null,disabled),/original CBE receipt/);
 assert.doesNotThrow(()=>assertPurchaseEvidence(l,'FTTEST12345',{},disabled));
 const enabled={LOTTERY_CBE_TRANSACTION_NUMBER_ONLY_ENABLED:'true'};
 assert.equal(customerEvidenceMode(l,enabled),'reference_only');
 assert.doesNotThrow(()=>assertPurchaseEvidence(l,'FTTEST12345',null,enabled));
});
