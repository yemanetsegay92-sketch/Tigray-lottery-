import { db } from '../firebase.js';
import { collection, doc, getDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash, normalizePhone } from './phoneHash.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lotId = new URLSearchParams(location.search).get('lot');
let lot = null;
let compressedScreenshot = null;

function formatBytes(bytes){
  if(!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units=['B','KB','MB']; let n=bytes, i=0;
  while(n>=1024 && i<units.length-1){n/=1024;i++;}
  return `${n.toFixed(i?1:0)} ${units[i]}`;
}

function setScreenshotInfo(text, error=false){
  const el=$('screenshotInfo');
  if(!el) return;
  el.className=error?'error form-note':'form-note';
  el.textContent=text;
}

function canvasToBlob(canvas, quality){
  return new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Could not compress image.')),'image/jpeg',quality));
}

async function compressImage(file){
  if(!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');
  const bitmap = await createImageBitmap(file);
  let width = bitmap.width, height = bitmap.height;
  const maxSide = 1280;
  const scale = Math.min(1, maxSide / Math.max(width,height));
  width = Math.max(1, Math.round(width*scale));
  height = Math.max(1, Math.round(height*scale));

  const canvas=document.createElement('canvas');
  canvas.width=width; canvas.height=height;
  const ctx=canvas.getContext('2d',{alpha:false});
  ctx.drawImage(bitmap,0,0,width,height);
  bitmap.close();

  // Keep the Firestore document comfortably below its 1 MiB limit.
  let quality=0.70;
  let blob=await canvasToBlob(canvas,quality);
  while(blob.size>300*1024 && quality>0.40){
    quality-=0.08;
    blob=await canvasToBlob(canvas,quality);
  }
  if(blob.size>330*1024){
    const tighter=Math.min(width,height);
    const scale2=720/tighter;
    const c2=document.createElement('canvas');
    c2.width=Math.max(1,Math.round(width*scale2));
    c2.height=Math.max(1,Math.round(height*scale2));
    c2.getContext('2d',{alpha:false}).drawImage(canvas,0,0,c2.width,c2.height);
    blob=await canvasToBlob(c2,0.52);
  }
  if(blob.size>360*1024) throw new Error('Screenshot is still too large after compression. Please choose a smaller image.');

  const dataUrl=await new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(new Error('Could not read compressed image.'));
    reader.readAsDataURL(blob);
  });
  return {dataUrl, size:blob.size, originalSize:file.size, width, height};
}

$('screenshot')?.addEventListener('change', async e=>{
  const file=e.target.files?.[0];
  compressedScreenshot=null;
  if(!file){setScreenshotInfo('Optional. Screenshot will be compressed automatically.');return;}
  setScreenshotInfo('Compressing screenshot…');
  try{
    compressedScreenshot=await compressImage(file);
    setScreenshotInfo(`Compressed from ${formatBytes(compressedScreenshot.originalSize)} to ${formatBytes(compressedScreenshot.size)} • ${compressedScreenshot.width}×${compressedScreenshot.height}`);
  }catch(err){
    e.target.value='';
    setScreenshotInfo(err.message||'Screenshot compression failed.',true);
  }
});

async function init(){
  if(!lotId){ $('lotteryInfo').innerHTML='<div class="error">Lottery not selected.</div>'; $('buyForm').style.display='none'; return; }
  try{
    const snap = await getDoc(doc(db,'lotteries',lotId));
    if(!snap.exists() || snap.data().status!=='active'){
      $('lotteryInfo').innerHTML='<div class="card"><h2>Lottery unavailable</h2><a class="btn" href="index.html">Go back</a></div>';
      $('buyForm').style.display='none'; return;
    }
    lot = {id:snap.id,...snap.data()};
    $('lotteryInfo').innerHTML=`<div class="card"><h2>${esc(lot.name)}</h2><p>Ticket price: <b>${Number(lot.price)} Birr</b></p><p>Ticket numbers are assigned after payment approval.</p></div>`;
    updateTotal();
  }catch(e){ console.error(e); $('lotteryInfo').innerHTML='<div class="error">Could not load this lottery.</div>'; }
}
function updateTotal(){ const q=Math.max(1,Math.min(100,Number($('quantity').value)||1)); $('quantity').value=q; $('total').textContent=`Total: ${q*Number(lot?.price||0)} Birr`; }
$('quantity').addEventListener('input', updateTotal);
$('buyForm').addEventListener('submit', async e=>{
  e.preventDefault(); if(!lot) return;
  const submit=$('submitBtn'); submit.disabled=true; submit.textContent='Submitting…';
  const name=$('name').value.trim(), phone=await normalizePhone($('phone').value), reference=$('reference').value.trim();
  const quantity=Math.max(1,Math.min(100,Number($('quantity').value)||1));
  if(!name || !phone || !reference){ $('message').innerHTML='<div class="error">Please complete all required fields.</div>'; submit.disabled=false; submit.textContent='Submit Payment Request'; return; }
  try{
    if($('screenshot').files?.length && !compressedScreenshot) throw new Error('Please wait for the screenshot to finish compressing, or remove it.');
    const refHash=await phoneHash(`REF:${reference}`);
    const requestRef=doc(db,'ticketRequests',refHash);
    const requestData={
      lotteryId:lot.id, lotteryName:lot.name, name, phone, reference,
      quantity, price:Number(lot.price), total:Number(lot.price)*quantity,
      status:'pending', ticketNumbers:[], createdAt:serverTimestamp()
    };
    if(compressedScreenshot){
      requestData.screenshotData=compressedScreenshot.dataUrl;
      requestData.screenshotBytes=compressedScreenshot.size;
      requestData.screenshotOriginalBytes=compressedScreenshot.originalSize;
      requestData.screenshotMime='image/jpeg';
    }
    await setDoc(requestRef,requestData);
    const h=await phoneHash(phone);
    await setDoc(doc(db,'publicStatus',h,'requests',requestRef.id),{
      lotteryId:lot.id, lotteryName:lot.name, phoneLast4:phone.slice(-4),
      quantity, total:Number(lot.price)*quantity, status:'pending', ticketNumbers:[], createdAt:serverTimestamp()
    });
    $('buyForm').style.display='none';
    $('message').innerHTML=`<div class="success"><b>✅ Request submitted.</b><p>Your payment is pending manual approval.</p><p>Use your phone number on the Check Ticket page to see the status later.</p><a class="btn" href="check.html">Check Status</a></div>`;
  }catch(err){
    console.error(err);
    const msg=err.code==='permission-denied'?'This payment reference may already be used. Please check the reference number.':(err.message||'Could not submit request.');
    $('message').innerHTML=`<div class="error">${esc(msg)}</div>`;
    submit.disabled=false; submit.textContent='Submit Payment Request';
  }
});
init();
