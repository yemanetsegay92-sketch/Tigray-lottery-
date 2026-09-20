import { db } from '../firebase.js';
import { collection, getDocs, doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const list=document.getElementById('lotteryList');
const LANG='tl_lang';
const translations={
 en:{navCheck:'Check Ticket',navHome:'Home',heroTitle:'Your chance. Your ticket. Your future.',heroText:'Choose an available lottery, submit your payment proof, and track your ticket status online.',viewLotteries:'View Lotteries',checkMyTicket:'Check my ticket',available:'Available lotteries',manualVerification:'Manual verification',howTitle:'Simple from start to finish',step1Title:'Choose',step1Text:'Select the lottery you want to enter.',step2Title:'Submit proof',step2Text:'Provide a reference number or payment screenshot.',step3Title:'Get your ticket',step3Text:'After approval, your ticket numbers are assigned.',footerText:'Please keep your phone number. You can use it anytime to check your ticket status.',contactEyebrow:'CONTACT US',contactTitle:'Need help?',contactText:'Contact us on WhatsApp for assistance with your ticket request.',contactWhatsApp:'Contact us on WhatsApp',developedBy:'Developed by YOAS Digital Solution'},
 ti:{navCheck:'መረጋገጺ ቲኬት',navHome:'ቀዳማይ ገጽ',heroTitle:'ዕድልኻ። ቲኬትካ። መጻኢኻ።',heroText:'ዝኸፈተ ሎተሪ ምረጽ፣ መረጋገጺ ክፍሊት ኣቕርብ፣ ኩነታት ቲኬትካ ኦንላይን ተኸታተል።',viewLotteries:'ሎተሪታት ርአ',checkMyTicket:'ቲኬተይ ኣረጋግጽ',available:'ዝተኸፍቱ ሎተሪታት',manualVerification:'ብኢድ ዝረጋገጽ',howTitle:'ካብ መጀመርታ ክሳብ መወዳእታ ቀሊል',step1Title:'ምረጽ',step1Text:'ክትሳተፍ ዝደለኻዮ ሎተሪ ምረጽ።',step2Title:'መረጋገጺ ኣቕርብ',step2Text:'ቁጽሪ መረጋገጺ ወይ ስክሪንሾት ክፍሊት ኣቕርብ።',step3Title:'ቲኬትካ ተቐበል',step3Text:'ድሕሪ ምጽዳቕ፣ ቁጽሪ ቲኬትካ ይምደብ።',footerText:'ቁጽሪ ስልክኻ ሓዞ። ኩነታት ቲኬትካ ኣብ ዝኾነ ግዜ ክትምርምር ትኽእል።',contactEyebrow:'ርኸቡና',contactTitle:'ሓገዝ ደሊኻ?',contactText:'ብዛዕባ ትእዛዝ ቲኬትካ ሓገዝ እንተደሊኻ፣ ብWhatsApp ርኸቡና።',contactWhatsApp:'ብWhatsApp ርኸቡና',developedBy:'ብ YOAS Digital Solution ዝተሰርሐ'}
};
function getLang(){return localStorage.getItem(LANG)||'ti'}
function applyLang(){const lang=getLang(),t=translations[lang];document.documentElement.lang=lang==='ti'?'ti':'en';document.querySelectorAll('[data-i18n]').forEach(el=>{const k=el.dataset.i18n;if(t[k])el.textContent=t[k]});const b=document.getElementById('langToggle');if(b)b.textContent=lang==='en'?'ትግርኛ':'English'}
window.addEventListener('storage',applyLang);document.getElementById('langToggle')?.addEventListener('click',e=>{e.preventDefault();localStorage.setItem(LANG,getLang()==='en'?'ti':'en');location.reload()});
function statusText(status){const ti=getLang()==='ti';return status==='active'?(ti?'ክፉት':'OPEN'):status==='upcoming'?(ti?'ቀረባ ግዜ':'COMING SOON'):status==='drawn'?(ti?'ድሮ ተወሲዱ':'DRAW COMPLETED'):(ti?'ተዓጽዩ':'CLOSED')}
const DEFAULT_PAYMENT_ACCOUNTS=[{bank:'CBE',number:'1000000000000',holderName:''}];
function normalizePaymentAccounts(raw){
  if(!Array.isArray(raw))return DEFAULT_PAYMENT_ACCOUNTS.map(x=>({...x}));
  const clean=raw.map(x=>({bank:String(x?.bank||'').trim(),number:String(x?.number||'').trim(),holderName:String(x?.holderName||'').trim()})).filter(x=>x.bank&&x.number);
  return clean.length?clean:DEFAULT_PAYMENT_ACCOUNTS.map(x=>({...x}));
}
function accountRowHtml(account,ti){
  return `<div class="payment-account"><div class="payment-account-main"><span class="bank-name">${esc(account.bank)}</span><code>${esc(account.number)}</code>${account.holderName?`<span class="account-holder">${ti?'ስም በዓል ሕሳብ':'Account holder'}: ${esc(account.holderName)}</span>`:''}</div><button type="button" class="copy-account" data-copy-account="${esc(account.number)}">${ti?'ኮፒ':'Copy'}</button></div>`;
}
function paymentAccountsHtml(lot){
  const ti=getLang()==='ti';
  const accounts=normalizePaymentAccounts(lot?.paymentAccounts);
  const primary=accounts[0];
  const others=accounts.slice(1);
  if(!primary)return '';
  return `<div class="payment-accounts"><div class="payment-title">${ti?'ክፍሊት ናብ':'Payment to'}</div>${accountRowHtml(primary,ti)}${others.length?`<button type="button" class="payment-toggle" data-toggle-payment="${esc(lot.id)}" aria-expanded="false"><span class="payment-toggle-arrow">⌄</span><span>${ti?'ካልኦት ሕሳባት':'Other accounts'}</span></button><div class="payment-others" data-payment-others="${esc(lot.id)}" hidden>${others.map(a=>accountRowHtml(a,ti)).join('')}</div>`:''}</div>`;
}
async function copyAccountNumber(number,button){
  try{
    await navigator.clipboard.writeText(number);
  }catch{
    try{
      const ta=document.createElement('textarea');ta.value=number;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
    }catch{alert(getLang()==='ti'?'ቁጽሪ ሕሳብ ኮፒ ኣይተገብረን።':'Could not copy the account number.');return;}
  }
  const old=button.textContent;button.textContent=getLang()==='ti'?'ኮፒ ✓':'Copied ✓';setTimeout(()=>button.textContent=old,1500);
}
document.addEventListener('click',e=>{
  const copy=e.target?.closest?.('[data-copy-account]');
  if(copy){e.preventDefault();e.stopPropagation();copyAccountNumber(copy.getAttribute('data-copy-account')||'',copy);return;}
  const toggle=e.target?.closest?.('[data-toggle-payment]');
  if(toggle){
    e.preventDefault();e.stopPropagation();
    const id=toggle.getAttribute('data-toggle-payment')||'';
    const box=document.querySelector(`[data-payment-others="${CSS.escape(id)}"]`);
    if(!box)return;
    const open=!box.hidden;box.hidden=open;toggle.setAttribute('aria-expanded',open?'false':'true');
    const arrow=toggle.querySelector('.payment-toggle-arrow');if(arrow)arrow.textContent=open?'⌄':'⌃';
  }
},true);
function setWhatsAppContact(number){const el=document.getElementById('whatsappContact');if(!el)return;const digits=String(number||'').replace(/[^0-9]/g,'');if(!digits){el.hidden=true;return;}el.href=`https://wa.me/${digits}`;el.hidden=false;}
function awardsList(lot){
  if(Array.isArray(lot.awards) && lot.awards.length) return lot.awards.filter(x=>String(x||'').trim()).map(x=>String(x).trim());
  const legacy=[lot.firstPrize,lot.secondPrize,lot.thirdPrize].filter(x=>String(x||'').trim());
  return legacy.length?legacy:['ሓጎሳት ምስ ሽልማት ኣብዚ ይግለጹ።'];
}
function openAwards(lot){
  const modal=document.getElementById('awardModal'),body=document.getElementById('awardModalBody'),title=document.getElementById('awardModalTitle');
  if(!modal||!body||!title)return;
  title.textContent = getLang()==='ti' ? `ሽልማታት · ${lot.name}` : `Winner awards · ${lot.name}`;
  const items=awardsList(lot);
  const ti=getLang()==='ti';
  body.innerHTML=`<div class="award-intro">${ti?'እዞም ሽልማታት ነዞም ሎተሪ ዝተዳለዉ እዮም።':'These are the published awards for this lottery.'}</div><div class="award-list">${items.map((a,i)=>`<div class="award-row"><span>${i+1}</span><b>${esc(a)}</b></div>`).join('')}</div>`;
  modal.hidden=false;document.body.classList.add('modal-open');
}
function closeAwards(){const m=document.getElementById('awardModal');if(m){m.hidden=true;document.body.classList.remove('modal-open')}}
function handleAwardsEvent(e){
  const target=e.target && e.target.nodeType===1?e.target:null;
  const btn=target?.closest?.('[data-awards]');
  if(btn){
    e.preventDefault();
    e.stopPropagation();
    const id=btn.getAttribute('data-awards');
    const lot=window.__lots?.find(x=>String(x.id)===String(id));
    if(lot) openAwards(lot);
    return;
  }
  const close=target?.closest?.('[data-close-award]');
  if(close){e.preventDefault();e.stopPropagation();closeAwards();}
}
document.addEventListener('click',handleAwardsEvent,true);
document.addEventListener('pointerup',handleAwardsEvent,true);
document.addEventListener('touchend',handleAwardsEvent,true);
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeAwards()});
async function loadSiteSettings(){try{const snap=await getDoc(doc(db,'settings','site'));if(snap.exists())setWhatsAppContact(snap.data().whatsappNumber||'');}catch(e){console.warn('Could not load contact settings:',e.message)}}
async function home(){try{const snap=await getDocs(collection(db,'lotteries'));const lots=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status!=='hidden');window.__lots=lots;lots.sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1));list.innerHTML=lots.length?lots.map(x=>{const active=x.status==='active';return `<article class="card lottery-card"><div class="card-top"><span class="status-badge status-${esc(x.status)}">${statusText(x.status)}</span><span class="price">${Number(x.price||0)} Birr</span></div><h2>${esc(x.name)}</h2><p class="muted">${esc(x.description||'Ticket numbers are assigned after approval.')}</p>${paymentAccountsHtml(x)}<div class="card-actions three-actions">${active?`<a class="btn btn-primary" href="buy.html?lot=${encodeURIComponent(x.id)}">${getLang()==='ti'?'ቲኬት ዓድግ':'Buy Ticket'} →</a>`:`<button class="btn" disabled>${statusText(x.status)}</button>`}<a class="btn btn-outline" href="check.html?lot=${encodeURIComponent(x.id)}">${getLang()==='ti'?'ቲኬት መርምር':'Check Ticket'}</a><button class="btn btn-gold-outline" type="button" data-awards="${esc(x.id)}">${getLang()==='ti'?'ሽልማታት':'Winner Awards'}</button></div></article>`}).join(''):'<div class="loading-card">No lotteries are available yet.</div>'}catch(e){console.error(e);list.innerHTML='<div class="error">Unable to load lotteries. Please try again.</div>'}}
applyLang();
Promise.all([loadSiteSettings(),home()]).then(()=>{
  document.querySelectorAll('[data-awards]').forEach(btn=>{
    btn.addEventListener('click',ev=>{
      ev.preventDefault();
      ev.stopPropagation();
      const lot=window.__lots?.find(x=>String(x.id)===String(btn.getAttribute('data-awards')));
      if(lot) openAwards(lot);
    });
  });
});

// Deployment trigger checkpoint: keep Awards WebView fix deployed.
