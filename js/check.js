import { db } from '../firebase.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash, normalizePhone } from './phoneHash.js';
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function formatDate(ts){try{return ts?.toDate?ts.toDate().toLocaleString():''}catch{return ''}}
$('checkForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const phone=await normalizePhone($('phone').value); if(!phone)return;
  $('message').innerHTML='<div class="message">Checking…</div>'; $('results').innerHTML='';
  try{
    const h=await phoneHash(phone);
    const snap=await getDocs(collection(db,'publicStatus',h,'requests'));
    if(snap.empty){$('message').innerHTML='<div class="error">No ticket requests found for this phone number.</div>';return;}
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt?.seconds||0)-(a.createdAt?.seconds||0));
    $('message').innerHTML=`<div class="success">Found ${rows.length} request${rows.length===1?'':'s'}.</div>`;
    $('results').innerHTML=rows.map(x=>`<div class="card row"><div><b>${esc(x.lotteryName||x.lotteryId)}</b> <span class="badge ${esc(x.status)}">${esc(x.status||'pending')}</span></div><p>Requested tickets: <b>${Number(x.quantity||1)}</b></p><p>Total: <b>${Number(x.total||0)} Birr</b></p>${x.status==='approved'?`<p>🎟️ Your ticket number${(x.ticketNumbers||[]).length===1?'':'s'}:</p><div>${(x.ticketNumbers||[]).map(n=>`<span class="ticket-chip">${esc(n)}</span>`).join('')}</div>`:''}${x.status==='pending'?'<p class="muted">Waiting for payment approval.</p>':''}${x.status==='rejected'?'<p class="muted">This payment request was rejected. Contact support if you think this is a mistake.</p>':''}<p class="muted">${formatDate(x.createdAt)}</p></div>`).join('');
  }catch(err){ console.error(err); $('message').innerHTML='<div class="error">Could not check status. Please try again.</div>'; }
});
