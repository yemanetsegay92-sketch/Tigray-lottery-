import { db } from '../firebase.js';
import { collection, getDocs, query, where, doc, getDoc, addDoc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { phoneHash, normalizePhone } from './phoneHash.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const lotId = new URLSearchParams(location.search).get('lot');
let lot = null;

async function init(){
  if(!lotId){ $('lotteryInfo').innerHTML='<div class="error">Lottery not selected.</div>'; $('buyForm').style.display='none'; return; }
  try{
    const snap = await getDoc(doc(db,'lotteries',lotId));
    if(!snap.exists() || snap.data().status!=='active'){
      $('lotteryInfo').innerHTML='<div class="card"><h2>Lottery unavailable</h2><a class="btn" href="index.html">Go back</a></div>';
      $('buyForm').style.display='none'; return;
    }
    lot = {id:snap.id,...snap.data()};
    $('lotteryInfo').innerHTML=`<div class="card"><h2>${esc(lot.name)}</h2><p>Ticket price: <b>${Number(lot.price)} Birr</b></p><p>Ticket numbers are assigned after payment approval.</p></div>`;
    updateTotal();
  }catch(e){ console.error(e); $('lotteryInfo').innerHTML='<div class="error">Could not load this lottery.</div>'; }
}
function updateTotal(){ const q=Math.max(1,Math.min(100,Number($('quantity').value)||1)); $('quantity').value=q; $('total').textContent=`Total: ${q*Number(lot?.price||0)} Birr`; }
$('quantity').addEventListener('input', updateTotal);
$('buyForm').addEventListener('submit', async e=>{
  e.preventDefault(); if(!lot) return;
  const submit=$('submitBtn'); submit.disabled=true; submit.textContent='Submitting…';
  const name=$('name').value.trim(), phone=await normalizePhone($('phone').value), reference=$('reference').value.trim();
  const quantity=Math.max(1,Math.min(100,Number($('quantity').value)||1));
  if(!name || !phone || !reference){ $('message').innerHTML='<div class="error">Please complete all required fields.</div>'; submit.disabled=false; submit.textContent='Submit Payment Request'; return; }
  try{
    const dup=await getDocs(query(collection(db,'ticketRequests'),where('reference','==',reference)));
    if(!dup.empty) throw new Error('This payment reference was already submitted.');
    const requestRef=await addDoc(collection(db,'ticketRequests'),{
      lotteryId:lot.id, lotteryName:lot.name, name, phone, reference,
      quantity, price:Number(lot.price), total:Number(lot.price)*quantity,
      status:'pending', ticketNumbers:[], createdAt:serverTimestamp()
    });
    const h=await phoneHash(phone);
    await setDoc(doc(db,'publicStatus',h,'requests',requestRef.id),{
      lotteryId:lot.id, lotteryName:lot.name, phoneLast4:phone.slice(-4),
      quantity, total:Number(lot.price)*quantity, status:'pending', ticketNumbers:[], createdAt:serverTimestamp()
    });
    $('buyForm').style.display='none';
    $('message').innerHTML=`<div class="success"><b>✅ Request submitted.</b><p>Your payment is pending manual approval.</p><p>Use your phone number on the Check Ticket page to see the status later.</p><a class="btn" href="check.html">Check Status</a></div>`;
  }catch(err){ console.error(err); $('message').innerHTML=`<div class="error">${esc(err.message||'Could not submit request.')}</div>`; submit.disabled=false; submit.textContent='Submit Payment Request'; }
});
init();
