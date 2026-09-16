import { db, auth } from '../../firebase.js';
import { collection, doc, getDocs, query, where, updateDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const wait=ms=>new Promise(r=>setTimeout(r,ms));

function addAwardsField(){
  const form=document.getElementById('createForm');
  if(!form || document.getElementById('v9AwardsField')) return;
  const wrap=document.createElement('label');
  wrap.id='v9AwardsField';
  wrap.className='span2';
  wrap.innerHTML='<span>Winner Awards (one per line)</span><textarea id="v9Awards" rows="4" placeholder="1st prize – 100,000 Birr\n2nd prize – 50,000 Birr\n3rd prize – 25,000 Birr"></textarea>';
  const grid=form.querySelector('.grid2');
  if(grid) grid.appendChild(wrap); else form.insertBefore(wrap,form.querySelector('button'));

  form.addEventListener('submit', async ()=>{
    const name=(document.getElementById('name')?.value||'').trim();
    const awards=(document.getElementById('v9Awards')?.value||'').split(/\n+/).map(x=>x.trim()).filter(Boolean);
    if(!name || !awards.length) return;
    window.__v9PendingAwards={name,awards,startedAt:Date.now()};
    for(let i=0;i<15;i++){
      await wait(700);
      const p=window.__v9PendingAwards;
      if(!p) return;
      try{
        const snap=await getDocs(query(collection(db,'lotteries'),where('name','==',p.name)));
        const candidates=snap.docs.filter(d=>{
          const t=d.data().createdAt?.toDate?.()?.getTime?.()||0;
          return t>=p.startedAt-5000;
        });
        if(candidates.length){
          const hit=candidates.sort((a,b)=>((b.data().createdAt?.seconds||0)-(a.data().createdAt?.seconds||0)))[0];
          await updateDoc(doc(db,'lotteries',hit.id),{awards:p.awards,awardsUpdatedAt:serverTimestamp(),awardsUpdatedBy:auth.currentUser?.uid||null});
          window.__v9PendingAwards=null;
          const field=document.getElementById('v9Awards');if(field)field.value='';
          return;
        }
      }catch(e){console.error('V9 awards save:',e)}
    }
  },true);
}

function addAwardsButtons(){
  document.querySelectorAll('#lotteries .row').forEach(row=>{
    if(row.querySelector('[data-v9-awards]')) return;
    const existing=[...row.querySelectorAll('button')].find(b=>b.dataset.edit||b.dataset.summary||b.dataset.delete);
    const id=existing?.dataset.edit||existing?.dataset.summary||existing?.dataset.delete;
    if(!id) return;
    const b=document.createElement('button');
    b.type='button';b.className='secondary';b.dataset.v9Awards=id;b.textContent='Winner Awards';
    b.addEventListener('click',()=>editAwards(id));
    const actions=row.querySelector('.actions');if(actions) actions.appendChild(b);
  });
}

async function editAwards(id){
  try{
    const snap=await getDocs(query(collection(db,'lotteries'),where('__name__','==',id)));
    if(!snap.size) return alert('Lottery not found.');
    const data=snap.docs[0].data();
    const current=Array.isArray(data.awards)?data.awards:[data.firstPrize,data.secondPrize,data.thirdPrize].filter(Boolean);
    const text=prompt('Winner awards (one per line)',current.join('\n'));
    if(text===null) return;
    const awards=text.split(/\n+/).map(v=>v.trim()).filter(Boolean);
    await updateDoc(doc(db,'lotteries',id),{awards,awardsUpdatedAt:serverTimestamp(),awardsUpdatedBy:auth.currentUser?.uid||null});
    alert('Winner awards updated.');
  }catch(e){console.error(e);alert(e.message||'Could not update winner awards.');}
}

function observe(){
  addAwardsField();addAwardsButtons();
  const host=document.getElementById('lotteries');
  if(host && !host.dataset.v9Observed){
    host.dataset.v9Observed='1';
    new MutationObserver(()=>addAwardsButtons()).observe(host,{childList:true,subtree:true});
  }
}

if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',observe); else observe();
