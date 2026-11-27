'use strict';

const {normalizePaymentReference}=require('./payment-claims');

const REASONS={
  duplicate:'This payment reference has already been used for another ticket request.',
  account_mismatch:'This payment was not sent to the official lottery receiving account.',
  receiver_mismatch:'This payment was not sent to the official lottery receiving account.',
  amount_mismatch:'The verified payment amount is lower than the required ticket total.'
};

function providerRejection({verification,reference,requiredAmount}){
  const v=verification||{};
  const code=String(v.providerCode||'');
  const status=Number(v.providerHttpStatus);
  const identified=/^FT[A-Z0-9]{8,30}$/.test(reference) &&
    normalizePaymentReference(v.reportedTransactionNumber)===reference && v.exists===true;
  if(!identified)return null;
  if(status===409 && code==='duplicate' && v.providerDuplicate===true){
    return {code,reason:REASONS.duplicate};
  }
  if(status===422 && code==='receiver_mismatch' && v.providerReceiverCheck==='mismatch'){
    return {code,reason:REASONS.receiver_mismatch};
  }
  if(status===422 && code==='account_mismatch' &&
    (v.providerReceiverCheck==='mismatch' || ['mismatch','masked_suffix_mismatch'].includes(v.receiverAccountStatus))){
    return {code,reason:REASONS.account_mismatch};
  }
  if(status===422 && code==='amount_mismatch' && v.providerAmountCheck==='lower' &&
    Number.isFinite(Number(v.amount)) && Number(v.amount)<Number(requiredAmount)){
    return {code,reason:REASONS.amount_mismatch};
  }
  return null;
}

module.exports={REASONS,providerRejection};
