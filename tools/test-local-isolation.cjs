'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {assertLocalEmulatorEnvironment,assertLocalUrl}=require('../lib/local-emulator-guard');
test('local browser config is demo-only and connects both emulators without production fallback',()=>{
 const source=fs.readFileSync('firebase.local.js','utf8');
 assert.match(source,/projectId:'demo-tigray-wallet'/);
 assert.match(source,/connectFirestoreEmulator\(db,'127\.0\.0\.1',8080\)/);
 assert.match(source,/connectAuthEmulator\(auth,'http:\/\/127\.0\.0\.1:9099'/);
 assert.doesNotMatch(source,/tigiray-lottery|AIzaSyC_D/);
 assert.match(source,/health\.ok|status\.firestore/);
});
test('Admin emulator guard rejects credentials, production projects, and missing emulator hosts',()=>{
 const valid={LOCAL_EMULATOR_ONLY:'true',GCLOUD_PROJECT:'demo-tigray-wallet',GOOGLE_CLOUD_PROJECT:'demo-tigray-wallet',
  FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
 assert.equal(assertLocalEmulatorEnvironment(valid).projectId,'demo-tigray-wallet');
 for(const change of [{GCLOUD_PROJECT:'tigiray-lottery'},{FIRESTORE_EMULATOR_HOST:''},{FIREBASE_AUTH_EMULATOR_HOST:''},{FIREBASE_SERVICE_ACCOUNT_JSON:'{}'}])
  assert.throws(()=>assertLocalEmulatorEnvironment({...valid,...change}),/requires|must use|forbidden/);
});
test('local provider override and server fetch policy reject every non-local URL',()=>{
 assert.equal(assertLocalUrl('http://127.0.0.1:4174/mock/checket').hostname,'127.0.0.1');
 for(const url of ['https://api.check.et/api/v1/verify','https://firestore.googleapis.com','https://identitytoolkit.googleapis.com','https://tigiray-lottery.firebaseapp.com'])
  assert.throws(()=>assertLocalUrl(url),/blocked/);
 const server=fs.readFileSync('tools/local/local-server.cjs','utf8');
 assert.match(server,/globalThis\.fetch=.*assertLocalUrl/s);
 assert.match(server,/WALLET_PRODUCTION_MUTATIONS_ENABLED:'false'/);
 assert.doesNotMatch(server,/FIREBASE_SERVICE_ACCOUNT_JSON\s*:/);
});
