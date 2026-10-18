import { db } from '../firebase.js';
import { getDoc, doc } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash, normalizePhone } from './phoneHash.js';
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));const lotId=new URLSearchParams(location.search).get('lot');let lot=null,compressedScreenshot=null;
const tg=window.Telegram?.WebApp||null; if(tg){try{tg.ready();tg.expand()}catch{}}
async function getBuyerTelegramLink(requestId){
  try{const r=await fetch('/api/telegram/buyer-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId})});const j=await r.json();return j.ok?j.url:'';}catch{return '';}
}
async function notifyTelegramAdmins(requestId,proofUploadToken,screenshot){
  try{
    await fetch('/api/telegram/notify-admins',{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        requestId,
        proofUploadToken,
        screenshotData:screenshot?.data||'',
        screenshotBytes:Number(screenshot?.size||0),
        screenshotOriginalBytes:Number(screenshot?.originalSize||0),
        screenshotMime:screenshot?'image/jpeg':''
      })
    });
  }catch{}
}
const T={en:{navCheck:'Check Ticket',backHome:'← Back to lotteries',yourDetails:'Your details',detailsNote:'Use the same phone number you will use to check your ticket.',fullName:'Full name',phoneNumber:'Phone number',tickets:'Tickets',ticketsNote:'Choose 1–5 tickets.',paymentProof:'Payment proof',proofNote:'Enter a transaction number or upload a screenshot/PDF bank receipt. You can also provide both.',referenceNumber:'Transaction / reference number',paymentScreenshot:'Payment screenshot or PDF receipt',uploadHint:'Choose an image or PDF',or:'OR',proofRule:'Enter a transaction number OR attach a screenshot/PDF receipt. Both are accepted.',ticketPrice:'Ticket price',numberOfTickets:'Number of tickets',total:'Total',submitRequest:'Submit ticket request',manualNote:'Payment is verified manually. Ticket numbers are assigned after approval.',ticketPending:'Your ticket numbers are assigned after approval.',requestReceived:'Request received',pending:'Your request is waiting for payment verification.',keepPhone:'Keep your phone number. You can use it later to check your status.',checkStatus:'Check status',screenshotAdded:'Receipt attached',chooseImage:'Choose an image or PDF',requiredProof:'Enter a transaction reference OR attach a screenshot/PDF receipt.',lotUnavailable:'Lottery unavailable',goBack:'Go back'},ti:{navCheck:'መረጋገጺ ቲኬት',backHome:'← ናብ ሎተሪታት',yourDetails:'ዝርዝር ሓበሬታኻ',detailsNote:'ንምርግጋጽ ቲኬትካ እቲ ዝተጠቐምካሉ ቁጽሪ ስልኪ ተጠቐም።',fullName:'ምሉእ ስም',phoneNumber:'ቁጽሪ ስልኪ',tickets:'ቲኬት',ticketsNote:'1–5 ቲኬት ምረጽ።',paymentProof:'መረጋገጺ ክፍሊት',proofNote:'ቁጽሪ ግብይት ወይ ስክሪንሾት/PDF ናይ ባንኪ መረጋገጺ ኣቕርብ። ክልቲኦም እውን ትኽእል።',referenceNumber:'ቁጽሪ መረጋገጺ ግብሪ',paymentScreenshot:'ስክሪንሾት ወይ PDF ክፍሊት',uploadHint:'ስክሪንሾት ወይ PDF ምረጽ',or:'ወይ',proofRule:'ቁጽሪ ግብይት ወይ ስክሪንሾት/PDF ኣቕርብ። ክልቲኦም እውን ይፍቀዱ።',ticketPrice:'ዋጋ ሓደ ቲኬት',numberOfTickets:'ብዝሒ ቲኬት',total:'ጠቕላላ',submitRequest:'ሕቶ ቲኬት ልኣኽ',manualNote:'ክፍሊት ብኢድ ይረጋገጽ። ቁጽሪ ቲኬት ድሕሪ ምጽዳቕ ይረኽብ።',ticketPending:'ቁጽሪ ቲኬትካ ድሕሪ ምጽዳቕ ይምደብ።',requestReceived:'ሕቶ ተቐቢልና',pending:'ሕቶኻ ንምርግጋጽ ክፍሊት ይጽበ ኣሎ።',keepPhone:'ቁጽሪ ስልኪኻ ሓዞ። ንኩነታትካ ድሕሪ ግዜ ብእኡ ክትምርምር ትኽእል።',checkStatus:'ኩነታት ኣረጋግጽ',screenshotAdded:'መረጋገጺ ተወሲኹ',chooseImage:'ስክሪንሾት ወይ PDF ምረጽ',requiredProof:'ቁጽሪ ግብይት ወይ ስክሪንሾት/PDF ኣቕርብ።',lotUnavailable:'ሎተሪ ኣይርከብን',goBack:'ተመለስ'}};
const lang=localStorage.getItem('tl_lang')||'ti',t=T[lang];function applyText(){document.documentElement.lang=lang==='ti'?'ti':'en';document.querySelectorAll('[data-i18n]').forEach(el=>{if(t[el.dataset.i18n])el.textContent=t[el.dataset.i18n]});const b=$('langToggle');if(b)b.textContent=lang==='en'?'ትግርኛ':'English'}$('langToggle')?.addEventListener('click',e=>{e.preventDefault();localStorage.setItem('tl_lang',lang==='en'?'ti':'en');location.reload()});applyText();
function blob(canvas,q){return new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(new Error('Could not prepare image.')),'image/jpeg',q))}
async function compressImage(file){const bitmap=await createImageBitmap(file);let w=bitmap.width,h=bitmap.height,scale=Math.min(1,1280/Math.max(w,h));w=Math.max(1,Math.round(w*scale));h=Math.max(1,Math.round(h*scale));const c=document.createElement('canvas');c.width=w;c.height=h;c.getContext('2d',{alpha:false}).drawImage(bitmap,0,0,w,h);bitmap.close();let q=.70,b=await blob(c,q);while(b.size>300*1024&&q>.42){q-=.08;b=await blob(c,q)}if(b.size>340*1024){const s=Math.min(w,h),scale2=720/s,c2=document.createElement('canvas');c2.width=Math.max(1,Math.round(w*scale2));c2.height=Math.max(1,Math.round(h*scale2));c2.getContext('2d',{alpha:false}).drawImage(c,0,0,c2.width,c2.height);b=await blob(c2,.52);w=c2.width;h=c2.height}if(b.size>380*1024)throw new Error('Please choose a smaller image.');const data=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=()=>reject(new Error('Could not read image.'));r.readAsDataURL(b)});return {data,size:b.size,originalSize:file.size}}
function readAsDataURL(file){return new Promise((res,rej)=>{const r=new FileReader();r.onload=()=>res(r.result);r.onerror=()=>rej(new Error('Could not read receipt.'));r.readAsDataURL(file)})}
$('screenshot')?.addEventListener('change',async e=>{
  compressedScreenshot=null;
  const f=e.target.files?.[0];
  if(!f){$('screenshotInfo').textContent=t.chooseImage;return}
  try{
    const isPdf=f.type==='application/pdf'||/\.pdf$/i.test(f.name);
    if(isPdf){
      if(f.size>2*1024*1024)throw new Error('PDF receipt must be 2 MB or smaller.');
      const data=await readAsDataURL(f);
      compressedScreenshot={data,size:f.size,originalSize:f.size,mime:'application/pdf'};
    }else{
      if(!['image/jpeg','image/png','image/webp'].includes(f.type))throw new Error('Choose a JPG, PNG, WebP or PDF receipt.');
      compressedScreenshot={...await compressImage(f),mime:'image/jpeg'};
    }
    $('screenshotInfo').textContent='✓ '+t.screenshotAdded+' ('+Math.round(compressedScreenshot.size/1024)+' KB)';
  }catch(err){e.target.value='';$('screenshotInfo').textContent=err.message||'Could not use this receipt.'}
});
function qty(){return Math.max(1,Math.min(5,Number($('quantity').value)||1))}function updateTotal(){const q=qty(),price=Number(lot?.price||0);$('quantity').value=q;$('total').textContent=`${t.total}: ${q*price} Birr`;$('reviewQty').textContent=q;$('reviewPrice').textContent=`${price} Birr`;$('reviewTotal').textContent=`${q*price} Birr`}$('qtyMinus').addEventListener('click',()=>{$('quantity').value=Math.max(1,qty()-1);updateTotal()});$('qtyPlus').addEventListener('click',()=>{$('quantity').value=Math.min(5,qty()+1);updateTotal()});$('quantity').addEventListener('input',updateTotal);
async function init(){if(!lotId){$('lotteryInfo').innerHTML=`<div class="error">${t.lotUnavailable}</div>`;$('buyForm').style.display='none';return}try{const snap=await getDoc(doc(db,'lotteries',lotId));if(!snap.exists()||snap.data().status!=='active'){$('lotteryInfo').innerHTML=`<div class="card lottery-head-card"><h2>${t.lotUnavailable}</h2><a class="btn btn-primary" href="index.html">${t.goBack}</a></div>`;$('buyForm').style.display='none';return}lot={id:snap.id,...snap.data()};$('lotteryInfo').innerHTML=`<div class="card lottery-head-card"><div class="eyebrow dark">OPEN LOTTERY</div><h1>${esc(lot.name)}</h1><div class="lottery-head-meta"><span class="meta-pill">${Number(lot.price)} Birr / ticket</span><span class="meta-pill">${esc(lot.min)} – ${esc(lot.max)}</span></div><p class="form-note">${t.ticketPending}</p></div>`;updateTotal()}catch(e){console.error(e);$('lotteryInfo').innerHTML='<div class="error">Could not load this lottery.</div>'}}
$('buyForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if(!lot)return;
  const name=$('name').value.trim();
  const phone=await normalizePhone($('phone').value);
  const reference=$('reference').value.trim();
  const quantity=qty();
  const hasShot=!!$('screenshot').files?.length;
  const telegramInitData=String(tg?.initData||'');
  const telegramUser=tg?.initDataUnsafe?.user||null;
  if(!name||!phone){
    $('message').innerHTML='<div class="error">Please complete your name and phone number.</div>';
    return;
  }
  if(!reference&&!compressedScreenshot&&!hasShot){
    $('message').innerHTML=`<div class="error">${t.requiredProof}</div>`;
    return;
  }
  if(hasShot&&!compressedScreenshot){
    $('message').innerHTML='<div class="error">Please wait for the screenshot to finish.</div>';
    return;
  }
  const btn=$('submitBtn');
  btn.disabled=true;
  btn.textContent='Submitting…';
  try{
    const r=await fetch('/api/customer/create-request',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({lotteryId:lot.id,name,phone,reference,quantity,telegramInitData,paymentProofData:compressedScreenshot?.data||'',paymentProofOriginalBytes:compressedScreenshot?.originalSize||0})
    });
    const j=await r.json();
    if(!r.ok||!j.ok)throw new Error(j.error||'Could not submit request.');
    const requestId=j.requestId;
    const proofUploadToken=String(j.proofUploadToken||'');
    const buyerLink=await getBuyerTelegramLink(requestId);
    const tgButton=buyerLink&&!telegramUser?`<p><a class="btn btn-primary" href="${esc(buyerLink)}" target="_blank" rel="noopener">🔔 Get Telegram notifications</a></p>`:'';
    $('buyForm').style.display='none';
    $('message').innerHTML=`<div class="success"><b>✓ ${t.requestReceived}</b><p>${t.pending}</p><p>${t.keepPhone}</p>${tgButton}<a class="btn btn-primary" href="check.html?lot=${encodeURIComponent(lot.id)}">${t.checkStatus}</a></div>`;
    void notifyTelegramAdmins(requestId,proofUploadToken,compressedScreenshot?.mime==='application/pdf'?null:compressedScreenshot);
  }catch(err){
    console.error(err);$('message').innerHTML=`<div class="error">${esc(err.message||'Could not submit request.')}</div>`;btn.disabled=false;btn.textContent=t.submitRequest;
  }
});
init();
