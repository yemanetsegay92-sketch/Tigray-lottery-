'use strict';
// Security Rules tests on the local Firestore emulator only.
// Uses synthetic users and the public web SDK (never production credentials).
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { collection, doc, getDoc, setDoc, updateDoc, deleteDoc, deleteField, serverTimestamp, writeBatch } = require('firebase/firestore');
if(!process.env.FIRESTORE_EMULATOR_HOST ||
   !/^demo-/.test(String(process.env.GCLOUD_PROJECT||''))) {
  throw new Error('Security Rules tests require isolated demo- Firestore emulator.');
}
let testEnv, general, assigned, unassigned, anonymous;
function validLottery(overrides={}){
  return {name:'Synthetic lottery',description:'',price:100,min:1,max:999,
    status:'active',approvalMode:'manual',createdAt:new Date(),adminIds:[],nextTicketNumber:1,
    awards:['First Prize'],paymentAccounts:[{bank:'CBE',number:'1000123456789',holderName:'Test Holder'}],
    ...overrides};
}
before(async()=>{
  testEnv=await initializeTestEnvironment({
    projectId:process.env.GCLOUD_PROJECT,
    firestore:{rules:fs.readFileSync('firestore.rules','utf8')}
  });
  await testEnv.withSecurityRulesDisabled(async context=>{
    const db=context.firestore();
    await Promise.all([
      setDoc(doc(db,'users','admin-1'),{role:'generalAdmin',lotteryIds:[]}),
      setDoc(doc(db,'users','lottery-1'),{role:'lotteryAdmin',lotteryIds:['lot-a']}),
      setDoc(doc(db,'users','lottery-2'),{role:'lotteryAdmin',lotteryIds:['lot-b']}),
      setDoc(doc(db,'users','buyer-1'),{role:'buyer'}),
      setDoc(doc(db,'lotteries','lot-a'),validLottery()),
      setDoc(doc(db,'lotteries','legacy-lot'),{
        name:'Legacy lottery',description:'',price:100,min:1,max:999,
        status:'closed',createdAt:new Date(),adminIds:[],nextTicketNumber:1
      }),
      setDoc(doc(db,'ticketRequests','req-1'),{lotteryId:'lot-a',status:'pending',total:100}),
      setDoc(doc(db,'paymentClaims','claim-1'),{requestId:'req-1',status:'consumed'}),
      setDoc(doc(db,'tickets','lot-a_10'),{lotteryId:'lot-a',requestId:'req-1',number:10}),
      setDoc(doc(db,'publicStatus','hashed-phone','requests','req-1'),{lotteryId:'lot-a',status:'pending'})
    ]);
  });
  general=testEnv.authenticatedContext('admin-1');
  assigned=testEnv.authenticatedContext('lottery-1');
  unassigned=testEnv.authenticatedContext('lottery-2');
  anonymous=testEnv.unauthenticatedContext();
});
after(async()=>{if(testEnv)await testEnv.cleanup();});

test('bank claim ledger remains inaccessible even to a logged-in general admin',async()=>{
  for(const c of [general,assigned,unassigned,anonymous]){
    const r=doc(c.firestore(),'paymentClaims','claim-1');
    await assertFails(getDoc(r));
    await assertFails(setDoc(r,{requestId:'attacker',status:'consumed'}));
    await assertFails(deleteDoc(r));
  }
});
test('no browser account can forge a ticket approval, ticket, or request creation',async()=>{
  for(const c of [general,assigned,unassigned,anonymous]){
    await assertFails(updateDoc(doc(c.firestore(),'ticketRequests','req-1'),{status:'approved',ticketNumbers:[10]}));
    await assertFails(setDoc(doc(c.firestore(),'ticketRequests','req-new-'+c.app?.name),{status:'approved',lotteryId:'lot-a'}));
    await assertFails(setDoc(doc(c.firestore(),'tickets','lot-a_11'),{lotteryId:'lot-a',number:11}));
    await assertFails(deleteDoc(doc(c.firestore(),'tickets','lot-a_10')));
  }
});
test('only assigned lottery admin or general admin can view private purchase and ticket',async()=>{
  await assertSucceeds(getDoc(doc(general.firestore(),'ticketRequests','req-1')));
  await assertSucceeds(getDoc(doc(assigned.firestore(),'ticketRequests','req-1')));
  await assertSucceeds(getDoc(doc(assigned.firestore(),'tickets','lot-a_10')));
  await assertFails(getDoc(doc(unassigned.firestore(),'ticketRequests','req-1')));
  await assertFails(getDoc(doc(unassigned.firestore(),'tickets','lot-a_10')));
  await assertFails(getDoc(doc(anonymous.firestore(),'ticketRequests','req-1')));
});
test('only general admin can assign users and create lotteries',async()=>{
  await assertSucceeds(updateDoc(doc(general.firestore(),'users','lottery-1'),{lotteryIds:['lot-a','lot-b']}));
  await assertFails(updateDoc(doc(assigned.firestore(),'users','lottery-1'),{role:'generalAdmin'}));
  await assertFails(setDoc(doc(assigned.firestore(),'lotteries','illegal-lot'),{status:'active'}));
  await assertFails(setDoc(doc(anonymous.firestore(),'users','fake-admin'),{role:'generalAdmin'}));
  await assertFails(setDoc(doc(general.firestore(),'lotteries','invalid-lot'),{status:'active',price:100}));
  await assertSucceeds(setDoc(doc(general.firestore(),'lotteries','approved-lot'),validLottery()));
  const missingMode=validLottery();delete missingMode.approvalMode;
  await assertFails(setDoc(doc(general.firestore(),'lotteries','missing-mode'),missingMode));
  await assertFails(setDoc(doc(general.firestore(),'lotteries','bad-mode'),validLottery({approvalMode:'sometimes'})));
  await assertSucceeds(setDoc(doc(general.firestore(),'lotteries','automatic-lot'),validLottery({approvalMode:'automatic'})));
});
test('General Admin can atomically create an automatic lottery and matching audit record',async()=>{
  const db=general.firestore();
  const lotteryRef=doc(collection(db,'lotteries'));
  const auditRef=doc(collection(db,'auditLogs'));
  const batch=writeBatch(db);
  batch.set(lotteryRef,validLottery({approvalMode:'automatic',createdAt:serverTimestamp()}));
  batch.set(auditRef,{action:'createLottery',lotteryId:lotteryRef.id,
    approvalMode:'automatic',adminId:'admin-1',createdAt:serverTimestamp(),
    paymentAccountBanks:['CBE']});
  await assertSucceeds(batch.commit());
});
test('lottery writes enforce the full schema and protect server allocation fields',async()=>{
  const ref=doc(assigned.firestore(),'lotteries','lot-a');
  await assertSucceeds(updateDoc(ref,{name:'Assigned admin edit'}));
  await assertSucceeds(updateDoc(ref,{paymentAccounts:[{bank:'CBE',number:'1000999999999',holderName:'Changed Holder'}]}));
  await assertFails(updateDoc(ref,{nextTicketNumber:900}));
  await assertFails(updateDoc(ref,{cleanupInProgress:true}));
  await assertFails(updateDoc(ref,{approvalMode:'automatic'}));
  await assertFails(updateDoc(ref,{approvalMode:deleteField()}));
  await assertFails(updateDoc(doc(general.firestore(),'lotteries','lot-a'),{nextTicketNumber:900}));
  await assertFails(updateDoc(doc(general.firestore(),'lotteries','lot-a'),{cleanupInProgress:true}));
  await assertFails(updateDoc(doc(general.firestore(),'lotteries','lot-a'),{extraData:'schema pollution'}));
  await assertSucceeds(updateDoc(doc(general.firestore(),'lotteries','legacy-lot'),{name:'Legacy edit'}));
  await assertSucceeds(updateDoc(doc(general.firestore(),'lotteries','legacy-lot'),{awards:['First Prize']}));
  await assertFails(updateDoc(doc(general.firestore(),'lotteries','legacy-lot'),{approvalMode:'automatic'}));
  await assertFails(updateDoc(doc(general.firestore(),'lotteries','legacy-lot'),{awards:deleteField()}));
  await assertFails(updateDoc(doc(general.firestore(),'lotteries','lot-a'),{paymentAccounts:deleteField()}));
});
test('buyer status is public-readable but no browser role can forge approved status',async()=>{
  await assertSucceeds(getDoc(doc(anonymous.firestore(),'publicStatus','hashed-phone','requests','req-1')));
  for (const c of [general,assigned,unassigned,anonymous]) {
    await assertFails(updateDoc(doc(c.firestore(),'publicStatus','hashed-phone','requests','req-1'),{status:'approved'}));
  }
});
test('server-owned queues and replay records reject every browser role',async()=>{
  for (const c of [general,assigned,unassigned,anonymous]) {
    await assertFails(setDoc(doc(c.firestore(),'autoPaymentQueue','req-1'),{state:'pending'}));
    await assertFails(getDoc(doc(c.firestore(),'autoApprovalActivations','lot-a')));
    await assertFails(setDoc(doc(c.firestore(),'autoApprovalActivations','lot-a'),{enabled:true}));
    await assertFails(setDoc(doc(c.firestore(),'buyerNotificationQueue','req-1'),{state:'pending'}));
    await assertFails(setDoc(doc(c.firestore(),'receiptUploadClaims','claim-2'),{requestId:'req-1'}));
  }
});
