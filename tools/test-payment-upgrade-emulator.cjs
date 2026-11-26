'use strict';
const {test,after}=require('node:test');const assert=require('node:assert/strict');
if(!process.env.FIRESTORE_EMULATOR_HOST||!/^demo-/.test(process.env.GCLOUD_PROJECT||''))throw Error('Isolated demo emulator required');
const {initializeApp,deleteApp}=require('firebase-admin/app');const {getFirestore}=require('firebase-admin/firestore');
const app=initializeApp({projectId:process.env.GCLOUD_PROJECT});const db=getFirestore(app);after(()=>deleteApp(app));
global.fetch=()=>{throw Error('NETWORK FORBIDDEN: inject mocked Check.et')};
const {paymentClaimRef,assertReferenceUnusedAtCheckout}=require('../lib/payment-claims');
const {reviewAction}=require('../lib/admin-payment-review');const {_approveRequestForEmulator:approve}=require('../api/admin/approvals');
const checkout=require('../api/customer/create-request');
async function submit(lotteryId,reference){let status,result;const res={setHeader(){},status(n){status=n;return this},json(x){result=x;return this}};await checkout({method:'POST',headers:{},body:{lotteryId,reference,name:'Synthetic',phone:'0912345678',quantity:1}},res);return {status,result};}
const lottery={status:'active',price:100,min:1,max:100,nextTicketNumber:1,paymentAccounts:[{bank:'CBE',number:'1000123456789',holderName:'TEST RECEIVER'}]};
test('checkout rejects consumed cross-lottery reference before provider, accepts unused and preserves idempotency under concurrency',async()=>{
 await db.collection('lotteries').doc('upgrade-checkout').set(lottery);
 await paymentClaimRef(db,'FTUPGRADEUSED01').set({requestId:'approved-in-deleted-lottery',lotteryId:'deleted',status:'consumed'});
 const used=await submit('upgrade-checkout',' ftupgradeused01 ');assert.equal(used.status,409);
 const results=await Promise.all([submit('upgrade-checkout','FTUPGRADEUNUSED01'),submit('upgrade-checkout','FTUPGRADEUNUSED01')]);
 assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 assert.equal((await db.collection('ticketRequests').doc(results.find(r=>r.status===200).result.requestId).get()).data().originalCustomerReference,'FTUPGRADEUNUSED01');
 assert.equal((await paymentClaimRef(db,'FTUPGRADEUSED01').get()).exists,true);
});
test('receipt-extracted reference uses identical global checkout ledger and conflicts with concurrent consumption',async()=>{
 await assert.rejects(db.runTransaction(tx=>assertReferenceUnusedAtCheckout(tx,db,'FTUPGRADEUSED01')),e=>e.statusCode===409);
 await db.runTransaction(tx=>assertReferenceUnusedAtCheckout(tx,db,'FTUPGRADERECEIPT02'));
});
test('verify again requires explicit credit confirmation, reserves atomically and retains first result',async()=>{
 const lotteryId='upgrade-review',requestId='upgrade-review-request';await db.collection('lotteries').doc(lotteryId).set(lottery);
 await db.collection('ticketRequests').doc(requestId).set({lotteryId,status:'pending',reference:'FTCUSTOMERORIG01',total:100});
 const first={providerHttpStatus:404,providerCode:'not_found',verified:false};
 await db.collection('autoPaymentQueue').doc(requestId).set({state:'manual_review',firstSubmittedReference:'FTCUSTOMERORIG01',verificationAttemptStartedAt:new Date(),firstCheckEtResult:first});
 const body={action:'review-verify',requestId,lotteryId,bank:'cbe',correctedReference:'FTCORRECTEDREF01',revision:0,accountIndex:0};
 const deps={env:{VERCEL_ENV:'production',LOTTERY_CHECKET_READ_ONLY_ENABLED:'true'},budget:async()=>{}};
 await assert.rejects(reviewAction(db,{uid:'admin'},body,deps),/not confirmed/);
 let release,calls=0;const gate=new Promise(r=>release=r);
 const running=reviewAction(db,{uid:'admin'},{...body,confirmCharge:true},{...deps,verify:async input=>{calls++;assert.equal(input.transactionNumber,'FTCORRECTEDREF01');assert.equal(input.accountNumber,lottery.paymentAccounts[0].number);await gate;return {verified:false,exists:true,providerDuplicate:true,providerHttpStatus:409,providerCode:'duplicate'};}});
 // Wait for durable provider reservation, not an arbitrary timing delay.
 for(let i=0;i<100;i++){const snap=await db.collection('ticketRequests').doc(requestId).get();if(snap.data().reviewRevision===1)break;}
 await assert.rejects(reviewAction(db,{uid:'admin'},{...body,confirmCharge:true},deps),/changed|running/);release();await running;assert.equal(calls,1);
 const details=await reviewAction(db,{uid:'admin'},{action:'review-details',requestId,lotteryId},deps);
 assert.deepEqual(details.automatic.result,first);assert.equal(details.attempts.length,1);assert.equal(details.attempts[0].result.providerCode,'duplicate');assert.equal(details.correction.reference,'FTCORRECTEDREF01');
});
test('corrected manual approval preserves original and atomically claims corrected bank reference',async()=>{
 const lotteryId='upgrade-manual';await db.collection('lotteries').doc(lotteryId).set(lottery);
 for(const id of ['correct-a','correct-b'])await db.collection('ticketRequests').doc(id).set({lotteryId,status:'pending',reference:'FTORIGINAL'+id,quantity:1,total:100,phone:'0912345678',name:'Synthetic',reviewRevision:0});
 const review={bank:'cbe',reference:'FTUPGRADECORRECT01',revision:0};
 const results=await Promise.allSettled(['correct-a','correct-b'].map(id=>approve(db,{uid:'admin'},{role:'lotteryAdmin',lotteryIds:[lotteryId]},id,lotteryId,'',null,review)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const claim=(await paymentClaimRef(db,review.reference).get()).data();assert.equal(claim.bankCategory,'cbe');assert.equal(claim.normalizedReference,review.reference);
 const order=(await db.collection('ticketRequests').doc(claim.requestId).get()).data();assert.ok(order.originalCustomerReference.startsWith('FTORIGINAL'));assert.equal(order.paymentCorrection.reference,review.reference);
 assert.equal((await db.collection('buyerNotificationQueue').doc(claim.requestId+'_approved').get()).exists,true);
 await assert.rejects(approve(db,{uid:'other'},{role:'lotteryAdmin',lotteryIds:[]},'correct-b',lotteryId,'',null,{...review,reference:'FTDIFFERENTFREE01'}),/assigned|reviewed/);
});
test('receipt verification sends the finalized file without the FT number and keeps the ticket pending',async()=>{
 const lotteryId='upgrade-file-review',requestId='upgrade-file-review-request';
 const expected='FTFILEEXPECTED01';
 const proofPath='payment-proofs/'+lotteryId+'/receipt.pdf';
 await db.collection('lotteries').doc(lotteryId).set(lottery);
 const request=db.collection('ticketRequests').doc(requestId);
 await request.set({lotteryId,status:'pending',total:100,reference:expected,proofPath,proofMime:'application/pdf',
  receiptExtraction:{reference:expected}});
 const body={action:'review-verify',requestId,lotteryId,bank:'cbe',correctedReference:expected,revision:0,
  accountIndex:0,verifyReceipt:true,confirmCharge:true,proofPath:'ignored-untrusted-path'};
 const bytes=Buffer.from('%PDF-synthetic original receipt bytes');
 const {verifyCheckEtPayment}=require('../lib/checket-verify');
 const deps={env:{VERCEL_ENV:'production',LOTTERY_CHECKET_READ_ONLY_ENABLED:'true'},budget:async()=>{},
  readReceipt:async original=>{
   assert.equal(original.proofPath,proofPath);
   return {buffer:bytes,mime:'application/pdf'};
  },
  verify:input=>verifyCheckEtPayment(input,{apiKey:'mock-key',fetchImpl:async(_url,options)=>{
   const form=options.body;
   assert.equal(form.get('bank'),'cbe');
   assert.equal(form.get('account_number'),lottery.paymentAccounts[0].number);
   assert.equal(form.has('transaction_number'),false);
   assert.equal(form.has('require_receiver_match'),false);
   assert.deepEqual(Buffer.from(await form.get('receipt_file').arrayBuffer()),bytes);
   return {status:200,json:async()=>({code:'verified',success:true,exists:true,duplicate:false,data:{
    bank:'cbe',transaction_number:'FTDIFFERENT01',verification_method:'official',receipt:{status:'completed'}
   }})};
  }})};
 const result=await reviewAction(db,{uid:'admin'},body,deps);
 assert.equal(result.state,'reference_mismatch');
 const history=await reviewAction(db,{uid:'admin'},{action:'review-details',requestId,lotteryId},deps);
 assert.equal(history.attempts[0].inputMethod,'receipt');
 assert.equal(history.attempts[0].result.reportedTransactionNumber,'FTDIFFERENT01');
 assert.equal((await request.get()).data().status,'pending');
 assert.equal((await paymentClaimRef(db,expected).get()).exists,false);
});
test('admin receipt receiver test records a match or mismatch without consuming the payment',async()=>{
 const lotteryId='upgrade-receiver-test';
 const alternateAccount='1000999999999';
 await db.collection('lotteries').doc(lotteryId).set({...lottery,paymentAccounts:[
  ...lottery.paymentAccounts,{bank:'CBE',number:alternateAccount,holderName:'ALTERNATE TEST RECEIVER'}
 ]});
 const {verifyCheckEtPayment}=require('../lib/checket-verify');
 for(const accountIndex of [0,1]){
  const requestId='receiver-test-'+accountIndex;
  const reference='FTRECEIVERTEST0'+accountIndex;
  const request=db.collection('ticketRequests').doc(requestId);
  await request.set({lotteryId,status:'pending',total:100,reference,
   proofPath:'payment-proofs/'+lotteryId+'/'+requestId+'.pdf',proofMime:'application/pdf',
   receiptExtraction:{reference}});
  const matches=accountIndex===0;
  const account=matches?lottery.paymentAccounts[0].number:alternateAccount;
  const deps={env:{VERCEL_ENV:'production',LOTTERY_CHECKET_READ_ONLY_ENABLED:'true'},budget:async()=>{},
   readReceipt:async()=>({buffer:Buffer.from('%PDF-synthetic receipt test'),mime:'application/pdf'}),
   verify:input=>verifyCheckEtPayment(input,{apiKey:'mock-key',fetchImpl:async(_url,{body})=>{
    assert.equal(body.get('account_number'),account);
    assert.equal(body.get('require_receiver_match'),'1');
    assert.equal(body.has('transaction_number'),false);
    if(!matches)return {status:422,json:async()=>({code:'receiver_mismatch',message:'private detail'})};
    return {status:200,json:async()=>({code:'verified',success:true,exists:true,duplicate:false,
     data:{bank:'cbe',transaction_number:reference,verification_method:'mobile_api',
      receipt:{status:'completed',receiver_account:'1********6789'}},checks:{receiver:'match'}})};
   }})};
  const result=await reviewAction(db,{uid:'admin'},{action:'review-verify',requestId,lotteryId,bank:'cbe',
   correctedReference:reference,revision:0,accountIndex,verifyReceipt:true,testReceiver:true,confirmCharge:true},deps);
  assert.equal(result.state,matches?'returned':'receiver_check_failed');
  assert.equal(result.result.providerCode,matches?'verified':'receiver_mismatch');
  const history=await reviewAction(db,{uid:'admin'},{action:'review-details',requestId,lotteryId},deps);
  const [attempt]=history.attempts;
  assert.equal(attempt.receiverMatchRequired,true);
  assert.equal(attempt.receivingSuffix,account.slice(-4));
  assert.equal(attempt.result.providerReceiverMatch,matches?'match':undefined);
  assert.equal(attempt.result.providerCbeAccountCheck,matches?false:undefined);
  assert.ok(!JSON.stringify(attempt).includes('private detail'));
  assert.equal((await request.get()).data().status,'pending');
  assert.equal((await paymentClaimRef(db,reference).get()).exists,false);
 }
});
test('actual receipt-only checkout checks server OCR claim, ignores browser OCR and cleans rejected finalized file',async()=>{
 const vm=require('node:vm'),fs=require('node:fs');const {createRequire}=require('node:module');
 const filename=require.resolve('../api/customer/create-request');const localRequire=createRequire(filename);
 const lotteryId='upgrade-receipt-checkout';await db.collection('lotteries').doc(lotteryId).set(lottery);
 const consumed='FTUPGRADERECEIPTUSED';await paymentClaimRef(db,consumed).set({requestId:'approved-elsewhere',lotteryId:'deleted'});
 let chosen=consumed,finalDeleted=0,stagedDeleted=0,sequence=0;
 const bucket={file:()=>({delete:async()=>{finalDeleted++}})};
 const staged={file:{copy:async()=>{},delete:async()=>{stagedDeleted++}},bytes:100,md5:'unique-proof',generation:'1'};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module,exports:module.exports,Buffer,console,process:{env:{LOTTERY_CBE_RECEIPT_OCR_ENABLED:'true'}},require:spec=>{
  if(spec==='../telegram/_lib')return {...localRequire(spec),adminDb:()=>new Proxy(db,{get(target,key){if(key==='runTransaction')return callback=>target.runTransaction(tx=>Promise.resolve(callback(tx)));const value=target[key];return typeof value==='function'?value.bind(target):value;}})};
  if(spec==='firebase-admin/storage')return {getStorage:()=>({bucket:()=>bucket})};
  if(spec==='./_receipt-upload')return {...localRequire(spec),verifyToken:()=>({lotteryId,mime:'image/png',session:'synthetic-'+(++sequence)}),validateStagedFile:async()=>staged};
  if(spec==='../../lib/checket-private-receipt')return {readFinalReceipt:async()=>({buffer:Buffer.from('synthetic'),mime:'image/png'})};
  if(spec==='../../lib/cbe-receipt-reference')return {extractReferenceFromReceipt:async()=>({ok:true,reference:chosen,originalReference:chosen,candidates:[{original:chosen,reference:chosen}]})};
  return localRequire(spec);
 }},{filename});
 async function receiptSubmit(){let status,result;const res={setHeader(){},status(n){status=n;return this},json(v){result=v;return this}};
  await module.exports({method:'POST',headers:{},body:{lotteryId,name:'Synthetic',phone:'0912345678',quantity:1,proofUploadToken:'fixture',receiptExtraction:{ok:true,reference:'FTMALICIOUSIGNORED'}}},res);return {status,result};}
 assert.equal((await receiptSubmit()).status,409);assert.equal(finalDeleted,1);assert.equal(stagedDeleted,1);
 chosen='FTUPGRADERECEIPTFREE';const accepted=await receiptSubmit();assert.equal(accepted.status,200);
 const request=(await db.collection('ticketRequests').doc(accepted.result.requestId).get()).data();assert.equal(request.reference,'');assert.equal(request.receiptExtraction.reference,chosen);assert.equal(finalDeleted,1);
});
