'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');const {createRequire}=require('node:module');
const filename=require.resolve('../api/admin/approvals');const realRequire=createRequire(filename);
function harness(environment,profile={role:'lotteryAdmin',lotteryIds:['assigned']}){
 let dbCalls=0,reviews=0;const module={exports:{}};
 const db={collection:name=>({doc:id=>({get:async()=>({exists:true,data:()=>profile})})})};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,process:{env:{VERCEL_ENV:environment}},Buffer,console,
 require:spec=>{
  if(spec==='../telegram/_lib')return {adminDb:()=>{dbCalls++;return db},FieldValue:{}};
  if(spec==='firebase-admin/auth')return {getAuth:()=>({verifyIdToken:async()=>({uid:'fixture-admin'})})};
  if(spec==='../../lib/admin-payment-review')return {reviewAction:async()=>{reviews++;return {revision:1}},reviewInput:()=>({}),checkRevision:()=>{}};
  return realRequire(spec);
 }},{filename});
 return {counts:()=>({dbCalls,reviews}),async call(action,lotteryId='assigned'){
  let status,result;const res={setHeader(){},status(n){status=n;return this},json(value){result=value;return this}};
  await module.exports({method:'POST',headers:{authorization:'Bearer fixture'},body:{action,requestId:'fixture',lotteryId,confirmCharge:true,revision:0,bank:'cbe',correctedReference:'FTFIXTURE12345'}},res);
  return {status,result};
 }};
}
for(const environment of ['preview','production',undefined])test('legacy diagnostics never reach Firebase/provider even with confirmation: '+environment,async()=>{
 const h=harness(environment);for(const action of ['checket-match-pending','checket-verify']){
  const response=await h.call(action);assert.equal(response.status,403);assert.equal(response.result.code,'PREVIEW_DIAGNOSTIC_DISABLED');assert.equal(response.result.readOnly,undefined);
 }assert.deepEqual(h.counts(),{dbCalls:0,reviews:0});
});
test('Preview cannot route any review or purchase decision to a shared production database',async()=>{
 const h=harness('preview');for(const action of ['review-details','review-save','review-duplicate','review-verify','approve','reject','cancel'])assert.equal((await h.call(action)).status,403);
 assert.deepEqual(h.counts(),{dbCalls:0,reviews:0});
});
test('production assigned Lottery Admin review remains intentional and authorized',async()=>{
 const h=harness('production');assert.equal((await h.call('review-save')).status,200);assert.equal(h.counts().reviews,1);
 assert.equal((await h.call('review-save','unassigned')).status,403);assert.equal(h.counts().reviews,1);
});
test('review helper independently refuses Preview before reading or writing Firebase',async()=>{
 const {reviewAction}=require('../lib/admin-payment-review');
 const db=new Proxy({},{get(){throw Error('Firebase must not be touched')}});
 await assert.rejects(reviewAction(db,{uid:'fixture'},{action:'review-details',requestId:'fixture',lotteryId:'assigned'},{env:{VERCEL_ENV:'preview'}}),e=>e.statusCode===403);
});
