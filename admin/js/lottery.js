import { TICKET_HEADERS, expandApprovedTicketRows, ticketRowsToTsv, ticketRowsToCsv } from './ticketRows.mjs';
import { renderChecketMatch, cbeAccounts } from './checketMatchUI.mjs';
import { db, auth } from '../../firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, updateDoc, addDoc, query, where, orderBy, limit, getCountFromServer, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash } from '../../js/phoneHash.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me = null, profile = null, lots = [], lot = null; let editingAwards = []; let editingPaymentAccounts = []; let displayedApproved = []; let pendingTotal = 0; let pendingHasMore = false; let approvedHasMore = false;

async function notifyBuyer(requestId){
  try{
    const token = await auth.currentUser.getIdToken();
    const r = await fetch('/api/telegram/notify-buyer', {
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${token}`},
      body:JSON.stringify({requestId})
    });
    const j = await r.json();
    if(j.ok && j.sent) $('message').innerHTML='<div class="success">Buyer Telegram notification sent.</div>';
    else if(j.ok && j.waitingForLink) $('message').innerHTML='<div class="success">Decision saved; buyer can connect Telegram to receive the notification.</div>';
    else if(!r.ok || !j.ok) console.warn('Buyer Telegram notification remains queued:',j.error||r.status);
  }catch(e){ console.warn('Buyer Telegram notification failed:',e.message); }
}

async function getTelegramAdminStatus(){
  const token = await auth.currentUser.getIdToken();
  const r = await fetch('/api/telegram/admin-status',{headers:{authorization:`Bearer ${token}`}});
  const j = await r.json();
  if(!r.ok || !j.ok) throw new Error(j.error||'Could not check Telegram connection.');
  return j;
}

function refreshTelegramStatus(){
  const connected=!!profile?.telegramChatId;
  $('telegramStatus').innerHTML=connected
    ? `<span class="success">✓ Connected${profile.telegramUsername?` as @${esc(profile.telegramUsername)}`:''}</span>`
    : '<span class="muted">Not connected</span>';
}

async function refreshTelegram(){
  try{
    const status=await getTelegramAdminStatus();
    profile={...profile,telegramChatId:status.connected?'connected':'',telegramUsername:status.username||'',telegramFirstName:status.firstName||''};
    refreshTelegramStatus();
    if(status.connected) $('telegramMessage').innerHTML='<div class="success">✅ Telegram is connected.</div>';
  }catch(e){$('telegramMessage').innerHTML=`<div class="error">${esc(e.message)}</div>`;}
}

async function connectTelegram(){
  try{
    const token=await auth.currentUser.getIdToken();
    const r=await fetch('/api/telegram/link-admin',{method:'POST',headers:{authorization:`Bearer ${token}`}});
    const j=await r.json();
    if(!r.ok || !j.ok) throw new Error(j.error||'Could not create Telegram connection link.');
    const url=String(j.url||'');
    const raw=url.split('start=')[1]||'';
    const startCode=decodeURIComponent(raw);
    const command=startCode?`/start ${startCode}`:'';
    const shortCode=startCode.replace(/^admin_/,'');
    $('telegramMessage').innerHTML=`
      <div class="telegram-connect-box">
        <div class="success"><b>Connect your Telegram account</b></div>
        <p>1. Tap <b>Open Telegram</b>.</p>
        <p>2. If Telegram shows <b>Start</b>, tap it. If the bot is already started, use <b>/link</b> with the code below.</p>
        ${command?`<div class="telegram-command"><code id="telegramCommand">${esc(command)}</code><button type="button" id="copyTelegramCommand" class="secondary">Copy command</button></div>`:''}
        ${shortCode?`<div class="telegram-command"><code id="telegramCode">${esc(shortCode)}</code><button type="button" id="copyTelegramCode" class="secondary">Copy code</button></div>`:''}
        <div class="actions"><a class="btn btn-primary" href="${esc(url)}">📲 Open Telegram</a></div>
        <p class="muted">After connecting, this page will check automatically. You can also tap <b>Refresh</b>.</p>
      </div>`;
    $('copyTelegramCommand')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(command);$('copyTelegramCommand').textContent='Copied ✓';}catch{}});
    $('copyTelegramCode')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText(shortCode);$('copyTelegramCode').textContent='Copied ✓';}catch{}});
    let tries=0;
    const poll=async()=>{
      tries++;
      try{
        const status=await getTelegramAdminStatus();
        if(status.connected){
          profile={...profile,telegramChatId:'connected',telegramUsername:status.username||'',telegramFirstName:status.firstName||''};
          refreshTelegramStatus();
          $('telegramMessage').innerHTML='<div class="success">✅ Telegram connected successfully.</div>';
          return;
        }
      }catch(e){console.warn('Telegram status check:',e.message);}
      if(tries<30) setTimeout(poll,2000);
    };
    setTimeout(poll,2500);
  }catch(e){$('telegramMessage').innerHTML=`<div class="error">${esc(e.message)}</div>`;}
}

$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html'});
$('refreshBtn').addEventListener('click',renderAll);
$('refreshTelegramStatus')?.addEventListener('click',refreshTelegram);
$('connectTelegram').addEventListener('click',connectTelegram);
$('lotterySelect').addEventListener('change',async e=>{lot=lots.find(x=>x.id===e.target.value)||lot;await renderAll()});
$('editBtn').addEventListener('click',editLottery);
$('addAward')?.addEventListener('click',addAward);
$('saveAwards')?.addEventListener('click',saveAwards);
$('addPaymentAccount')?.addEventListener('click',addPaymentAccount);
$('savePaymentAccounts')?.addEventListener('click',savePaymentAccounts);
$('findPaymentForm')?.addEventListener('submit',findPaymentByReference);
$('findPhoneForm')?.addEventListener('submit',findPaymentByPhone);


onAuthStateChanged(auth,async u=>{
  if(!u){location.href='login.html';return}
  me=u;
  try{
    const p=await getDoc(doc(db,'users',u.uid));
    if(!p.exists()||p.data().role!=='lotteryAdmin'){location.href='login.html';return}
    profile=p.data();
    refreshTelegramStatus();
    const ids=profile.lotteryIds||[];
    if(!ids.length) throw new Error('No lottery assigned to this account.');
    const snaps=await Promise.all(ids.map(id=>getDoc(doc(db,'lotteries',id))));
    lots=snaps.filter(s=>s.exists()).map(s=>({id:s.id,...s.data()}));
    if(!lots.length) throw new Error('None of your assigned lotteries are available.');
    $('lotterySelect').innerHTML=lots.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
    lot=lots[0];
    await renderAll();
  }catch(e){console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`;}
});

// Reference-based request IDs are SHA-256('REF:' + uppercase(reference))
// truncated to 40 hex characters by the existing customer API. An exact
// Firestore document lookup avoids reading 20,000 unrelated requests.
// Query the phone's public-status subcollection, ordered newest-first.
// Unlike listing ticketRequests, this works for screenshot-only requests whose
// request IDs cannot be reconstructed from a transaction reference.
async function findPaymentByPhone(event) {
  event?.preventDefault();
  if(!lot || !me) return;
  const raw=String($('paymentPhoneSearch')?.value||'').trim();
  const result=$('findPhoneResult');
  const button=$('findPhoneBtn');
  if(!raw || !result || !button) return;
  if(raw.replace(/[^0-9]/g,'').length<9){
    result.innerHTML='<div class="error">Please enter the complete buyer phone number used at checkout.</div>';
    return;
  }
  button.disabled=true;
  button.textContent='Searching…';
  result.innerHTML='<p class="muted">Finding recent requests for that phone…</p>';
  try {
    const hash=await phoneHash(raw);
    // Single-field createdAt index, capped at 30 documents even when a load
    // test used the same phone for 20,000 requests.
    const recent=await getDocs(query(
      collection(db,'publicStatus',hash,'requests'),
      orderBy('createdAt','desc'),
      limit(30)
    ));
    const candidates=recent.docs.filter(x=>x.data().lotteryId===lot.id).slice(0,12);
    if(!candidates.length) {
      result.innerHTML='<div class="error">No recent requests for that phone in this lottery. Check the phone number and selected lottery.</div>';
      return;
    }
    const rows=[];
    for(const item of candidates){
      try{
        const snap=await getDoc(doc(db,'ticketRequests',item.id));
        if(snap.exists() && snap.data().lotteryId===lot.id){
          rows.push({id:snap.id,data:snap.data()});
        }
      }catch(err){
        console.warn('Could not read candidate request:',item.id,err.code||err.message);
      }
    }
    if(!rows.length){
      result.innerHTML='<div class="error">Matching status found, but the payment details could not be read. Check your admin permissions.</div>';
      return;
    }
    result.innerHTML='<p class="muted">Showing '+rows.length+' most recent matching payment request(s).</p>'+
      rows.map(({id,data})=>{
        const mime=String(data.proofMime||'');
        const created=data.createdAt?.toDate?.().toLocaleString()||'';
        return `<div class="request-card">
          <div class="card-head"><div><b>${esc(data.name||'Unnamed buyer')}</b> · ${esc(data.phone||'')}</div><span class="badge">${esc(data.status||'pending')}</span></div>
          <p>${Number(data.quantity)||1} ticket(s) · ${Number(data.total)||0} Birr${data.reference?` · Ref ${esc(data.reference)}`:' · Receipt-only (no reference)'}</p>
          <p class="muted">Submitted: ${esc(created)} · Request ID: ${esc(id)}</p>
          ${data.proofPath?`<div class="actions"><button class="secondary" type="button" data-phone-receipt="${esc(id)}" data-phone-mime="${esc(mime)}">${mime==='application/pdf'?'📎 Download PDF receipt':'📎 View payment screenshot'}</button></div>`:'<p class="muted">Reference only; no uploaded receipt.</p>'}
        </div>`;
      }).join('');
    result.querySelectorAll('[data-phone-receipt]').forEach(btn=>
      btn.addEventListener('click',()=>openPrivateReceipt(btn.dataset.phoneReceipt,btn.dataset.phoneMime)));
  }catch(error){
    console.error('phone payment lookup failed',error);
    result.innerHTML='<div class="error">'+esc(error?.message||'Could not find payment by phone.')+'</div>';
  }finally{
    button.disabled=false;
    button.textContent='Find by phone';
  }
}

async function findPaymentByReference(event){
  event?.preventDefault();
  if(!lot || !me) return;
  const reference=String($('paymentRefSearch')?.value||'').trim();
  const result=$('findPaymentResult');
  const button=$('findPaymentBtn');
  if(!result || !button) return;
  if(!reference || reference.length>180) {
    result.innerHTML='<div class="error">Enter a valid exact payment reference.</div>';
    return;
  }
  button.disabled=true;
  button.textContent='Searching…';
  result.innerHTML='<p class="muted">Looking up the exact payment reference…</p>';
  try {
    const token=await auth.currentUser.getIdToken();
    const response=await fetch('/api/admin/approvals',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':'Bearer '+token},
      body:JSON.stringify({action:'lookup-reference',lotteryId:lot.id,reference})
    });
    const payload=await response.json();
    if(response.status===404 && payload.code==='PAYMENT_NOT_FOUND'){
      result.innerHTML='<div class="muted">No payment found for this reference in the selected lottery. Check the number and try again.</div>';
      return;
    }
    if(!response.ok||!payload.ok)throw new Error(payload.error||'Could not search payments.');
    const data=payload.request;
    const requestId=data.id;
    const status=String(data.status||'unknown');
    const mime=String(data.proofMime||'');
    const created=data.createdAt?new Date(data.createdAt).toLocaleString():'';
    result.innerHTML=`<div class="request-card">
      <div class="card-head"><div><b>${esc(data.name||'Unnamed customer')}</b> · ${esc(data.phone||'')}</div><span class="badge">${esc(status)}</span></div>
      <p>Reference: <b>${esc(data.reference||reference)}</b> · ${Number(data.quantity)||1} ticket(s) · ${Number(data.total)||0} Birr</p>
      <p class="muted">Submitted: ${esc(created)} · Request ID: ${esc(requestId)}</p>
      ${data.hasProof?`<div class="actions"><button type="button" class="secondary" data-found-receipt="1">${mime==='application/pdf'?'📎 Download PDF receipt':'📎 View payment screenshot'}</button></div>`:'<p class="muted">This request has no uploaded receipt (reference only).</p>'}
    </div>`;
    result.querySelector('[data-found-receipt]')?.addEventListener('click',()=>openPrivateReceipt(requestId,mime));
  }catch(error){
    console.error('payment reference lookup failed',error);
    result.innerHTML='<div class="error">'+esc(error?.message||'Could not search for that payment reference.')+'</div>';
  }finally{
    button.disabled=false;
    button.textContent='Find payment';
  }
}


async function refreshSoldTicketCount(){
  if(!lot)return;
  const selected=lot.id;
  const target=$('statTickets');
  if(target)target.textContent='…';
  try{
    const count=await getCountFromServer(query(collection(db,'tickets'),where('lotteryId','==',selected)));
    if(lot?.id===selected&&target)target.textContent=count.data().count.toLocaleString('en-US');
  }catch(error){
    console.error('Exact ticket count unavailable:',error);
    if(lot?.id===selected&&target)target.textContent='—';
  }
}

async function renderAll(){
  if(!lot)return;
  if($('findPaymentResult'))$('findPaymentResult').innerHTML='';
  if($('findPhoneResult'))$('findPhoneResult').innerHTML='';
  $('lotteryName').textContent='· '+lot.name;
  $('lotteryInfo').innerHTML=`<span class="meta-pill"><b>${esc(lot.name)}</b></span><span class="meta-pill">Status: ${esc(lot.status)}</span><span class="meta-pill">Price: ${Number(lot.price||0)} Birr</span><span class="meta-pill">Sequence: ${esc(lot.min)} – ${esc(lot.max)}</span>`;

  const requests=collection(db,'ticketRequests');
  const [pendingSnap,approvedSnap]=await Promise.all([
    getDocs(query(requests,where('lotteryId','==',lot.id),where('status','==','pending'),limit(51))),
    getDocs(query(requests,where('lotteryId','==',lot.id),where('status','==','approved'),limit(101)))
  ]);

  pendingHasMore=pendingSnap.docs.length>50;
  approvedHasMore=approvedSnap.docs.length>100;
  const pending=pendingSnap.docs.slice(0,50).map(d=>({id:d.id,...d.data()}));
  displayedApproved=approvedSnap.docs.slice(0,100).map(d=>({id:d.id,...d.data()}));
  pendingTotal=pending.length;

  $('statPending').textContent=pendingHasMore?'50+':pending.length;
  $('statApproved').textContent=approvedHasMore?'100+':displayedApproved.length;
  $('statRejected').textContent='—';
  if($('statCancelled')) $('statCancelled').textContent='—';
  await refreshSoldTicketCount();

  renderPending(pending,pendingHasMore);
  renderSummary(displayedApproved,approvedHasMore);
  renderAwardsEditor();
  renderPaymentAccountsEditor();
}
function normalizeScreenshot(src){
  const raw=String(src||'').trim();
  if(!raw)return '';
  if(raw.startsWith('data:image/'))return raw;
  if(raw.startsWith('http://')||raw.startsWith('https://'))return raw;
  if(raw.startsWith('blob:'))return raw;
  const mime=raw.startsWith('/9j/')?'image/jpeg':'image/png';
  return `data:${mime};base64,${raw}`;
}

function ensureScreenshotModal(){
  if($('screenshotModal'))return;
  const modal=document.createElement('div');
  modal.id='screenshotModal';
  modal.className='screenshot-modal';
  modal.hidden=true;
  modal.innerHTML='<div class="screenshot-modal-backdrop" data-close-screenshot></div><div class="screenshot-modal-card" role="dialog" aria-modal="true" aria-labelledby="screenshotTitle"><div class="screenshot-modal-head"><b id="screenshotTitle">Payment screenshot</b><button type="button" class="danger small-btn" data-close-screenshot>Close</button></div><div class="screenshot-view"><img id="screenshotViewer" alt="Payment screenshot"></div><div class="screenshot-tools"><button type="button" class="secondary" id="zoomOut">− Zoom</button><button type="button" class="secondary" id="zoomReset">100%</button><button type="button" class="secondary" id="zoomIn">+ Zoom</button><a class="btn" id="downloadScreenshot" download="payment-screenshot.png">⬇ Download</a></div></div>';
  document.body.appendChild(modal);
  $('zoomOut').addEventListener('click',()=>changeScreenshotZoom(-0.2));
  $('zoomIn').addEventListener('click',()=>changeScreenshotZoom(0.2));
  $('zoomReset').addEventListener('click',()=>setScreenshotZoom(1));
  modal.addEventListener('click',e=>{if(e.target.closest('[data-close-screenshot]'))closeScreenshotModal();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape')closeScreenshotModal();});
}

let screenshotZoom=1;
function setScreenshotZoom(value){
  screenshotZoom=Math.max(0.5,Math.min(3,value));
  const img=$('screenshotViewer');
  if(img)img.style.transform=`scale(${screenshotZoom})`;
}
function changeScreenshotZoom(delta){setScreenshotZoom(screenshotZoom+delta)}
function openScreenshotModal(id){
  ensureScreenshotModal();
  const src=normalizeScreenshot(window.__screenshotData?.[id]);
  if(!src)return;
  $('screenshotViewer').src=src;
  $('screenshotViewer').style.transform='scale(1)';
  screenshotZoom=1;
  $('downloadScreenshot').href=src;
  $('downloadScreenshot').download=`payment-screenshot-${id}.png`;
  $('screenshotModal').hidden=false;
  document.body.classList.add('modal-open');
}
function closeScreenshotModal(){
  const modal=$('screenshotModal');
  if(modal){modal.hidden=true;document.body.classList.remove('modal-open');}
  if(activePrivateReceiptUrl){URL.revokeObjectURL(activePrivateReceiptUrl);activePrivateReceiptUrl=null;}
}

let activePrivateReceiptUrl=null;
async function openPrivateReceipt(id,mime){
  try{
    const token=await auth.currentUser.getIdToken();
    const response=await fetch('/api/admin/approvals?receipt=1&requestId='+encodeURIComponent(id),{
      headers:{authorization:'Bearer '+token},cache:'no-store'
    });
    if(!response.ok){
      let err={};try{err=await response.json()}catch{}
      throw new Error(err.error||'Could not load payment receipt.');
    }
    const signed=await response.json();
    if(!signed.ok||!signed.url)throw new Error(signed.error||'Could not authorize private receipt.');
    // The file is fetched directly from private Google Cloud Storage using a
    // short-lived signed URL. Keep downloaded bytes in an ephemeral Blob.
    let receiptResponse;
    try{receiptResponse=await fetch(signed.url,{cache:'no-store'});}
    catch{throw new Error('Could not download receipt from Storage. Check bucket CORS for this website.');}
    if(!receiptResponse.ok)throw new Error('Private receipt download failed ('+receiptResponse.status+').');
    const blob=await receiptResponse.blob();
    const url=URL.createObjectURL(blob);
    if(mime==='application/pdf'){
      const link=document.createElement('a');
      link.href=url;link.download='payment-receipt-'+id+'.pdf';
      document.body.appendChild(link);link.click();link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
      return;
    }
    if(activePrivateReceiptUrl)URL.revokeObjectURL(activePrivateReceiptUrl);
    activePrivateReceiptUrl=url;
    ensureScreenshotModal();
    $('screenshotViewer').src=url;
    $('screenshotViewer').style.transform='scale(1)';
    screenshotZoom=1;
    $('downloadScreenshot').href=url;
    $('downloadScreenshot').download='payment-receipt-'+id+'.jpg';
    $('screenshotModal').hidden=false;
    document.body.classList.add('modal-open');
  }catch(error){alert(error.message||'Could not load payment receipt.')}
}

function renderPending(items,hasMore=false){
  const availableCbe = cbeAccounts(lot);
  const verificationControls = item => {
    if (!item.reference) return '<p class="muted">Check.et: Receipt-only request. No transaction reference available.</p>';
    if (!availableCbe.length) return '<p class="muted">Check.et: Configure this lottery\'s real CBE payment account first.</p>';
    const id = esc(item.id);
    const opts = availableCbe.map(a=>`<option value="${a.index}">${esc(a.label)}</option>`).join('');
    return `<div class="actions" style="align-items:flex-end"><label>CBE receiving account
      <select data-checket-account="${id}">${opts}</select></label>
      <button class="secondary" type="button" data-match-pending="${id}">🔎 Verify CBE payment (read only)</button></div>
      <div data-checket-pending-result="${id}" aria-live="polite"></div>`;
  };

  ensureScreenshotModal();
  window.__screenshotData=Object.create(null);
  items.forEach(x=>{if(x.screenshotData)window.__screenshotData[x.id]=x.screenshotData;});
  $('pendingCount').textContent=hasMore?`${items.length} shown · more pending requests`:`${items.length} pending`;
  $('requests').innerHTML=items.map(x=>`<div class="request-card"><div class="card-head"><div><b>${esc(x.name)}</b> · ${esc(x.phone)}</div><span class="badge pending">PENDING</span></div><p>${Number(x.quantity||1)} ticket(s) · <b>${Number(x.total||0)} Birr</b>${x.reference?` · Ref ${esc(x.reference)}`:''}</p>${x.screenshotData?`<div class="screenshot-wrap"><button type="button" class="screenshot-preview" data-view-screenshot="${esc(x.id)}"><img src="${esc(normalizeScreenshot(x.screenshotData))}" alt="Payment screenshot"><span>Tap to view full size</span></button></div>`:''}${x.proofPath?`<div class="actions"><button type="button" class="secondary" data-private-proof="${esc(x.id)}" data-proof-mime="${esc(x.proofMime||'')}">📎 ${x.proofMime==='application/pdf'?'Download PDF receipt':'View payment screenshot'}</button></div>`:''}${verificationControls(x)}<div class="actions"><button data-approve="${esc(x.id)}">✓ Approve & Assign</button><button class="danger" data-reject="${esc(x.id)}">✕ Reject</button></div></div>`).join('')||'<div class="success">No pending requests.</div>';
  document.querySelectorAll('[data-approve]').forEach(b=>b.addEventListener('click',()=>approve(b.dataset.approve)));
  document.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click',()=>reject(b.dataset.reject)));
  document.querySelectorAll('[data-match-pending]').forEach(b=>b.addEventListener('click',()=>verifyPendingPayment(b)));
  document.querySelectorAll('[data-view-screenshot]').forEach(b=>b.addEventListener('click',()=>openScreenshotModal(b.dataset.viewScreenshot)));
  document.querySelectorAll('[data-private-proof]').forEach(b=>b.addEventListener('click',()=>openPrivateReceipt(b.dataset.privateProof,b.dataset.proofMime)));
}

async function verifyPendingPayment(button) {
  const requestId = button.dataset.matchPending;
  const parent = button.closest('.request-card');
  const accountSelect = parent?.querySelector('[data-checket-account]');
  const target = parent?.querySelector('[data-checket-pending-result]');
  if (!requestId || !target || !accountSelect || !lot) return;
  const selectedLotteryId = lot.id;
  button.disabled = true;
  target.textContent = 'Checking payment and matching to this pending ticket…';
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch('/api/admin/approvals', {
      method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+token},
      body:JSON.stringify({action:'checket-match-pending',
        requestId,lotteryId:selectedLotteryId,accountIndex:Number(accountSelect.value)})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Check.et verification failed.');
    target.innerHTML = renderChecketMatch(data);
  } catch (error) {
    target.innerHTML = '<div class="error">'+esc(error.message||'Verification failed.')+'</div>';
  } finally {
    button.disabled = false;
  }
}

function renderSummary(items,hasMore=false){
  const {rows:r,missingTicketRequests}=expandApprovedTicketRows(items);
  const count=$('summaryCount');
  count.textContent=r.length+' individual ticket(s) shown from '+items.length+' approved purchase(s)' +
    (hasMore?' · More approved purchases exist (export includes only those loaded).':'') +
    (missingTicketRequests?' · WARNING: '+missingTicketRequests+' approved purchase(s) have no assigned ticket numbers.':'');
  const head='<thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Ticket Number</th><th>Ticket Price (Birr)</th><th>Purchase Qty</th><th>Action</th></tr></thead>';
  $('summaryTable').innerHTML=r.length?'<table>'+head+'<tbody>'+r.map(x=>'<tr><td>'+esc(x.date)+'</td><td>'+esc(x.name)+'</td><td>'+esc(x.phone)+'</td><td>'+esc(x.reference)+'</td><td><b>'+esc(x.ticketNumber)+'</b></td><td>'+esc(Number.isFinite(x.price)?x.price:'—')+'</td><td>'+esc(x.purchaseQuantity)+'</td><td>'+(x.firstInPurchase?'<button class="danger small-btn" data-cancel="'+esc(x.requestId)+'">Cancel purchase</button>':'—')+'</td></tr>').join('')+'</tbody></table>':'<p class="muted">No approved ticket numbers in the loaded purchases.</p>';
  $('downloadCsv').onclick=()=>downloadCsv(safeFileName(lot.name)+'-tickets.csv',r);
  $('copyExcel').onclick=async()=>{
    try{await navigator.clipboard.writeText(ticketRowsToTsv(r));$('summaryMessage').innerHTML='<div class="success">One row per ticket copied. Paste into Excel or Google Sheets.</div>'}
    catch{$('summaryMessage').innerHTML='<div class="error">Copy is blocked. Use Download CSV instead.</div>'}
  };
  document.querySelectorAll('[data-cancel]').forEach(b=>b.addEventListener('click',()=>cancelApproval(b.dataset.cancel)));
}
function downloadCsv(name,rows){
  const csv=ticketRowsToCsv(rows);
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function safeFileName(s){return String(s||'lottery').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)}

function renderAwardsEditor(){
  const host=$('awardsEditor');
  if(!host)return;
  const source=Array.isArray(lot?.awards)&&lot.awards.length?lot.awards:['First Prize'];
  editingAwards=source.map(x=>String(x||''));
  host.innerHTML=editingAwards.map((award,i)=>'<div class="award-edit-row"><input class="award-input" type="text" value="'+esc(award)+'" placeholder="Award '+(i+1)+'"><button type="button" class="danger small-btn" data-remove-award="'+i+'">Remove</button></div>').join('');
  host.querySelectorAll('[data-remove-award]').forEach(btn=>btn.addEventListener('click',()=>removeAward(Number(btn.dataset.removeAward))));
}

function currentAwards(){
  return Array.from(document.querySelectorAll('#awardsEditor .award-input')).map(input=>String(input.value||'').trim());
}

function removeAward(index){
  const values=currentAwards();
  values.splice(index,1);
  editingAwards=values.length?values:['First Prize'];
  renderAwardsEditor();
}

function addAward(){
  const values=currentAwards();
  editingAwards=[...values,''];
  const host=$('awardsEditor');
  host.innerHTML=editingAwards.map((award,i)=>'<div class="award-edit-row"><input class="award-input" type="text" value="'+esc(award)+'" placeholder="Award '+(i+1)+'"><button type="button" class="danger small-btn" data-remove-award="'+i+'">Remove</button></div>').join('');
  host.querySelectorAll('[data-remove-award]').forEach(btn=>btn.addEventListener('click',()=>removeAward(Number(btn.dataset.removeAward))));
  host.querySelector('.award-input:last-of-type')?.focus();
}

async function saveAwards(){
  const values=currentAwards().filter(Boolean);
  if(!values.length){$('awardsMessage').innerHTML='<div class="error">At least one award is required.</div>';return;}
  try{
    await updateDoc(doc(db,'lotteries',lot.id),{awards:values});
    lot={...lot,awards:values};
    lots=lots.map(x=>x.id===lot.id?lot:x);
    editingAwards=values;
    renderAwardsEditor();
    await addDoc(collection(db,'auditLogs'),{action:'updateLotteryAwards',lotteryId:lot.id,adminId:me.uid,awards:values,createdAt:serverTimestamp()});
    $('awardsMessage').innerHTML='<div class="success">Winner awards saved.</div>';
  }catch(e){$('awardsMessage').innerHTML='<div class="error">'+esc(e.message||'Could not save awards.')+'</div>';}
}
function normalizePaymentAccounts(raw){
  const fallback=[{bank:'CBE',number:'1000000000000',holderName:''}];
  if(!Array.isArray(raw))return fallback;
  const clean=raw.map(x=>({bank:String(x?.bank||'').trim(),number:String(x?.number||'').trim(),holderName:String(x?.holderName||'').trim()})).filter(x=>x.bank&&x.number);
  return clean.length?clean:fallback;
}

function renderPaymentAccountsEditor(){
  const host=$('paymentAccountsEditor');
  if(!host)return;
  editingPaymentAccounts=normalizePaymentAccounts(lot?.paymentAccounts);
  host.innerHTML=editingPaymentAccounts.map((a,i)=>`<div class="payment-account-edit-row"><label>Bank name<input type="text" data-payment-bank="${i}" value="${esc(a.bank)}" placeholder="CBE"></label><label>Account number<input type="text" data-payment-number="${i}" value="${esc(a.number)}" inputmode="numeric" placeholder="1000000000000"></label><label>Account holder<input type="text" data-payment-holder="${i}" value="${esc(a.holderName||'')}" placeholder="Account holder name"></label><button type="button" class="danger small-btn" data-remove-payment="${i}">Remove</button></div>`).join('');
  host.querySelectorAll('[data-remove-payment]').forEach(b=>b.addEventListener('click',()=>removePaymentAccount(Number(b.dataset.removePayment))));
}

function currentPaymentAccounts(){
  return [...document.querySelectorAll('[data-payment-bank]')].map((input,i)=>({
    bank:String(input.value||'').trim(),
    number:String(document.querySelector(`[data-payment-number="${i}"]`)?.value||'').trim(),
    holderName:String(document.querySelector(`[data-payment-holder="${i}"]`)?.value||'').trim()
  })).filter(x=>x.bank||x.number||x.holderName);
}

function addPaymentAccount(){
  const values=currentPaymentAccounts();
  editingPaymentAccounts=[...values,{bank:'',number:'',holderName:''}];
  renderPaymentAccountsEditor();
  const inputs=document.querySelectorAll('[data-payment-bank]');
  inputs[inputs.length-1]?.focus();
}

function removePaymentAccount(index){
  const values=currentPaymentAccounts();
  values.splice(index,1);
  editingPaymentAccounts=values.length?values:[{bank:'',number:'',holderName:''}];
  renderPaymentAccountsEditor();
}

async function savePaymentAccounts(){
  const btn=$('savePaymentAccounts');
  const values=currentPaymentAccounts();
  if(!values.length){$('paymentAccountsMessage').innerHTML='<div class="error">Add at least one payment account.</div>';return;}
  if(values.some(x=>!x.bank||!x.number||x.number.length<4)){$('paymentAccountsMessage').innerHTML='<div class="error">Complete each bank name and account number.</div>';return;}
  btn.disabled=true;
  try{
    await updateDoc(doc(db,'lotteries',lot.id),{paymentAccounts:values});
    lot={...lot,paymentAccounts:values};
    lots=lots.map(x=>x.id===lot.id?lot:x);
    editingPaymentAccounts=values;
    renderPaymentAccountsEditor();
    await addDoc(collection(db,'auditLogs'),{action:'updateLotteryPaymentAccounts',lotteryId:lot.id,adminId:me.uid,paymentAccountBanks:values.map(x=>x.bank),createdAt:serverTimestamp()});
    $('paymentAccountsMessage').innerHTML='<div class="success">Payment accounts saved for this lottery.</div>';
  }catch(e){
    $('paymentAccountsMessage').innerHTML=`<div class="error">${esc(e.message||'Could not save payment accounts.')}</div>`;
  }finally{btn.disabled=false;}
}

async function editLottery(){const name=prompt('Lottery name',lot.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',lot.price));if(!price||price<=0)return alert('Invalid price.');const status=prompt('Status: active, upcoming, closed, drawn',lot.status)||lot.status;try{await updateDoc(doc(db,'lotteries',lot.id),{name:name.trim(),price,status});lot={...lot,name:name.trim(),price,status};$('lotterySelect').selectedOptions[0].textContent=lot.name;await renderAll();await addDoc(collection(db,'auditLogs'),{action:'editLottery',lotteryId:lot.id,adminId:me.uid,createdAt:serverTimestamp()});$('message').innerHTML='<div class="success">Lottery updated.</div>'}catch(e){alert(e.message)}}

async function reject(id){
  if(!confirm('Reject this payment request?'))return;
  const reason=prompt('Reason for rejection (for the customer):\n1. Reference not found\n2. Payment amount incorrect\n3. Screenshot unclear\n4. Duplicate request\n5. Other','Reference not found');
  if(reason===null)return;
  const cleaned=reason.trim();
  if(!cleaned)return alert('Please provide a rejection reason.');
  try{
    const token=await auth.currentUser.getIdToken();
    const response=await fetch('/api/admin/approvals',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':'Bearer '+token},
      body:JSON.stringify({action:'reject',requestId:id,lotteryId:lot.id,reason:cleaned})
    });
    const result=await response.json();
    if(!response.ok||!result.ok)throw new Error(result.error||'Could not reject request.');
    await renderAll();
    $('message').innerHTML='<div class="success">Payment request rejected. Buyer notification queued.</div>';
    await notifyBuyer(id);
  }catch(error){$('message').innerHTML='<div class="error">'+esc(error.message)+'</div>';}
}

async function cancelApproval(id){
  if(lot.status==='drawn'){alert('This lottery has already been drawn. Approved tickets cannot be cancelled now.');return;}
  const reason=prompt('Why are you cancelling this approval?','Approved in error.');
  if(reason===null)return;
  try{
    const token=await auth.currentUser.getIdToken();
    const r=await fetch('/api/admin/approvals',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify({action:'cancel',requestId:id,reason:reason.trim()||'Approved in error.'})});
    const j=await r.json();
    if(!r.ok||!j.ok)throw new Error(j.error||'Could not cancel this approval.');
    $('message').innerHTML='<div class="success">Approval cancelled. The assigned ticket numbers have been released and will not be reused.</div>';
    await renderAll();
    await notifyBuyer(id);
  }catch(e){console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`}
}

async function approve(id){
  if(!confirm('Approve this payment and assign the next available ticket number(s)?'))return;
  const button=document.querySelector(`[data-approve="${CSS.escape(id)}"]`);
  if(button) button.disabled=true;

  try{
    const token=await auth.currentUser.getIdToken();
    const r=await fetch('/api/admin/approvals',{
      method:'POST',
      headers:{
        'content-type':'application/json',
        'authorization':`Bearer ${token}`
      },
      body:JSON.stringify({action:'approve',requestId:id,lotteryId:lot.id})
    });

    const j=await r.json();
    if(!r.ok || !j.ok){
      throw new Error(j.error||'Could not approve this request.');
    }

    const result=j.request||{};
    const assignedNumbers=Array.isArray(result.ticketNumbers)?result.ticketNumbers:[];
    const publicHash=String(result.phoneHash||'');

    const initialData={
      name:String(result.name||''),
      phone:String(result.phone||''),
      reference:String(result.reference||''),
      quantity:Number(result.quantity||assignedNumbers.length||1),
      total:Number(result.total||0),
      lotteryId:result.lotteryId||lot.id,
      lotteryName:result.lotteryName||lot.name,
      phoneHash:publicHash,
      createdAt:new Date()
    };

    displayedApproved=[
      {id,...initialData,status:'approved',ticketNumbers:assignedNumbers,reviewedBy:me.uid,reviewedAt:new Date()},
      ...displayedApproved
    ].slice(0,100);

    pendingTotal=Math.max(0,pendingTotal-1);
    lot={
      ...lot,
      nextTicketNumber:
        assignedNumbers.length
          ? Math.max(...assignedNumbers)+1
          : lot.nextTicketNumber
    };

    button?.closest('.request-card')?.remove();
    $('statPending').textContent=pendingHasMore?'50+':pendingTotal;
    $('statApproved').textContent=approvedHasMore?'100+':displayedApproved.length;

    await refreshSoldTicketCount();

    renderSummary(displayedApproved,approvedHasMore);
    $('message').innerHTML='<div class="success">Payment approved and ticket number(s) assigned.</div>';
    await notifyBuyer(id);
  }catch(e){
    console.error(e);
    $('message').innerHTML=`<div class="error">${esc(e.message)}</div>`;
  }finally{
    if(button) button.disabled=false;
  }
}
