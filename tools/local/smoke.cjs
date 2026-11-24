'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {assertLocalUrl}=require('../../lib/local-emulator-guard');
const BASE='http://127.0.0.1:4174';
(async()=>{
 for(const url of ['https://firestore.googleapis.com','https://identitytoolkit.googleapis.com','https://api.check.et/api/v1/verify'])
  assert.throws(()=>assertLocalUrl(url),/blocked/);
 const health=await fetch(BASE+'/__local/health').then(async response=>({status:response.status,data:await response.json()}));
 assert.equal(health.status,200);assert.deepEqual(health.data,{ok:true,projectId:'demo-tigray-wallet',firestore:true,auth:true});
 const browserConfig=await fetch(BASE+'/firebase.js').then(response=>response.text());
 assert.match(browserConfig,/demo-tigray-wallet/);assert.match(browserConfig,/connectFirestoreEmulator/);assert.match(browserConfig,/connectAuthEmulator/);
 assert.doesNotMatch(browserConfig,/tigiray-lottery|AIzaSyC_D/);
 assert.doesNotMatch(browserConfig,/https:\/\/www\.gstatic\.com/);
 for(const module of ['firebase-app.js','firebase-auth.js','firebase-firestore.js']){
  const response=await fetch(BASE+'/__local/'+module);assert.equal(response.status,200);
  assert.doesNotMatch(await response.text(),/https:\/\/www\.gstatic\.com\/firebasejs/);
 }
 const login=await fetch(BASE+'/local-login').then(response=>response.text());
 assert.match(login,/LOCAL EMULATOR ONLY/);
 const checkout=await fetch(BASE+'/buy.html?lot=local-rf-lottery').then(response=>response.text());
 assert.doesNotMatch(checkout,/https:\/\/telegram\.org|https:\/\/www\.gstatic\.com/);
 assert.match(checkout,/\/__local\/telegram-web-app\.js/);
 const unauthorized=await fetch(BASE+'/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'wallet-summary'})});
 assert.equal(unauthorized.status,401);
 const mocked=await fetch(BASE+'/mock/checket',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({bank:'cbe',transaction_number:'FTLOCALDEPOSIT01',account_number:'1000000000001'})}).then(response=>response.json());
 assert.equal(mocked.exists,true);assert.equal(mocked.data.receipt.amount,100);
 const localServer=fs.readFileSync('tools/local/local-server.cjs','utf8');
 assert.match(localServer,/assertLocalUrl\(raw\)/);assert.match(localServer,/delete process\.env\.FIREBASE_SERVICE_ACCOUNT_JSON/);
 console.log('PASS: browser, Admin API and Check.et are pinned to localhost demo emulators.');
})().catch(error=>{console.error(error);process.exitCode=1;});
