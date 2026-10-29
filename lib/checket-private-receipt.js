'use strict';
// Read a *previously finalized* private receipt directly from Firebase Storage.
// Never accept arbitrary paths, URLs, or bytes from the browser.
const {getStorage} = require('firebase-admin/storage');
const BUCKET='tigiray-lottery.firebasestorage.app';
const SUPPORTED=new Set(['application/pdf','image/jpeg','image/png','image/webp']);
const LIMITS={'application/pdf':2*1024*1024,'image/jpeg':420*1024,'image/png':420*1024,'image/webp':420*1024};
function receiptError(message,statusCode=400){return Object.assign(new Error(message),{statusCode});}
function validSignature(buffer,mime){
  if(!Buffer.isBuffer(buffer)||buffer.length<16)return false;
  if(mime==='application/pdf')return buffer.subarray(0,5).toString('ascii')==='%PDF-';
  if(mime==='image/jpeg')return buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff;
  if(mime==='image/png')return buffer.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'));
  if(mime==='image/webp')return buffer.subarray(0,4).toString()==='RIFF'&&buffer.subarray(8,12).toString()==='WEBP';
  return false;
}
async function readFinalReceipt(request, deps={}){
  const lotteryId=String(request.lotteryId||'');
  const path=String(request.proofPath||'');
  const mime=String(request.proofMime||'').toLowerCase();
  const safePrefix='payment-proofs/'+encodeURIComponent(lotteryId)+'/';
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(lotteryId) || !path.startsWith(safePrefix) ||
    path.length>600 || path.includes('..') || path.includes('\\') || !SUPPORTED.has(mime)) {
    throw receiptError('No supported finalized private receipt is attached to this purchase.');
  }
  const storage=deps.storage||getStorage();
  const file=storage.bucket(BUCKET).file(path);
  let metadata, bytes;
  try{
    [metadata]=await file.getMetadata();
    const size=Number(metadata.size);
    if(metadata.contentType!==mime || !Number.isSafeInteger(size) || size<16 || size>LIMITS[mime]) {
      throw receiptError('Receipt type or size does not match the finalized private upload.',409);
    }
    // Object is immutable to customers after finalization; revalidate the bytes.
    [bytes]=await file.download();
    if(bytes.length!==size || bytes.length>LIMITS[mime] || !validSignature(bytes,mime)){
      throw receiptError('Private receipt bytes do not match the recorded PDF/image type.',409);
    }
  }catch(error){
    if(error.statusCode)throw error;
    if(error.code===404)throw receiptError('Private receipt is unavailable.',404);
    throw receiptError('Could not read the private receipt from Firebase Storage.',503);
  }
  return {buffer:bytes,mime};
}
module.exports={readFinalReceipt,validSignature};
