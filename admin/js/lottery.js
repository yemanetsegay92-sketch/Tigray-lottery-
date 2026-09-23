import { db, auth } from '../../firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, updateDoc, addDoc, query, where, limit, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
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

async function renderAll(){
  if(!lot)return;
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
  const displayedTicketTotal=displayedApproved.reduce((s,x)=>s+Number(x.quantity||0),0);
  $('statTickets').textContent=approvedHasMore?`${displayedTicketTotal}+`:`${displayedTicketTotal}`;

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
let screenshotObjectUrl='';

function setScreenshotZoom(value){
  screenshotZoom=Math.max(0.5,Math.min(3,value));
  const img=$('screenshotViewer');
  if(img)img.style.transform=`scale(${screenshotZoom})`;
}

function changeScreenshotZoom(delta){setScreenshotZoom(screenshotZoom+delta)}

async function openScreenshotModal(id){
  ensureScreenshotModal();

  let src=normalizeScreenshot(window.__screenshotData?.[id]);

  if(!src && window.__screenshotPath?.[id]){
    try{
      const token=await auth.currentUser.getIdToken();
      const r=await fetch(`/api/admin/approvals?action=screenshot&requestId=${encodeURIComponent(id)}`,{
        headers:{authorization:`Bearer ${token}`}
      });

      if(!r.ok){
        let message='Could not load payment screenshot.';
        try{
          const j=await r.json();
          if(j?.error) message=j.error;
        }catch{}
        throw new Error(message);
      }

      const blob=await r.blob();

      if(screenshotObjectUrl){
        URL.revokeObjectURL(screenshotObjectUrl);
        screenshotObjectUrl='';
      }

      screenshotObjectUrl=URL.createObjectURL(blob);
      src=screenshotObjectUrl;
    }catch(e){
      console.error(e);
      $('message').innerHTML=`<div class="error">${esc(e.message||'Could not load payment screenshot.')}</div>`;
      return;
    }
  }

  if(!src)return;

  $('screenshotViewer').src=src;
  $('screenshotViewer').style.transform='scale(1)';
  screenshotZoom=1;
  $('downloadScreenshot').href=src;
  $('downloadScreenshot').download=`payment-screenshot-${id}.jpg`;
  $('screenshotModal').hidden=false;
  document.body.classList.add('modal-open');
}

function closeScreenshotModal(){
  const modal=$('screenshotModal');
  if(modal){
    modal.hidden=true;
    document.body.classList.remove('modal-open');
  }

  const viewer=$('screenshotViewer');
  if(viewer) viewer.removeAttribute('src');

  if(screenshotObjectUrl){
    URL.revokeObjectURL(screenshotObjectUrl);
    screenshotObjectUrl='';
  }
}

function renderPending(items,hasMore=false){
  ensureScreenshotModal();
  window.__screenshotData=Object.create(null);
  window.__screenshotPath=Object.create(null);

  items.forEach(x=>{
    if(x.screenshotData) window.__screenshotData[x.id]=x.screenshotData;
    if(x.screenshotPath) window.__screenshotPath[x.id]=x.screenshotPath;
  });

  $('pendingCount').textContent=hasMore?`${items.length} shown · more pending requests`:`${items.length} pending`;

  $('requests').innerHTML=items.map(x=>{
    const hasScreenshot=!!(x.screenshotData||x.screenshotPath);
    const proofButton=hasScreenshot
      ? `<div class="screenshot-wrap"><button type="button" class="secondary" data-view-screenshot="${esc(x.id)}">🧾 View payment screenshot</button></div>`
      : '';

    return `<div class="request-card"><div class="card-head"><div><b>${esc(x.name)}</b> · ${esc(x.phone)}</div><span class="badge pending">PENDING</span></div><p>${Number(x.quantity||1)} ticket(s) · <b>${Number(x.total||0)} Birr</b>${x.reference?` · Ref ${esc(x.reference)}`:''}</p>${proofButton}<div class="actions"><button data-approve="${esc(x.id)}">✓ Approve & Assign</button><button class="danger" data-reject="${esc(x.id)}">✕ Reject</button></div></div>`;
  }).join('')||'<div class="success">No pending requests.</div>';

  document.querySelectorAll('[data-approve]').forEach(b=>b.addEventListener('click',()=>approve(b.dataset.approve)));
  document.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click',()=>reject(b.dataset.reject)));
  document.querySelectorAll('[data-view-screenshot]').forEach(b=>b.addEventListener('click',()=>openScreenshotModal(b.dataset.viewScreenshot)));
}

function rows(data){return data.map(x=>({id:x.id,date:x.createdAt?.toDate?x.createdAt.toDate().toLocaleString():'',name:x.name||'',phone:x.phone||'',reference:x.reference||'',quantity:Number(x.quantity||0),total:Number(x.total||0),status:x.status||'',ticketNumbers:(x.ticketNumbers||[]).map(n=>String(n).padStart(6,'0')).join(' ')}))}
function renderSummary(items,hasMore=false){
  const r=rows(items);
  $('summaryCount').textContent=hasMore?`${r.length} shown · more approved requests`:`${r.length} approved request(s)`;
  $('summaryTable').innerHTML=r.length?`<table><thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Qty</th><th>Total</th><th>Ticket Numbers</th><th>Action</th></tr></thead><tbody>${r.map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td>${esc(x.reference)}</td><td>${x.quantity}</td><td>${x.total}</td><td>${esc(x.ticketNumbers)}</td><td><button class="danger small-btn" data-cancel="${esc(x.id)}">Cancel</button></td></tr>`).join('')}</tbody></table>`:'<p class="muted">No approved requests yet.</p>';
  $('downloadCsv').onclick=()=>downloadCsv(`${safeFileName(lot.name)}-approved.csv`,r);
  $('copyExcel').onclick=async()=>{const tsv=[['Date','Name','Phone','Reference','Qty','Total','Ticket Numbers'],...r.map(x=>[x.date,x.name,x.phone,x.reference,x.quantity,x.total,x.ticketNumbers])].map(row=>row.map(v=>String(v).replace(/\t/g,' ').replace(/\n/g,' ')).join('\t')).join('\n');try{await navigator.clipboard.writeText(tsv);$('summaryMessage').innerHTML='<div class="success">Copied. Paste directly into Excel or Google Sheets.</div>'}catch{$('summaryMessage').innerHTML='<div class="error">Copy is blocked. Use Download CSV instead.</div>'}};
  document.querySelectorAll('[data-cancel]').forEach(b=>b.addEventListener('click',()=>cancelApproval(b.dataset.cancel)));
}
function downloadCsv(name,rows){const h=['Date','Name','Phone','Reference','Qty','Total','Ticket Numbers'];const csv='\ufeff'+[h,...rows.map(x=>[x.date,x.name,x.phone,x.reference,x.quantity,x.total,x.ticketNumbers])].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
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
  try{
    const r=doc(db,'ticketRequests',id),s=await getDoc(r);if(!s.exists())throw new Error('Request not found.');const x=s.data();if(x.status!=='pending')throw new Error('This request has already been reviewed.');if(x.lotteryId!==lot.id)throw new Error('Not authorized for this lottery.');
    const reason=prompt('Reason for rejection (for the customer):\n1. Reference not found\n2. Payment amount incorrect\n3. Screenshot unclear\n4. Duplicate request\n5. Other','Reference not found');if(reason===null)return;
    const cleaned=reason.trim()||'Payment could not be verified.';
    await updateDoc(r,{status:'rejected',rejectionReason:cleaned,reviewedBy:me.uid,reviewedAt:serverTimestamp()});
    const h=await phoneHash(x.phone||'');
    if(h){const pub=doc(db,'publicStatus',h,'requests',id);const ps=await getDoc(pub);if(ps.exists())await updateDoc(pub,{status:'rejected',rejectionReason:cleaned,reviewedAt:serverTimestamp()});}
    await addDoc(collection(db,'auditLogs'),{action:'rejectRequest',lotteryId:lot.id,requestId:id,adminId:me.uid,rejectionReason:cleaned,createdAt:serverTimestamp()});
    pendingTotal=Math.max(0,pendingTotal-1);
    const button=document.querySelector(`[data-reject="${CSS.escape(id)}"]`);
    button?.closest('.request-card')?.remove();
    $('statPending').textContent=pendingTotal;
    $('statRejected').textContent=Number($('statRejected').textContent||0)+1;
    $('pendingCount').textContent=pendingTotal>0?`${Math.min(50,pendingTotal)} shown · ${pendingTotal} pending`:'0 pending';
    $('message').innerHTML='<div class="success">Payment request rejected.</div>';
    await notifyBuyer(id);
  }catch(e){$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`}
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

    const displayedTicketTotal=displayedApproved.reduce((s,x)=>s+Number(x.quantity||0),0);
    $('statTickets').textContent=approvedHasMore?`${displayedTicketTotal}+`:`${displayedTicketTotal}`;

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
