import { db, auth } from '../firebase.js';
import { getDoc, doc } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { phoneHash, normalizePhone } from './phoneHash.js';
const $=id=>document.getElementById(id);const esc=s=>String(s??'').replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[c]));const lotId=new URLSearchParams(location.search).get('lot');let lot=null,compressedScreenshot=null;
const tg=window.Telegram?.WebApp||null; if(tg){try{tg.ready();tg.expand()}catch{}}
let walletUser=null,walletPurchasesEnabled=false;
function renderWalletPurchase(){const button=$('walletBuyBtn');if(!button)return;button.hidden=!walletUser;button.disabled=!walletPurchasesEnabled;button.textContent=walletPurchasesEnabled?'Buy instantly with wallet':'Wallet purchases unavailable';$('walletBuyNote').hidden=!!walletUser;}
onAuthStateChanged(auth,user=>{walletUser=user;renderWalletPurchase();});
fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'wallet-status'})}).then(async response=>{const data=await response.json();walletPurchasesEnabled=response.ok&&data.ok&&data.capabilities?.purchases===true;renderWalletPurchase();}).catch(()=>{walletPurchasesEnabled=false;renderWalletPurchase();});
async function getBuyerTelegramLink(requestId,buyerLinkToken){
  try{const r=await fetch('/api/telegram/buyer-link',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId,buyerLinkToken})});const j=await r.json();return j.ok?j.url:'';}catch{return '';}
}
const T={en:{navCheck:'Check Ticket',backHome:'← Back to lotteries',yourDetails:'Your details',detailsNote:'Use the same phone number you will use to check your ticket.',fullName:'Full name',phoneNumber:'Phone number',tickets:'Tickets',ticketsNote:'Choose 1–5 tickets.',paymentProof:'Payment proof',proofNote:'Enter a transaction number or upload a screenshot/PDF bank receipt. You can also provide both.',referenceNumber:'Transaction / reference number',paymentScreenshot:'Payment screenshot or PDF receipt',uploadHint:'Choose an image or PDF',or:'OR',proofRule:'Enter a transaction number OR attach a screenshot/PDF receipt. Both are accepted.',ticketPrice:'Ticket price',numberOfTickets:'Number of tickets',total:'Total',submitRequest:'Submit ticket request',manualNote:'Payment is checked after submission. Tickets are assigned after approval.',ticketPending:'Your ticket numbers are assigned after approval.',requestReceived:'Request received',pending:'Your request is waiting for payment verification.',keepPhone:'Keep your phone number. You can use it later to check your status.',checkStatus:'Check status',screenshotAdded:'Receipt attached',chooseImage:'Choose an image or PDF',uploadHelpTitle:'Need help attaching a receipt?',uploadHelpText:'Save the receipt from your banking app, then choose it above from Photos or Files. If the picker does not open, use the app menu to open this page in Chrome or Samsung Internet.',requiredProof:'Enter a transaction reference OR attach a screenshot/PDF receipt.',lotUnavailable:'Lottery unavailable',goBack:'Go back'},ti:{navCheck:'መረጋገጺ ቲኬት',backHome:'← ናብ ሎተሪታት',yourDetails:'ዝርዝር ሓበሬታኻ',detailsNote:'ንምርግጋጽ ቲኬትካ እቲ ዝተጠቐምካሉ ቁጽሪ ስልኪ ተጠቐም።',fullName:'ምሉእ ስም',phoneNumber:'ቁጽሪ ስልኪ',tickets:'ቲኬት',ticketsNote:'1–5 ቲኬት ምረጽ።',paymentProof:'መረጋገጺ ክፍሊት',proofNote:'ቁጽሪ ግብይት ወይ ስክሪንሾት/PDF ናይ ባንኪ መረጋገጺ ኣቕርብ። ክልቲኦም እውን ትኽእል።',referenceNumber:'ቁጽሪ መረጋገጺ ግብሪ',paymentScreenshot:'ስክሪንሾት ወይ PDF ክፍሊት',uploadHint:'ስክሪንሾት ወይ PDF ምረጽ',or:'ወይ',proofRule:'ቁጽሪ ግብይት ወይ ስክሪንሾት/PDF ኣቕርብ። ክልቲኦም እውን ይፍቀዱ።',ticketPrice:'ዋጋ ሓደ ቲኬት',numberOfTickets:'ብዝሒ ቲኬት',total:'ጠቕላላ',submitRequest:'ሕቶ ቲኬት ልኣኽ',manualNote:'ክፍሊት ድሕሪ ምልኣኽ ይረጋገጽ። ቁጽሪ ቲኬት ድሕሪ ምጽዳቕ ይምደብ።',ticketPending:'ቁጽሪ ቲኬትካ ድሕሪ ምጽዳቕ ይምደብ።',requestReceived:'ሕቶ ተቐቢልና',pending:'ሕቶኻ ንምርግጋጽ ክፍሊት ይጽበ ኣሎ።',keepPhone:'ቁጽሪ ስልኪኻ ሓዞ። ንኩነታትካ ድሕሪ ግዜ ብእኡ ክትምርምር ትኽእል።',checkStatus:'ኩነታት ኣረጋግጽ',screenshotAdded:'መረጋገጺ ተወሲኹ',chooseImage:'ስክሪንሾት ወይ PDF ምረጽ',uploadHelpTitle:'መረጋገጺ ንምልዓል ሓገዝ የድልየካ?',uploadHelpText:'መረጋገጺ ካብ ናይ ባንኪ ኣፕ ኣቐምጦ። ካብ ፎቶ ወይ Files ምረጾ። ምምራጽ ፋይል እንተዘይተኸፊቱ፡ ብ Chrome ወይ Samsung Internet ክፈቶ።',requiredProof:'ቁጽሪ ግብይት ወይ ስክሪንሾት/PDF ኣቕርብ።',lotUnavailable:'ሎተሪ ኣይርከብን',goBack:'ተመለስ'}};
const lang=localStorage.getItem('tl_lang')||'ti',t=T[lang];function applyText(){document.documentElement.lang=lang==='ti'?'ti':'en';document.querySelectorAll('[data-i18n]').forEach(el=>{if(t[el.dataset.i18n])el.textContent=t[el.dataset.i18n]});const b=$('langToggle');if(b)b.textContent=lang==='en'?'ትግርኛ':'English'}$('langToggle')?.addEventListener('click',e=>{e.preventDefault();localStorage.setItem('tl_lang',lang==='en'?'ti':'en');location.reload()});applyText();
function blob(canvas,q){return new Promise((res,rej)=>canvas.toBlob(b=>b?res(b):rej(new Error('Could not prepare image.')),'image/jpeg',q))}
async function decodeImage(file){
  if(typeof createImageBitmap==='function'){
    try{const bitmap=await createImageBitmap(file);return {source:bitmap,width:bitmap.width,height:bitmap.height,close:()=>bitmap.close()};}catch{}
  }
  // Embedded Android browsers may lack createImageBitmap(File).
  const url=URL.createObjectURL(file);
  try{
    const image=await new Promise((resolve,reject)=>{const el=new Image();el.onload=()=>resolve(el);el.onerror=()=>reject(new Error('Could not open this image.'));el.src=url;});
    return {source:image,width:image.naturalWidth,height:image.naturalHeight,close:()=>URL.revokeObjectURL(url)};
  }catch(error){URL.revokeObjectURL(url);throw error;}
}
async function compressImage(file){
  const decoded=await decodeImage(file);
  try{
    let w=decoded.width,h=decoded.height;
    if(!w||!h||w*h>16*1024*1024)throw new Error('Choose an image smaller than 16 megapixels.');
    const scale=Math.min(1,1280/Math.max(w,h));
    w=Math.max(1,Math.round(w*scale));h=Math.max(1,Math.round(h*scale));
    const c=document.createElement('canvas');c.width=w;c.height=h;
    c.getContext('2d',{alpha:false}).drawImage(decoded.source,0,0,w,h);
    let q=.70,b=await blob(c,q);
    while(b.size>300*1024&&q>.42){q-=.08;b=await blob(c,q);}
    if(b.size>340*1024){
      const factor=Math.min(1,720/Math.max(w,h)),c2=document.createElement('canvas');
      c2.width=Math.max(1,Math.round(w*factor));c2.height=Math.max(1,Math.round(h*factor));
      c2.getContext('2d',{alpha:false}).drawImage(c,0,0,c2.width,c2.height);
      b=await blob(c2,.52);
    }
    if(b.size>380*1024)throw new Error('Please choose a smaller image.');
    return {blob:b,size:b.size,originalSize:file.size};
  }finally{decoded.close();}
}
async function uploadPrivateReceipt(lotteryId, receipt) {
  const response=await fetch('/api/customer/create-request',{
    method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({action:'authorize-receipt-upload',lotteryId,mime:receipt.mime,bytes:receipt.size})
  });
  const policy=await response.json();
  if(!response.ok||!policy.ok)throw new Error(policy.error||'Could not prepare private receipt upload.');
  const form=new FormData();
  // All signed policy fields precede the file, which must be the final form part.
  for(const [name,value] of Object.entries(policy.fields||{}))form.append(name,value);
  const filename=receipt.mime==='application/pdf'?'receipt.pdf':'receipt.jpg';
  form.append('file',new Blob([receipt.blob],{type:receipt.mime}),filename);
  let uploaded;
  try{uploaded=await fetch(policy.uploadUrl,{method:'POST',body:form,mode:'cors'});}
  catch{throw new Error('Direct upload failed. Check your connection and Firebase Storage CORS configuration.');}
  if(!uploaded.ok)throw new Error('Private receipt upload failed ('+uploaded.status+'). Please try again.');
  return String(policy.proofUploadToken||'');
}
let receiptSelection=0;
$('screenshot')?.addEventListener('change',async e=>{
  const current=++receiptSelection;
  compressedScreenshot=null;
  const file=e.target.files?.[0];
  if(!file){$('screenshotInfo').textContent=t.chooseImage;return;}
  $('screenshotInfo').textContent=lang==='ti'?'መረጋገጺ ይዳሎ ኣሎ…':'Preparing receipt…';
  try{
    const pdf=file.type==='application/pdf'||/\.pdf$/i.test(file.name);
    let prepared;
    if(pdf){
      if(file.size>2*1024*1024)throw new Error('PDF receipt must be 2 MB or smaller.');
      prepared={blob:file,size:file.size,originalSize:file.size,mime:'application/pdf'};
    }else{
      if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('Choose a JPG, PNG, WebP or PDF receipt.');
      prepared={...await compressImage(file),mime:'image/jpeg'};
    }
    if(current!==receiptSelection)return;
    compressedScreenshot=prepared;
    $('screenshotInfo').textContent='✓ '+t.screenshotAdded+' ('+Math.round(prepared.size/1024)+' KB)';
  }catch(error){
    if(current!==receiptSelection)return;
    e.target.value='';$('screenshotInfo').textContent=error.message||'Could not use this receipt.';
  }
});
let serverEvidenceMode='';
function evidenceMode(){return serverEvidenceMode||(lot?.paymentEvidenceMode==='reference_only'?'reference_only':'standard')}
function referenceOnly(){return evidenceMode()==='reference_only'}
function receiptRequired(){return evidenceMode()==='receipt_required'}
function applyEvidenceMode(){
 const only=referenceOnly(),receipt=receiptRequired();
 const upload=document.querySelector('label.upload-box'),help=document.querySelector('.mobile-upload-help');
 if(upload)upload.hidden=only;
 if(help)help.hidden=only;
 $('screenshot').disabled=only;
 $('screenshot').required=receipt;
 const referenceLabel=$('reference').closest('label');
 if(referenceLabel){referenceLabel.hidden=receipt;referenceLabel.style.display=receipt?'none':'';}
 $('reference').disabled=receipt;
 $('reference').required=only;
 const note=document.querySelector('.proof-rule');
 if(note)note.textContent=only?(lang==='ti'?'ቁጽሪ ግብይት ጥራይ ኣእቱ።':'Enter transaction reference only. No file upload needed.'):t.proofRule;
 const description=document.querySelector('[data-i18n="proofNote"]');
 if(description)description.textContent=only?(lang==='ti'?'ቁጽሪ ግብይት ጥራይ ኣእቱ።':'Enter the bank transaction reference only.'):t.proofNote;
 if(receipt){if(note)note.textContent='Upload the original CBE receipt PDF or screenshot.';if(description)description.textContent='An original CBE receipt PDF or screenshot is required.';}
}
function qty(){return Math.max(1,Math.min(5,Number($('quantity').value)||1))}function updateTotal(){const q=qty(),price=Number(lot?.price||0);$('quantity').value=q;$('total').textContent=`${t.total}: ${q*price} Birr`;$('reviewQty').textContent=q;$('reviewPrice').textContent=`${price} Birr`;$('reviewTotal').textContent=`${q*price} Birr`}$('qtyMinus').addEventListener('click',()=>{$('quantity').value=Math.max(1,qty()-1);updateTotal()});$('qtyPlus').addEventListener('click',()=>{$('quantity').value=Math.min(5,qty()+1);updateTotal()});$('quantity').addEventListener('input',updateTotal);
async function init(){if(!lotId){$('lotteryInfo').innerHTML=`<div class="error">${t.lotUnavailable}</div>`;$('buyForm').style.display='none';return}try{const snap=await getDoc(doc(db,'lotteries',lotId));if(!snap.exists()||snap.data().status!=='active'){$('lotteryInfo').innerHTML=`<div class="card lottery-head-card"><h2>${t.lotUnavailable}</h2><a class="btn btn-primary" href="index.html">${t.goBack}</a></div>`;$('buyForm').style.display='none';return}lot={id:snap.id,...snap.data()};$('lotteryInfo').innerHTML=`<div class="card lottery-head-card"><div class="eyebrow dark">OPEN LOTTERY</div><h1>${esc(lot.name)}</h1><div class="lottery-head-meta"><span class="meta-pill">${Number(lot.price)} Birr / ticket</span><span class="meta-pill">${esc(lot.min)} – ${esc(lot.max)}</span></div><p class="form-note">${t.ticketPending}</p></div>`;applyEvidenceMode();updateTotal()}catch(e){console.error(e);$('lotteryInfo').innerHTML='<div class="error">Could not load this lottery.</div>'}}
let submitting=false;
$('buyForm').addEventListener('submit',async e=>{
  e.preventDefault();
  if(submitting)return;
  submitting=true;
  try {
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
  if(referenceOnly()&&!reference){$('message').innerHTML='<div class="error">Transaction reference is required for this lottery.</div>';return;}
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
    // The JPEG/PDF bytes go directly from this browser to private GCS.
    // Only a small signed upload token is sent through Vercel.
    let proofUploadToken='';
    if(compressedScreenshot&&!referenceOnly()){
      btn.textContent='Uploading receipt…';
      proofUploadToken=await uploadPrivateReceipt(lot.id,compressedScreenshot);
    }
    btn.textContent='Submitting…';
    const r=await fetch('/api/customer/create-request',{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({lotteryId:lot.id,name,phone,reference,quantity,telegramInitData,proofUploadToken,paymentProofOriginalBytes:compressedScreenshot?.originalSize||0})
    });
    const j=await r.json();
    if(!r.ok||!j.ok)throw new Error(j.error||'Could not submit request.');
    const requestId=j.requestId;
    const buyerLinkToken=String(j.buyerLinkToken||'');
    const buyerLink=await getBuyerTelegramLink(requestId,buyerLinkToken);
    const tgButton=buyerLink&&!telegramUser?`<p><a class="btn btn-primary" href="${esc(buyerLink)}" target="_blank" rel="noopener">🔔 Get Telegram notifications</a></p>`:'';
    $('buyForm').style.display='none';
    $('message').innerHTML=`<div class="success"><b>✓ ${t.requestReceived}</b><p>${t.pending}</p><p>${t.keepPhone}</p>${tgButton}<a class="btn btn-primary" href="check.html?lot=${encodeURIComponent(lot.id)}">${t.checkStatus}</a></div>`;
  }catch(err){
    console.error(err);$('message').innerHTML=`<div class="error">${esc(err.message||'Could not submit request.')}</div>`;btn.disabled=false;btn.textContent=t.submitRequest;
  }
  } finally {submitting=false;}
});
$('walletBuyBtn')?.addEventListener('click',async()=>{
 if(!walletUser||!lot)return location.href='account.html';
 if(!walletPurchasesEnabled){$('message').innerHTML='<div class="error">Wallet purchases are not yet available.</div>';return;}
 const button=$('walletBuyBtn');button.disabled=true;button.textContent='Buying…';
 const storageKey='wallet-buy-key:'+walletUser.uid+':'+lot.id;
 let requestKey=sessionStorage.getItem(storageKey);
 if(!requestKey){requestKey=(crypto.randomUUID?.()||String(Date.now())+Math.random().toString(36).slice(2)).replace(/[^a-zA-Z0-9_-]/g,'');sessionStorage.setItem(storageKey,requestKey);}
 try{
  const token=await walletUser.getIdToken();
  const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action:'wallet-purchase',lotteryId:lot.id,requestKey,quantity:qty()})});
  const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error||'Wallet purchase failed.');
  sessionStorage.removeItem(storageKey);$('buyForm').style.display='none';
  $('message').innerHTML=`<div class="success"><b>✓ Tickets assigned instantly</b><p>${result.ticketNumbers.map(x=>esc(x)).join(', ')}</p><a class="btn btn-primary" href="account.html">Open wallet</a></div>`;
 }catch(error){$('message').innerHTML='<div class="error">'+esc(error.message)+'</div>';button.disabled=false;button.textContent='Buy instantly with wallet';}
});
async function loadEvidencePolicy(){
 const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'purchase-evidence-policy',lotteryId:lotId})});
 const result=await response.json();
 if(!response.ok||!result.ok)throw new Error(result.error||'Could not load purchase policy.');
 serverEvidenceMode=result.mode;applyEvidenceMode();$('submitBtn').disabled=false;
}
$('submitBtn').disabled=true;
init().then(loadEvidencePolicy).catch(error=>{console.error(error);$('buyForm').style.display='none';$('message').innerHTML='<div class="error">Could not load the secure purchase policy. Please refresh.</div>';});
