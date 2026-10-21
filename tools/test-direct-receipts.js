'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
process.env.PAYMENT_PROOF_TOKEN_SECRET = 'test-only-value-never-deploy-' + 'a'.repeat(40);
const {
  signToken, verifyToken, receiptPath, validateStagedFile, TYPES, FINISH_TTL_MS
} = require('../api/customer/_receipt-upload');
const lot='SmHhy38Cn6mnEHjjtPZl';
const session='a'.repeat(32);
const path=receiptPath(lot,session,'jpg');
const body={v:1,lotteryId:lot,mime:'image/jpeg',session,path,exp:Date.now()+FINISH_TTL_MS};
function rejects(fn,msg){assert.throws(fn,{message:msg});}
const signed=signToken(body);
assert.deepEqual(verifyToken(signed,lot),body);
assert.equal(TYPES['image/jpeg'].max,420*1024);
assert.equal(TYPES['application/pdf'].max,2*1024*1024);
rejects(()=>verifyToken(signed,'another-lottery'),'Receipt upload authorization has expired or is invalid.');
rejects(()=>verifyToken(signed.replace(/^./,'b'),lot),'Receipt upload authorization is invalid.');
rejects(()=>verifyToken(signToken({...body,exp:Date.now()-10}),lot),
  'Receipt upload authorization has expired or is invalid.');
rejects(()=>verifyToken(signToken({...body,path:'payment-proofs/foo/evil.jpg'}),lot),
  'Receipt upload authorization has expired or is invalid.');
rejects(()=>verifyToken(signToken({...body,mime:'text/html'}),lot),
  'Receipt upload authorization has expired or is invalid.');
rejects(()=>verifyToken(signToken({...body,exp:Date.now()+FINISH_TTL_MS+120000}),lot),
  'Receipt upload authorization has expired or is invalid.');
async function run(){
  const jpg=Buffer.from([0xff,0xd8,0xff,0xe0,0x12]);
  const fakeFile={
    getMetadata:async()=>[{
      size:jpg.length,contentType:'image/jpeg',metadata:{proofsession:session},
      md5Hash:crypto.createHash('md5').update(jpg).digest('base64'),generation:'123'
    }],
    download:async()=>[jpg]
  };
  const fakeBucket={file:name=>{assert.equal(name,path);return fakeFile}};
  const validated=await validateStagedFile(fakeBucket,body);
  assert.equal(validated.bytes,jpg.length);
  assert.equal(validated.generation,'123');
  const mismatch={...fakeFile,getMetadata:async()=>[{size:jpg.length,
    contentType:'image/jpeg',metadata:{proofsession:'someone-else'},generation:'123'}]};
  await assert.rejects(validateStagedFile({file:()=>mismatch},body),/invalid or exceeds/);
  await assert.rejects(validateStagedFile({file:()=>({...fakeFile,
    download:async()=>[Buffer.from([0,0,0])]})},body),/does not match/);
  const over={...fakeFile,getMetadata:async()=>[{
    size:420*1024+1,contentType:'image/jpeg',metadata:{proofsession:session}
  }]};
  await assert.rejects(validateStagedFile({file:()=>over},body),/exceeds/);
  console.log('PASS: receipt token signature, expiry, lottery binding, path binding, type, size, MIME and session validation');
}
run().catch(e=>{console.error(e);process.exitCode=1});
