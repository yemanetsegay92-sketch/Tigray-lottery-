'use strict';

// Conservative eligibility policy for unattended CBE ticket approvals.
// Parsing an uploaded receipt is NOT sufficient: require official verification
// of the transaction against the configured receiving account.
const {normalizePaymentReference}=require('./payment-claims');
function timestampMs(value) {
  if(!value)return NaN;
  if(typeof value.toMillis==='function')return value.toMillis();
  if(typeof value.seconds==='number')return value.seconds*1000;
  const v=Date.parse(String(value));
  return Number.isFinite(v)?v:NaN;
}
function nameKey(value) {
  return String(value||'').toUpperCase().replace(/\b(MR|MRS|MS|DR|PROF)\.?\b/g,'')
    .replace(/[^A-Z\s]/g,' ').replace(/\s+/g,' ').trim();
}
function cbeAccounts(lottery) {
  return (Array.isArray(lottery?.paymentAccounts)?lottery.paymentAccounts:[])
    .filter(x=>/^(CBE|COMMERCIAL BANK OF ETHIOPIA)$/i.test(String(x.bank||'').trim()))
    .filter(x=>/^\d{8,30}$/.test(String(x.number||'').replace(/\s/g,'')) &&
      String(x.number).replace(/\s/g,'')!=='1000000000000');
}
function evaluateAutoPayment({purchase,lottery,verification,duplicate={},nowMs=Date.now()}) {
  const reasons=[];
  if(!purchase||purchase.status!=='pending')reasons.push('purchase_not_pending');
  if(!lottery||lottery.status!=='active'||lottery.cleanupInProgress)reasons.push('lottery_not_active');
  const accounts=cbeAccounts(lottery);
  if(accounts.length!==1)reasons.push('requires_exactly_one_real_cbe_account');
  const account=accounts[0]||null;
  if(!account||!nameKey(account.holderName))reasons.push('receiving_account_holder_unconfigured');
  if(!verification||verification.bank!=='cbe'||verification.verified!==true||
    verification.status!=='completed'||verification.verificationMethod!=='official') {
    reasons.push('no_official_completed_cbe_confirmation');
  }
  if(verification?.providerDuplicate===true)reasons.push('checket_previous_verification_review');
  if(verification?.providerCbeAccountCheck!==true)reasons.push('provider_account_check_not_established');
  if(!['exact_match','masked_unverifiable'].includes(verification?.receiverAccountStatus)) {
    reasons.push('receiver_account_invalid_or_missing');
  }
  if(account && verification?.receiverAccountStatus==='masked_unverifiable' &&
    verification?.maskedReceiverSuffix &&
    !String(account.number).replace(/\s/g,'').endsWith(verification.maskedReceiverSuffix)) {
    reasons.push('masked_suffix_mismatch');
  }
  if(account && nameKey(account.holderName) !== nameKey(verification?.receiverName)) {
    reasons.push('receiver_name_not_matching_configured_holder');
  }
  const expected=Number(purchase?.total), actual=Number(verification?.amount);
  if(!Number.isSafeInteger(Math.round(expected*100))||expected<=0 ||
    verification?.amount===null||!Number.isFinite(actual)||
    Math.round(expected*100)!==Math.round(actual*100) ||
    String(verification?.currency||'').toUpperCase()!=='ETB')reasons.push('payment_amount_currency_mismatch');
  const paymentAt=timestampMs(verification?.transactionDate);
  const orderedAt=timestampMs(purchase?.createdAt);
  if(!Number.isFinite(paymentAt)||!Number.isFinite(orderedAt)||
    paymentAt<orderedAt-30*60000 || paymentAt>orderedAt+30*60000 ||
    paymentAt>nowMs+5*60000)reasons.push('payment_time_outside_30_minute_window');
  const reference=normalizePaymentReference(verification?.reportedTransactionNumber);
  const submitted=normalizePaymentReference(purchase?.reference);
  if(!/^FT[A-Z0-9]{8,30}$/.test(reference))reasons.push('missing_or_invalid_bank_reference');
  if(submitted && submitted!==reference)reasons.push('buyer_reference_mismatch');
  if(duplicate.claimStatus!=='unused')reasons.push('payment_claim_already_used_or_unchecked');
  if(Number(duplicate.otherCount||0)>0 || duplicate.truncated===true ||
    Number(duplicate.otherApprovedCount||0)>0)reasons.push('reference_used_on_other_request');
  // Do not depend on payer name matching the ticket buyer: legitimate third party
  // payments exist. All approval requirements above remain mandatory.
  return {
    eligible:reasons.length===0,
    reasons,
    reference,
    expectedAmount:Number.isFinite(expected)?expected:null,
    receivingAccountLast4:account?String(account.number).slice(-4):'',
    policy:'CBE_UNATTENDED_V1'
  };
}
module.exports={evaluateAutoPayment,nameKey,timestampMs,cbeAccounts};
