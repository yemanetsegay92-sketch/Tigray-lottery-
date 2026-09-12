import { db, auth } from '../../firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, updateDoc, addDoc, query, where, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash } from '../../js/phoneHash.js';
const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me=null,profile=null,lots=[],lot=null,lastSummary=[];
async function notifyBuyer(requestId){
  try{
    const token=await auth.currentUser.getIdToken();
    const r=await fetch('/api/telegram/notify-buyer',{
      method:'POST',
      headers:{'content-type':'application/json','authorization':`Bearer ${token}`},
      body:JSON.stringify({requestId})
    });
    const j=await r.json();
    if(j.ok && j.sent){
      $('message').innerHTML='<div class="success">Buyer Telegram notification sent.</div>';
    }
  }catch(e){
    console.warn('Buyer Telegram notification failed:',e.message);
  }
}

async function connectTelegram(){
  try{
    const token=await auth.currentUser.getIdToken();
    const r=await fetch('/api/telegram/link-admin',{
      method:'POST',
      headers:{'authorization':`Bearer ${token}`}
    });
    const j=await r.json();
    if(!r.ok || !j.ok) throw new Error(j.error || 'Could not create Telegram connection link.');
    window.open(j.url,'_blank','noopener');
    $('telegramMessage').innerHTML='<div class="success">Telegram opened. Press Start in the bot, then return here and refresh.</div>';
  }catch(e){
    $('telegramMessage').innerHTML=`<div class="error">${esc(e.message)}</div>`;
  }
}

function refreshTelegramStatus(){
  const connected=!!profile?.telegramChatId;
  $('telegramStatus').innerHTML=connected
    ? `<span class="success">✓ Connected${profile.telegramUsername?` as @${esc(profile.telegramUsername)}`:''}</span>`
    : '<span class="muted">Not connected</span>';
}

$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html'});$('refreshBtn').addEventListener('click',renderAll);$('lotterySelect').addEventListener('change',async e=>{lot=lots.find(x=>x.id===e.target.value)||lot;await renderAll()});$('editBtn').addEventListener('click',editLottery);$('connectTelegram').addEventListener('click',connectTelegram);
onAuthStateChanged(auth,async u=>{if(!u){location.href='login.html';return}me=u;try{const p=await getDoc(doc(db,'users',u.uid));if(!p.exists()||p.data().role!=='lotteryAdmin'){location.href='login.html';return}profile=p.data();refreshTelegramStatus();const ids=profile.lotteryIds||[];if(!ids.length)throw new Error('No lottery assigned to this account.');const snaps=await Promise.all(ids.map(id=>getDoc(doc(db,'lotteries',id))));lots=snaps.filter(s=>s.exists()).map(s=>({id:s.id,...s.data()}));if(!lots.length)throw new Error('None of your assigned lotteries are available.');$('lotterySelect').innerHTML=lots.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');lot=lots[0];await renderAll()}catch(e){console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`}});
async function renderAll(){if(!lot)return;$('lotteryName').textContent='· '+lot.name;$('lotteryInfo').innerHTML=`<span class="meta-pill"><b>${esc(lot.name)}</b></span><span class="meta-pill">Status: ${esc(lot.status)}</span><span class="meta-pill">Price: ${Number(lot.price||0)} Birr</span><span class="meta-pill">Sequence: ${esc(lot.min)} – ${esc(lot.max)}</span>`;const rs=await getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',lot.id)));const all=rs.docs.map(d=>({id:d.id,...d.data()}));const pending=all.filter(x=>x.status==='pending'),approved=all.filter(x=>x.status==='approved'),rejected=all.filter(x=>x.status==='rejected');lastSummary=approved;$('statPending').textContent=pending.length;$('statApproved').textContent=approved.length;$('statRejected').textContent=rejected.length;$('statTickets').textContent=approved.reduce((s,x)=>s+Number(x.quantity||0),0);renderPending(pending);renderSummary(approved)}
function renderPending(items){$('pendingCount').textContent=`${items.length} pending`;$('requests').innerHTML=items.map(x=>`<div class="request-card"><div class="card-head"><div><b>${esc(x.name)}</b> · ${esc(x.phone)}</div><span class="badge pending">PENDING</span></div><p>${Number(x.quantity||1)} ticket(s) · <b>${Number(x.total||0)} Birr</b>${x.reference?` · Ref ${esc(x.reference)}`:''}</p>${x.screenshotData?`<div class="screenshot-wrap"><a href="${esc(x.screenshotData)}" target="_blank" rel="noopener"><img src="${esc(x.screenshotData)}" alt="Payment screenshot"></a></div>`:''}<div class="actions"><button data-approve="${esc(x.id)}">✓ Approve & Assign</button><button class="danger" data-reject="${esc(x.id)}">✕ Reject</button></div></div>`).join('')||'<div class="success">No pending requests.</div>';document.querySelectorAll('[data-approve]').forEach(b=>b.addEventListener('click',()=>approve(b.dataset.approve)));document.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click',()=>reject(b.dataset.reject)))}
function rows(data){return data.map(x=>({date:x.createdAt?.toDate?x.createdAt.toDate().toLocaleString():'',name:x.name||'',phone:x.phone||'',reference:x.reference||'',quantity:Number(x.quantity||0),total:Number(x.total||0),status:x.status||'',ticketNumbers:(x.ticketNumbers||[]).map(n=>String(n).padStart(6,'0')).join(' ')}))}
function renderSummary(items){const r=rows(items);$('summaryCount').textContent=`${r.length} approved request(s)`;$('summaryTable').innerHTML=r.length?`<table><thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Qty</th><th>Total</th><th>Status</th><th>Ticket Numbers</th></tr></thead><tbody>${r.map(x=>`<tr><td>${esc(x.date)}</td><td>${esc(x.name)}</td><td>${esc(x.phone)}</td><td>${esc(x.reference)}</td><td>${x.quantity}</td><td>${x.total}</td><td>${esc(x.status)}</td><td>${esc(x.ticketNumbers)}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No approved requests yet.</p>';$('downloadCsv').onclick=()=>downloadCsv(`${safeFileName(lot.name)}-approved.csv`,r);$('copyExcel').onclick=async()=>{const tsv=[['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'],...r.map(x=>[x.date,x.name,x.phone,x.reference,x.quantity,x.total,x.status,x.ticketNumbers])].map(row=>row.map(v=>String(v).replace(/\t/g,' ').replace(/\n/g,' ')).join('\t')).join('\n');try{await navigator.clipboard.writeText(tsv);$('summaryMessage').innerHTML='<div class="success">Copied. Paste directly into Excel or Google Sheets.</div>'}catch{$('summaryMessage').innerHTML='<div class="error">Copy is blocked. Use Download CSV instead.</div>'}}}
function downloadCsv(name,rows){const h=['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'];const csv='\ufeff'+[h,...rows.map(x=>[x.date,x.name,x.phone,x.reference,x.quantity,x.total,x.status,x.ticketNumbers])].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}function safeFileName(s){return String(s||'lottery').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)}
async function editLottery(){const name=prompt('Lottery name',lot.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',lot.price));if(!price||price<=0)return alert('Invalid price.');const status=prompt('Status: active, upcoming, closed, drawn',lot.status)||lot.status;try{await updateDoc(doc(db,'lotteries',lot.id),{name:name.trim(),price,status});lot={...lot,name:name.trim(),price,status};$('lotterySelect').selectedOptions[0].textContent=lot.name;await renderAll();await addDoc(collection(db,'auditLogs'),{action:'editLottery',lotteryId:lot.id,adminId:me.uid,createdAt:serverTimestamp()});$('message').innerHTML='<div class="success">Lottery updated.</div>'}catch(e){alert(e.message)}}
async function reject(id){if(!confirm('Reject this payment request?'))return;try{const r=doc(db,'ticketRequests',id),s=await getDoc(r);if(!s.exists())throw new Error('Request not found.');const x=s.data();if(x.status!=='pending')throw new Error('This request has already been reviewed.');if(x.lotteryId!==lot.id)throw new Error('Not authorized for this lottery.');const reason=prompt('Reason for rejection (for the customer):\n1. Reference not found\n2. Payment amount incorrect\n3. Screenshot unclear\n4. Duplicate request\n5. Other','Reference not found');if(reason===null)return;await updateDoc(r,{status:'rejected',rejectionReason:reason.trim()||'Payment could not be verified.',reviewedBy:me.uid,reviewedAt:serverTimestamp()});const h=await phoneHash(x.phone||'');const pub=doc(db,'publicStatus',h,'requests',id);const ps=await getDoc(pub);if(ps.exists())await updateDoc(pub,{status:'rejected',rejectionReason:reason.trim()||'Payment could not be verified.',reviewedAt:serverTimestamp()});await addDoc(collection(db,'auditLogs'),{action:'rejectRequest',lotteryId:lot.id,requestId:id,adminId:me.uid,rejectionReason:reason.trim()||'Payment could not be verified.',createdAt:serverTimestamp()});await renderAll();await notifyBuyer(id)}catch(e){$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`}}
async function approve(id){
  if(!confirm('Approve this payment and assign the next available ticket number(s)?')) return;
  try{
    const initial=await getDoc(doc(db,'ticketRequests',id));
    if(!initial.exists()) throw new Error('Request not found.');
    const initialData=initial.data();
    const publicHash=await phoneHash(initialData.phone||'');

    await runTransaction(db,async tx=>{
      // All transaction reads happen before any writes.
      const reqRef=doc(db,'ticketRequests',id);
      const lotRef=doc(db,'lotteries',lot.id);
      const reqSnap=await tx.get(reqRef);
      const lotSnap=await tx.get(lotRef);
      if(!reqSnap.exists()||!lotSnap.exists()) throw new Error('Request or lottery not found.');

      const x=reqSnap.data(), l=lotSnap.data();
      if(x.status!=='pending') throw new Error('This request has already been reviewed.');
      if(x.lotteryId!==lot.id) throw new Error('Not authorized for this lottery.');

      const count=Math.max(1,Math.min(100,Number(x.quantity||1)));
      const min=Number(l.min), max=Number(l.max);
      let next=Number.isFinite(Number(l.nextTicketNumber))?Number(l.nextTicketNumber):min;
      if(next<min||next>max) next=min;

      // Read a small consecutive window. This keeps phone/browser memory low.
      // If old tickets occupy some numbers, continue until we have enough free ones.
      const scanLimit=Math.min(max-next+1,Math.max(count+20,count*4));
      const refs=[];
      for(let n=next;n<next+scanLimit;n++) refs.push({n,ref:doc(db,'tickets',`${lot.id}_${n}`)});
      const snaps=[];
      for(const item of refs) snaps.push({n:item.n,ref:item.ref,snap:await tx.get(item.ref)});

      const picks=snaps.filter(x=>!x.snap.exists()).slice(0,count).map(x=>x.n);
      if(picks.length<count) throw new Error('Not enough free ticket numbers are immediately available. Please approve again.');

      // Read public status before writes.
      let publicRef=null, publicSnap=null;
      if(publicHash){
        publicRef=doc(db,'publicStatus',publicHash,'requests',id);
        publicSnap=await tx.get(publicRef);
      }

      // ---------------- WRITES START HERE ----------------
      for(const n of picks){
        const item=snaps.find(v=>v.n===n);
        tx.set(item.ref,{lotteryId:lot.id,number:n,requestId:id,assignedAt:serverTimestamp(),assignedBy:me.uid});
      }
      const nextAfter=Math.max(...picks)+1;
      tx.update(reqRef,{status:'approved',ticketNumbers:picks,reviewedBy:me.uid,reviewedAt:serverTimestamp()});
      tx.update(lotRef,{nextTicketNumber:nextAfter});
      if(publicSnap?.exists()){
        tx.update(publicRef,{status:'approved',ticketNumbers:picks,reviewedAt:serverTimestamp()});
      }
    });

    $('message').innerHTML='<div class="success">Payment approved and ticket number(s) assigned.</div>';
    await renderAll();
    await notifyBuyer(id);
  }catch(e){
    console.error(e);
    $('message').innerHTML=`<div class="error">${esc(e.message)}</div>`;
  }
}
