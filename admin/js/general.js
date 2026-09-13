import { db, auth, createSecondaryAuth } from '../../firebase.js';
import { onAuthStateChanged, signOut, createUserWithEmailAndPassword, updateProfile, signOut as authSignOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, addDoc, updateDoc, deleteDoc, setDoc, serverTimestamp, query, where, arrayUnion } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lots=[];
let drawDigits=[];
let drawBusy=false;

$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html';});
$('generatePassword')?.addEventListener('click',()=>{$('resetPassword').value=generateTempPassword();$('resetPassword').focus();});
$('resetPasswordForm')?.addEventListener('submit',resetLotteryAdminPassword);
$('drawLotterySelect')?.addEventListener('change',()=>setupDraw());
$('drawDigitBtn')?.addEventListener('click',drawDigit);
$('resetDrawBtn')?.addEventListener('click',resetDraw);
$('saveDrawBtn')?.addEventListener('click',saveDraw);
$('closeSummary')?.addEventListener('click',()=>{$('summaryPanel').style.display='none';});

onAuthStateChanged(auth,async u=>{
  if(!u){location.href='login.html';return;}
  try{
    const p=await getDoc(doc(db,'users',u.uid));
    if(!p.exists()||p.data().role!=='generalAdmin'){location.href='login.html';return;}
    await renderLotteries();
    await renderSummaryOverview();
    setupDraw();
  }catch(e){console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message||'Could not load the General Admin dashboard.')}</div>`;}
});

$('createForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const min=Number($('min').value),max=Number($('max').value),price=Number($('price').value);
    if(!Number.isFinite(min)||!Number.isFinite(max)||min>max||price<=0)throw new Error('Check price and number range.');
    const newLottery=await addDoc(collection(db,'lotteries'),{name:$('name').value.trim(),price,min,max,status:$('status').value,description:$('description').value.trim(),createdAt:serverTimestamp(),adminIds:[],nextTicketNumber:min});
    await addDoc(collection(db,'auditLogs'),{action:'createLottery',lotteryId:newLottery.id,adminId:auth.currentUser.uid,createdAt:serverTimestamp()});
    e.target.reset();$('message').innerHTML='<div class="success">Lottery created.</div>';await renderLotteries();await renderSummaryOverview();setupDraw();
  }catch(err){console.error(err);$('message').innerHTML=`<div class="error">${esc(err.message)}</div>`;}
});

async function findAdminByEmail(email){
  const qs=await getDocs(query(collection(db,'users'),where('email','==',email)));
  const hit=qs.docs.find(d=>d.data().role==='lotteryAdmin');
  return hit?{id:hit.id,...hit.data()}:null;
}
async function setAdminMessage(text,ok=false){$('adminMessage').innerHTML=`<div class="${ok?'success':'error'}">${esc(text)}</div>`;}

async function createNewLotteryAdmin({email,password,displayName,lotteryId}){
  const existing=await findAdminByEmail(email);
  if(existing)throw new Error('This email is already a Lottery Admin. Use “Assign another lottery” below instead.');
  let secondaryAuth;
  try{
    secondaryAuth=createSecondaryAuth(`creator_${Date.now()}`);
    const cred=await createUserWithEmailAndPassword(secondaryAuth,email,password);
    await updateProfile(cred.user,{displayName});
    await setDoc(doc(db,'users',cred.user.uid),{role:'lotteryAdmin',lotteryIds:[lotteryId],displayName,email,createdAt:serverTimestamp()});
    await addDoc(collection(db,'auditLogs'),{action:'createLotteryAdmin',lotteryId,adminId:auth.currentUser.uid,targetUserId:cred.user.uid,createdAt:serverTimestamp()});
    return cred.user.uid;
  }finally{if(secondaryAuth)try{await authSignOut(secondaryAuth)}catch{}}
}

$('adminForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=e.target.querySelector('button');btn.disabled=true;
  try{
    if(!lots.length)throw new Error('Create a lottery first.');
    const lotteryId=$('adminLottery').value,email=$('adminEmail').value.trim().toLowerCase(),password=$('adminPassword').value,displayName=$('adminName').value.trim();
    if(!lotteryId||!email||password.length<6||!displayName)throw new Error('Complete all new-admin fields.');
    await createNewLotteryAdmin({email,password,displayName,lotteryId});e.target.reset();await renderAdminList();await setAdminMessage('Lottery admin account created and assigned.',true);
  }catch(err){console.error(err);const msg=err?.code==='auth/email-already-in-use'?'This email already exists in Firebase Authentication. Use “Assign another lottery” if this is an existing Lottery Admin.':(err?.code==='permission-denied'?'Firestore permission denied while saving the admin profile. Make sure the General Admin profile exists and the V6 rules are published.':(err.message||'Could not create lottery admin.'));await setAdminMessage(msg,false)}finally{btn.disabled=false;}
});

$('assignForm').addEventListener('submit',async e=>{
  e.preventDefault();const btn=e.target.querySelector('button');btn.disabled=true;
  try{
    const email=$('assignEmail').value.trim().toLowerCase(),lotteryId=$('assignLottery').value;
    if(!email||!lotteryId)throw new Error('Enter the admin email and choose a lottery.');
    const admin=await findAdminByEmail(email);if(!admin)throw new Error('No Lottery Admin profile was found for this email. Create the admin account first.');
    const ids=Array.isArray(admin.lotteryIds)?admin.lotteryIds:[];if(ids.includes(lotteryId))throw new Error('This admin is already assigned to that lottery.');
    await updateDoc(doc(db,'users',admin.id),{lotteryIds:arrayUnion(lotteryId)});await addDoc(collection(db,'auditLogs'),{action:'assignLottery',lotteryId,adminId:auth.currentUser.uid,targetUserId:admin.id,createdAt:serverTimestamp()});e.target.reset();await renderAdminList();await setAdminMessage('Lottery assigned successfully. This admin can now manage both lotteries.',true);
  }catch(err){console.error(err);await setAdminMessage(err.message||'Could not assign lottery.',false)}finally{btn.disabled=false;}
});

async function renderAdminList(){
  const host=$('adminList');
  try{
    const qs=await getDocs(query(collection(db,'users'),where('role','==','lotteryAdmin'))),rows=qs.docs.map(d=>({id:d.id,...d.data()}));
    $('statAdmins').textContent=rows.length;
    host.innerHTML=rows.length?`<table><thead><tr><th>Admin</th><th>Email</th><th>Assigned lotteries</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${esc(a.displayName||'')}</td><td>${esc(a.email||'')}</td><td>${(a.lotteryIds||[]).map(id=>{const l=lots.find(x=>x.id===id);return esc(l?l.name:id)}).join(', ')}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No lottery admins yet.</p>';
  }catch(e){host.innerHTML=`<div class="error">${esc(e.message||'Could not load lottery admins.')}</div>`;}
}

async function renderLotteries(){
  const ls=await getDocs(collection(db,'lotteries'));lots=ls.docs.map(d=>({id:d.id,...d.data()}));$('statLotteries').textContent=lots.length;
  const opts=lots.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');$('adminLottery').innerHTML=opts;$('assignLottery').innerHTML=opts;if($('drawLotterySelect'))$('drawLotterySelect').innerHTML=opts;
  $('lotteries').innerHTML=lots.map(x=>`<div class="row"><b>${esc(x.name)}</b> <span class="badge ${esc(x.status)}">${esc(x.status)}</span><br><span class="muted">ID: ${esc(x.id)} · ${Number(x.price||0)} Birr · ${esc(x.min)}–${esc(x.max)} · Next: ${esc(x.nextTicketNumber??x.min)}</span><div class="actions"><button data-edit="${esc(x.id)}">Edit</button><button class="secondary" data-summary="${esc(x.id)}">Open Summary</button><button class="danger" data-delete="${esc(x.id)}">Delete</button></div></div>`).join('')||'<p class="muted">No lotteries.</p>';
  document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editLottery(b.dataset.edit)));
  document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>removeLottery(b.dataset.delete)));
  document.querySelectorAll('[data-summary]').forEach(b=>b.addEventListener('click',()=>openLotterySummary(b.dataset.summary)));
  await renderAdminList();
}

async function renderSummaryOverview(){
  const host=$('overview');host.innerHTML='<p class="muted">Loading summary…</p>';
  try{
    const rows=[];let totalTickets=0,totalRevenue=0;
    for(const lot of lots){
      const qs=await getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',lot.id))),docs=qs.docs;
      const approved=docs.filter(d=>d.data().status==='approved'),pending=docs.filter(d=>d.data().status==='pending'),rejected=docs.filter(d=>d.data().status==='rejected'),cancelled=docs.filter(d=>d.data().status==='cancelled');
      const revenue=approved.reduce((s,d)=>s+Number(d.data().total||0),0);totalTickets+=approved.reduce((s,d)=>s+Number(d.data().quantity||0),0);totalRevenue+=revenue;
      rows.push(`<div class="row"><b>${esc(lot.name)}</b><br><span class="muted">Approved: ${approved.length} · Pending: ${pending.length} · Rejected: ${rejected.length} · Cancelled: ${cancelled.length} · Approved value: ${revenue} Birr</span></div>`);
    }
    $('statTickets').textContent=totalTickets;$('statRevenue').textContent=`${totalRevenue} Birr`;host.innerHTML=rows.join('')||'<p class="muted">No lotteries yet.</p>';
  }catch(e){host.innerHTML=`<div class="error">${esc(e.message||'Could not load summary.')}</div>`;}
}

async function openLotterySummary(id){
  const lot=lots.find(x=>x.id===id);if(!lot)return;$('summaryTitle').textContent=`Summary · ${lot.name}`;$('summaryPanel').style.display='block';$('summaryTable').innerHTML='<p class="muted">Loading…</p>';
  try{const qs=await getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',id)));renderSummaryTable(qs.docs.map(d=>({id:d.id,...d.data()})),lot);$('summaryPanel').scrollIntoView({behavior:'smooth'});}catch(e){$('summaryTable').innerHTML=`<div class="error">${esc(e.message||'Could not load summary.')}</div>`;}
}
function makeRows(data){return data.map(x=>({date:x.createdAt?.toDate?x.createdAt.toDate().toLocaleString():'',name:x.name||'',phone:x.phone||'',reference:x.reference||'',quantity:Number(x.quantity||0),total:Number(x.total||0),status:x.status||'',ticketNumbers:(x.ticketNumbers||[]).join(' ')}))}
function tableHtml(rows){return `<table><thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Qty</th><th>Total</th><th>Status</th><th>Ticket Numbers</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.name)}</td><td>${esc(r.phone)}</td><td>${esc(r.reference)}</td><td>${r.quantity}</td><td>${r.total}</td><td>${esc(r.status)}</td><td>${esc(r.ticketNumbers)}</td></tr>`).join('')}</tbody></table>`}
function renderSummaryTable(items,lot){const approved=makeRows(items.filter(x=>x.status==='approved'));$('summaryCount').textContent=`${approved.length} approved request(s)`;$('summaryTable').innerHTML=approved.length?tableHtml(approved):'<p class="muted">No approved requests yet.</p>';$('downloadCsv').onclick=()=>downloadCsv(`${safeFileName(lot.name)}-approved.csv`,approved);$('copyExcel').onclick=async()=>{const tsv=[['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'],...approved.map(r=>[r.date,r.name,r.phone,r.reference,r.quantity,r.total,r.status,r.ticketNumbers])].map(r=>r.map(cell=>String(cell).replace(/\t/g,' ').replace(/\n/g,' ')).join('\t')).join('\n');try{await navigator.clipboard.writeText(tsv);$('summaryMessage').innerHTML='<div class="success">Copied. Paste directly into Excel or Google Sheets.</div>'}catch{$('summaryMessage').innerHTML='<div class="error">Copy is blocked by this browser. Use Download CSV instead.</div>'}}}
function downloadCsv(name,rows){const header=['Date','Name','Phone','Reference','Qty','Total','Status','Ticket Numbers'];const csv='\ufeff'+[header,...rows.map(r=>[r.date,r.name,r.phone,r.reference,r.quantity,r.total,r.status,r.ticketNumbers])].map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
function safeFileName(s){return String(s||'lottery').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)}

async function editLottery(id){const x=lots.find(l=>l.id===id);if(!x)return;const name=prompt('Lottery name',x.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',x.price));if(!price||price<=0)return alert('Invalid price.');const status=prompt('Status: active, upcoming, closed, drawn',x.status)||x.status;try{await updateDoc(doc(db,'lotteries',id),{name:name.trim(),price,status});await addDoc(collection(db,'auditLogs'),{action:'editLottery',lotteryId:id,adminId:auth.currentUser.uid,createdAt:serverTimestamp()});await renderLotteries();await renderSummaryOverview();setupDraw();}catch(e){alert(e.message)}}
async function removeLottery(id){if(!confirm('Delete this lottery? This action should only be used when the lottery is no longer needed.'))return;try{await deleteDoc(doc(db,'lotteries',id));await addDoc(collection(db,'auditLogs'),{action:'deleteLottery',lotteryId:id,adminId:auth.currentUser.uid,createdAt:serverTimestamp()});await renderLotteries();await renderSummaryOverview();setupDraw();}catch(e){alert(e.message)}}

async function resetLotteryAdminPassword(e){
  e.preventDefault();const btn=e.target.querySelector('button[type="submit"]');btn.disabled=true;
  try{
    const email=$('resetEmail').value.trim().toLowerCase(),password=$('resetPassword').value;
    if(!email||password.length<6)throw new Error('Enter an existing Lottery Admin email and a password of at least 6 characters.');
    const token=await auth.currentUser.getIdToken();const r=await fetch('/api/admin/reset-password',{method:'POST',headers:{'content-type':'application/json','authorization':`Bearer ${token}`},body:JSON.stringify({email,password})});const j=await r.json();if(!r.ok||!j.ok)throw new Error(j.error||'Could not reset password.');
    $('resetMessage').innerHTML=`<div class="success">✅ Password changed for ${esc(j.displayName||email)}. Give the Lottery Admin this temporary password securely: <b>${esc(password)}</b></div>`;await addDoc(collection(db,'auditLogs'),{action:'resetLotteryAdminPasswordUI',adminId:auth.currentUser.uid,targetEmail:email,createdAt:serverTimestamp()});
  }catch(e){$('resetMessage').innerHTML=`<div class="error">${esc(e.message)}</div>`}finally{btn.disabled=false;}
}

function generateTempPassword(){const chars='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#';let out='';const bytes=new Uint32Array(12);crypto.getRandomValues(bytes);for(const n of bytes)out+=chars[n%chars.length];return out}

function setupDraw(){
  const select=$('drawLotterySelect');if(!select)return;
  const id=select.value||(lots[0]?.id||'');if(id)select.value=id;
  const x=lots.find(l=>l.id===select.value)||lots[0];if(!x)return;
  drawDigits=[];$('drawResult').textContent='';$('drawMessage').innerHTML='';renderBalls();updateDrawUI(x);
}
function renderBalls(){
  const host=$('drawBottle');if(!host)return;
  host.querySelectorAll('.draw-ball').forEach(el=>el.remove());
  for(let d=0;d<=9;d++){const el=document.createElement('div');el.className='draw-ball';el.dataset.digit=d;el.textContent=d;host.appendChild(el);positionBall(el,true);}
}
function positionBall(el,initial=false){
  const left=12+Math.random()*72,top=18+Math.random()*65;el.style.left=`${left}%`;el.style.top=`${top}%`;if(initial)el.style.transition='none';setTimeout(()=>el.style.transition='',20);}
function shuffleBalls(){document.querySelectorAll('.draw-ball').forEach(el=>positionBall(el));}
function updateDrawUI(lottery){
  const maxLen=String(Math.max(Math.abs(Number(lottery.max||0)),Math.abs(Number(lottery.min||0)))).replace(/^-/,'').length||1;
  $('drawTarget').textContent=`${drawDigits.length}/${maxLen} digits`;
  $('drawResult').textContent=drawDigits.join('');
  $('drawDigitBtn').disabled=drawBusy||drawDigits.length>=maxLen||lottery.status==='drawn';
  $('resetDrawBtn').disabled=drawBusy;
  $('saveDrawBtn').disabled=drawBusy||drawDigits.length!==maxLen||lottery.status==='drawn';
  if(lottery.status==='drawn')$('drawMessage').innerHTML='<div class="success">This lottery already has a saved draw result.</div>';
}
async function drawDigit(){
  const lottery=lots.find(l=>l.id===$('drawLotterySelect').value)||lots[0];if(!lottery||drawBusy||lottery.status==='drawn')return;
  const maxLen=String(Math.max(Math.abs(Number(lottery.max||0)),Math.abs(Number(lottery.min||0)))).replace(/^-/,'').length||1;
  if(drawDigits.length>=maxLen)return;
  drawBusy=true;updateDrawUI(lottery);shuffleBalls();
  await new Promise(r=>setTimeout(r,650));
  const digit=Math.floor(Math.random()*10);const ball=document.querySelector(`.draw-ball[data-digit="${digit}"]`);if(ball){document.querySelectorAll('.draw-ball').forEach(b=>b.classList.remove('opened'));ball.classList.add('opened');}
  drawDigits.push(digit);$('drawResult').textContent=drawDigits.map(String).join('');
  await new Promise(r=>setTimeout(r,450));
  if(ball)ball.classList.remove('opened');
  drawBusy=false;updateDrawUI(lottery);
  if(drawDigits.length===maxLen)$('drawMessage').innerHTML='<div class="success">Number complete. Review it, then save the draw result.</div>';
}
function resetDraw(){drawDigits=[];$('drawMessage').innerHTML='';$('drawResult').textContent='';const l=lots.find(x=>x.id===$('drawLotterySelect').value)||lots[0];renderBalls();if(l)updateDrawUI(l)}
async function saveDraw(){
  const lottery=lots.find(l=>l.id===$('drawLotterySelect').value)||lots[0];if(!lottery||drawDigits.length===0)return;
  const result=drawDigits.join('');if(!confirm(`Save ${result} as the draw result for ${lottery.name}?`))return;
  try{
    await updateDoc(doc(db,'lotteries',lottery.id),{status:'drawn',drawnNumber:result,drawDigits,drawnAt:serverTimestamp(),drawnBy:auth.currentUser.uid});
    await addDoc(collection(db,'auditLogs'),{action:'saveDrawResult',lotteryId:lottery.id,drawnNumber:result,adminId:auth.currentUser.uid,createdAt:serverTimestamp()});
    lottery={...lottery,status:'drawn',drawnNumber:result,drawDigits};lots=lots.map(l=>l.id===lottery.id?lottery:l);
    $('drawMessage').innerHTML='<div class="success">✅ Draw result saved successfully.</div>';updateDrawUI(lottery);await renderLotteries();await renderSummaryOverview();
  }catch(e){$('drawMessage').innerHTML=`<div class="error">${esc(e.message)}</div>`}
}
