import { db, auth } from '../../firebase.js';
import { onAuthStateChanged, signOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, updateDoc, query, where, runTransaction, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash } from '../../js/phoneHash.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let me=null,profile=null,lot=null,lastSummary=[];
$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html';});
$('refreshBtn').addEventListener('click',renderAll);
$('editBtn').addEventListener('click',editLottery);
$('closeSummary').addEventListener('click',()=>{$('summaryPanel').style.display='none';});

onAuthStateChanged(auth,async u=>{
  if(!u){location.href='login.html';return;}
  me=u;
  try{
    const p=await getDoc(doc(db,'users',u.uid));
    if(!p.exists()||p.data().role!=='lotteryAdmin'){location.href='login.html';return;}
    profile=p.data();
    const ids=profile.lotteryIds||[];
    if(!ids.length)throw new Error('No lottery assigned to this account.');
    const s=await getDoc(doc(db,'lotteries',ids[0]));
    if(!s.exists())throw new Error('Assigned lottery no longer exists.');
    lot={id:s.id,...s.data()};
    await renderAll();
  }catch(e){console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`;}
});

async function renderAll(){
  if(!lot)return;
  $('lotteryName').textContent='· '+lot.name;
  $('lotteryInfo').innerHTML=`<p><b>${esc(lot.name)}</b> <span class="badge ${esc(lot.status)}">${esc(lot.status)}</span></p><p>Ticket price: <b>${Number(lot.price||0)} Birr</b></p><p>Number range: ${esc(lot.min)} – ${esc(lot.max)}</p>`;
  const rs=await getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',lot.id)));
  const all=rs.docs.map(d=>({id:d.id,...d.data()}));
  const pending=all.filter(x=>x.status==='pending');
  lastSummary=all.filter(x=>x.status==='approved');
  renderPending(pending);
  renderSummary(lastSummary);
}
function renderPending(items){
  $('pendingCount').textContent=`${items.length} pending`;
  $('requests').innerHTML=items.map(x=>`<div class="row request-card">
    <div class="card-head"><div><b>${esc(x.name)}</b> · ${esc(x.phone)}</div><span class="badge pending">PENDING</span></div>
    <div>${Number(x.quantity||1)} ticket(s) · <b>${Number(x.total||0)} Birr</b> · Ref ${esc(x.reference||'')}</div>
    ${x.screenshotData?`<div class="screenshot-wrap"><a href="${esc(x.screenshotData)}" target="_blank" rel="noopener"><img src="${esc(x.screenshotData)}" alt="Payment screenshot"></a><div class="muted">Screenshot: ${Math.round(Number(x.screenshotBytes||0)/1024)} KB after compression</div></div>`:''}
    <div class="actions"><button data-approve="${esc(x.id)}">✓ Approve & Assign</button><button class="danger" data-reject="${esc(x.id)}">✕ Reject</button></div>
  </div>`).join('')||'<div class="success">No pending requests. New payment requests will appear here.</div>';
  document.querySelectorAll('[data-approve]').forEach(b=>b.addEventListener('click',()=>approve(b.dataset.approve)));
  document.querySelectorAll('[data-reject]').forEach(b=>b.addEventListener('click',()=>reject(b.dataset.reject)));
}
function renderSummary(items){
  const rows=items.map(x=>({
    date:x.createdAt?.toDate?x.createdAt.toDate().toLocaleString():'', name:x.name||'', phone:x.phone||'', reference:x.reference||'',
    quantity:Number(x.quantity||0), total:Number(x.total||0), status:x.status||'', ticketNumbers:(x.ticketNumbers||[]).join(' ')
  }));
  $('summaryCount').textContent=`${rows.length} approved`;
  $('summaryTable').innerHTML=rows.length?`<table><thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Qty</th><th>Total</th><th>Status</th><th>Ticket Numbers</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.reference)}</td><td>${r.quantity}</td><td>${r.total}</td><td>${esc(r.status)}</td><td>${esc(r.ticketNumbers)}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No approved requests yet.</p>';
  $('downloadCsv').onclick=()=>downloadCsv(`${safeFileName(lot.name)}-approved.csv`,rows);
  $('copyExcel').onclick=async()=>{
    const tsv=[['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'],...rows.map(r=>[r.date,r.name,r.phone,r.reference,r.quantity,r.total,r.status,r.ticketNumbers])].map(r=>r.map(v=>String(v).replace(/\t/g,' ').replace(/\n/g,' ')).join('\t')).join('\n');
    try{await navigator.clipboard.writeText(tsv);$('summaryMessage').innerHTML='<div class="success">Copied. Paste directly into Excel or Google Sheets.</div>';}catch(e){$('summaryMessage').innerHTML='<div class="error">Copy is blocked by this browser. Use Download CSV instead.</div>';}
  };
}
function downloadCsv(name,rows){
  const header=['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'];
  const csv='\ufeff'+[header,...rows.map(r=>[r.date,r.name,r.phone,r.reference,r.quantity,r.total,r.status,r.ticketNumbers])]
    .map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function safeFileName(s){return String(s||'lottery').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60);}

async function editLottery(){const name=prompt('Lottery name',lot.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',lot.price));if(!price||price<=0)return alert('Invalid price.');try{await updateDoc(doc(db,'lotteries',lot.id),{name:name.trim(),price});lot={...lot,name:name.trim(),price};await renderAll();$('message').innerHTML='<div class="success">Lottery updated.</div>';}catch(e){alert(e.message);}}
async function reject(id){if(!confirm('Reject this payment request?'))return;try{const r=doc(db,'ticketRequests',id);const rs=await getDoc(r);if(!rs.exists())throw new Error('Request not found.');const data=rs.data();if(data.status!=='pending')throw new Error('This request has already been reviewed.');if(data.lotteryId!==lot.id)throw new Error('Not authorized for this lottery.');await updateDoc(r,{status:'rejected',reviewedBy:me.uid,reviewedAt:serverTimestamp()});const h=await phoneHash(data.phone||'');if(h)await updateDoc(doc(db,'publicStatus',h,'requests',id),{status:'rejected',reviewedAt:serverTimestamp()});await renderAll();}catch(e){$('message').innerHTML=`<div class="error">${esc(e.message)}</div>`;}}
async function approve(id){
  if(!confirm('Approve this payment and assign random ticket number(s)?')) return;

  try{
    const initial = await getDoc(doc(db,'ticketRequests',id));

    if(!initial.exists()){
      throw new Error('Request not found.');
    }

    const initialData = initial.data();
    const publicHash = await phoneHash(initialData.phone || '');

    await runTransaction(db, async tx => {

      // ==============================
      // 1. READ REQUEST
      // ==============================
      const reqRef = doc(db,'ticketRequests',id);
      const reqSnap = await tx.get(reqRef);

      if(!reqSnap.exists()){
        throw new Error('Request not found.');
      }

      const x = reqSnap.data();

      if(x.status !== 'pending'){
        throw new Error('This request has already been reviewed.');
      }

      if(x.lotteryId !== lot.id){
        throw new Error('Not authorized for this lottery.');
      }


      // ==============================
      // 2. TICKET SETTINGS
      // ==============================
      const count = Math.max(
        1,
        Math.min(100, Number(x.quantity || 1))
      );

      const min = Number(lot.min);
      const max = Number(lot.max);
      const range = max - min + 1;

      if(count > range){
        throw new Error('Not enough ticket numbers in this lottery.');
      }


      // ==============================
      // 3. CREATE RANDOM CANDIDATES
      // READ ONLY A SMALL NUMBER
      // ==============================

      const candidates = [];
      const neededCandidates = Math.min(
        range,
        Math.max(count * 10, 20)
      );

      let attempts = 0;

      while(
        candidates.length < neededCandidates &&
        attempts < neededCandidates * 10
      ){
        attempts++;

        const n =
          Math.floor(Math.random() * range) + min;

        if(!candidates.includes(n)){
          candidates.push(n);
        }
      }


      // ==============================
      // 4. READ ALL CANDIDATES FIRST
      // ==============================

      const ticketRefs = candidates.map(n =>
        doc(db,'tickets',`${lot.id}_${n}`)
      );

      const ticketSnaps = [];

      for(const ref of ticketRefs){
        ticketSnaps.push(await tx.get(ref));
      }


      // ==============================
      // 5. FIND FREE TICKETS
      // ==============================

      const picks = [];

      for(let i = 0; i < candidates.length; i++){

        if(!ticketSnaps[i].exists()){
          picks.push(candidates[i]);
        }

        if(picks.length >= count){
          break;
        }
      }

      if(picks.length < count){
        throw new Error(
          'Could not find enough free ticket numbers. Please approve again.'
        );
      }


      // ==============================
      // 6. WRITES START HERE
      // ==============================

      for(const n of picks){

        const ticketRef =
          doc(db,'tickets',`${lot.id}_${n}`);

        tx.set(ticketRef,{
          lotteryId: lot.id,
          number: n,
          requestId: id,
          assignedAt: serverTimestamp(),
          assignedBy: me.uid
        });
      }


      // Update ticket request
      tx.update(reqRef,{
        status:'approved',
        ticketNumbers:picks,
        reviewedBy:me.uid,
        reviewedAt:serverTimestamp()
      });


      // Update public customer status
      if(publicHash){

        const publicRef = doc(
          db,
          'publicStatus',
          publicHash,
          'requests',
          id
        );

        tx.update(publicRef,{
          status:'approved',
          ticketNumbers:picks,
          reviewedAt:serverTimestamp()
        });
      }

    });


    $('message').innerHTML =
      '<div class="success">Payment approved and ticket number(s) assigned successfully.</div>';

    await renderAll();

  }catch(e){

    console.error(e);

    $('message').innerHTML =
      `<div class="error">${esc(e.message)}</div>`;
  }
}