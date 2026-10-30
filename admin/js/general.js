import { expandApprovedTicketRows, ticketRowsToCsv, ticketRowsToTsv } from './ticketRows.mjs';
import {renderChecketMatch, cbeAccounts} from './checketMatchUI.mjs';
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

$('logoutBtn').addEventListener('click',async()=>{await signOut(auth);location.href='login.html';});
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
$('checketMatchLottery')?.addEventListener('change',()=>{
  updateChecketMatchAccounts();
  void loadPendingChecketReceipts();
});
function updateChecketMatchAccounts(){
  const lotto = lots.find(x=>x.id===$('checketMatchLottery')?.value);
  const options = cbeAccounts(lotto);
  const select = $('checketMatchAccount');
  if(!select)return;
  select.innerHTML = options.length
    ? options.map(x=>`<option value="${x.index}">${esc(x.label)}</option>`).join('')
    : '<option value="">No real CBE receiving account configured</option>';
  $('checketMatchButton').disabled = !options.length;
}
// Find existing pending receipts â€” the original file stays in private Storage.
async function loadPendingChecketReceipts(){
  const select=$('checketReceiptRequestId');
  const button=$('checketReceiptButton');
  const lotteryId=$('checketMatchLottery')?.value;
  if(!select || !button)return;
  button.disabled=true;
  select.innerHTML='<option value="">Loading pending receiptsâ€¦</option>';
  if(!lotteryId){select.innerHTML='<option value="">Choose a lottery first</option>';return;}
  try{
    const results=await getDocs(query(collection(db,'ticketRequests'),
      where('lotteryId','==',lotteryId),where('status','==','pending'),limit(50)));
    if($('checketMatchLottery').value!==lotteryId)return;
    const receipts=results.docs.filter(d=>Boolean(d.data().proofPath)&&
      ['application/pdf','image/jpeg','image/png','image/webp'].includes(String(d.data().proofMime||'')));
    select.innerHTML=receipts.length
      ? '<option value="">Choose a pending PDF/image receipt</option>'+receipts.map(d=>{
          const item=d.data();
          const suffix=item.proofMime==='application/pdf'?'PDF':'Screenshot';
          return `<option value="${esc(d.id)}">${esc(suffix)} Â· ${esc(Number(item.total||0))} ETB Â· ${esc(String(item.name||'Buyer').slice(0,35))} Â· ${esc(d.id.slice(0,8))}</option>`;
        }).join('')
      : '<option value="">No pending PDF/image receipts in the first 50 requests</option>';
    button.disabled=true; // Require explicit selection of a particular pending purchase.
  }catch(error){
    select.innerHTML='<option value="">Could not load pending receipts</option>';
    $('checketReceiptResult').innerHTML='<div class="error">'+esc(error.message||'Receipt lookup failed.')+'</div>';
  }
}
$('checketReceiptRequestId')?.addEventListener('change',()=>{
  $('checketReceiptButton').disabled=!$('checketReceiptRequestId').value || $('checketMatchButton').disabled;
});
$('checketReceiptRefresh')?.addEventListener('click',loadPendingChecketReceipts);
$('checketReceiptForm')?.addEventListener('submit',async event=>{
  event.preventDefault();
  const target=$('checketReceiptResult');
  const button=$('checketReceiptButton');
  const requestId=$('checketReceiptRequestId').value;
  const lotteryId=$('checketMatchLottery').value;
  const accountIndex=$('checketMatchAccount').value;
  if(!requestId || accountIndex==='')return;
  button.disabled=true;
  target.textContent='Sending existing private receipt to Check.et (no OCR)â€¦';
  try{
    const token=await auth.currentUser.getIdToken();
    const response=await fetch('/api/admin/approvals',{
      method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},
      body:JSON.stringify({action:'checket-match-pending',lotteryId,requestId,
        verificationMethod:'receipt',accountIndex:Number(accountIndex)})
    });
    const data=await response.json();
    if(!response.ok || !data.ok) throw new Error(data.error||'The receipt could not be verified.');
    target.innerHTML=renderChecketMatch(data);
  }catch(error){
    target.innerHTML='<div class="error">'+esc(error.message||'Receipt test failed.')+'</div>';
  }finally{
    button.disabled=!$('checketReceiptRequestId').value || $('checketMatchButton').disabled;
  }
});

$('checketMatchForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const target = $('checketMatchResult');
  const button = $('checketMatchButton');
  const lotteryId = $('checketMatchLottery').value;
  const reference = $('checketMatchReference').value.trim();
  const accountIndex = $('checketMatchAccount').value;
  button.disabled = true;
  target.textContent = 'Finding pending ticket and verifying CBE paymentâ€¦';
  try {
    const token = await auth.currentUser.getIdToken();
    const response = await fetch('/api/admin/approvals', {
      method:'POST',
      headers:{'content-type':'application/json',authorization:'Bearer '+token},
      body:JSON.stringify({action:'checket-match-pending',lotteryId,reference,accountIndex:Number(accountIndex)})
    });
    const data = await response.json();
    if(!response.ok||!data.ok)throw new Error(data.error||'Could not match pending payment.');
    target.innerHTML = renderChecketMatch(data);
  }catch(error){
    target.innerHTML = '<div class="error">'+esc(error.message||'Verification unavailable.')+'</div>';
  }finally{button.disabled=false;}
});



// Read-only Check.et test; deliberately does not call approveRequest.
$('checketForm')?.addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('checketSubmit');
  const result = $('checketResult');
  button.disabled = true;
  result.textContent = 'Checking with Check.etâ€¦';
  try {
    if (!auth.currentUser) throw new Error('Sign in as General Admin first.');
    const bank = $('checketBank').value;
    const transactionNumber = $('checketReference').value.trim();
    const accountNumber = $('checketAccount').value.trim();
    if (['cbe','boa','cbebirr'].includes(bank) && !accountNumber) throw new Error('Enter the account number for this bank.');
    const token = await auth.currentUser.getIdToken();
    const response = await fetch('/api/admin/approvals', {
      method: 'POST',
      headers: {'content-type':'application/json', authorization:'Bearer ' + token},
      body: JSON.stringify({action:'checket-verify',bank,transactionNumber,accountNumber})
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'Verification failed.');
    const exactMatch = data.verified && data.receiverAccountMatches === true;
    const status = exactMatch ? 'PROVIDER CONFIRMED â€” RECEIVER ACCOUNT MATCHES'
      : data.verified ? 'PAYMENT FOUND â€” RECEIVING ACCOUNT NOT CONFIRMED'
      : 'PAYMENT NOT CONFIRMED';
    const account = data.receiverAccountStatus === 'exact_match'
      ? 'Full receiving account matches the number entered'
      : data.receiverAccountStatus === 'mismatch'
      ? 'WARNING â€” returned full receiving account differs. STOP and investigate.'
      : data.receiverAccountStatus === 'masked_unverifiable'
      ? 'Bank returned a MASKED receiver account. Full account match cannot be confirmed.'
      : 'Receiver account not returned; independent account match unavailable';
    const amount = data.amount === null ? 'Not returned' : Number(data.amount).toLocaleString('en-US') + ' ' + esc(data.currency || '');
    result.innerHTML = `<div class="${exactMatch?'success':'error'}"><strong>${esc(status)}</strong>
      <p>Amount: ${amount} Â· Status: ${esc(data.status)} Â· Bank: ${esc(data.bank)}</p>
      <p>Sender: ${esc(data.payerName || 'Not returned')}</p>
      <p>Recipient: ${esc(data.receiverName || 'Not returned')}</p>
      <p>${esc(account)}</p>
      <p>Previously verified in Check.et branch: ${data.providerDuplicate?'Yes':'No'}</p>
      <p><strong>Read-only result. No ticket or payment was approved.</strong></p></div>`;
  } catch (error) {
    result.innerHTML = `<div class="error">${esc(error.message || 'Check.et verification failed.')}</div>`;
  } finally {
    button.disabled = false;
  }
});

onAuthStateChanged(auth,async u=>{
  if(!u){location.href='login.html';return;}
  try{
    const p=await getDoc(doc(db,'users',u.uid));
    if(!p.exists()||p.data().role!=='generalAdmin'){location.href='login.html';return;}
    await renderLotteries();
    await renderSummaryOverview();
    await loadContactSettings();
    renderCreatePaymentAccountsEditor();
    setupDraw();
    // Previously confirmed cleanups resume automatically after refresh/sign-in.
    void autoResumeCleanupOnLoad();
  }catch(e){console.error(e);$('message').innerHTML=`<div class="error">${esc(e.message||'Could not load the General Admin dashboard.')}</div>`;}
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
    const newLottery=doc(collection(db,'lotteries'));
    const batch=writeBatch(db);
    batch.set(newLottery,{name:$('name').value.trim(),price,min,max,status:$('status').value,approvalMode,description:$('description').value.trim(),createdAt:serverTimestamp(),adminIds:[],nextTicketNumber:min,awards:['First Prize'],paymentAccounts});
    batch.set(doc(collection(db,'auditLogs')),{action:'createLottery',lotteryId:newLottery.id,approvalMode,adminId:auth.currentUser.uid,createdAt:serverTimestamp(),paymentAccountBanks:paymentAccounts.map(x=>x.bank)});
    await batch.commit();
    e.target.reset();
    createPaymentAccounts=DEFAULT_PAYMENT_ACCOUNTS.map(x=>({...x}));
    renderCreatePaymentAccountsEditor();
    $('message').innerHTML='<div class="success">Lottery created with '+esc(approvalMode)+' approval.</div>';await renderLotteries();await renderSummaryOverview();setupDraw();
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
  if(existing)throw new Error('This email is already a Lottery Admin. Use â€œAssign another lotteryâ€ below instead.');
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
  }catch(err){console.error(err);const msg=err?.code==='auth/email-already-in-use'?'This email already exists in Firebase Authentication. Use â€œAssign another lotteryâ€ if this is an existing Lottery Admin.':(err?.code==='permission-denied'?'Firestore permission denied while saving the admin profile. Make sure the General Admin profile exists and the V6 rules are published.':(err.message||'Could not create lottery admin.'));await setAdminMessage(msg,false)}finally{btn.disabled=false;}
});

// Explicit admin selection avoids silent "no match" caused by email typos,
// and thãOx¶‰žËkºwµçM½¹ÍÐ‰…¹¹•È€ô€ µ•ÍÍ…”œ¤ì4(€ÑÉäì4(€€€¥˜€ …±½ÑÑ•Éä¹±•…¹ÕÁ%¹AÉ½É•ÍÌ¤ì4(€€€€€‰…¹¹•È¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰µÕÑ•ˆù¡•­¥¹œ±¥¹­•É•½É‘Ì™½È€œ­•ÍŒ¡±½ÑÑ•Éä¹¹…µ”¤¬ŸŠ˜ð½‘¥Øøœì4(€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€¡•­¥¹œ±¥¹­•É•½É‘ÏŠ˜œ¤ì4(€€€€€½¹ÍÐÀ€ô…Ý…¥Ð±•…¹ÕÁÁ¤ ±½ÑÑ•Éäµ±•…¹ÕÀµÁÉ•Ù¥•Üœ±¥¤ì4(€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€AÉ•Ù¥•Üè€œ­À¹É•ÅÕ•ÍÑÌ¬œÁÕÉ¡…Í•Ì°€œ­À¹…ÁÁÉ½Ù•¬œ…ÁÁÉ½Ù•°€œ­À¹Ñ¥­•ÑÌ¬œÑ¥­•ÑÌ¸•±•Ñ¥½¸¡…Ì9=PÍÑ…ÉÑ•¸œ¤ì4(€€€€€½¹ÍÐ‘•Ñ…¥°€ô4(€€€€€€€€1½ÑÑ•Éäè€œ­À¹¹…µ”¬q¸œ¬4(€€€€€€€€A…åµ•¹ÐÉ•ÅÕ•ÍÑÌè€œ­À¹É•ÅÕ•ÍÑÌ¬q¸œ¬4(€€€€€€€€ÁÁÉ½Ù•É•ÅÕ•ÍÑÌè€œ­À¹…ÁÁÉ½Ù•¬q¸œ¬4(€€€€€€€€%ÍÍÕ•Ñ¥­•ÑÌè€œ­À¹Ñ¥­•ÑÌ¬q¸œ¬4(€€€€€€€€I••¥ÁÐ±…¥µÌè€œ­À¹±…¥µÌ¬q¸œ¬4(€€€€€€€€EÕ•Õ•¹½Ñ¥™¥…Ñ¥½¹Ìè€œ­À¹¹½Ñ¥™¥…Ñ¥½¹Ì¬q¹q¸œ¬4(€€€€€€€€Q¡¥ÌAI599Q1dÉ•µ½Ù•Ì¥ÑÌÉ•ÅÕ•ÍÑÌ°Ñ¥­•Ð¹Õµ‰•ÉÌ°É••¥ÁÑÌ…¹…‘µ¥¸…ÍÍ¥¹µ•¹ÑÌ¸€œ¬4(€€€€€€€€±°ÕÍÑ½µ•ÉÌ¥¸Ñ¡¥Ì±½ÑÑ•Éä°¥¹±Õ‘¥¹œ…¹äÉ•…°‰Õå•ÉÌ°Ý¥±°±½Í”Ñ¡•¥ÈÉ•½É‘Ì¸€œ¬4(€€€€€€€€1½ÑÑ•ÉäµÍÁ•¥™¥Œ…Õ‘¥Ð¡¥ÍÑ½Éä¥Ì…±Í¼±•…É•°±•…Ù¥¹œ„µ¥¹¥µ…°‘•±•Ñ¥½¸•ÉÑ¥™¥…Ñ”¸€œ¬4(€€€€€€€€¥É•‰…Í”ÅÕ½Ñ…Ì½È‰¥±±¥¹œµ…ä…ÁÁ±ä¸€œ¬4(€€€€€€€€Q¡”±½ÑÑ•ÉäÉ•µ…¥¹Ì±½Í•Ñ¡É½Õ¡½ÕÐ±•…¹ÕÀ¸Q¼ÁÉ½••ÑåÁ”éq¹1Q€œ­¥ì4(€€€€€½¹ÍÐ½¹™¥Éµ…Ñ¥½¸€ôÁÉ½µÁÐ¡‘•Ñ…¥°¤ì4(€€€€€¥˜€¡½¹™¥Éµ…Ñ¥½¸€„ôô€1Q€œ­¥¤ì4(€€€€€€€‰…¹¹•È¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰µÕÑ•ˆù1½ÑÑ•Éä±•…¹ÕÀ…¹•±±•¸9¼‘…Ñ„¡…¹•¸ð½‘¥Øøœì4(€€€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€…¹•±±•èå½ÔµÕÍÐ•¹Ñ•È1Q€œ­¥¬œ•á…Ñ±ä¸9¼‘…Ñ„Ý…Ì¡…¹•¸œ¤ì4(€€€€€€€É•ÑÕÉ¸ì4(€€€€€ô4(€€€€€¥˜€¡À¹…ÁÁÉ½Ù•øÀñðÀ¹Ñ¥­•ÑÌøÀ¤ì4(€€€€€€€½¹ÍÐ•áÑÉ„€ô½¹™¥É´ ]I9%9èQ¡¥Ì±½ÑÑ•Éä¡…Ì€œ­À¹…ÁÁÉ½Ù•¬4(€€€€€€€€€€œ…ÁÁÉ½Ù•ÁÕÉ¡…Í•Ì…¹€œ­À¹Ñ¥­•ÑÌ¬œ¥ÍÍÕ•Ñ¥­•ÑÌ¸€œ¬4(€€€€€€€€€€Q¡•Í”Ñ¥­•ÐÉ•½É‘ÌÝ¥±°…±Í¼‰”Á•Éµ…¹•¹Ñ±äÉ•µ½Ù•¸½¹Ñ¥¹Õ”üœ¤ì4(€€€€€€€¥˜€ …•áÑÉ„¤ìÍ¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€…¹•±±•…Ð…ÁÁÉ½Ù•µÑ¥­•ÐÝ…É¹¥¹œ¸9¼‘…Ñ„Ý…Ì¡…¹•¸œ¤ìÉ•ÑÕÉ¸ìô4(€€€€€ô4(€€€€€½¹ÍÐ½¹Í•¹Ð€ô½¹™¥É´ 1…ÍÐ½¹™¥Éµ…Ñ¥½¸è±½Í”…¹Á•Éµ…¹•¹Ñ±ä‘•±•Ñ”±½ÑÑ•Éä€œ­À¹¹…µ”¬4(€€€€€€€€œ…¹10¥ÑÌÉ•±…Ñ•ÁÕÉ¡…Í”‘…Ñ„üQ¡¥Ì…¹¹½Ð‰”Õ¹‘½¹”¸œ¤ì4(€€€€€¥˜€ …½¹Í•¹Ð¤ìÍ¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€…¹•±±•…Ð™¥¹…°½¹™¥Éµ…Ñ¥½¸¸9¼‘…Ñ„Ý…Ì¡…¹•¸œ¤ìÉ•ÑÕÉ¸ìô4(€€€€€…Ý…¥Ð±•…¹ÕÁÁ¤ ±½ÑÑ•Éäµ±•…¹ÕÀµÍÑ…ÉÐœ±¥±ì4(€€€€€€€½¹™¥É´è1Q€œ­¥°…•ÁÑ%ÉÉ•Ù•ÉÍ¥‰±”éÑÉÕ”4(€€€€€ô¤ì4(€€€€€±½ÑÑ•Éä¹±•…¹ÕÁ%¹AÉ½É•ÍÌ€ôÑÉÕ”ì4(€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€•±•Ñ¥½¸ÍÑ…ÉÑ•¸Q¡¥Ì±½ÑÑ•Éä¥Ì¹½Ü±½Í•ìÉÕ¹¹¥¹œÍµ…±°‰…Ñ¡•ÏŠ˜œ¤ì4(€€€ô•±Í”¥˜€ ……±É•…‘å½¹™¥Éµ•€˜˜€…½¹™¥É´ I•ÍÕµ”Ñ¡”•á¥ÍÑ¥¹œ‘•±•Ñ¥½¸½˜€œ­±½ÑÑ•Éä¹¹…µ”¬4(€€€€€€œüI•±…Ñ•Ñ•ÍÐ‘…Ñ„Ý¥±°‰”É•µ½Ù•¥¸Íµ…±°‰…Ñ¡•Ì¸œ¤¤ì4(€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€I•ÍÕµ”…¹•±±•¸±•…¹ÕÀÉ•µ…¥¹ÌÁ…ÕÍ•…¹Ñ¡”±½ÑÑ•ÉäÍÑ…åÌ±½Í•¸œ¤ì4(€€€€€É•ÑÕÉ¸ì4(€€€ô4(€€€±•ÐÍÑ•ÁÌ€ô€À°É•ÅÕ•ÍÑÌ€ô€À°‘½Õµ•¹ÑÌ€ô€À°™¥±•Ì€ô€À°ÅÕ½Ñ…I•ÑÉ¥•ÌôÀì4(€€€Ý¡¥±”€¡ÑÉÕ”¤ì4(€€€€€±•ÐÍÑ•Àì4(€€€€€ÑÉäì4(€€€€€€€ÍÑ•À€ô…Ý…¥Ð±•…¹ÕÁÁ¤ ±½ÑÑ•Éäµ±•…¹ÕÀµÍÑ•Àœ±¥¤ì4(€€€€€ô…Ñ €¡”¤ì4(€€€€€€€€¼¼¥É•‰…Í”…¸ÍÑ¥±°¥µÁ½Í”É•…°ÅÕ½Ñ„±¥µ¥ÑÌ•Ù•¸Ý¥Ñ¡½ÕÐ½ÕÈ½±‘…¥±ä…À¸4(€€€€€€€¥˜€¡”¹ÍÑ…ÑÕÌ€„ôô€ÐÈä€˜˜”¹ÍÑ…ÑÕÌ€„ôô€ÔÀÌ¤Ñ¡É½Ü”ì4(€€€€€€€ÅÕ½Ñ…I•ÑÉ¥•Ì¬¬ì4(€€€€€€€½¹ÍÐÝ…¥Ñ5Ì€ô5…Ñ ¹µ¥¸ ÌÀ¨ØÀ¨ÄÀÀÀ°ØÀ¨ÄÀÀÀ©5…Ñ ¹Á½Ü È±5…Ñ ¹µ¥¸¡ÅÕ½Ñ…I•ÑÉ¥•Ì°Ô¤¤¤ì4(€€€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°¥É•‰…Í”¥Ì±¥µ¥Ñ¥¹œÉ•ÅÕ•ÍÑÌ¸ÕÑ½µ…Ñ¥…±±äÉ•ÑÉå¥¹œÝ¡•¸Ñ¡”½½±‘½Ý¸•¹‘Ìì­••ÀÑ¡”Ñ…ˆ½Á•¸¸œ¤ì4(€€€€€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í”¡É•Í½±Ù”ôùÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”±Ý…¥Ñ5Ì¤¤ì4(€€€€€€€½¹Ñ¥¹Õ”ì4(€€€€€ô4(€€€€€ÅÕ½Ñ…I•ÑÉ¥•Ì€ô€Àì4(€€€€€ÍÑ•ÁÌ¬¬ì4(€€€€€€¼¼e¥•±½…Í¥½¹…±±äì±…É”±½ÑÑ•É¥•ÌÉ•µ…¥¸…ÕÑ½µ…Ñ¥ŒÝ¥Ñ¡½ÕÐ™±½½‘¥¹œY•É•°¸4(€€€€€¥˜€¡ÍÑ•ÁÌ”ÈÀÀ€ôôô€À¤…Ý…¥Ð¹•ÜAÉ½µ¥Í”¡É•Í½±Ù”ôùÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”°ÄÔÀÀ¤¤ì4(€€€€€É•ÅÕ•ÍÑÌ€¬ôÍÑ•À¹Á¡…Í”ôôôÉ•ÅÕ•ÍÑÌœ€üÍÑ•À¹ÁÉ½•ÍÍ•‘ñðÀ€è€Àì4(€€€€€‘½Õµ•¹ÑÌ€¬ôÍÑ•À¹‘•±•Ñ•‘½Õµ•¹ÑÍñðÀì4(€€€€€™¥±•Ì€¬ôÍÑ•À¹É•µ½Ù•‘¥±•ÍñðÀì4(€€€€€‰…¹¹•È¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰µÕÑ•ˆù±•…¹ÕÀÉÕ¹¹¥¹œ™½È€ñˆøœ­•ÍŒ¡±½ÑÑ•Éä¹¹…µ”¤¬4(€€€€€€€€œð½ˆøƒŠPÁ¡…Í”è€œ­•ÍŒ¡ÍÑ•À¹Á¡…Í•ñðœœ¤¬œì‰…Ñ¡•Ìè€œ­ÍÑ•ÁÌ¬4(€€€€€€€€œìÉ•ÅÕ•ÍÑÌ±•…É•¥¸Ñ¡¥ÌÍ•ÍÍ¥½¸è€œ­É•ÅÕ•ÍÑÌ¬4(€€€€€€€€œì¥É•ÍÑ½É”‘½Õµ•¹ÑÌÉ•µ½Ù•è€œ­‘½Õµ•¹ÑÌ¬4(€€€€€€€€œìMÑ½É…”™¥±•ÌÉ•µ½Ù•è€œ­™¥±•Ì¬4(€€€€€€€€œ¸-••ÀÑ¡¥ÌÑ…ˆ½Á•¸¸±•…¹ÕÀ…¸É•ÍÕµ”¥˜¥¹Ñ•ÉÉÕÁÑ•¸ð½‘¥Øøœì4(€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€±•…¹¥¹œ€œ­ÍÑ•À¹Á¡…Í”¬œè€œ­‘½Õµ•¹ÑÌ¬œ¥É•ÍÑ½É”‘½Õµ•¹ÑÌ…¹€œ­™¥±•Ì¬œMÑ½É…”™¥±•ÌÉ•µ½Ù•¥¸Ñ¡¥ÌÍ•ÍÍ¥½¸¸œ¤ì4(€€€€€¥˜€¡ÍÑ•À¹Á…ÕÍ•¤ì4(€€€€€€€½¹ÍÐÉ•…‘åQ¥µ”€ô…Ñ”¹Á…ÉÍ”¡MÑÉ¥¹œ¡ÍÑ•À¹Ý…¥Ñ¥¹U¹Ñ¥±ñðœœ¤¤ì4(€€€€€€€¥˜€ …9Õµ‰•È¹¥Í¥¹¥Ñ”¡É•…‘åQ¥µ”¤¤ì4(€€€€€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€±•…¹ÕÀÁ…ÕÍ•¸Q¡”Í…™”É•ÍÕµ”Ñ¥µ”½Õ±¹½Ð‰”É•…¸±¥¬½¹Ñ¥¹Õ”±•…¹ÕÀ±…Ñ•È¸œ¤ì4(€€€€€€€€€‰É•…¬ì4(€€€€€€€ô4(€€€€€€€½¹ÍÐÝ…¥Ñ5Ì€ô5…Ñ ¹µ…à À±É•…‘åQ¥µ”µ…Ñ”¹¹½Ü ¤¤¬ÄÈÀÀì4(€€€€€€€½¹ÍÐµ¥¹ÕÑ•Ì€ô5…Ñ ¹µ…à Ä±5…Ñ ¹•¥°¡Ý…¥Ñ5Ì¼ØÀÀÀÀ¤¤ì4(€€€€€€€½¹ÍÐÝ…¥Ñ¥¹œ€ô€MÑ½É…”Í…™•ÑäÁ…ÕÍ”è…ÕÑ½µ…Ñ¥ŒÉ•ÍÕµ”¥¸…‰½ÕÐ€œ­µ¥¹ÕÑ•Ì¬4(€€€€€€€€€€œµ¥¹ÕÑ”¡Ì¤¸-••ÀÑ¡¥ÌÑ…ˆ½Á•¸ì¹¼Y•É•°A$É•ÅÕ•ÍÑÌ…É”µ…‘”‘ÕÉ¥¹œÑ¡”Á…ÕÍ”¸œì4(€€€€€€€‰…¹¹•È¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰µÕÑ•ˆøœ­•ÍŒ¡Ý…¥Ñ¥¹œ¤¬œð½‘¥Øøœì4(€€€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥±Ý…¥Ñ¥¹œ¤ì4(€€€€€€€€¼¼A…ÕÍ”Ñ¡”‰É½ÝÍ•ÈÉ…Ñ¡•ÈÑ¡…¸¥ÍÍÕ¥¹œÉ•Á•…Ñ•Y•É•°Õ¹Ñ¥½¸É•ÅÕ•ÍÑÌ¸4(€€€€€€€€¼¼%˜¡É½µ”±½Í•Ì°Ñ¡”Í…Ù•±•…¹ÕÀÍÑ…Ñ”…±±½ÝÌ½¹”µ±¥¬É•ÍÕµÁÑ¥½¸¸4(€€€€€€€…Ý…¥Ð¹•ÜAÉ½µ¥Í”¡É•Í½±Ù”ôùÍ•ÑQ¥µ•½ÕÐ¡É•Í½±Ù”±Ý…¥Ñ5Ì¤¤ì4(€€€€€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°€UÁ±½…±¥¹­Ì¡…Ù”•áÁ¥É•¸I•ÍÕµ¥¹œÑ¡”™¥¹…°±•…¹ÕÀ…ÕÑ½µ…Ñ¥…±±çŠ˜œ¤ì4(€€€€€€€½¹Ñ¥¹Õ”ì4(€€€€€ô4(€€€€€¥˜€¡ÍÑ•À¹‘½¹”¤ì4(€€€€€€€±•…¹ÕÁ9½Ñ¥•Ì¹‘•±•Ñ”¡¥¤ì4(€€€€€€€‰…¹¹•È¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰ÍÕ•ÍÌˆù1½ÑÑ•Éä€œ­•ÍŒ¡±½ÑÑ•Éä¹¹…µ”¤¬4(€€€€€€€€€€œ…¹¥ÑÌ±¥¹­•É•½É‘ÌÝ•É”‘•±•Ñ•¸Õ‘¥Ð±½ÌÁÉ•Í•ÉÙ•¸ð½‘¥Øøœì4(€€€€€€€‰É•…¬ì4(€€€€€ô4(€€€ô4(€ô…Ñ ¡•ÉÉ½È¤ì4(€€€½¹ÍÐÁÉ•™¥à€ô•ÉÉ½È¹ÍÑ…ÑÕÌôôôÐÈä4(€€€€€€ü€±•…¹ÕÀÍ…™•±äÁ…ÕÍ•‰äÑ¡”‘…¥±ä¥É•ÍÑ½É”‘•±•Ñ¥½¸Õ…É¸€œ4(€€€€€€è€±•…¹ÕÀÍÑ½ÁÁ•Ý¥Ñ¡½ÕÐ…ÕÑ½µ…Ñ¥…±±äÉ•ÑÉå¥¹œ¸€œì4(€€€Í¡½Ý±•…¹ÕÁ9½Ñ¥”¡¥°ÁÉ•™¥à­•ÉÉ½È¹µ•ÍÍ…”¤ì4(€€€‰…¹¹•È¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰•ÉÉ½Èˆøœ­•ÍŒ¡ÁÉ•™¥à­•ÉÉ½È¹µ•ÍÍ…”¤¬4(€€€€€€œI•™É•Í •¹•É…°‘µ¥¸…¹Í•±•Ð½¹Ñ¥¹Õ”±•…¹ÕÀÝ¡•¸Í…™”¸ð½‘¥Øøœì4(€ô™¥¹…±±äì4(€€€±•…¹ÕÁ	ÕÍäõ™…±Í”ì4(€€€ÑÉäì…Ý…¥ÐÉ•¹‘•É1½ÑÑ•É¥•Ì ¤ì…Ý…¥ÐÉ•¹‘•ÉMÕµµ…Éå=Ù•ÉÙ¥•Ü ¤ìÍ•ÑÕÁÉ…Ü ¤ìô4(€€€…Ñ ¡•ÉÉ½È¤ì½¹Í½±”¹Ý…É¸ …Í¡‰½…ÉÉ•™É•Í …™Ñ•È±•…¹ÕÀèœ±•ÉÉ½È¤ìô4(€ô4)ô4(4(4)…Íå¹Œ™Õ¹Ñ¥½¸±½…‘½¹Ñ…ÑM•ÑÑ¥¹Ì ¥ì4(€ÑÉåì4(€€€½¹ÍÐÍ¹…Àõ…Ý…¥Ð•Ñ½Œ¡‘½Œ¡‘ˆ°Í•ÑÑ¥¹Ìœ°Í¥Ñ”œ¤¤ì4(€€€½¹ÍÐ‘…Ñ„õÍ¹…À¹•á¥ÍÑÌ ¤ýÍ¹…À¹‘…Ñ„ ¤éíôì4(€€€€ Ý¡…ÑÍ…ÁÁ9Õµ‰•Èœ¤¹Ù…±Õ”õ‘…Ñ„¹Ý¡…ÑÍ…ÁÁ9Õµ‰•Éñðœœì4(€€€ÕÁ‘…Ñ•½¹Ñ…ÑAÉ•Ù¥•Ü ¤ì4(€õ…Ñ ¡”¥ì4(€€€€ ½¹Ñ…Ñ5•ÍÍ…”œ¤¹¥¹¹•É!Q50õ€ñ‘¥Ø±…ÍÌô‰•ÉÉ½Èˆø‘í•ÍŒ¡”¹µ•ÍÍ…•ñð½Õ±¹½Ð±½…½¹Ñ…ÐÍ•ÑÑ¥¹Ì¸œ¥ôð½‘¥Øù€ì4(€ô4)ô4(4)™Õ¹Ñ¥½¸É•¹‘•ÉÉ•…Ñ•A…åµ•¹Ñ½Õ¹ÑÍ‘¥Ñ½È ¥ì4(€½¹ÍÐ¡½ÍÐô É•…Ñ•A…åµ•¹Ñ½Õ¹ÑÍ‘¥Ñ½Èœ¤ì4(€¥˜ …¡½ÍÐ¥É•ÑÕÉ¸ì4(€¡½ÍÐ¹¥¹¹•É!Q50õÉ•…Ñ•A…åµ•¹Ñ½Õ¹ÑÌ¹µ…À ¡„±¤¤ôù€ñ‘¥Ø±…ÍÌô‰Á…åµ•¹Ðµ…½Õ¹Ðµ•‘¥ÐµÉ½ÜÉ•…Ñ”µÁ…åµ•¹ÐµÉ½Üˆøñ±…‰•°ù	…¹¬¹…µ”ñ¥¹ÁÕÐÑåÁ”ô‰Ñ•áÐˆ‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ‰…¹¬ôˆ‘í¥ôˆÙ…±Õ”ôˆ‘í•ÍŒ¡„¹‰…¹¬¥ôˆÁ±…•¡½±‘•Èô‰	ˆøð½±…‰•°øñ±…‰•°ù½Õ¹Ð¹Õµ‰•Èñ¥¹ÁÕÐÑåÁ”ô‰Ñ•áÐˆ‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ¹Õµ‰•Èôˆ‘í¥ôˆÙ…±Õ”ôˆ‘í•ÍŒ¡„¹¹Õµ‰•È¥ôˆ¥¹ÁÕÑµ½‘”ô‰¹Õµ•É¥ŒˆÁ±…•¡½±‘•ÈôˆÄÀÀÀÀÀÀÀÀÀÀÀÀˆøð½±…‰•°øñ±…‰•°ù½Õ¹Ð¡½±‘•Èñ¥¹ÁÕÐÑåÁ”ô‰Ñ•áÐˆ‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ¡½±‘•Èôˆ‘í¥ôˆÙ…±Õ”ôˆ‘í•ÍŒ¡„¹¡½±‘•É9…µ•ñðœœ¥ôˆÁ±…•¡½±‘•Èô‰½Õ¹Ð¡½±‘•È¹…µ”ˆøð½±…‰•°øñ‰ÕÑÑ½¸ÑåÁ”ô‰‰ÕÑÑ½¸ˆ±…ÍÌô‰‘…¹•ÈÍµ…±°µ‰Ñ¸ˆ‘…Ñ„µÉ•µ½Ù”µÉ•…Ñ”µÁ…åµ•¹Ðôˆ‘í¥ôˆùI•µ½Ù”ð½‰ÕÑÑ½¸øð½‘¥Øù€¤¹©½¥¸ œœ¤ì4(€¡½ÍÐ¹ÅÕ•ÉåM•±•Ñ½É±° m‘…Ñ„µÉ•µ½Ù”µÉ•…Ñ”µÁ…åµ•¹Ñtœ¤¹™½É… ¡ˆôùˆ¹…‘‘Ù•¹Ñ1¥ÍÑ•¹•È ±¥¬œ° ¤ôùÉ•µ½Ù•É•…Ñ•A…åµ•¹Ñ½Õ¹Ð¡9Õµ‰•È¡ˆ¹‘…Ñ…Í•Ð¹É•µ½Ù•É•…Ñ•A…åµ•¹Ð¤¤¤¤ì4)ô4(4)™Õ¹Ñ¥½¸É•…‘É•…Ñ•A…åµ•¹Ñ½Õ¹ÑÌ ¥ì4(€½¹ÍÐ‰…¹­Ìõl¸¸¹‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° m‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ‰…¹­tœ¥tì4(€É•ÑÕÉ¸‰…¹­Ì¹µ…À ¡¥¹ÁÕÐ±¤¤ôø¡í‰…¹¬éMÑÉ¥¹œ¡¥¹ÁÕÐ¹Ù…±Õ•ñðœœ¤¹ÑÉ¥´ ¤±¹Õµ‰•ÈéMÑÉ¥¹œ¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È¡m‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ¹Õµ‰•Èôˆ‘í¥ô‰u€¤ü¹Ù…±Õ•ñðœœ¤¹ÑÉ¥´ ¤±¡½±‘•É9…µ”éMÑÉ¥¹œ¡‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È¡m‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ¡½±‘•Èôˆ‘í¥ô‰u€¤ü¹Ù…±Õ•ñðœœ¤¹ÑÉ¥´ ¥ô¤¤¹™¥±Ñ•È¡àôùà¹‰…¹­ññà¹¹Õµ‰•Éññà¹¡½±‘•É9…µ”¤ì4)ô4(4)™Õ¹Ñ¥½¸…‘‘É•…Ñ•A…åµ•¹Ñ½Õ¹Ð ¥ì4(€É•…Ñ•A…åµ•¹Ñ½Õ¹ÑÌ¹ÁÕÍ ¡í‰…¹¬èœœ±¹Õµ‰•Èèœœ±¡½±‘•É9…µ”èœô¤ì4(€É•¹‘•ÉÉ•…Ñ•A…åµ•¹Ñ½Õ¹ÑÍ‘¥Ñ½È ¤ì4(€½¹ÍÐ¥¹ÁÕÑÌõ‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° m‘…Ñ„µÉ•…Ñ”µÁ…åµ•¹Ðµ‰…¹­tœ¤ì4(€¥¹ÁÕÑÍm¥¹ÁÕÑÌ¹±•¹Ñ ´Åtü¹™½ÕÌ ¤ì4)ô4(4)™Õ¹Ñ¥½¸É•µ½Ù•É•…Ñ•A…åµ•¹Ñ½Õ¹Ð¡¥¹‘•à¥ì4(€É•…Ñ•A…åµ•¹Ñ½Õ¹ÑÌ¹ÍÁ±¥”¡¥¹‘•à°Ä¤ì4(€¥˜ …É•…Ñ•A…åµ•¹Ñ½Õ¹ÑÌ¹±•¹Ñ ¥É•…Ñ•A…åµ•¹Ñ½Õ¹ÑÌ¹ÁÕÍ ¡í‰…¹¬èœœ±¹Õµ‰•Èèœœ±¡½±‘•É9…µ”èœô¤ì4(€É•¹‘•ÉÉ•…Ñ•A…åµ•¹Ñ½Õ¹ÑÍ‘¥Ñ½È ¤ì4)ô4(4)™Õ¹Ñ¥½¸ÕÁ‘…Ñ•½¹Ñ…ÑAÉ•Ù¥•Ü ¥ì4(€½¹ÍÐÉ…Üô Ý¡…ÑÍ…ÁÁ9Õµ‰•Èœ¤ü¹Ù…±Õ•ñðœœì4(€½¹ÍÐ‘¥¥ÑÌõÉ…Ü¹É•Á±…” ½mxÀ´åt½œ°œœ¤ì4(€€ Ý¡…ÑÍ…ÁÁAÉ•Ù¥•Üœ¤¹Ù…±Õ”õ‘¥¥ÑÌý¡ÑÑÁÌè¼½Ý„¹µ”¼‘í‘¥¥ÑÍõ€è9½Ð½¹™¥ÕÉ•œì4)ô4(4)…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù•½¹Ñ…ÑM•ÑÑ¥¹Ì¡”¥ì4(€”¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤ì4(€½¹ÍÐÉ…Üô Ý¡…ÑÍ…ÁÁ9Õµ‰•Èœ¤¹Ù…±Õ”¹ÑÉ¥´ ¤ì4(€½¹ÍÐ‘¥¥ÑÌõÉ…Ü¹É•Á±…” ½mxÀ´åt½œ°œœ¤ì4(€¥˜¡‘¥¥ÑÌ¹±•¹Ñ €ð€äñð‘¥¥ÑÌ¹±•¹Ñ €ø€ÄÔ¥ì4(€€€€ ½¹Ñ…Ñ5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰•ÉÉ½Èˆù¹Ñ•È„Ù…±¥]¡…ÑÍÁÀ¹Õµ‰•È°¥¹±Õ‘¥¹œ½Õ¹ÑÉä½‘”¸ð½‘¥Øøœì4(€€€É•ÑÕÉ¸ì4(€ô4(€ÑÉåì4(€€€…Ý…¥ÐÍ•Ñ½Œ¡‘½Œ¡‘ˆ°Í•ÑÑ¥¹Ìœ°Í¥Ñ”œ¤±íÝ¡…ÑÍ…ÁÁ9Õµ‰•Èé‘¥¥ÑÌ±ÕÁ‘…Ñ•‘ÐéÍ•ÉÙ•ÉQ¥µ•ÍÑ…µÀ ¤±ÕÁ‘…Ñ•‘	äé…ÕÑ ¹ÕÉÉ•¹ÑUÍ•È¹Õ¥‘ô±íµ•É”éÑÉÕ•ô¤ì4(€€€…Ý…¥Ð…‘‘½Œ¡½±±•Ñ¥½¸¡‘ˆ°…Õ‘¥Ñ1½Ìœ¤±í…Ñ¥½¸èÕÁ‘…Ñ•ÕÍÑ½µ•É½¹Ñ…Ðœ±Ý¡…ÑÍ…ÁÁ9Õµ‰•É1…ÍÐÐé‘¥¥ÑÌ¹Í±¥” ´Ð¤±…‘µ¥¹%é…ÕÑ ¹ÕÉÉ•¹ÑUÍ•È¹Õ¥±É•…Ñ•‘ÐéÍ•ÉÙ•ÉQ¥µ•ÍÑ…µÀ ¥ô¤ì4(€€€ÕÁ‘…Ñ•½¹Ñ…ÑAÉ•Ù¥•Ü ¤ì4(€€€€ ½¹Ñ…Ñ5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰ÍÕ•ÍÌˆù]¡…ÑÍÁÀ½¹Ñ…ÐÕÁ‘…Ñ•½¸Ñ¡”ÁÕ‰±¥Œ¡½µ”Á…”¸ð½‘¥Øøœì4(€õ…Ñ ¡”¥ì4(€€€€ ½¹Ñ…Ñ5•ÍÍ…”œ¤¹¥¹¹•É!Q50õ€ñ‘¥Ø±…ÍÌô‰•ÉÉ½Èˆø‘í•ÍŒ¡”¹µ•ÍÍ…•ñð½Õ±¹½ÐÍ…Ù”½¹Ñ…ÐÍ•ÑÑ¥¹Ì¸œ¥ôð½‘¥Øù€ì4(€ô4)ô4(4)…Íå¹Œ™Õ¹Ñ¥½¸É•Í•Ñ1½ÑÑ•Éå‘µ¥¹A…ÍÍÝ½É¡”¥ì4(€”¹ÁÉ•Ù•¹Ñ•™…Õ±Ð ¤í½¹ÍÐ‰Ñ¸õ”¹Ñ…É•Ð¹ÅÕ•ÉåM•±•Ñ½È ‰ÕÑÑ½¹mÑåÁ”ô‰ÍÕ‰µ¥Ð‰tœ¤í‰Ñ¸¹‘¥Í…‰±•õÑÉÕ”ì4(€ÑÉåì4(€€€½¹ÍÐ•µ…¥°ô É•Í•Ñµ…¥°œ¤¹Ù…±Õ”¹ÑÉ¥´ ¤¹Ñ½1½Ý•É…Í” ¤±Á…ÍÍÝ½Éô É•Í•ÑA…ÍÍÝ½Éœ¤¹Ù…±Õ”ì4(€€€¥˜ …•µ…¥±ññÁ…ÍÍÝ½É¹±•¹Ñ ðØ¥Ñ¡É½Ü¹•ÜÉÉ½È ¹Ñ•È…¸•á¥ÍÑ¥¹œ1½ÑÑ•Éä‘µ¥¸•µ…¥°…¹„Á…ÍÍÝ½É½˜…Ð±•…ÍÐ€Ø¡…É…Ñ•ÉÌ¸œ¤ì4(€€€½¹ÍÐÑ½­•¸õ…Ý…¥Ð…ÕÑ ¹ÕÉÉ•¹ÑUÍ•È¹•Ñ%‘Q½­•¸ ¤í½¹ÍÐÈõ…Ý…¥Ð™•Ñ  œ½…Á¤½…‘µ¥¸½É•Í•ÐµÁ…ÍÍÝ½Éœ±íµ•Ñ¡½èA=MPœ±¡•…‘•ÉÌéì½¹Ñ•¹ÐµÑåÁ”œè…ÁÁ±¥…Ñ¥½¸½©Í½¸œ°…ÕÑ¡½É¥é…Ñ¥½¸œé	•…É•È€‘íÑ½­•¹õô±‰½‘äé)M=8¹ÍÑÉ¥¹¥™ä¡í•µ…¥°±Á…ÍÍÝ½É‘ô¥ô¤í½¹ÍÐ¨õ…Ý…¥ÐÈ¹©Í½¸ ¤í¥˜ …È¹½­ñð…¨¹½¬¥Ñ¡É½Ü¹•ÜÉÉ½È¡¨¹•ÉÉ½Éñð½Õ±¹½ÐÉ•Í•ÐÁ…ÍÍÝ½É¸œ¤ì4(€€€€ É•Í•Ñ5•ÍÍ…”œ¤¹¥¹¹•É!Q50õ€ñ‘¥Ø±…ÍÌô‰ÍÕ•ÍÌˆûŠrA…ÍÍÝ½É¡…¹•™½È€‘í•ÍŒ¡¨¹‘¥ÍÁ±…å9…µ•ññ•µ…¥°¥ô¸¥Ù”Ñ¡”1½ÑÑ•Éä‘µ¥¸Ñ¡¥ÌÑ•µÁ½É…ÉäÁ…ÍÍÝ½ÉÍ•ÕÉ•±äè€ñˆø‘í•ÍŒ¡Á…ÍÍÝ½É¥ôð½ˆøð½‘¥Øù€í…Ý…¥Ð…‘‘½Œ¡½±±•Ñ¥½¸¡‘ˆ°…Õ‘¥Ñ1½Ìœ¤±í…Ñ¥½¸èÉ•Í•Ñ1½ÑÑ•Éå‘µ¥¹A…ÍÍÝ½É‘U$œ±…‘µ¥¹%é…ÕÑ ¹ÕÉÉ•¹ÑUÍ•È¹Õ¥±Ñ…É•Ñµ…¥°é•µ…¥°±É•…Ñ•‘ÐéÍ•ÉÙ•ÉQ¥µ•ÍÑ…µÀ ¥ô¤ì4(€õ…Ñ ¡”¥ì É•Í•Ñ5•ÍÍ…”œ¤¹¥¹¹•É!Q50õ€ñ‘¥Ø±…ÍÌô‰•ÉÉ½Èˆø‘í•ÍŒ¡”¹µ•ÍÍ…”¥ôð½‘¥Øùõ™¥¹…±±åí‰Ñ¸¹‘¥Í…‰±•õ™…±Í”íô4)ô4(4)™Õ¹Ñ¥½¸•¹•É…Ñ•Q•µÁA…ÍÍÝ½É ¥í½¹ÍÐ¡…ÉÌô	!)-159AEIMQUY]aei…‰‘•™¡¥©­µ¹½ÁÅÉÍÑÕÙÝáåèÈÌÐÔØÜàä… Œœí±•Ð½ÕÐôœœí½¹ÍÐ‰åÑ•Ìõ¹•ÜU¥¹ÐÌÉÉÉ…ä ÄÈ¤íÉåÁÑ¼¹•ÑI…¹‘½µY…±Õ•Ì¡‰åÑ•Ì¤í™½È¡½¹ÍÐ¸½˜‰åÑ•Ì¥½ÕÐ¬õ¡…ÉÍm¸•¡…ÉÌ¹±•¹Ñ¡tíÉ•ÑÕÉ¸½ÕÑô4(4)™Õ¹Ñ¥½¸Í•ÑÕÁÉ…Ü ¥ì4(€½¹ÍÐÍ•±•Ðô ‘É…Ý1½ÑÑ•ÉåM•±•Ðœ¤í¥˜ …Í•±•Ð¥É•ÑÕÉ¸ì4(€½¹ÍÐ¥õÍ•±•Ð¹Ù…±Õ•ñð¡±½ÑÍlÁtü¹¥‘ñðœœ¤í¥˜¡¥¥Í•±•Ð¹Ù…±Õ”õ¥ì4(€½¹ÍÐàõ±½ÑÌ¹™¥¹¡°ôù°¹¥ôôõÍ•±•Ð¹Ù…±Õ”¥ññ±½ÑÍlÁtí¥˜ …à¥É•ÑÕÉ¸ì4(€‘É…Ý¥¥ÑÌõmtì ‘É…ÝI•ÍÕ±Ðœ¤¹Ñ•áÑ½¹Ñ•¹Ðôœœì ‘É…Ý5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœœíÉ•¹‘•É	…±±Ì ¤íÕÁ‘…Ñ•É…ÝU$¡à¤ì4)ô4)™Õ¹Ñ¥½¸É•¹‘•É	…±±Ì ¥ì4(€½¹ÍÐ¡½ÍÐô ‘É…Ý	½ÑÑ±”œ¤í¥˜ …¡½ÍÐ¥É•ÑÕÉ¸ì4(€¡½ÍÐ¹ÅÕ•ÉåM•±•Ñ½É±° œ¹‘É…Üµ‰…±°œ¤¹™½É… ¡•°ôù•°¹É•µ½Ù” ¤¤ì4(€™½È¡±•ÐôÀíðôäí¬¬¥í½¹ÍÐ•°õ‘½Õµ•¹Ð¹É•…Ñ•±•µ•¹Ð ‘¥Øœ¤í•°¹±…ÍÍ9…µ”ô‘É…Üµ‰…±°œí•°¹‘…Ñ…Í•Ð¹‘¥¥Ðõí•°¹Ñ•áÑ½¹Ñ•¹Ðôœœí•°¹ÍÑå±”¹Í•ÑAÉ½Á•ÉÑä œ´µ‰…±°µ¡Õ”œ±MÑÉ¥¹œ ¡¨ÌÜ¬ÄÈ¤”ÌØÀ¤¤í¡½ÍÐ¹…ÁÁ•¹‘¡¥±¡•°¤íÁ½Í¥Ñ¥½¹	…±°¡•°±ÑÉÕ”¤íô4)ô4)™Õ¹Ñ¥½¸Á½Í¥Ñ¥½¹	…±°¡•°±¥¹¥Ñ¥…°õ™…±Í”¥ì4(€½¹ÍÐ±•™ÐôÄÈ­5…Ñ ¹É…¹‘½´ ¤¨ÜÈ±Ñ½ÀôÄà­5…Ñ ¹É…¹‘½´ ¤¨ØÔí•°¹ÍÑå±”¹±•™Ðõ€‘í±•™Ñô•€í•°¹ÍÑå±”¹Ñ½Àõ€‘íÑ½Áô•€í¥˜¡¥¹¥Ñ¥…°¥•°¹ÍÑå±”¹ÑÉ…¹Í¥Ñ¥½¸ô¹½¹”œíÍ•ÑQ¥µ•½ÕÐ  ¤ôù•°¹ÍÑå±”¹ÑÉ…¹Í¥Ñ¥½¸ôœœ°ÈÀ¤íô4)™Õ¹Ñ¥½¸Í¡Õ™™±•	…±±Ì ¥í‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° œ¹‘É…Üµ‰…±°œ¤¹™½É… ¡•°ôùÁ½Í¥Ñ¥½¹	…±°¡•°¤¤íô4)™Õ¹Ñ¥½¸ÕÁ‘…Ñ•É…ÝU$¡±½ÑÑ•Éä¥ì4(€½¹ÍÐµ…á1•¸õMÑÉ¥¹œ¡5…Ñ ¹µ…à¡5…Ñ ¹…‰Ì¡9Õµ‰•È¡±½ÑÑ•Éä¹µ…áñðÀ¤¤±5…Ñ ¹…‰Ì¡9Õµ‰•È¡±½ÑÑ•Éä¹µ¥¹ñðÀ¤¤¤¤¹É•Á±…” ½x´¼°œœ¤¹±•¹Ñ¡ñðÄì4(€€ ‘É…ÝQ…É•Ðœ¤¹Ñ•áÑ½¹Ñ•¹Ðõ€‘í‘É…Ý¥¥ÑÌ¹±•¹Ñ¡ô¼‘íµ…á1•¹ô‘¥¥ÑÍ€ì4(€€ ‘É…ÝI•ÍÕ±Ðœ¤¹Ñ•áÑ½¹Ñ•¹Ðõ‘É…Ý¥¥ÑÌ¹©½¥¸ œœ¤ì4(€€ ‘É…Ý¥¥Ñ	Ñ¸œ¤¹‘¥Í…‰±•õ‘É…Ý	ÕÍåññ‘É…Ý¥¥ÑÌ¹±•¹Ñ øõµ…á1•¹ññ±½ÑÑ•Éä¹ÍÑ…ÑÕÌôôô‘É…Ý¸œì4(€€ É•Í•ÑÉ…Ý	Ñ¸œ¤¹‘¥Í…‰±•õ‘É…Ý	ÕÍäì4(€€ Í…Ù•É…Ý	Ñ¸œ¤¹‘¥Í…‰±•õ‘É…Ý	ÕÍåññ‘É…Ý¥¥ÑÌ¹±•¹Ñ „ôõµ…á1•¹ññ±½ÑÑ•Éä¹ÍÑ…ÑÕÌôôô‘É…Ý¸œì4(€¥˜¡±½ÑÑ•Éä¹ÍÑ…ÑÕÌôôô‘É…Ý¸œ¤ ‘É…Ý5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰ÍÕ•ÍÌˆùQ¡¥Ì±½ÑÑ•Éä…±É•…‘ä¡…Ì„Í…Ù•‘É…ÜÉ•ÍÕ±Ð¸ð½‘¥Øøœì4)ô4)…Íå¹Œ™Õ¹Ñ¥½¸‘É…Ý¥¥Ð ¥ì4(€½¹ÍÐ±½ÑÑ•Éäõ±½ÑÌ¹™¥¹¡°ôù°¹¥ôôô ‘É…Ý1½ÑÑ•ÉåM•±•Ðœ¤¹Ù…±Õ”¥ññ±½ÑÍlÁtí¥˜ …±½ÑÑ•Éåññ‘É…Ý	ÕÍåññ±½ÑÑ•Éä¹ÍÑ…ÑÕÌôôô‘É…Ý¸œ¥É•ÑÕÉ¸ì4(€½¹ÍÐµ…á1•¸õMÑÉ¥¹œ¡5…Ñ ¹µ…à¡5…Ñ ¹…‰Ì¡9Õµ‰•È¡±½ÑÑ•Éä¹µ…áñðÀ¤¤±5…Ñ ¹…‰Ì¡9Õµ‰•È¡±½ÑÑ•Éä¹µ¥¹ñðÀ¤¤¤¤¹É•Á±…” ½x´¼°œœ¤¹±•¹Ñ¡ñðÄì4(€¥˜¡‘É…Ý¥¥ÑÌ¹±•¹Ñ øõµ…á1•¸¥É•ÑÕÉ¸ì4(€‘É…Ý	ÕÍäõÑÉÕ”íÕÁ‘…Ñ•É…ÝU$¡±½ÑÑ•Éä¤íÍ¡Õ™™±•	…±±Ì ¤ì4(€…Ý…¥Ð¹•ÜAÉ½µ¥Í”¡ÈôùÍ•ÑQ¥µ•½ÕÐ¡È°ØÔÀ¤¤ì4(€½¹ÍÐ‘¥¥Ðõ5…Ñ ¹™±½½È¡5…Ñ ¹É…¹‘½´ ¤¨ÄÀ¤í½¹ÍÐ‰…±°õ‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½È¡€¹‘É…Üµ‰…±±m‘…Ñ„µ‘¥¥Ðôˆ‘í‘¥¥Ñô‰u€¤í¥˜¡‰…±°¥í‘½Õµ•¹Ð¹ÅÕ•ÉåM•±•Ñ½É±° œ¹‘É…Üµ‰…±°œ¤¹™½É… ¡ˆôùíˆ¹±…ÍÍ1¥ÍÐ¹É•µ½Ù” ½Á•¹•œ¤íˆ¹Ñ•áÑ½¹Ñ•¹Ðôœœíô¤í‰…±°¹±…ÍÍ1¥ÍÐ¹…‘ ½Á•¹•œ¤í‰…±°¹Ñ•áÑ½¹Ñ•¹ÐõMÑÉ¥¹œ¡‘¥¥Ð¤íô4(€‘É…Ý¥¥ÑÌ¹ÁÕÍ ¡‘¥¥Ð¤ì ‘É…ÝI•ÍÕ±Ðœ¤¹Ñ•áÑ½¹Ñ•¹Ðõ‘É…Ý¥¥ÑÌ¹µ…À¡MÑÉ¥¹œ¤¹©½¥¸ œœ¤ì4(€…Ý…¥Ð¹•ÜAÉ½µ¥Í”¡ÈôùÍ•ÑQ¥µ•½ÕÐ¡È°ÐÔÀ¤¤ì4(€¥˜¡‰…±°¥í‰…±°¹±…ÍÍ1¥ÍÐ¹É•µ½Ù” ½Á•¹•œ¤í‰…±°¹Ñ•áÑ½¹Ñ•¹Ðôœœíô4(€‘É…Ý	ÕÍäõ™…±Í”íÕÁ‘…Ñ•É…ÝU$¡±½ÑÑ•Éä¤ì4(€¥˜¡‘É…Ý¥¥ÑÌ¹±•¹Ñ ôôõµ…á1•¸¤ ‘É…Ý5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰ÍÕ•ÍÌˆù9Õµ‰•È½µÁ±•Ñ”¸I•Ù¥•Ü¥Ð°Ñ¡•¸Í…Ù”Ñ¡”‘É…ÜÉ•ÍÕ±Ð¸ð½‘¥Øøœì4)ô4)™Õ¹Ñ¥½¸É•Í•ÑÉ…Ü ¥í‘É…Ý¥¥ÑÌõmtì ‘É…Ý5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœœì ‘É…ÝI•ÍÕ±Ðœ¤¹Ñ•áÑ½¹Ñ•¹Ðôœœí½¹ÍÐ°õ±½ÑÌ¹™¥¹¡àôùà¹¥ôôô ‘É…Ý1½ÑÑ•ÉåM•±•Ðœ¤¹Ù…±Õ”¥ññ±½ÑÍlÁtíÉ•¹‘•É	…±±Ì ¤í¥˜¡°¥ÕÁ‘…Ñ•É…ÝU$¡°¥ô4)…Íå¹Œ™Õ¹Ñ¥½¸Í…Ù•É…Ü ¥ì4(€½¹ÍÐ±½ÑÑ•Éäõ±½ÑÌ¹™¥¹¡°ôù°¹¥ôôô ‘É…Ý1½ÑÑ•ÉåM•±•Ðœ¤¹Ù…±Õ”¥ññ±½ÑÍlÁtí¥˜ …±½ÑÑ•Éåññ‘É…Ý¥¥ÑÌ¹±•¹Ñ ôôôÀ¥É•ÑÕÉ¸ì4(€½¹ÍÐÉ•ÍÕ±Ðõ‘É…Ý¥¥ÑÌ¹©½¥¸ œœ¤í¥˜ …½¹™¥É´¡M…Ù”€‘íÉ•ÍÕ±Ñô…ÌÑ¡”‘É…ÜÉ•ÍÕ±Ð™½È€‘í±½ÑÑ•Éä¹¹…µ•ôý€¤¥É•ÑÕÉ¸ì4(€ÑÉåì4(€€€…Ý…¥ÐÕÁ‘…Ñ•½Œ¡‘½Œ¡‘ˆ°±½ÑÑ•É¥•Ìœ±±½ÑÑ•Éä¹¥¤±íÍÑ…ÑÕÌè‘É…Ý¸œ±‘É…Ý¹9Õµ‰•ÈéÉ•ÍÕ±Ð±‘É…Ý¥¥ÑÌ±‘É…Ý¹ÐéÍ•ÉÙ•ÉQ¥µ•ÍÑ…µÀ ¤±‘É…Ý¹	äé…ÕÑ ¹ÕÉÉ•¹ÑUÍ•È¹Õ¥‘ô¤ì4(€€€…Ý…¥Ð…‘‘½Œ¡½±±•Ñ¥½¸¡‘ˆ°…Õ‘¥Ñ1½Ìœ¤±í…Ñ¥½¸èÍ…Ù•É…ÝI•ÍÕ±Ðœ±±½ÑÑ•Éå%é±½ÑÑ•Éä¹¥±‘É…Ý¹9Õµ‰•ÈéÉ•ÍÕ±Ð±…‘µ¥¹%é…ÕÑ ¹ÕÉÉ•¹ÑUÍ•È¹Õ¥±É•…Ñ•‘ÐéÍ•ÉÙ•ÉQ¥µ•ÍÑ…µÀ ¥ô¤ì4(€€€±½ÑÑ•Éäõì¸¸¹±½ÑÑ•Éä±ÍÑ…ÑÕÌè‘É…Ý¸œ±‘É…Ý¹9Õµ‰•ÈéÉ•ÍÕ±Ð±‘É…Ý¥¥ÑÍôí±½ÑÌõ±½ÑÌ¹µ…À¡°ôù°¹¥ôôõ±½ÑÑ•Éä¹¥ý±½ÑÑ•Éäé°¤ì4(€€€€ ‘É…Ý5•ÍÍ…”œ¤¹¥¹¹•É!Q50ôœñ‘¥Ø±…ÍÌô‰ÍÕ•ÍÌˆûŠrÉ…ÜÉ•ÍÕ±ÐÍ…Ù•ÍÕ•ÍÍ™Õ±±ä¸ð½‘¥ØøœíÕÁ‘…Ñ•É…ÝU$¡±½ÑÑ•Éä¤í…Ý…¥ÐÉ•¹‘•É1½ÑÑ•É¥•Ì ¤í…Ý…¥ÐÉ•¹‘•ÉMÕµµ…Éå=Ù•ÉÙ¥•Ü ¤ì4(€õ…Ñ ¡”¥ì ‘É…Ý5•ÍÍ…”œ¤¹¥¹¹•É!Q50õ€ñ‘¥Ø±…ÍÌô‰•ÉÉ½Èˆø‘í•ÍŒ¡”¹µ•ÍÍ…”¥ôð½‘¥Øùô4)ô4