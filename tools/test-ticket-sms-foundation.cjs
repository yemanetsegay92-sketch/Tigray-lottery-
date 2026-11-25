'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {parseSmsConsent,normalizeRecipient,renderTicketStatusSms,queueSmsMetadata}=
 require('../lib/ticket-sms-foundation');

test('SMS consent must be explicitly checked, with legacy requests defaulting off',()=>{
 assert.equal(parseSmsConsent(undefined),false);
 assert.equal(parseSmsConsent(null),false);
 assert.equal(parseSmsConsent(false),false);
 assert.equal(parseSmsConsent(true),true);
 for(const value of ['true','false',1,{},[]])
  assert.throws(()=>parseSmsConsent(value),/checkbox/);
 assert.deepEqual(queueSmsMetadata({}),{smsRequested:false,smsDeliveryState:'not_enabled'});
 assert.deepEqual(queueSmsMetadata({smsNotificationConsent:true}),{smsRequested:true,smsDeliveryState:'not_enabled'});
});

test('SMS recipient accepts only supported Ethiopian 09 and 07 numbers',()=>{
 assert.equal(normalizeRecipient('0912345678'),'+251912345678');
 assert.equal(normalizeRecipient('+251791234567'),'+251791234567');
 for(const x of ['0812345678','091234567','+254791234567','','123','090000000000'])
  assert.equal(normalizeRecipient(x),null);
});

test('ticket status messages never disclose ticket numbers, payment details, recipient names or references',()=>{
 const data={phone:'0912345678',smsNotificationConsent:true,name:'Synthetic Sensitive Customer',
  reference:'FTSECRET123',ticketNumbers:[1042,1043],total:100,lotteryName:'Synthetic Private Lottery'};
 for(const status of ['approved','rejected','cancelled']){
  const message=renderTicketStatusSms({...data,status});
  assert.equal(message.to,'+251912345678');
  assert.equal(message.status,status);
  assert.match(message.text,/Tigray Lottery/);
  assert.match(message.text,new RegExp(status));
  assert.ok(message.text.length<=160,'one ASCII SMS segment');
  for(const secret of ['Synthetic','FTSECRET123','1042','1043','100','0912345678'])assert.ok(!message.text.includes(secret));
 }
 assert.equal(renderTicketStatusSms({...data,status:'pending'}),null);
 assert.equal(renderTicketStatusSms({...data,status:'approved',smsNotificationConsent:false}),null);
 assert.equal(renderTicketStatusSms({...data,status:'approved',phone:'invalid'}),null);
});

test('source checkout is opt-in only and approval/rejection/cancellation queue is provider-disabled',()=>{
 const html=fs.readFileSync('buy.html','utf8');
 const js=fs.readFileSync('js/buy.js','utf8');
 const api=fs.readFileSync('api/customer/create-request.js','utf8');
 const approval=fs.readFileSync('api/admin/approvals.js','utf8');
 assert.match(html,/<input id="smsNotificationConsent" type="checkbox">/);
 assert.match(js,/smsNotificationConsent=\$\('smsNotificationConsent'\)\?\.checked===true/);
 assert.match(js,/quantity,smsNotificationConsent,telegramInitData/);
 assert.match(api,/parseSmsConsent\(body.smsNotificationConsent\)/);
 assert.match(api,/smsNotificationConsentAt:FieldValue.serverTimestamp\(\)/);
 assert.equal((approval.match(/queueSmsMetadata\(request\)/g)||[]).length,3);
 assert.ok(!/api\/send\b|api\/bulk_send\b/.test(require('node:fs').readFileSync('lib/ticket-sms-foundation.js','utf8')),
  'Foundation must not send any real SMS');
});
