'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {evaluateAutoPayment,nameKey}=require('../lib/cbe-auto-eligibility');
const {enabledFor,checkWorkerSecret,inspectRequest,processOne}=require('../lib/cbe-auto-worker');
const {cutoverMs,isAfterCutover}=require('../lib/cbe-auto-cutover');
const created=new Date(Date.now()-10*60000).toISOString();
const purchase={status:'pending',lotteryId:'safe-lottery',reference:'FTTEST12345',
  total:1000,quantity:1,createdAt:created};
const lottery={status:'active',paymentAccounts:[{
  bank:'CBE',number:'1000123456789',holderName:'MAHLIET TSEGAY GIDEY'
}]};
const verification={bank:'cbe',reportedBank:'cbe',verified:true,status:'completed',verificationMethod:'official',
  providerDuplicate:false,providerCbeAccountCheck:true,
  receiverAccountStatus:'masked_unverifiable',maskedReceiverSuffix:'6789',
  receiverName:'Mrs Mahliet Tsegay Gidey',currency:'ETB',amount:1000,
  reportedTransactionNumber:'FTTEST12345',
  transactionDate:new Date(Date.now()-9*60000).toISOString()};
const unused={claimStatus:'unused',otherCount:0,otherApprovedCount:0,truncated:false};
const env={VERCEL_ENV:'production',LOTTERY_CBE_AUTO_APPROVAL_ENABLED:'true',
  LOTTERY_CBE_AUTO_APPROVAL_START_AT:new Date(Date.now()-40*60000).toISOString(),
  LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS:'safe-lottery',
  CHECK_ET_API_KEY:'not-real-provider-key',
  LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET:'A'.repeat(45)};
function assess(v={},p=purchase,l=lottery,d=unused){
  return evaluateAutoPayment({purchase:p,lottery:l,verification:{...verification,...v},duplicate:d});
}
function fakeDb({p=purchase,l=lottery,claim=false,other=[]}={}){
  const logs=[];
  return {
    logs,
    collection(name){
      return {
        doc(id){
          return {
            async get(){
              if(name==='ticketRequests')return {id,exists:!!p,data:()=>p};
              if(name==='lotteries')return {id,exists:!!l,data:()=>l};
              if(name==='paymentClaims')return {id,exists:!!claim,data:()=>({requestId:'different'})};
              if(name==='autoPaymentQueue')return {id,exists:true,data:()=>({attempts:1})};
              throw Error('unexpected collection '+name);
            },
            async update(update){logs.push({name,id,update})}
          };
        },
        where(field,op,value){
          assert.equal(name,'ticketRequests');
          assert.equal(field,'reference');assert.equal(op,'==');
          return {limit(n){assert.equal(n,21);return {get:async()=>({
            docs:other.map((o,i)=>({id:o.id||'other-'+i,data:()=>o})),
            size:other.length
          })}}};
        }
      };
    }
  };
}
test('reference and screenshot payment become eligible after official receipt verification',()=>{
  assert.equal(assess().eligible,true);
  assert.equal(assess({}, {...purchase,reference:''}).eligible,true);
  assert.equal(nameKey('Mrs Mahliet Tsegay Gidey'),'MAHLIET TSEGAY GIDEY');
});
test('no CBE account configured, wrong receiving holder, or wrong suffix prevents approval',()=>{
  assert.equal(assess({receiverName:'Other Person'}).eligible,false);
  assert.equal(assess({maskedReceiverSuffix:'0000'}).eligible,false);
  assert.equal(assess({maskedReceiverSuffix:''}).eligible,false);
  assert.equal(assess({},purchase,{...lottery,paymentAccounts:[]}).eligible,false);
  assert.equal(assess({},purchase,{...lottery,paymentAccounts:[
    ...lottery.paymentAccounts,{bank:'CBE',number:'1000999912345',holderName:'Other'}
  ]}).eligible,false);
});
test('forged, unconfirmed, duplicated, unverified receiver checks never qualify',()=>{
  for(const change of [
    {verified:false},{status:'pending'},{verificationMethod:'ocr'},
    {providerDuplicate:true},{providerCbeAccountCheck:false},
    {receiverAccountStatus:'masked_suffix_mismatch'},
    {amount:900},{currency:'USD'},{reportedTransactionNumber:'FTWRONGREF88'}
  ])assert.equal(assess(change).eligible,false,JSON.stringify(change));
});
test('stale 16-day receipt, missing bank time, and future bank time never qualify',()=>{
  for(const date of [null,new Date(Date.now()-16*86400000).toISOString(),
    new Date(Date.now()+60*60000).toISOString()])
    assert.equal(assess({transactionDate:date}).eligible,false);
});
test('amount only 0.01 birr off is rejected',()=>{
  assert.equal(assess({amount:1000.01}).eligible,false);
});
test('claim consumed or another pending purchase with reference blocks auto approval',()=>{
  assert.equal(assess({},purchase,lottery,{...unused,claimStatus:'used_by_another_request'}).eligible,false);
  assert.equal(assess({},purchase,lottery,{...unused,otherCount:1}).eligible,false);
});
test('automation is disabled absent explicit production, backfill, key and allowlist gates',()=>{
  assert.equal(enabledFor('safe-lottery',env),true);
  for(const overrides of [
    {VERCEL_ENV:'preview'}, {LOTTERY_CBE_AUTO_APPROVAL_ENABLED:'false'},
    {LOTTERY_CBE_AUTO_APPROVAL_START_AT:''},
    {LOTTERY_CBE_AUTO_APPROVAL_LOTTERY_IDS:'other-lottery'}, {CHECK_ET_API_KEY:''}
  ])assert.equal(enabledFor('safe-lottery',{...env,...overrides}),false);
});
test('cron requires constant-time matching secret and cannot run with missing secret',()=>{
  assert.equal(checkWorkerSecret({headers:{authorization:'Bearer '+env.LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET}},env),true);
  assert.equal(checkWorkerSecret({headers:{authorization:'Bearer '+env.LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET.slice(0,-1)+'B'}},env),false);
  assert.equal(checkWorkerSecret({headers:{authorization:'Bearer 😀'.repeat(45)}},env),false);
  assert.equal(checkWorkerSecret({headers:{}},{...env,LOTTERY_CBE_AUTO_APPROVAL_CRON_SECRET:''}),false);
});
test('inspector safely verifies a reference and checks global claim',async()=>{
  const db=fakeDb();let calls=0;
  const result=await inspectRequest(db,'req-1',{env,verify:async input=>{
    calls++;assert.equal(input.bank,'cbe');assert.equal(input.accountNumber,'1000123456789');
    assert.equal(input.transactionNumber,'FTTEST12345');
    return verification;
  }});
  assert.equal(calls,1);
  assert.equal(result.decision,'eligible');
  assert.equal(result.immutableGuard.reference,'FTTEST12345');
});
test('inspector uses previously stored private image/PDF only when buyer omitted reference',async()=>{
  const db=fakeDb({p:{...purchase,reference:'',proofPath:'payment-proofs/safe-lottery/final.pdf'}});
  let downloaded=0;
  const result=await inspectRequest(db,'req-2',{env,
    readReceipt:async()=>{downloaded++;return {buffer:Buffer.from('%PDF test'),mime:'application/pdf'}},
    verify:async input=>{assert.equal(input.transactionNumber,undefined);assert.equal(input.receiptFile.mime,'application/pdf');return verification}
  });
  assert.equal(downloaded,1);
  assert.equal(result.decision,'eligible');
});
test('no production env gate means verification is never attempted',async()=>{
  const db=fakeDb();
  const result=await inspectRequest(db,'req-3',{env:{...env,VERCEL_ENV:'preview'},
    verify:()=>{throw Error('must not contact Check.et')}});
  assert.equal(result.decision,'disabled');
});
test('valid candidate calls the actual atomic approval hook; queue records success',async()=>{
  const db=fakeDb();let approved=0;
  const state=await processOne(db,'req-1',{env,verify:async()=>verification,
    approve:async(id,lot,ref,guard)=>{
      approved++;assert.equal(id,'req-1');assert.equal(lot,'safe-lottery');
      assert.equal(ref,'FTTEST12345');assert.equal(guard.policy,'CBE_UNATTENDED_V1');
    }});
  assert.equal(state,'approved');assert.equal(approved,1);
  assert.equal(db.logs.at(-1).update.state,'approved');
});
test('amount mismatch results in manual review, no issuance callback invoked',async()=>{
  const db=fakeDb();
  const state=await processOne(db,'req-1',{env,verify:async()=>({...verification,amount:200}),
    approve:()=>{throw Error('must not approve');}});
  assert.equal(state,'manual_review');
  assert.equal(db.logs.at(-1).update.state,'manual_review');
});
test('provider outages are retried with backoff without approving anything',async()=>{
  const db=fakeDb();
  const state=await processOne(db,'req-1',{env,verify:async()=>{
    throw Object.assign(new Error('network timeout'),{statusCode:503});
  },approve:()=>{throw Error('must not approve');}});
  assert.equal(state,'retry');
  assert.equal(db.logs.at(-1).update.state,'pending');
});

test('historical test-only receipts are rejected by explicit cutover in both purchase and bank dates',()=>{
  assert.ok(Number.isFinite(cutoverMs(env)));
  assert.equal(isAfterCutover(purchase.createdAt,verification.transactionDate,env),true);
  const late={...env,LOTTERY_CBE_AUTO_APPROVAL_START_AT:new Date(Date.now()-5*60000).toISOString()};
  assert.equal(isAfterCutover(purchase.createdAt,verification.transactionDate,late),false);
  assert.equal(isAfterCutover(new Date().toISOString(),
    new Date(Date.now()-15*60000).toISOString(),late),false);
});
test('cutover has timezone and defaults fail-closed',()=>{
  assert.equal(Number.isNaN(cutoverMs({...env,LOTTERY_CBE_AUTO_APPROVAL_START_AT:'2026-10-30T12:00'})),true);
  assert.equal(Number.isNaN(cutoverMs({...env,LOTTERY_CBE_AUTO_APPROVAL_START_AT:'not-a-date'})),true);
  assert.equal(enabledFor('safe-lottery',{...env,LOTTERY_CBE_AUTO_APPROVAL_START_AT:new Date(Date.now()+120000).toISOString()}),false);
});
test('a pre-cutover pending test purchase never triggers a provider call',async()=>{
  const old={...purchase,createdAt:new Date(Date.now()-55*60000).toISOString()};
  const db=fakeDb({p:old});
  const result=await inspectRequest(db,'req-legacy',{env,
    verify:()=>{throw Error('historical request should not use Check.et quota')}});
  assert.equal(result.decision,'manual_review');
  assert.deepEqual(result.reasons,['purchase_before_go_live_cutover']);
});
test('new purchase paid before cutover cannot approve, even with otherwise matching receipt',async()=>{
  const db=fakeDb();
  const oldBank={...verification,transactionDate:new Date(Date.now()-55*60000).toISOString()};
  const result=await inspectRequest(db,'req-legacy-payment',{env,verify:async()=>oldBank});
  assert.equal(result.decision,'manual_review');
  assert.deepEqual(result.reasons,['purchase_or_bank_transfer_before_go_live_cutover']);
});
