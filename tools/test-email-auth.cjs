'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {normalizeContactPhone,verifiedCustomerIdentity}=require('../lib/wallet-core');
const {normalizeReceivingAccount,normalizeHolderName,publicReceiver}=require('../lib/wallet-company-config');

test('verified customer identity accepts verified email and preserves verified phone',()=>{
 assert.deepEqual(verifiedCustomerIdentity({uid:'email-user',email:'Customer@Example.COM',email_verified:true}),{
  type:'email',key:'customer@example.com',phone:'',email:'customer@example.com'
 });
 assert.deepEqual(verifiedCustomerIdentity({uid:'phone-user',phone_number:'+251911000001'}),{
  type:'phone',key:'0911000001',phone:'0911000001',email:''
 });
 assert.throws(()=>verifiedCustomerIdentity({uid:'unverified',email:'customer@example.com',email_verified:false}),/verified/i);
 assert.equal(normalizeContactPhone('07 11 000 001'),'0711000001');
});

test('email authentication errors are clear without revealing account details',async()=>{
 const {emailAuthErrorMessage}=await import('../js/emailAuthErrors.mjs');
 assert.match(emailAuthErrorMessage({code:'auth/email-already-in-use'}),/already exists/i);
 assert.match(emailAuthErrorMessage({code:'auth/invalid-credential'}),/email or password is incorrect/i);
 assert.match(emailAuthErrorMessage({code:'auth/too-many-requests'}),/wait/i);
 assert.equal(emailAuthErrorMessage(new Error('Enter a valid Ethiopian mobile number (09 or 07).')),'Enter a valid Ethiopian mobile number (09 or 07).');
});

test('central CBE receiver validation exposes only customer-safe fields',()=>{
 assert.equal(normalizeReceivingAccount('1000 1234 5678 9'),'1000123456789');
 assert.equal(normalizeHolderName('  Tigray Lottery PLC  '),'Tigray Lottery PLC');
 assert.deepEqual(publicReceiver({receivingAccount:'1000123456789',receivingHolderName:'Tigray Lottery PLC'}),{
  configured:true,bank:'CBE',account:'1000123456789',holderName:'Tigray Lottery PLC'
 });
 assert.throws(()=>normalizeReceivingAccount('1234'),/8 to 30 digits/i);
});
