'use strict';
function paymentEvidenceMode(lot){return lot?.paymentEvidenceMode==='reference_only'?'reference_only':'standard';}
function fail(msg){throw Object.assign(new Error(msg),{statusCode:400});}
function assertUploadAllowed(lot){if(paymentEvidenceMode(lot)==='reference_only')fail('This lottery accepts transaction references only, not uploaded receipts.');}
function assertPurchaseEvidence(lot,reference,proof){
 if(paymentEvidenceMode(lot)==='reference_only'){
  if(!String(reference||'').trim())fail('Enter a transaction reference for this lottery.');
  if(proof)fail('Receipt uploads are disabled for this lottery.');
 }else if(!String(reference||'').trim()&&!proof)fail('Enter a transaction reference OR upload a receipt.');
}
module.exports={paymentEvidenceMode,assertUploadAllowed,assertPurchaseEvidence};
