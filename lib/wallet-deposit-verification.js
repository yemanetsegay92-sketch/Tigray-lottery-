'use strict';
const {normalizePaymentReference}=require('./payment-claims');
function nameKey(value){return String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toUpperCase();}
function assessAutomaticDeposit({deposit,provider,receiver,providerReceiverAccountAssurance=false}){
 const reasons=[];
 const expectedRef=normalizePaymentReference(deposit?.reference),reportedRef=normalizePaymentReference(provider?.reportedTransactionNumber);
 if(provider?.verified!==true||provider?.providerDuplicate===true)reasons.push('payment_not_final');
 if(provider?.bank!=='cbe'||provider?.reportedBank!=='cbe'||provider?.status!=='completed'||provider?.verificationMethod!=='official')reasons.push('bank_status_unverified');
 if(expectedRef!==reportedRef)reasons.push('reference_mismatch');
 if(Math.round(Number(provider?.amount)*100)!==Number(deposit?.amountSantim)||String(provider?.currency).toUpperCase()!=='ETB')reasons.push('amount_mismatch');
 if(!providerReceiverAccountAssurance||provider?.providerCbeAccountCheck!==true||
   !['exact_match','masked_unverifiable'].includes(provider?.receiverAccountStatus)||
   nameKey(provider?.receiverName)!==nameKey(receiver?.holderName))reasons.push('receiver_unverified');
 const paidAt=Date.parse(String(provider?.transactionDate||''));
 if(!Number.isFinite(paidAt)||paidAt>Date.now()+5*60000||paidAt<Date.now()-7*86400000)reasons.push('date_unverified');
 // A matching name is not ownership. The provider/KYC bridge must explicitly
 // bind the payer identity to the authenticated Firebase customer UID.
 if(provider?.payerIdentityVerified!==true||provider?.payerCustomerUid!==deposit?.uid)reasons.push('payer_ownership_unverified');
 if(reasons.length)return {eligible:false,reasons};
 return {eligible:true,reasons:[],evidence:{bank:'cbe',completed:true,receiverVerified:true,
  customerOwnershipVerified:true,referenceVerified:true,verifiedAmountSantim:Number(deposit.amountSantim),
  currency:'ETB',verificationMethod:'official',customerUid:deposit.uid,
  ownershipMethod:'provider_verified_identity',transactionDate:provider.transactionDate,
  payerName:provider.payerName,reference:expectedRef}};
}
module.exports={assessAutomaticDeposit};
