import { db } from '../firebase.js';
import { collection, getDocs } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const list = document.getElementById('lotteryList');

async function home(){
  try{
    const snap = await getDocs(collection(db,'lotteries'));
    const lots = snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status!=='hidden');
    lots.sort((a,b)=>(a.status==='active'?0:1)-(b.status==='active'?0:1));
    list.innerHTML = lots.length ? lots.map(x=>{
      const action = x.status==='active'
        ? `<a class="btn" href="buy.html?lot=${encodeURIComponent(x.id)}">Buy Ticket</a>`
        : `<button disabled>${x.status==='upcoming'?'Coming Soon':x.status==='drawn'?'Draw Completed':'Closed'}</button>`;
      return `<article class="card"><div class="status ${esc(x.status)}">${esc(x.status)}</div><h2>${esc(x.name)}</h2><p>Ticket price: <b>${Number(x.price||0)} Birr</b></p><p>Number range: ${esc(x.min)} – ${esc(x.max)}</p>${x.description?`<p class="muted">${esc(x.description)}</p>`:''}${action}</article>`;
    }).join('') : '<p class="empty">No lotteries available yet.</p>';
  }catch(e){
    console.error(e);
    list.innerHTML='<div class="error">Unable to load lotteries. Please try again.</div>';
  }
}
home();
