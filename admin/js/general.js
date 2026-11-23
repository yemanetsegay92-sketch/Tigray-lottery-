import { expandApprovedTicketRows, ticketRowsToCsv, ticketRowsToTsv } from './ticketRows.mjs';
import { db, auth, createSecondaryAuth } from '../../firebase.js';
import { onAuthStateChanged, signOut, createUserWithEmailAndPassword, updateProfile, signOut as authSignOut } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { collection, getDocs, doc, getDoc, addDoc, updateDoc, setDoc, writeBatch, serverTimestamp, query, where, limit, getCountFromServer, arrayUnion } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';

const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lots=[];
const cleanupNotices = new Map();
function showCleanupNotice(lotteryId, text) {
  cleanupNotices.set(lotteryId, text);
  const box = [...document.querySelectorAll('[data-cleanup-message]')]
    .find(element => element.dataset.cleanupMessage === lotteryId);
  if (box) box.textContent = text;
}
let drawDigits=[];
let drawBusy=false;
const DEFAULT_PAYMENT_ACCOUNTS=[{bank:'CBE',number:'1000000000000',holderName:''}];
let createPaymentAccounts=DEFAULT_PAYMENT_ACCOUNTS.map(x=>({...x}));

$('logoutBtn').addEventListener('click',async()=>{document.documentElement.classList.remove('admin-verified');await signOut(auth);location.href='login.html';});
$('generatePassword')?.addEventListener('click',()=>{$('resetPassword').value=generateTempPassword();$('resetPassword').focus();});
$('resetPasswordForm')?.addEventListener('submit',resetLotteryAdminPassword);
$('drawLotterySelect')?.addEventListener('change',()=>setupDraw());
$('drawDigitBtn')?.addEventListener('click',drawDigit);
$('resetDrawBtn')?.addEventListener('click',resetDraw);
$('saveDrawBtn')?.addEventListener('click',saveDraw);
$('closeSummary')?.addEventListener('click',()=>{$('summaryPanel').style.display='none';});
$('contactForm')?.addEventListener('submit',saveContactSettings);
$('whatsappNumber')?.addEventListener('input',updateContactPreview);
$('addCreatePaymentAccount')?.addEventListener('click',addCreatePaymentAccount);
// Workspace navigation: render one panel at a time and load expensive data only when selected.
const generalPanels=Array.from(document.querySelectorAll('.admin-wrap > section'));
const generalGroups={overview:[0,1],lotteries:[4],create:[3],admins:[5,8],draw:[6],
 reports:[7,9],verify:[2],settings:[10,11],wallet:[12]};
let generalView='overview';
function showGeneralView(view){
 generalView=generalGroups[view]?view:'overview';
 generalPanels.forEach((panel,index)=>{panel.hidden=!generalGroups[generalView].includes(index)});
 document.querySelectorAll('#workspaceNav [data-view]').forEach(button=>{
  const selected=button.dataset.view===generalView;
  if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
 });
}
async function openGeneralView(view){
 showGeneralView(view);
 try{
  if(generalView==='lotteries')await renderLotteries();
  if(generalView==='admins')await renderAdminList();
  if(generalView==='reports')await renderSummaryOverview();
  if(generalView==='draw')setupDraw();
  if(generalView==='settings')await loadContactSettings();
  if(generalView==='create')renderCreatePaymentAccountsEditor();
  if(generalView==='wallet')await loadWalletFinance();
 }catch(e){$('message').innerHTML='<div class="error">'+esc(e.message||'Could not load this section.')+'</div>';}
}
document.querySelectorAll('#workspaceNav [data-view]').forEach(button=>
 button.addEventListener('click',()=>void openGeneralView(button.dataset.view)));
showGeneralView('overview');
$('refreshWalletFinance')?.addEventListener('click',()=>void loadWalletFinance());
async function walletFinanceApi(action,body={}){
 const token=await auth.currentUser.getIdToken();
 const response=await fetch('/api/admin/approvals',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action,...body})});
 const payload=await response.json().catch(()=>({}));
 if(!response.ok||!payload.ok)throw new Error(payload.error||'Wallet finance request failed.');
 return payload;
}
async function loadWalletFinance(){
 const host=$('walletFinance');if(!host)return;host.innerHTML='<p class="muted">Loading wallet finance…</p>';
 try{
  const data=await walletFinanceApi('wallet-finance-summary');
  const pending=data.deposits.filter(x=>x.status==='pending');
  const obligations=data.obligations.map(x=>({...x,remaining:Number(x.amountSantim||0)-Number(x.settledSantim||0)-Number(x.refundedSantim||0)}));
  host.innerHTML=`<h3>Pending deposits</h3>${pending.length?`<div class="table-wrap"><table><thead><tr><th>Reference</th><th>Amount</th><th>Customer</th><th>Action</th></tr></thead><tbody>${pending.map(x=>`<tr><td>${esc(x.reference)}</td><td>${(Number(x.amountSantim)/100).toFixed(2)} ETB</td><td>${esc(x.legalName||x.uid)}</td><td><button class="small-btn" data-deposit="${esc(x.id)}">Verify & approve</button></td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No pending deposits.</p>'}
  <h3>Owner obligations</h3>${obligations.length?`<div class="table-wrap"><table><thead><tr><th>Lottery</th><th>Request</th><th>Outstanding</th><th>Status</th><th>Actions</th></tr></thead><tbody>${obligations.map(x=>`<tr><td>${esc(x.lotteryId)}</td><td>${esc(x.requestId)}</td><td>${(x.remaining/100).toFixed(2)} ETB</td><td>${esc(x.status||'open')}</td><td>${x.remaining>0?`<button class="small-btn" data-settle="${esc(x.id)}" data-remaining="${x.remaining}">Settle</button> <button class="secondary small-btn" data-refund="${esc(x.requestId)}">Refund</button>`:'—'}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No wallet obligations.</p>'}
  <h3>Settlement history</h3>${data.settlements.length?`<div class="table-wrap"><table><thead><tr><th>Lottery</th><th>Reference</th><th>Amount</th><th>Obligation</th></tr></thead><tbody>${data.settlements.map(x=>`<tr><td>${esc(x.lotteryId)}</td><td>${esc(x.reference)}</td><td>${(Number(x.amountSantim)/100).toFixed(2)} ETB</td><td>${esc(x.obligationId)}</td></tr>`).join('')}</tbody></table></div>`:'<p class="muted">No settlements recorded.</p>'}`;
  host.querySelectorAll('[data-deposit]').forEach(button=>button.addEventListener('click',()=>void approveWalletDeposit(button.dataset.deposit,pending.find(x=>x.id===button.dataset.deposit))));
  host.querySelectorAll('[data-settle]').forEach(button=>button.addEventListener('click',()=>void settleWalletObligation(button.dataset.settle,Number(button.dataset.remaining))));
  host.querySelectorAll('[data-refund]').forEach(button=>button.addEventListener('click',()=>void refundWalletPurchase(button.dataset.refund)));
 }catch(error){host.innerHTML='<div class="error">'+esc(error.message)+'</div>';}
}
async function approveWalletDeposit(id,deposit){
 const payerName=prompt('Verified CBE payer legal name',deposit?.legalName||'');if(payerName===null)return;
 const transactionDate=prompt('Verified CBE transaction date/time (ISO 8601)',new Date().toISOString());if(!transactionDate)return;
 const receivingAccount=prompt('CBE receiving account number reviewed on the transfer');if(!receivingAccount)return;
 const receivingOwner=prompt('Receiving account owner reviewed on the transfer');if(!receivingOwner)return;
 const reviewNote=prompt('Review note (how receiver, amount, status, date and payer ownership were verified)');if(!reviewNote||reviewNote.trim().length<10)return alert('Enter a review note of at least 10 characters.');
 if(!confirm('Confirm that receiver, amount, completed status, transaction reference, date, and payer ownership were independently verified.'))return;
 try{await walletFinanceApi('wallet-deposit-approve',{depositId:id,payerName,transactionDate,receivingAccount,receivingOwner,reviewNote,reviewAttestation:'gm_independent_review'});await loadWalletFinance();}
 catch(error){$('walletFinanceMessage').innerHTML='<div class="error">'+esc(error.message)+'</div>';}
}
async function settleWalletObligation(id,remaining){
 const raw=prompt('Settlement amount in ETB (up to '+(remaining/100).toFixed(2)+')');if(raw===null)return;
 const amountSantim=Math.round(Number(raw)*100);if(!Number.isSafeInteger(amountSantim)||amountSantim<1||amountSantim>remaining)return alert('Invalid settlement amount.');
 const reference=prompt('Completed bank-transfer reference');if(!reference)return;
 const receivingAccount=prompt('Lottery owner receiving account number');if(!receivingAccount)return;
 const receivingOwner=prompt('Lottery owner / account holder name');if(!receivingOwner)return;
 const transactionDate=prompt('Completed transfer date/time (ISO 8601)',new Date().toISOString());if(!transactionDate)return;
 const reviewNote=prompt('Settlement verification note');if(!reviewNote||reviewNote.trim().length<10)return alert('Enter a review note of at least 10 characters.');
 if(!confirm('Record this completed owner settlement? This history is append-only.'))return;
 try{await walletFinanceApi('wallet-settle',{obligationId:id,amountSantim,reference,receivingAccount,receivingOwner,transactionDate,reviewNote,reviewAttestation:'gm_independent_review'});await loadWalletFinance();}
 catch(error){$('walletFinanceMessage').innerHTML='<div class="error">'+esc(error.message)+'</div>';}
}
async function refundWalletPurchase(requestId){
 const reason=prompt('Refund reason');if(!reason)return;
 if(!confirm('Refund this wallet purchase and cancel its tickets?'))return;
 try{await walletFinanceApi('wallet-refund',{requestId,reason});await loadWalletFinance();}
 catch(error){$('walletFinanceMessage').innerHTML='<div class="error">'+esc(error.message)+'</div>';}
}
let accessGeneration=0;
onAuthStateChanged(auth,async u=>{
  const generation=++accessGeneration;
  document.documentElement.classList.remove('admin-verified');
  $('adminAccessCheck').textContent='Verifying administrator access…';
  if(!u){location.href='login.html';return;}
  try{
    const p=await getDoc(doc(db,'users',u.uid));
    if(generation!==accessGeneration || auth.currentUser?.uid!==u.uid)return;
    if(!p.exists()||p.data().role!=='generalAdmin'){location.replace(p.exists() && p.data().role==='lotteryAdmin' ? 'lottery.html' : 'login.html');return;}
    await loadLotteriesBasics();
    showGeneralView('overview');
    // Previously confirmed cleanups resume automatically after refresh/sign-in.
    void autoResumeCleanupOnLoad();
    if(generation===accessGeneration && auth.currentUser?.uid===u.uid)document.documentElement.classList.add('admin-verified');
  }catch(e){$('adminAccessCheck').textContent='Unable to verify administrator access. Please sign in again.';console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message||'Could not load the General Admin dashboard.')}</div>`;}
});

$('createForm').addEventListener('submit',async e=>{
  e.preventDefault();
  try{
    const min=Number($('min').value),max=Number($('max').value),price=Number($('price').value);
    if(!Number.isFinite(min)||!Number.isFinite(max)||min>max||price<=0)throw new Error('Check price and number range.');
    const paymentAccounts=readCreatePaymentAccounts();
    if(!paymentAccounts.length)throw new Error('Add at least one payment account.');
    if(paymentAccounts.some(x=>!x.bank||!x.number||x.number.length<4))throw new Error('Complete each payment account.');
    const approvalMode=$('approvalMode').value;
    if(!['manual','automatic'].includes(approvalMode))throw new Error('Choose manual or automatic approval.');
    if(approvalMode==='automatic' && !validAutomaticCbeAccounts(paymentAccounts))
      throw new Error('For automatic approval, configure exactly one real CBE receiving account with its correct account-holder name.');
    const paymentEvidenceMode=$('paymentEvidenceMode').value;
    if(!['standard','reference_only'].includes(paymentEvidenceMode))throw Error('Invalid payment evidence mode.');
    const newLottery=doc(collection(db,'lotteries'));
    const batch=writeBatch(db);
    batch.set(newLottery,{name:$('name').value.trim(),price,min,max,status:$('status').value,approvalMode,description:$('description').value.trim(),createdAt:serverTimestamp(),adminIds:[],nextTicketNumber:min,awards:['First Prize'],paymentAccounts,paymentEvidenceMode});
    batch.set(doc(collection(db,'auditLogs')),{action:'createLottery',lotteryId:newLottery.id,approvalMode,adminId:auth.currentUser.uid,createdAt:serverTimestamp(),paymentAccountBanks:paymentAccounts.map(x=>x.bank)});
    await batch.commit();
    let activationError='';
    if(approvalMode==='automatic') {
      try { await updateCbeActivation(newLottery.id,true); }
      catch(error) { activationError=error.message||'Could not activate CBE automatic approval.'; }
    }
    e.target.reset();
    createPaymentAccounts=DEFAULT_PAYMENT_ACCOUNTS.map(x=>({...x}));
    renderCreatePaymentAccountsEditor();
    $('message').innerHTML=activationError
      ? '<div class="error">Lottery created, but CBE automatic approval is NOT ACTIVE: '+esc(activationError)+'. Use the Activate button beside the lottery to retry.</div>'
      : '<div class="success">Lottery created with '+esc(approvalMode)+(approvalMode==='automatic'?' CBE automatic approval activated.':' approval.')+'</div>';
    await loadLotteriesBasics();showGeneralView('create');
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

// Explicit admin selection avoids silent "no match" caused by email typos,
// and the inline live region reports progress/errors beside the clicked button.
$('assignForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const btn=$('assignLotteryBtn'),msg=$('assignMessage');
  const adminSelect=$('assignAdminSelect'),lotterySelect=$('assignLottery');
  btn.disabled=true;adminSelect.disabled=true;lotterySelect.disabled=true;
  const buttonText=btn.textContent;btn.textContent='Assigning…';
  msg.innerHTML='<div class="success">Checking admin and lottery assignment…</div>';
  try{
    const adminId=adminSelect.value,lotteryId=lotterySelect.value;
    if(!adminId||!lotteryId)throw new Error('Choose an existing Lottery Admin and a lottery.');
    if(!lots.some(l=>l.id===lotteryId))throw new Error('Lottery not found. Refresh the page and try again.');
    const profileSnap=await getDoc(doc(db,'users',adminId));
    if(!profileSnap.exists()||profileSnap.data().role!=='lotteryAdmin')
      throw new Error('The selected user is not a Lottery Admin. Refresh the page.');
    const admin=profileSnap.data();
    const ids=Array.isArray(admin.lotteryIds)?admin.lotteryIds:[];
    if(ids.includes(lotteryId))throw new Error('This admin is already assigned to that lottery.');
    if(!auth.currentUser)throw new Error('Your admin session has expired. Sign in again.');
    // Write the role assignment and its audit record together: otherwise the
    // first write could succeed while the log fails and look like no response.
    const batch=writeBatch(db);
    batch.update(doc(db,'users',adminId),{lotteryIds:arrayUnion(lotteryId)});
    batch.set(doc(collection(db,'auditLogs')),{action:'assignLottery',lotteryId,
      adminId:auth.currentUser.uid,targetUserId:adminId,createdAt:serverTimestamp()});
    await batch.commit();
    const label=lots.find(l=>l.id===lotteryId)?.name||lotteryId;
    msg.innerHTML='<div class="success">✓ '+esc(admin.displayName||admin.email||'Lottery Admin')+
      ' can now manage '+esc(label)+'.</div>';
    await renderAdminList();
  }catch(err){
    console.error('Assign Lottery failed:',err);
    const explanation=err?.code==='permission-denied'
      ? 'Firebase permission denied. Confirm you are signed in as General Admin.'
      : (err?.message||'Could not assign the lottery.');
    msg.innerHTML='<div class="error">'+esc(explanation)+'</div>';
  }finally{
    btn.disabled=false;adminSelect.disabled=false;lotterySelect.disabled=false;
    btn.textContent=buttonText;
  }
});

async function renderAdminList(){
  const host=$('adminList'),select=$('assignAdminSelect');
  try{
    const qs=await getDocs(query(collection(db,'users'),where('role','==','lotteryAdmin'))),rows=qs.docs.map(d=>({id:d.id,...d.data()}));
    $('statAdmins').textContent=rows.length;
    const previouslySelected=select.value;
    select.innerHTML='<option value="">'+(rows.length?'Choose an existing Lottery Admin…':'No lottery admins found — create one above')+'</option>'+
      rows.map(a=>'<option value="'+esc(a.id)+'">'+esc((a.displayName||a.email||'Lottery Admin')+' · '+(a.email||a.id))+'</option>').join('');
    if(rows.some(a=>a.id===previouslySelected))select.value=previouslySelected;
    host.innerHTML=rows.length?`<table><thead><tr><th>Admin</th><th>Email</th><th>Assigned lotteries</th></tr></thead><tbody>${rows.map(a=>`<tr><td>${esc(a.displayName||'')}</td><td>${esc(a.email||'')}</td><td>${(a.lotteryIds||[]).map(id=>{const l=lots.find(x=>x.id===id);return esc(l?l.name:id)}).join(', ')}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No lottery admins yet. Create one using the form above, then assign additional lotteries here.</p>';
  }catch(e){
    select.innerHTML='<option value="">Could not load existing admins</option>';
    host.innerHTML=`<div class="error">${esc(e.message||'Could not load lottery admins.')}</div>`;
    $('assignMessage').innerHTML='<div class="error">Could not load available Lottery Admins. Refresh the page or check permissions.</div>';
  }
}

function validAutomaticCbeAccounts(accounts){
  const cbe=accounts.filter(a=>/^(CBE|COMMERCIAL BANK OF ETHIOPIA)$/i.test(String(a.bank||'').trim()) &&
    /^\d{8,30}$/.test(String(a.number||'').replace(/\s/g,'')) &&
    String(a.number).replace(/\s/g,'')!=='1000000000000');
  return cbe.length===1 && /[A-Za-z]/.test(String(cbe[0].holderName||'')) &&
    String(cbe[0].holderName||'').trim().length>2;
}
async function cbeActivationApi(action,lotteryId,extras={}){
  const token=await auth.currentUser.getIdToken();
  const response=await fetch('/api/admin/approvals',{
    method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
    body:JSON.stringify({action,lotteryId,...extras})
  });
  const result=await response.json().catch(()=>({}));
  if(!response.ok||!result.ok)throw new Error(result.error||'Could not update automatic approval.');
  return result;
}
async function updateCbeActivation(id,enabled){
  return cbeActivationApi('cbe-activation-set',id,{enabled});
}
async function refreshCbeApprovalStatus(){
  const automatic=lots.filter(x=>x.approvalMode==='automatic' && !x.cleanupInProgress);
  await Promise.all(automatic.map(async lottery=>{
    const host=[...document.querySelectorAll('[data-auto-status]')].find(x=>x.dataset.autoStatus===lottery.id);
    if(!host)return;
    try{
      const result=await cbeActivationApi('cbe-activation-status',lottery.id);
      if(!host.isConnected)return;
      const status=result.enabled?'LIVE — CBE automatic approval enabled'
        :result.activated?'ACTIVATED — global worker disabled or lottery not open'
        :result.paused?'PAUSED — new purchases require manual review'
        :'NOT ACTIVATED — new purchases require manual review';
      const button=document.createElement('button');
      button.type='button';
      button.className=result.activated?'secondary small-btn':'small-btn';
      button.textContent=result.activated?'Pause CBE Auto Approval':'Activate CBE Auto Approval';
      button.disabled=!result.configured && !result.activated;
      button.addEventListener('click',async()=>{
        const enable=!result.activated;
        const question=enable
          ? 'Activate real-money CBE automatic approval for '+lottery.name+'? Only verified matching payments can issue tickets.'
          : 'Pause CBE automatic approval for '+lottery.name+'? New purchases will require manual review.';
        if(!confirm(question))return;
        button.disabled=true;
        try{
          await updateCbeActivation(lottery.id,enable);
          await refreshCbeApprovalStatus();
        }catch(error){host.textContent='CBE approval change failed: '+(error.message||'Unknown error');}
        finally{button.disabled=false;}
      });
      host.textContent=status+(result.accountLast4?' · CBE account ending '+result.accountLast4:'');
      host.appendChild(document.createTextNode(' '));
      host.appendChild(button);
    }catch(error){
      host.textContent='CBE approval status unavailable: '+(error.message||'Unknown error');
    }
  }));
}

async function loadLotteriesBasics(){
  const ls=await getDocs(collection(db,'lotteries'));lots=ls.docs.map(d=>({id:d.id,...d.data()}));
  $('statLotteries').textContent=lots.length;
  const opts=lots.map(x=>`<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('');
  $('adminLottery').innerHTML=opts;$('assignLottery').innerHTML=opts;
  if($('drawLotterySelect'))$('drawLotterySelect').innerHTML=opts;
}
async function renderLotteries(){
  await loadLotteriesBasics();
  if ($('deleteAllLotteries')) $('deleteAllLotteries').disabled = !lots.length || cleanupBusy || bulkCleanupBusy;
  $('lotteries').innerHTML=lots.map(x=>{const mode=x.approvalMode==='automatic'?'Automatic CBE':'Manual';return `<div class="row"><b>${esc(x.name)}</b> <span class="badge ${esc(x.status)}">${esc(x.status)}</span><br><span class="muted">ID: ${esc(x.id)} · ${Number(x.price||0)} Birr · ${esc(x.min)}–${esc(x.max)} · Next: ${esc(x.nextTicketNumber??x.min)} · Approval: <b>${mode}</b></span><div class="actions"><button data-edit="${esc(x.id)}">Edit</button><button class="secondary" data-summary="${esc(x.id)}">Open Summary</button><button class="danger" data-delete="${esc(x.id)}">${x.cleanupInProgress?"Continue Cleanup":"Delete & Clear"}</button></div>${x.approvalMode==='automatic'?`<div class="muted" data-auto-status="${esc(x.id)}">Checking CBE auto approval…</div>`:''}<div class="muted" data-cleanup-message="${esc(x.id)}">${esc(cleanupNotices.get(x.id) || (x.cleanupInProgress?'Cleanup already started: this lottery is closed. Click Continue Cleanup to resume.':'Click Delete & Clear to preview linked data; then type DELETE followed by the exact lottery ID to confirm.'))}</div></div>`}).join('')||'<p class="muted">No lotteries.</p>';
  document.querySelectorAll('[data-edit]').forEach(b=>b.addEventListener('click',()=>editLottery(b.dataset.edit)));
  document.querySelectorAll('[data-delete]').forEach(b=>b.addEventListener('click',()=>removeLottery(b.dataset.delete)));
  document.querySelectorAll('[data-summary]').forEach(b=>b.addEventListener('click',()=>openLotterySummary(b.dataset.summary)));
  void refreshCbeApprovalStatus();
}

async function renderSummaryOverview(){
  const host=$('overview');host.innerHTML='<p class="muted">Loading summary…</p>';
  try{
    const rows=[];
    let allSold=0;
    for(const lot of lots){
      const [approvedSnap,pendingSnap,soldSnap]=await Promise.all([
        getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',lot.id),where('status','==','approved'),limit(101))),
        getDocs(query(collection(db,'ticketRequests'),where('lotteryId','==',lot.id),where('status','==','pending'),limit(51))),
        getCountFromServer(query(collection(db,'tickets'),where('lotteryId','==',lot.id)))
      ]);
      const approvedShown=Math.min(100,approvedSnap.docs.length);
      const pendingShown=Math.min(50,pendingSnap.docs.length);
      const approvedHasMore=approvedSnap.docs.length>100;
      const pendingHasMore=pendingSnap.docs.length>50;
      const sold=Number(soldSnap.data().count||0);
      allSold+=sold;
      rows.push('<div class="row"><b>'+esc(lot.name)+'</b><br><span class="muted">Sold tickets: <b>'+sold.toLocaleString('en-US')+'</b> · Approved purchases shown: '+approvedShown+(approvedHasMore?'+':'')+' · Pending shown: '+pendingShown+(pendingHasMore?'+':'')+'<br>Next ticket: '+esc(lot.nextTicketNumber??lot.min)+'</span></div>');
    }
    $('statTickets').textContent=allSold.toLocaleString('en-US');
    $('statRevenue').textContent='—'; // No reliable revenue aggregation yet.
    host.innerHTML=rows.join('')||'<p class="muted">No lotteries yet.</p>';
  }catch(e){
    $('statTickets').textContent='—';
    host.innerHTML='<div class="error">'+esc(e.message||'Could not load summary.')+'</div>';
  }
}
async function openLotterySummary(id){
  showGeneralView('reports');
  const lot=lots.find(x=>x.id===id);if(!lot)return;
  $('summaryTitle').textContent=`Summary · ${lot.name}`;
  $('summaryPanel').style.display='block';
  $('summaryTable').innerHTML='<p class="muted">Loading up to 100 approved requests…</p>';
  try{
    const qs=await getDocs(query(
      collection(db,'ticketRequests'),
      where('lotteryId','==',id),
      where('status','==','approved'),
      limit(101)
    ));
    const items=qs.docs.slice(0,100).map(d=>({id:d.id,...d.data()}));
    const hasMore=qs.docs.length>100;
    renderSummaryTable(items,lot,hasMore);
    $('summaryPanel').scrollIntoView({behavior:'smooth'});
  }catch(e){
    $('summaryTable').innerHTML=`<div class="error">${esc(e.message||'Could not load summary.')}</div>`;
  }
}

function tableHtml(rows){
  const head='<thead><tr><th>Date</th><th>Name</th><th>Phone</th><th>Reference</th><th>Ticket Number</th><th>Ticket Price (Birr)</th><th>Purchase Qty</th><th>Request ID</th></tr></thead>';
  return '<table>'+head+'<tbody>'+rows.map(r=>'<tr><td>'+esc(r.date)+'</td><td>'+esc(r.name)+'</td><td>'+esc(r.phone)+'</td><td>'+esc(r.reference)+'</td><td><b>'+esc(r.ticketNumber)+'</b></td><td>'+esc(Number.isFinite(r.price)?r.price:'—')+'</td><td>'+esc(r.purchaseQuantity)+'</td><td>'+esc(r.requestId)+'</td></tr>').join('')+'</tbody></table>';
}
function renderSummaryTable(items,lot,hasMore=false){
  const {rows:approved,missingTicketRequests}=expandApprovedTicketRows(items);
  $('summaryCount').textContent=approved.length+' individual ticket(s) shown from '+items.length+' approved purchase(s)' +
    (hasMore?' · More approved purchases exist (export includes only those loaded).':'') +
    (missingTicketRequests?' · WARNING: '+missingTicketRequests+' approved purchase(s) have no ticket numbers.':'');
  $('summaryTable').innerHTML=approved.length?tableHtml(approved):'<p class="muted">No approved ticket numbers in loaded purchases.</p>';
  $('downloadCsv').onclick=()=>downloadCsv(safeFileName(lot.name)+'-tickets.csv',approved);
  $('copyExcel').onclick=async()=>{
    try{await navigator.clipboard.writeText(ticketRowsToTsv(approved));$('summaryMessage').innerHTML='<div class="success">Copied one row per ticket.</div>'}
    catch{$('summaryMessage').innerHTML='<div class="error">Copy blocked. Use Download CSV instead.</div>'}
  };
}
function downloadCsv(name,rows){
  const csv=ticketRowsToCsv(rows);
  const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'}),a=document.createElement('a');
  a.href=URL.createObjectURL(blob);a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}
function safeFileName(s){return String(s||'lottery').replace(/[^a-z0-9_-]+/gi,'_').slice(0,60)}

async function editLottery(id){const x=lots.find(l=>l.id===id);if(!x)return;const name=prompt('Lottery name',x.name);if(name===null)return;const price=Number(prompt('Ticket price (Birr)',x.price));if(!price||price<=0)return alert('Invalid price.');const status=prompt('Status: active, upcoming, closed, drawn',x.status)||x.status;try{await updateDoc(doc(db,'lotteries',id),{name:name.trim(),price,status});await addDoc(collection(db,'auditLogs'),{action:'editLottery',lotteryId:id,adminId:auth.currentUser.uid,createdAt:serverTimestamp()});await renderLotteries();await renderSummaryOverview();setupDraw();}catch(e){alert(e.message)}}

let cleanupBusy = false;
let bulkCleanupBusy = false;
$('deleteAllLotteries')?.addEventListener('click',clearAllLotteries);

async function clearAllLotteries() {
  if (cleanupBusy || bulkCleanupBusy) return;
  const ids = lots.map(item => item.id);
  if (!ids.length) return;
  const button = $('deleteAllLotteries');
  const status = $('bulkCleanupStatus');
  bulkCleanupBusy = true;
  button.disabled = true;
  let started = false;
  try {
    status.textContent = 'Reading a deletion preview for all '+ids.length+' lotteries. Nothing has been deleted.';
    const previews = [];
    for (const id of ids) {
      previews.push(await cleanupApi('lottery-cleanup-preview', id));
    }
    const totals = previews.reduce((v, p) => ({
      requests:v.requests+Number(p.requests||0),
      approved:v.approved+Number(p.approved||0),
      tickets:v.tickets+Number(p.tickets||0),
      autoPayments:v.autoPayments+Number(p.autoPayments||0)
    }), {requests:0,approved:0,tickets:0,autoPayments:0});
    const phrase = 'DELETE ALL '+ids.length+' LOTTERIES';
    const detail =
      'PERMANENTLY DELETE EVERY LOTTERY?\n\n'+
      'Lotteries: '+ids.length+'\n'+
      'Purchase requests: '+totals.requests+'\n'+
      'Approved purchases: '+totals.approved+'\n'+
      'Issued tickets: '+totals.tickets+'\n'+
      'Automatic payment queue records: '+totals.autoPayments+'\n\n'+
      'This includes any real buyer records in the listed lotteries, not just test records. '+
      'Lottery receipt files, notifications and audit history will also be removed. '+
      'Used bank-reference claims remain blocked, and admin accounts remain. '+
      'Ensure the Firestore export is complete; uploaded receipt files are not in that export.\n\n'+
      'Enter this exact phrase to continue:\n'+phrase;
    if (prompt(detail) !== phrase) {
      status.textContent = 'Bulk cleanup cancelled. No new deletion was started.';
      return;
    }
    if (!confirm('FINAL CONFIRMATION: Permanently clear ALL '+ids.length+
      ' lotteries, including '+totals.approved+' approved purchases and '+totals.tickets+
      ' tickets? This cannot be undone from the dashboard.')) {
      status.textContent = 'Bulk cleanup cancelled at final confirmation.';
      return;
    }
    // Close all lotteries first, so interrupted bulk cleanup is recoverable
    // through the existing per-lottery auto-resume flow after a page refresh.
    for (const p of previews) {
      if (!p.cleanupInProgress) {
        await cleanupApi('lottery-cleanup-start', p.lotteryId, {
          confirm:'DELETE '+p.lotteryId, acceptIrreversible:true
        });
      }
      started = true;
      const item = lots.find(x => x.id === p.lotteryId);
      if (item) item.cleanupInProgress = true;
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      status.textContent = 'Bulk cleanup: lottery '+(i+1)+' of '+ids.length+
        '. Keep this tab open. Closing it will not erase progress.';
      const completed = await removeLottery(id, true);
      if (!completed) throw new Error('Cleanup paused at lottery '+(i+1)+
        '. Refresh General Admin to resume remaining confirmed deletions.');
    }
    status.textContent = 'Bulk cleanup finished. All '+ids.length+
      ' selected lotteries were removed. Used bank references and admin accounts were preserved.';
  } catch (error) {
    console.error('Bulk lottery cleanup stopped:',error);
    status.textContent = (started ? 'Bulk cleanup partially completed. ' : 'No new bulk cleanup confirmed. ')+
      (error.message || 'Unknown error')+
      ' If any lotteries show Continue Cleanup, refresh General Admin to resume them.';
  } finally {
    bulkCleanupBusy = false;
    try { await renderLotteries(); await renderSummaryOverview(); setupDraw(); }
    catch (error) { console.warn('Refresh after bulk cleanup:', error); }
    button.disabled = !lots.length || cleanupBusy;
  }
}

async function cleanupApi(action, lotteryId, extras={}) {
  const token = await auth.currentUser.getIdToken();
  const res = await fetch('/api/admin/approvals', {
    method:'POST',
    headers:{'content-type':'application/json','authorization':'Bearer '+token},
    body:JSON.stringify({action,lotteryId,...extras})
  });
  const body = await res.json().catch(()=>({}));
  if (!res.ok || !body.ok) {
    const error = new Error(body.error || 'Cleanup request failed (HTTP '+res.status+').');
    error.status = res.status;
    throw error;
  }
  return body;
}
async function autoResumeCleanupOnLoad() {
  const pending = lots.filter(lottery => lottery.cleanupInProgress === true).map(lottery=>lottery.id);
  for (const id of pending) {
    // Every pending item was already confirmed when cleanup started.
    if (!lots.some(lottery=>lottery.id===id && lottery.cleanupInProgress)) continue;
    await removeLottery(id, true);
  }
}
async function removeLottery(id, alreadyConfirmed=false) {
  if (cleanupBusy) return;
  const lottery = lots.find(item=>item.id===id);
  if (!lottery) return true;
  cleanupBusy = true;
  let completed = false;
  const banner = $('message');
  try {
    if (!lottery.cleanupInProgress) {
      banner.innerHTML='<div class="muted">Checking linked records for '+esc(lottery.name)+'…</div>';
      showCleanupNotice(id, 'Checking linked records…');
      const p = await cleanupApi('lottery-cleanup-preview',id);
      showCleanupNotice(id, 'Preview: '+p.requests+' purchases, '+p.approved+' approved, '+p.tickets+' tickets. Deletion has NOT started.');
      const detail =
        'Lottery: '+p.name+'\n'+
        'Payment requests: '+p.requests+'\n'+
        'Approved requests: '+p.approved+'\n'+
        'Issued tickets: '+p.tickets+'\n'+
        'Receipt claims: '+p.claims+'\n'+
        'Queued auto-payments: '+p.autoPayments+'\n'+
        'Queued notifications: '+p.notifications+'\n\n'+
        'This PERMANENTLY removes its requests, ticket numbers, receipts and admin assignments. '+
        'All customers in this lottery, including any real buyers, will lose their records. '+
        'Lottery-specific audit history is also cleared, leaving a minimal deletion certificate. '+
        'Previously used bank references remain blocked to prevent the same payment being approved twice. '+
        'Firebase quotas or billing may apply. '+
        'The lottery remains closed throughout cleanup. To proceed type:\nDELETE '+id;
      const confirmation = prompt(detail);
      if (confirmation !== 'DELETE '+id) {
        banner.innerHTML='<div class="muted">Lottery cleanup cancelled. No data changed.</div>';
        showCleanupNotice(id, 'Cancelled: you must enter DELETE '+id+' exactly. No data was changed.');
        return;
      }
      if (p.approved>0 || p.tickets>0) {
        const extra = confirm('WARNING: This lottery has '+p.approved+
          ' approved purchases and '+p.tickets+' issued tickets. '+
          'These ticket records will also be permanently removed. Continue?');
        if (!extra) { showCleanupNotice(id, 'Cancelled at approved-ticket warning. No data was changed.'); return; }
      }
      const consent = confirm('Last confirmation: close and permanently delete lottery '+p.name+
        ' and ALL its related purchase data? This cannot be undone.');
      if (!consent) { showCleanupNotice(id, 'Cancelled at final confirmation. No data was changed.'); return; }
      await cleanupApi('lottery-cleanup-start',id,{
        confirm:'DELETE '+id, acceptIrreversible:true
      });
      lottery.cleanupInProgress = true;
      showCleanupNotice(id, 'Deletion started. This lottery is now closed; running small batches…');
    } else if (!alreadyConfirmed && !confirm('Resume the existing deletion of '+lottery.name+
      '? Related test data will be removed in small batches.')) {
      showCleanupNotice(id, 'Resume cancelled. Cleanup remains paused and the lottery stays closed.');
      return;
    }
    let steps = 0, requests = 0, documents = 0, files = 0, quotaRetries=0;
    while (true) {
      let step;
      try {
        step = await cleanupApi('lottery-cleanup-step',id);
      } catch (e) {
        // Firebase can still impose real quota limits even without our old daily cap.
        if (e.status !== 429 && e.status !== 503) throw e;
        quotaRetries++;
        const waitMs = Math.min(30*60*1000,60*1000*Math.pow(2,Math.min(quotaRetries,5)));
        showCleanupNotice(id,'Firebase is limiting requests. Automatically retrying when the cooldown ends; keep the tab open.');
        await new Promise(resolve=>setTimeout(resolve,waitMs));
        continue;
      }
      quotaRetries = 0;
      steps++;
      // Yield occasionally; large lotteries remain automatic without flooding Vercel.
      if (steps%200 === 0) await new Promise(resolve=>setTimeout(resolve,1500));
      requests += step.phase==='requests' ? step.processed||0 : 0;
      documents += step.deletedDocuments||0;
      files += step.removedFiles||0;
      banner.innerHTML='<div class="muted">Cleanup running for <b>'+esc(lottery.name)+
        '</b> — phase: '+esc(step.phase||'')+'; batches: '+steps+
        '; requests cleared in this session: '+requests+
        '; Firestore documents removed: '+documents+
        '; Storage files removed: '+files+
        '. Keep this tab open. Cleanup can resume if interrupted.</div>';
      showCleanupNotice(id, 'Cleaning '+step.phase+': '+documents+' Firestore documents and '+files+' Storage files removed in this session.');
      if (step.paused) {
        const readyTime = Date.parse(String(step.waitingUntil||''));
        if (!Number.isFinite(readyTime)) {
          showCleanupNotice(id, 'Cleanup paused. The safe resume time could not be read. Click Continue Cleanup later.');
          break;
        }
        const waitMs = Math.max(0,readyTime-Date.now())+1200;
        const minutes = Math.max(1,Math.ceil(waitMs/60000));
        const waiting = 'Storage safety pause: automatic resume in about '+minutes+
          ' minute(s). Keep this tab open; no Vercel API requests are made during the pause.';
        banner.innerHTML='<div class="muted">'+esc(waiting)+'</div>';
        showCleanupNotice(id,waiting);
        // Pause the browser rather than issuing repeated Vercel Function requests.
        // If Chrome closes, the saved cleanup state allows one-click resumption.
        await new Promise(resolve=>setTimeout(resolve,waitMs));
        showCleanupNotice(id, 'Upload links have expired. Resuming the final cleanup automatically…');
        continue;
      }
      if (step.done) {
        completed = true;
        cleanupNotices.delete(id);
        banner.innerHTML='<div class="success">Lottery '+esc(lottery.name)+
          ' and its linked records were deleted. Audit logs preserved.</div>';
        break;
      }
    }
  } catch(error) {
    const prefix = error.status===429
      ? 'Cleanup safely paused by the daily Firestore deletion guard. '
      : 'Cleanup stopped without automatically retrying. ';
    showCleanupNotice(id, prefix+error.message);
    banner.innerHTML='<div class="error">'+esc(prefix+error.message)+
      ' Refresh General Admin and select Continue Cleanup when safe.</div>';
  } finally {
    cleanupBusy=false;
    try { await renderLotteries(); await renderSummaryOverview(); setupDraw(); }
    catch(error) { console.warn('Dashboard refresh after cleanup:',error); }
  }
  return completed;
}


async function loadContactSettings(){
  try{
    const snap=await getDoc(doc(db,'settings','site'));
    const data=snap.exists()?snap.data():{};
    $('whatsappNumber').value=data.whatsappNumber||'';
    updateContactPreview();
  }catch(e){
    $('contactMessage').innerHTML=`<div class="error">${esc(e.message||'Could not load contact settings.')}</div>`;
  }
}

function renderCreatePaymentAccountsEditor(){
  const host=$('createPaymentAccountsEditor');
  if(!host)return;
  host.innerHTML=createPaymentAccounts.map((a,i)=>`<div class="payment-account-edit-row create-payment-row"><label>Bank name<input type="text" data-create-payment-bank="${i}" value="${esc(a.bank)}" placeholder="CBE"></label><label>Account number<input type="text" data-create-payment-number="${i}" value="${esc(a.number)}" inputmode="numeric" placeholder="1000000000000"></label><label>Account holder<input type="text" data-create-payment-holder="${i}" value="${esc(a.holderName||'')}" placeholder="Account holder name"></label><button type="button" class="danger small-btn" data-remove-create-payment="${i}">Remove</button></div>`).join('');
  host.querySelectorAll('[data-remove-create-payment]').forEach(b=>b.addEventListener('click',()=>removeCreatePaymentAccount(Number(b.dataset.removeCreatePayment))));
}

function readCreatePaymentAccounts(){
  const banks=[...document.querySelectorAll('[data-create-payment-bank]')];
  return banks.map((input,i)=>({bank:String(input.value||'').trim(),number:String(document.querySelector(`[data-create-payment-number="${i}"]`)?.value||'').trim(),holderName:String(document.querySelector(`[data-create-payment-holder="${i}"]`)?.value||'').trim()})).filter(x=>x.bank||x.number||x.holderName);
}

function addCreatePaymentAccount(){
  createPaymentAccounts.push({bank:'',number:'',holderName:''});
  renderCreatePaymentAccountsEditor();
  const inputs=document.querySelectorAll('[data-create-payment-bank]');
  inputs[inputs.length-1]?.focus();
}

function removeCreatePaymentAccount(index){
  createPaymentAccounts.splice(index,1);
  if(!createPaymentAccounts.length)createPaymentAccounts.push({bank:'',number:'',holderName:''});
  renderCreatePaymentAccountsEditor();
}

function updateContactPreview(){
  const raw=$('whatsappNumber')?.value||'';
  const digits=raw.replace(/[^0-9]/g,'');
  $('whatsappPreview').value=digits?`https://wa.me/${digits}`:'Not configured';
}

async function saveContactSettings(e){
  e.preventDefault();
  const raw=$('whatsappNumber').value.trim();
  const digits=raw.replace(/[^0-9]/g,'');
  if(digits.length < 9 || digits.length > 15){
    $('contactMessage').innerHTML='<div class="error">Enter a valid WhatsApp number, including country code.</div>';
    return;
  }
  try{
    await setDoc(doc(db,'settings','site'),{whatsappNumber:digits,updatedAt:serverTimestamp(),updatedBy:auth.currentUser.uid},{merge:true});
    await addDoc(collection(db,'auditLogs'),{action:'updateCustomerContact',whatsappNumberLast4:digits.slice(-4),adminId:auth.currentUser.uid,createdAt:serverTimestamp()});
    updateContactPreview();
    $('contactMessage').innerHTML='<div class="success">WhatsApp contact updated on the public home page.</div>';
  }catch(e){
    $('contactMessage').innerHTML=`<div class="error">${esc(e.message||'Could not save contact settings.')}</div>`;
  }
}

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
  for(let d=0;d<=9;d++){const el=document.createElement('div');el.className='draw-ball';el.dataset.digit=d;el.textContent='';el.style.setProperty('--ball-hue',String((d*37+12)%360));host.appendChild(el);positionBall(el,true);}
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
  const digit=Math.floor(Math.random()*10);const ball=document.querySelector(`.draw-ball[data-digit="${digit}"]`);if(ball){document.querySelectorAll('.draw-ball').forEach(b=>{b.classList.remove('opened');b.textContent='';});ball.classList.add('opened');ball.textContent=String(digit);}
  drawDigits.push(digit);$('drawResult').textContent=drawDigits.map(String).join('');
  await new Promise(r=>setTimeout(r,450));
  if(ball){ball.classList.remove('opened');ball.textContent='';}
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
