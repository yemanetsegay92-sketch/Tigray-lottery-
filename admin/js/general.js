import { db, auth, createSecondaryAuth } from '../../firebase.js';
import { onAuthStateChanged, signOut, createUserWithEmailAndPassword, updateProfile, signOut as authSignOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, addDoc, updateDoc, deleteDoc, setDoc, serverTimestamp, query, where, orderBy } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lots=[];

$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html';});

onAuthStateChanged(auth,async u=>{
  if(!u){location.href='login.html';return;}
  try{
    const p=await getDoc(doc(db,'users',u.uid));
    if(!p.exists() || p.data().role!=='generalAdmin'){location.href='login.html';return;}
    await renderLotteries();
    await renderSummaryOverview();
  }catch(e){
    console.error(e);
    $('message').innerHTML=`<div class="error">${esc(e.message||'Could not load the General Admin dashboard.')}</div>`;
  }
});

$('createForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const min=Number($('min').value),max=Number($('max').value),price=Number($('price').value);
    if(!Number.isFinite(min)||!Number.isFinite(max)||min>max||price<=0) throw new Error('Check price and number range.');
    await addDoc(collection(db,'lotteries'),{
      name:$('name').value.trim(),price,min,max,status:$('status').value,
      description:$('description').value.trim(),createdAt:serverTimestamp(),adminIds:[]
    });
    e.target.reset(); $('message').innerHTML='<div class="success">Lottery created.</div>';
    await renderLotteries(); await renderSummaryOverview();
  }catch(err){console.error(err);$('message').innerHTML=`<div class="error">${esc(err.message)}</div>`;}
});

$('adminForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=e.target.querySelector('button');btn.disabled=true;
  try{
    if(!lots.length) throw new Error('Create a lottery first.');
    const lotteryId=$('adminLottery').value;
    const email=$('adminEmail').value.trim();
    const password=$('adminPassword').value;
    const displayName=$('adminName').value.trim();
    if(!lotteryId||!email||password.length<6||!displayName) throw new Error('Complete all lottery-admin fields.');

    const secondaryAuth=createSecondaryAuth();
    const cred=await createUserWithEmailAndPassword(secondaryAuth,email,password);
    await updateProfile(cred.user,{displayName});
    await setDoc(doc(db,'users',cred.user.uid),{
      role:'lotteryAdmin',lotteryIds:[lotteryId],displayName,email,createdAt:serverTimestamp()
    });
    await authSignOut(secondaryAuth);
    $('adminForm').reset();
    $('adminMessage').innerHTML='<div class="success">Lottery admin account created and assigned.</div>';
  }catch(err){
    console.error(err);
    $('adminMessage').innerHTML=`<div class="error">${esc(err.message||'Could not create lottery admin.')}</div>`;
  }finally{btn.disabled=false;}
});

async function renderLotteries(){
  const ls=await getDocs(collection(db,'lotteries'));
  lots=ls.docs.map(d=>({id:d.id,...d.data()}));
  $('adminLottery').innerHTML=lots.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.id)})</option>`).join('');
  $('lotteries').innerHTML=lots.map(x=>`<div class="row">
    <b>${esc(x.name)}</b> <span class="badge ${esc(x.status)}">${esc(x.status)}</span>
    <br><span class="muted">ID: ${esc(x.id)} · ${Number(x.price||0)} Birr · ${esc(x.min)}–${esc(x.max)}</span>
    <div class="actions">
      <button data-edit="${esc(x.id)}">Edit</button>
      <button class="secondary" data-summary="${esc(x.id)}">Open Summary</button>
      <button class="danger" data-delete="${esc(x.id)}">Delete</button>
    </div>
  </div>`).join('')||'<p class="muted">No lotteries.</p>';
  document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editLottery(b.dataset.edit)));
  document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>removeLottery(b.dataset.delete)));
  document.querySelectorAll('[data-summary]').forEach(b=>b.addEventListener('click',()=>openLotterySummary(b.dataset.summary)));
}

async function renderSummaryOverview(){
  const host=$('overview');
  host.innerHTML='<p class="muted">Loading summary…</p>';
  try{
    const rows=[];
    for(const lot of lots){
      const qs=await getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',lot.id)));
      const approved=qs.docs.filter(d=>d.data().status==='approved');
      const pending=qs.docs.filter(d=>d.data().status==='pending');
      const rejected=qs.docs.filter(d=>d.data().status==='rejected');
      const revenue=approved.reduce((s,d)=>s+Number(d.data().total||0),0);
      rows.push(`<div class="row"><b>${esc(lot.name)}</b><br><span class="muted">Approved: ${approved.length} · Pending: ${pending.length} · Rejected: ${rejected.length} · Approved value: ${revenue} Birr</span></div>`);
    }
    host.innerHTML=rows.join('')||'<p class="muted">No lotteries yet.</p>';
  }catch(e){host.innerHTML=`<div class="error">${esc(e.message||'Could not load summary.')}</div>`;}
}

async function openLotterySummary(id){
  const lot=lots.find(x=>x.id===id); if(!lot)return;
  $('summaryTitle').textContent=`Summary · ${lot.name}`;
  $('summaryPanel').style.display='block';
  $('summaryTable').innerHTML='<p class="muted">Loading…</p>';
  try{
    const qs=await getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',id)));
    renderSummaryTable(qs.docs.map(d=>({id:d.id,...d.data()})),lot);
    $('summaryPanel').scrollIntoView({behavior:'smooth'});
  }catch(e){$('summaryTable').innerHTML=`<div class="error">${esc(e.message||'Could not load summary.')}</div>`;}
}

function makeRows(data){return data.map(x=>({
  date:x.createdAt?.toDate ? x.createdAt.toDate().toLocaleString() : '',
  name:x.name||'', phone:x.phone||'', reference:x.reference||'', quantity:Number(x.quantity||0), total:Number(x.total||0),
  status:x.status||'', ticketNumbers:(x.ticketNumbers||[]).join(' ')
}));}
function tableHtml(rows){
  return `<table><thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Qty</th><th>Total</th><th>Status</th><th>Ticket Numbers</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.reference)}</td><td>${r.quantity}</td><td>${r.total}</td><td>${esc(r.status)}</td><td>${esc(r.ticketNumbers)}</td></tr>`).join('')}</tbody></table>`;
}
function renderSummaryTable(items,lot){
  const approved=makeRows(items.filter(x=>x.status==='approved'));
  $('summaryCount').textContent=`${approved.length} approved request(s)`;
  $('summaryTable').innerHTML=approved.length?tableHtml(approved):'<p class="muted">No approved requests yet.</p>';
  const exportData=approved;
  $('downloadCsv').onclick=()=>downloadCsv(`${safeFileName(lot.name)}-approved.csv`,exportData);
  $('copyExcel').onclick=async()=>{
    const tsv=[['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'],...exportData.map(r=>[r.date,r.name,r.phone,r.reference,r.quantity,r.total,r.status,r.ticketNumbers])].map(r=>r.map(cell=>String(cell).replace(/\t/g,' ').replace(/\n/g,' ')).join('\t')).join('\n');
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

$('closeSummary')?.addEventListener('click',()=>{$('summaryPanel').style.display='none';});
async function editLottery(id){const x=lots.find(l=>l.id===id);if(!x)return;const name=prompt('Lottery name',x.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',x.price));if(!price||price<=0)return alert('Invalid price.');const status=prompt('Status: active, upcoming, closed, drawn',x.status)||x.status;try{await updateDoc(doc(db,'lotteries',id),{name:name.trim(),price,status});await renderLotteries();await renderSummaryOverview();}catch(e){alert(e.message);}}
async function removeLottery(id){if(!confirm('Delete this lottery? This is only recommended for test lotteries.'))return;try{await deleteDoc(doc(db,'lotteries',id));await renderLotteries();await renderSummaryOverview();}catch(e){alert(e.message);}}
