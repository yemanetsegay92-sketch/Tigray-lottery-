#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const api = fs.readFileSync('api/admin/approvals.js','utf8');
const checkout = fs.readFileSync('api/customer/create-request.js','utf8');
const ui = fs.readFileSync('admin/js/general.js','utf8');
function includes(text, pattern, description) {
  assert.match(text, pattern, description);
}
includes(api, /profile\.role !== 'generalAdmin'/, 'Only general admin may clean up');
includes(api, /body\.confirm !== 'DELETE ' \+ lotteryId/, 'Exact lottery ID required');
includes(api, /body\.acceptIrreversible !== true/, 'Irreversible deletion confirmation required');
includes(api, /cleanupInProgress:true, cleanupPhase:'requests', status:'closed'/, 'Close the lottery before deleting');
includes(api, /cleanupDatePacific\(\)/, 'Timezone-aware daily quota');
includes(api, /CLEANUP_DAILY_DELETE_LIMIT = 5000/, 'Conservative quota cap');
includes(api, /db\.runTransaction\(async tx => \{[\s\S]*?tx\.set\(dailyRef,/, 'Atomic quota and deletes');
includes(api, /where\('lotteryId','==',lotteryId\)/, 'Scope deletions to selected lottery');
includes(api, /db\.collection\('publicStatus'\)\.doc\(phoneHash\)\.collection\('requests'\)\.doc\(item\.id\)/, 'Remove linked public request');
includes(api, /phase === 'finalProofs' \|\| phase === 'incomingProofs'/, 'Sweep finalized and incoming Storage files');
includes(api, /FieldValue\.arrayRemove\(lotteryId\)/, 'Remove lottery from admin assignments');
includes(api, /action:'fullLotteryCleanup'/, 'Keep an audit entry for deletion');
includes(api, /if \(lottery\.cleanupInProgress === true\)/, 'Block approval during cleanup');
includes(api, /selectedLottery\.data\(\)\.cleanupInProgress === true/, 'Block rejection during cleanup');
includes(checkout, /currentLottery\.data\(\)\.cleanupInProgress === true/, 'Prevent late checkouts from creating data');
includes(ui, /'lottery-cleanup-preview'/, 'Show confirmation preview');
includes(ui, /'lottery-cleanup-start'/, 'Start confirmed cleanup');
includes(ui, /'lottery-cleanup-step'/, 'Support resumable cleanup');
assert.doesNotMatch(ui, /await deleteDoc\(doc\(db,'lotteries',id\)\)/, 'Old orphan-producing deletion removed');
console.log('Cleanup authorization, lifecycle and safety checks passed');


// Lightweight request-level tests: no Firebase credentials, network or writes.
// Simulate the full General Admin API handler using in-memory Firestore stubs.
const vm = require('node:vm');
let lottery = {name:'Sandbox only',status:'active'};
const snapshot = data => ({exists:!!data,data:()=>data});
const fakeDb = {
  collection(name) {
    return {
      doc(id) {
        return {
          collection(subName) { return fakeDb.collection(subName); },
          get: async () => snapshot(name==='lotteries' ? (id==='sandbox'?lottery:null) :
            name==='users' ? (id==='general'?{role:'generalAdmin'}:{role:'lotteryAdmin'}) : null),
          update: async changes => { if (name==='lotteries') Object.assign(lottery,changes); }
        };
      },
      where() {
        return {
          where() {return this;},
          count() { return {get: async () => ({data:()=>({count:0})})}; },
          limit() {return {get:async()=>({empty:true,size:0,docs:[]})};}
        };
      }
    };
  },
  async runTransaction(cb) {
    return cb({
      get: ref=>ref.get(),
      update: (ref,changes)=>ref.update(changes)
    });
  }
};
const sandbox = {
  module:{exports:{}}, Buffer,console,process:{env:{}},
  require(spec) {
    if (spec==='crypto') return require('node:crypto');
    if (spec==='../telegram/_lib') return {adminDb:()=>fakeDb,FieldValue:{
      serverTimestamp:()=>new Date(),arrayRemove:value=>({remove:value})
    }};
    if (spec==='firebase-admin/auth') return {getAuth:()=>({verifyIdToken:async token=>({uid:token})})};
    if (spec==='firebase-admin/storage') return {getStorage:()=>({bucket:()=>({})})};
    throw new Error('Unexpected require: '+spec);
  }
};
vm.runInNewContext(api,sandbox,{filename:'approvals.js'});
const handle = sandbox.module.exports;
async function send(uid,body) {
  let code=200,output;
  const res={
    setHeader() {},
    status(status) {code=status;return this;},
    json(value) {output=value;return this;}
  };
  await handle({method:'POST',headers:{authorization:'Bearer '+uid},body},res);
  return {code,output};
}
(async ()=>{
  let r=await send('other',{action:'lottery-cleanup-preview',lotteryId:'sandbox'});
  assert.equal(r.code,403,'Lottery Admin cannot delete lotteries');
  r=await send('general',{action:'lottery-cleanup-preview',lotteryId:'sandbox'});
  assert.equal(r.code,200,'General Admin can preview');
  assert.equal(r.output.requests,0);
  r=await send('general',{action:'lottery-cleanup-start',lotteryId:'sandbox',confirm:'WRONG',acceptIrreversible:true});
  assert.equal(r.code,400,'Incorrect typed confirmation blocks deletion');
  assert.equal(lottery.status,'active','Bad confirmation cannot close lottery');
  r=await send('general',{action:'lottery-cleanup-start',lotteryId:'sandbox',confirm:'DELETE sandbox',acceptIrreversible:true});
  assert.equal(r.code,200,'Typed confirmation starts cleanup');
  assert.equal(lottery.status,'closed','Lottery closes before data removal');
  assert.equal(lottery.cleanupPhase,'requests');
  r=await send('general',{action:'lottery-cleanup-step',lotteryId:'sandbox'});
  assert.equal(r.code,200,'Empty phase advances successfully');
  assert.equal(lottery.cleanupPhase,'tickets','Cleanup progress remains resumable');
  console.log('Mocked General Admin cleanup API tests passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
