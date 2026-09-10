import { db, auth, initializeApp, getAuth, firebaseConfigExport } from '../../firebase.js';
import { onAuthStateChanged, signOut, createUserWithEmailAndPassword, updateProfile } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, addDoc, updateDoc, deleteDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const $=id=>document.getElementById(id); const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lots=[]; let me=null;
$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html';});
onAuthStateChanged(auth,async u=>{if(!u){location.href='login.html';return;}me=u;const p=await getDoc(doc(db,'users',u.uid));if(!p.exists()||p.data().role!=='generalAdmin'){location.href='login.html';return;}await render();});
$('createForm').addEventListener('submit',async e=>{e.preventDefault();try{const min=Number($('min').value),max=Number($('max').value),price=Number($('price').value);if(min>max||price<=0)throw new Error('Check price and number range.');await addDoc(collection(db,'lotteries'),{name:$('name').value.trim(),price,min,max,status:$('status').value,description:$('description').value.trim(),createdAt:serverTimestamp(),adminIds:[]});e.target.reset();$('adminMessage').innerHTML='';await render();$('message').innerHTML='<div class="success">Lottery created.</div>';}catch(err){console.error(err);$('message').innerHTML=`<div class="error">${esc(err.message)}</div>`;}});
$('adminForm').addEventListener('submit',async e=>{e.preventDefault();const btn=e.target.querySelector('button');btn.disabled=true;try{
  if(!lots.length) throw new Error('Create a lottery first.');
  const lotteryId=$('adminLottery').value; const email=$('adminEmail').value.trim(); const password=$('adminPassword').value; const displayName=$('adminName').value.trim();
  if(!lotteryId||!email||password.length<6||!displayName) throw new Error('Complete all lottery-admin fields.');
  const secondaryApp=initializeApp(firebaseConfigExport,'adminCreator_'+Date.now()); const secondaryAuth=getAuth(secondaryApp);
  const cred=await createUserWithEmailAndPassword(secondaryAuth,email,password); await updateProfile(cred.user,{displayName});
  await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js').then(m=>m.signOut(secondaryAuth));
  await setDoc(doc(db,'users',cred.user.uid),{role:'lotteryAdmin',lotteryIds:[lotteryId],displayName,email,createdAt:serverTimestamp()});
  $('adminForm').reset(); $('adminMessage').innerHTML='<div class="success">Lottery admin account created and assigned.</div>';
 }catch(err){console.error(err);$('adminMessage').innerHTML=`<div class="error">${esc(err.message||'Could not create lottery admin.')}</div>`;}finally{btn.disabled=false;}
});
async function render(){
 const ls=await getDocs(collection(db,'lotteries'));lots=ls.docs.map(d=>({id:d.id,...d.data()}));
 $('adminLottery').innerHTML=lots.map(x=>`<option value="${esc(x.id)}">${esc(x.name)} (${esc(x.id)})</option>`).join('');
 $('lotteries').innerHTML=lots.map(x=>`<div class="row"><b>${esc(x.name)}</b> <span class="badge ${esc(x.status)}">${esc(x.status)}</span><br><span class="muted">ID: ${esc(x.id)} · ${Number(x.price||0)} Birr · ${esc(x.min)}–${esc(x.max)}</span><div class="actions"><button data-edit="${esc(x.id)}">Edit</button><button class="danger" data-delete="${esc(x.id)}">Delete</button></div></div>`).join('')||'<p class="muted">No lotteries.</p>';
 document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editLottery(b.dataset.edit)));
 document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>removeLottery(b.dataset.delete)));
 const rs=await getDocs(collection(db,'ticketRequests'));renderRequests(rs);
}
function renderRequests(rs){$('requests').innerHTML=rs.docs.map(d=>{const x=d.data(),lot=lots.find(l=>l.id===x.lotteryId);return `<div class="row"><b>${esc(x.name)}</b> · ${esc(x.phone)}<br>Lottery: ${esc(lot?.name||x.lotteryId)}<br>${Number(x.quantity||1)} ticket(s) · ${Number(x.total||0)} Birr · Ref ${esc(x.reference||'')}<br>Status: <b>${esc(x.status||'pending')}</b>${x.ticketNumbers?.length?`<br>🎟️ ${x.ticketNumbers.map(n=>`<span class="badge">${esc(n)}</span>`).join(' ')}`:''}</div>`}).join('')||'<p class="muted">No requests.</p>';}
async function editLottery(id){const x=lots.find(l=>l.id===id);if(!x)return;const name=prompt('Lottery name',x.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',x.price));if(!price||price<=0)return alert('Invalid price.');const status=prompt('Status: active, upcoming, closed, drawn',x.status)||x.status;try{await updateDoc(doc(db,'lotteries',id),{name:name.trim(),price,status});await render();}catch(e){alert(e.message);}}
async function removeLottery(id){if(!confirm('Delete this lottery? This is only recommended for test lotteries.'))return;try{await deleteDoc(doc(db,'lotteries',id));await render();}catch(e){alert(e.message);}}
