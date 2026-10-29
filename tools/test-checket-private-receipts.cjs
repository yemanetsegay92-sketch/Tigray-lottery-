'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {verifyCheckEtPayment}=require('../lib/checket-verify');
const {readFinalReceipt,validSignature}=require('../lib/checket-private-receipt');
const PDF=Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const PNG=Buffer.concat([Buffer.from('89504e470d0a1a0a','hex'),Buffer.alloc(30)]);
const RECEIPT={
  verified:true,success:true,exists:true,duplicate:false,
  data:{bank:'cbe',transaction_number:'FTPDFTEST123',verification_method:'official',
    receipt:{status:'completed',amount:1000,currency:'ETB',
      receiver_account:'1********1234',transaction_date:'2026-10-29T14:00:00+03:00'}}
};
const incoming={lotteryId:'lotTest',proofMime:'application/pdf',proofPath:'payment-proofs/lotTest/request-id.pdf'};
function storageFor(buffer,mime='application/pdf',size=buffer.length){
  return {bucket(name){
    assert.equal(name,'tigiray-lottery.firebasestorage.app');
    return {file(path){
      assert.equal(path,incoming.proofPath);
      return {getMetadata:async()=>[{size,contentType:mime}],
        download:async()=>[buffer]};
    }};
  }}};
}
const key='chk_fake_only';
test('private PDF read checks storage path, MIME, size and signature',async()=>{
  const result=await readFinalReceipt(incoming,{storage:storageFor(PDF)});
  assert.deepEqual(result.buffer,PDF);
  assert.equal(result.mime,'application/pdf');
});
test('rejects unsafe path outside approved private Firebase object',async()=>{
  await assert.rejects(readFinalReceipt({...incoming,proofPath:'other/lotTest/fake.pdf'},
    {storage:storageFor(PDF)}),/No supported finalized/);
});
test('rejects object exceeding 2 MB before downloading',async()=>{
  await assert.rejects(readFinalReceipt(incoming,{storage:storageFor(PDF,'application/pdf',3*1024*1024)}),
    /type or size/);
});
test('rejects a fake PDF and incorrect storage content type',async()=>{
  await assert.rejects(readFinalReceipt(incoming,{
    storage:storageFor(Buffer.from('not a PDF at all; corrupted file'))}),/do not match/);
  await assert.rejects(readFinalReceipt(incoming,{storage:storageFor(PDF,'image/png')}),/type or size/);
});
test('direct PDF uses multipart receipt_file and receiving account, never client file URL',async()=>{
  let tested=false;
  const response=await verifyCheckEtPayment({
    bank:'cbe',accountNumber:'1000123412345',
    receiptFile:{buffer:PDF,mime:'application/pdf'}
  },{apiKey:key,fetchImpl:async(url,opts)=>{
    assert.equal(url,'https://api.check.et/api/v1/verify');
    assert.equal(opts.headers.Authorization,'Bearer '+key);
    assert.equal(opts.headers['Content-Type'],undefined);
    assert.ok(opts.body instanceof FormData);
    assert.equal(opts.body.get('bank'),'cbe');
    assert.equal(opts.body.get('account_number'),'1000123412345');
    assert.equal(opts.body.get('transaction_number'),null);
    const part=opts.body.get('receipt_file');
    assert.equal(part.name,'bank-receipt.pdf');
    assert.equal(part.type,'application/pdf');
    assert.deepEqual(Buffer.from(await part.arrayBuffer()),PDF);
    tested=true;
    return {status:200,json:async()=>RECEIPT};
  }});
  assert.equal(tested,true);
  assert.equal(response.inputMethod,'pdf');
  assert.equal(response.reportedTransactionNumber,'FTPDFTEST123');
  assert.equal(response.verified,true);
  assert.ok(!JSON.stringify(response).includes(key));
});
test('image is tested without OCR and 422 produces an honest, safe error',async()=>{
  await assert.rejects(verifyCheckEtPayment({
    bank:'cbe',accountNumber:'1000123412345',
    receiptFile:{buffer:PNG,mime:'image/png'}
  },{apiKey:key,fetchImpl:async(_url,opts)=>{
    assert.equal(opts.body.get('receipt_text'),null);
    assert.equal(opts.body.get('receipt_file').type,'image/png');
    return {status:422,json:async()=>({message:'image receipt_text required'})};
  }}),error=>error.statusCode===422 && /could not process/.test(error.message));
});
test('screenshot signature check works without OCR',()=>{
  assert.equal(validSignature(PNG,'image/png'),true);
  assert.equal(validSignature(PNG,'application/pdf'),false);
});
test('no reference and no file is rejected without an API request',async()=>{
  await assert.rejects(verifyCheckEtPayment({bank:'cbe',accountNumber:'1000123412345'},
    {apiKey:key,fetchImpl:()=>{throw Error('should not call');}}),/transaction reference/);
});
