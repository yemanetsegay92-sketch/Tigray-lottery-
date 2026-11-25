'use strict';

// Provider-neutral foundation only. This module never performs network calls.
// SMS sending MUST remain off until a provider approves the intended use.
function invalid(message){return Object.assign(new Error(message),{statusCode:400});}
function parseSmsConsent(value){
 if(value===undefined||value===null)return false;
 if(typeof value!=='boolean')throw invalid('SMS notification consent must be a checkbox choice.');
 return value===true;
}
function normalizeRecipient(value){
 const raw=String(value||'').replace(/[\s()-]/g,'');
 if(/^0[79]\d{8}$/.test(raw))return '+251'+raw.slice(1);
 if(/^\+251[79]\d{8}$/.test(raw))return raw;
 return null;
}
const STATUSES=new Set(['approved','rejected','cancelled']);
function renderTicketStatusSms(request){
 // Notification is sent to an unverified customer-supplied number. Avoid
 // disclosing personal data, payment details, ticket numbers or bank references.
 if(request?.smsNotificationConsent!==true||!STATUSES.has(request?.status))return null;
 const to=normalizeRecipient(request.phone);
 if(!to)return null;
 const status=request.status==='approved'?'approved':
   request.status==='rejected'?'rejected':'cancelled';
 return {to,status,text:`Tigray Lottery: Your ticket request was ${status}. Check its status at https://tigraylottery.com/check.html`};
}
function queueSmsMetadata(request){
 // Future independent SMS worker may inspect this flag, but existing Telegram
 // worker must not send SMS or change its retry behaviour.
 return {smsRequested:request?.smsNotificationConsent===true,
   smsDeliveryState:'not_enabled'};
}
module.exports={parseSmsConsent,normalizeRecipient,renderTicketStatusSms,queueSmsMetadata};
