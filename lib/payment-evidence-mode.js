'use strict';
const {cbeAccounts}=require('./cbe-auto-eligibility');
function paymentEvidenceMode(lot){return lot?.paymentEvidenceMode==='reference_only'?'reference_only':'standard';}
function transactionNumberOnlyEnabled(env=process.env){return env.LOTTERY_CBE_TRANSACTION_NUMBER_ONLY_ENABLED==='true';}
function receiptRequired(lot,env=process.env){return cbeAccounts(lot).length>0&&!transactionNumberOnlyEnabled(env);}
function customerEvidenceMode(lot,env=process.env){return receiptRequired(lot,env)?'receipt_required':paymentEvidenceMode(lot);}
function fail(msg){throw Object.assign(new Error(msg),{statusCode:400});}
function assertUploadAllowed(lot,env=process.env){if(customerEvidenceMode(lot,env)==='reference_only')fail('This lottery accepts transaction references only, not uploaded receipts.');}
function assertPurchaseEvidence(lot,reference,proof,env=process.env){
 const mode=customerEvidenceMode(lot,env);
 if(mode==='receipt_required'){
  if(!proof)fail('An original CBE receipt PDF or screenshot is required for this purchase.');
 }else if(mode==='reference_only'){
  if(!String(reference||'').trim())fail('Enter a transaction reference for this lottery.');
  if(proof)fail('Receipt uploads are disabled for this lottery.');
 }else if(!String(reference||'').trim()&&!proof)fail('Enter a transaction reference OR upload a receipt.');
}
module.exports={paymentEvidenceMode,transactionNumberOnlyEnabled,receiptRequired,customerEvidenceMode,assertUploadAllowed,assertPurchaseEvidence};
