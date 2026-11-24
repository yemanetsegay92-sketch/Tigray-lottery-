'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const path=require('node:path');

async function errorMessage(error){
 const moduleUrl=pathToFileURL(path.join(__dirname,'../js/phoneAuthErrors.mjs')).href;
 const {phoneAuthErrorMessage}=await import(moduleUrl);
 return phoneAuthErrorMessage(error);
}

test('Firebase backend error 39 is translated without exposing an internal code',async()=>{
 const visible=await errorMessage({code:'auth/error-code:-39',message:'Firebase: Error (auth/error-code:-39).'});
 assert.match(visible,/temporarily unavailable/i);
 assert.doesNotMatch(visible,/-39|backendError|Firebase/i);
});

test('HTTP 503 backendError detail is translated even when Firebase supplies a generic code',async()=>{
 const visible=await errorMessage({code:'auth/internal-error',message:'503 Service Unavailable: backendError'});
 assert.match(visible,/temporarily unavailable/i);
 assert.doesNotMatch(visible,/503|backend/i);
});

test('phone authentication errors give customers focused recovery guidance',async()=>{
 assert.match(await errorMessage({code:'auth/invalid-phone-number'}),/09 or 07/);
 assert.match(await errorMessage({code:'auth/captcha-check-failed'}),/security check/i);
 assert.match(await errorMessage({code:'auth/too-many-requests'}),/wait/i);
 assert.match(await errorMessage({code:'auth/network-request-failed'}),/connection/i);
 assert.match(await errorMessage({code:'auth/invalid-verification-code'}),/incorrect/i);
 assert.match(await errorMessage({code:'auth/code-expired'}),/expired/i);
});
