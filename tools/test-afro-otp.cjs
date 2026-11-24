'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizePhone,assertEligible,enabled,isLivePilot,keyedHash,verifiedProviderResponse,getClientIp}=require('../lib/afro-otp-core');
const {createOtpService}=require('../lib/afro-otp-service');

const demo={
 LOCAL_EMULATOR_ONLY:'true',GCLOUD_PROJECT:'demo-tigray-wallet',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 AFROMESSAGE_OTP_ENABLED:'true',AFROMESSAGE_MOCK_PROVIDER:'true',
 AFROMESSAGE_PHONE_HASH_KEY:'mock-32-character-secret-not-for-real-usage'
};
class MemoryDb{
 constructor(){this.docs=new Map();this.chain=Promise.resolve();}
 collection(collection){return {doc:id=>{
  const key=collection+'/'+id,db=this;
  return {key,async get(){return db.read(key)},async update(data){
   if(!db.docs.has(key))throw new Error('Not found');db.docs.set(key,{...db.docs.get(key),...data});
  }};
 }};}
 read(key){const item=this.docs.get(key);return {exists:!!item,data:()=>item||undefined};}
 async runTransaction(fn){
  const operation=this.chain.then(async()=>{
   const writes=[],tx={
    get:async ref=>this.read(ref.key),
    create:(ref,value)=>writes.push({type:'create',key:ref.key,value}),
    set:(ref,value,opts)=>writes.push({type:'set',key:ref.key,value,merge:opts?.merge}),
    update:(ref,value)=>writes.push({type:'update',key:ref.key,value})
   };
   const result=await fn(tx);
   for(const w of writes){
    if(w.type==='create'&&this.docs.has(w.key))throw new Error('duplicate create');
    if(w.type==='update'&&!this.docs.has(w.key))throw new Error('missing document');
    const original=this.docs.get(w.key)||{};
    this.docs.set(w.key,w.type==='create'||w.merge===false?w.value:{...original,...w.value});
   }
   return result;
  });
  this.chain=operation.catch(()=>{});
  return operation;
 }
}
class MockAuth{
 constructor(){this.people=new Map();this.tokens=[];}
 async getUserByPhoneNumber(phone){
  const person=this.people.get(phone);
  if(!person)throw Object.assign(new Error('not found'),{code:'auth/user-not-found'});
  return person;
 }
 async createUser({phoneNumber}){
  const p={uid:'generated-user-1',phoneNumber,disabled:false};
  this.people.set(phoneNumber,p);return p;
 }
 async createCustomToken(uid){this.tokens.push(uid);return 'offline-synthetic-token';}
}
function fixture(){
 const db=new MemoryDb(),auth=new MockAuth();let now=1795554000000;
 let sent=0,checked=0,badReply=false;
 const provider={
  async sendOtp(phone){sent++;return {verificationId:'mock-verification-id-001'};},
  async verifyOtp(phone,verificationId,code){
   checked++;
   if(badReply)return {acknowledge:'success',response:{phone:'+251700000000',verificationId,code}};
   if(code!=='123456')return {acknowledge:'error',response:{errors:['incorrect']}};
   return {acknowledge:'success',response:{phone,verificationId,code}};
  }
 };
 const service=createOtpService({db,auth,provider,env:demo,clock:()=>now});
 return {db,auth,provider,service,get sent(){return sent},get checked(){return checked},
  setNow:value=>{now=value},badReply:value=>{badReply=value}};
}
test('normalizes two Ethiopian operators and rejects other prefixes',()=>{
 assert.equal(normalizePhone('0912345678'),'+251912345678');
 assert.equal(normalizePhone('+251791234567'),'+251791234567');
 assert.equal(normalizePhone('251791234567'),'+251791234567');
 for(const x of ['0812345678','091234567','+254712345678',''])assert.throws(()=>normalizePhone(x));
});
test('production sends fail closed without explicit pilot credentials, even with public flags',()=>{
 assert.equal(enabled({}),false);
 const env={VERCEL_ENV:'production',AFROMESSAGE_OTP_ENABLED:'true',
  AFROMESSAGE_API_TOKEN:'token',AFROMESSAGE_PHONE_HASH_KEY:'012345678901234567890123456789ab',
  AFROMESSAGE_COMMERCIAL_APPROVED:'true',AFROMESSAGE_PUBLIC_REGISTRATION_ENABLED:'true'};
 assert.equal(enabled(env),true);
 assert.throws(()=>assertEligible('+251912345678',env),/pilot/);
 assert.throws(()=>getClientIp({headers:{'x-forwarded-for':'1.2.3.4, 5.6.7.8'}},env),/connection/);
 assert.equal(getClientIp({headers:{'x-forwarded-for':'1.2.3.4'}},env),'1.2.3.4');
});
test('provider acknowledgement alone never proves ownership',()=>{
 assert.equal(verifiedProviderResponse({acknowledge:'success',response:{}},'+251912345678','vc','123456'),false);
 assert.equal(verifiedProviderResponse({acknowledge:'success',response:{
  phone:'+251912345678',verificationId:'vc',code:'123456'
 }},'+251912345678','vc','123456'),true);
});
test('OTP success issues a single Firebase custom token and preserves UID',async()=>{
 const t=fixture(),phone='+251912345678';
 t.auth.people.set(phone,{uid:'existing-customer-uid',phoneNumber:phone,disabled:false});
 const {challengeId}=await t.service.start({phone:'0912345678',ip:'127.0.0.1'});
 assert.equal(t.sent,1);
 const result=await t.service.verify({challengeId,code:'123456'});
 assert.equal(result.customToken,'offline-synthetic-token');
 assert.deepEqual(t.auth.tokens,['existing-customer-uid']);
 await assert.rejects(()=>t.service.verify({challengeId,code:'123456'}),/invalid|already used/i);
 assert.equal(t.checked,1);
});
test('an incorrect code can be retried but attempts are capped',async()=>{
 const t=fixture(),{challengeId}=await t.service.start({phone:'0791234567',ip:'127.0.0.1'});
 for(let i=0;i<5;i++)await assert.rejects(()=>t.service.verify({challengeId,code:'999999'}),/Incorrect/);
 await assert.rejects(()=>t.service.verify({challengeId,code:'123456'}),/invalid|expired/i);
 assert.equal(t.auth.tokens.length,0);
});
test('cross-phone provider response cannot mint any Firebase token',async()=>{
 const t=fixture(),{challengeId}=await t.service.start({phone:'0912345678',ip:'127.0.0.1'});
 t.badReply(true);
 await assert.rejects(()=>t.service.verify({challengeId,code:'123456'}),/Incorrect/);
 assert.equal(t.auth.tokens.length,0);
});
test('SMS budgets and expired challenges fail closed',async()=>{
 const t=fixture();
 for(let i=0;i<3;i++)await t.service.start({phone:'0912345678',ip:'127.0.0.1'});
 await assert.rejects(()=>t.service.start({phone:'0912345678',ip:'127.0.0.1'}),/Too many/);
 const x=await t.service.start({phone:'0791234567',ip:'127.0.0.1'});
 t.setNow(1795554000000+301000);
 await assert.rejects(()=>t.service.verify({challengeId:x.challengeId,code:'123456'}),/expired/);
});
test('customer OTP cannot sign in an existing admin account',async()=>{
 const t=fixture(),phone='+251912345678';
 t.auth.people.set(phone,{uid:'privileged-user',phoneNumber:phone,disabled:false,customClaims:{admin:true}});
 const x=await t.service.start({phone,ip:'127.0.0.1'});
 await assert.rejects(()=>t.service.verify({challengeId:x.challengeId,code:'123456'}),/cannot use customer/);
 assert.equal(t.auth.tokens.length,0);
});

test('real-SMS mode can run only in locally isolated emulators and only for explicitly verified test contact',()=>{
 const phone='+251912345678';
 const env={
  LOCAL_EMULATOR_ONLY:'true',GCLOUD_PROJECT:'demo-tigray-wallet',GOOGLE_CLOUD_PROJECT:'demo-tigray-wallet',
  FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
  VERCEL_ENV:'preview',AFROMESSAGE_LIVE_PILOT:'true',AFROMESSAGE_OTP_ENABLED:'true',
  AFROMESSAGE_MOCK_PROVIDER:'false',AFROMESSAGE_API_TOKEN:'offline-placeholder-not-a-real-token',
  AFROMESSAGE_PHONE_HASH_KEY:'synthetic-hmac-secret-longer-than-32-characters'
 };
 env.AFROMESSAGE_PILOT_PHONE_HASHES=keyedHash(phone,env);
 assert.equal(isLivePilot(env),true);
 assert.equal(enabled(env),true);
 assert.doesNotThrow(()=>assertEligible(phone,env));
 assert.throws(()=>assertEligible('+251912345679',env),/not available/);
 assert.equal(getClientIp({headers:{}},env),'127.0.0.1');
 for(const bad of [
  {...env,AFROMESSAGE_API_TOKEN:''},
  {...env,VERCEL_ENV:'production'},
  {...env,GCLOUD_PROJECT:'tigiray-lottery'},
  {...env,FIRESTORE_EMULATOR_HOST:''},
  {...env,AFROMESSAGE_MOCK_PROVIDER:'true'},
  {...env,AFROMESSAGE_LIVE_PILOT:'false'}
 ])assert.equal(isLivePilot(bad),false);
});
