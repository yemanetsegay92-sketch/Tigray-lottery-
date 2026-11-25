import {auth} from '../firebase.js';
import {RecaptchaVerifier,signInWithPhoneNumber,onAuthStateChanged,signOut,createUserWithEmailAndPassword,signInWithEmailAndPassword,sendEmailVerification,sendPasswordResetEmail,updateProfile} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {phoneAuthErrorMessage} from './phoneAuthErrors.mjs';
import {emailAuthErrorMessage} from './emailAuthErrors.mjs';
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let confirmation=null;
let walletCapabilities={registration:false,deposits:false,purchases:false,receiver:{configured:false}};
auth.useDeviceLanguage();
function normalizePhone(value){const digits=String(value||'').replace(/\D/g,'');if(/^0[79]\d{8}$/.test(digits))return '+251'+digits.slice(1);if(/^251[79]\d{8}$/.test(digits))return '+'+digits;throw new Error('Enter a valid Ethiopian mobile number (09 or 07).');}
function localPhone(value){return normalizePhone(value).replace('+251','0');}
function message(text,error=false){$('walletMessage').innerHTML=`<div class="${error?'error':'success'}">${esc(text)}</div>`;}
function pendingProfile(){try{return JSON.parse(sessionStorage.getItem('walletPendingProfile')||'{}');}catch{return {};}}
function rememberProfile(name,phone){sessionStorage.setItem('walletPendingProfile',JSON.stringify({name,phone}));}
async function loadCapabilities(){
 try{
  const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'wallet-status'})});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error('Status unavailable');
  walletCapabilities={registration:data.capabilities?.registration===true,deposits:data.capabilities?.deposits===true,purchases:data.capabilities?.purchases===true,receiver:data.receivingAccount||{configured:false}};
 }catch{walletCapabilities={registration:false,deposits:false,purchases:false,receiver:{configured:false}};}
 $('registerWallet').disabled=!walletCapabilities.registration;
 const receiver=walletCapabilities.receiver,configured=receiver.configured===true;
 $('walletReceivingAccount').hidden=!configured;
 if(configured){$('walletReceiverNumber').textContent=receiver.account;$('walletReceiverHolder').textContent=receiver.holderName;}
 const depositOpen=walletCapabilities.deposits&&configured;
 $('depositAmount').disabled=!depositOpen;$('depositReference').disabled=!depositOpen;$('submitDeposit').disabled=!depositOpen;
 $('submitDeposit').textContent=depositOpen?'Submit deposit':'Deposits unavailable';
 $('depositAvailability').textContent=depositOpen?'Send funds only to the official account shown here, then submit the CBE reference.':'Wallet deposits are unavailable until the official CBE receiving account is configured and deposit controls are authorized.';
}
async function api(action,body={}){const token=await auth.currentUser.getIdToken();const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action,...body})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Wallet request failed.');return data;}
async function refresh(){try{const data=await api('wallet-summary');$('registration').hidden=true;$('walletDashboard').hidden=false;$('walletBalance').textContent=(Number(data.balanceSantim)/100).toFixed(2)+' ETB';$('walletActivity').innerHTML=[...data.deposits.map(x=>`<p>Deposit ${esc(x.reference)} · ${(Number(x.amountSantim)/100).toFixed(2)} ETB · ${esc(x.status)}</p>`),...data.ledger.map(x=>`<p>${esc(x.type)} · ${(Number(x.amountSantim)/100).toFixed(2)} ETB</p>`)].join('')||'<p class="form-note">No activity yet.</p>';}catch(error){if(/Register/i.test(error.message)){$('registration').hidden=false;$('walletDashboard').hidden=true;}else message(error.message,true);}}
function showVerifiedCustomer(current){
 $('signedOut').hidden=true;$('verifyEmail').hidden=true;
 const saved=pendingProfile();$('walletName').value=$('walletName').value||saved.name||current.displayName||'';
 if(current.phoneNumber){$('walletContactPhone').value=current.phoneNumber.replace('+251','0');$('walletContactPhoneLabel').hidden=true;}
 else{$('walletContactPhone').value=$('walletContactPhone').value||saved.phone||'';$('walletContactPhoneLabel').hidden=false;}
 void refresh();
}
onAuthStateChanged(auth,current=>{
 const verified=!!current?.phoneNumber||current?.emailVerified===true;
 if(!current){$('signedOut').hidden=false;$('verifyEmail').hidden=true;$('registration').hidden=true;$('walletDashboard').hidden=true;return;}
 if(!verified){$('signedOut').hidden=true;$('registration').hidden=true;$('walletDashboard').hidden=true;$('verifyEmail').hidden=false;$('verificationEmail').textContent=current.email||'';return;}
 showVerifiedCustomer(current);
});
$('emailRegisterForm').addEventListener('submit',async event=>{event.preventDefault();try{const name=$('emailFullName').value.trim(),phone=localPhone($('emailContactPhone').value);rememberProfile(name,phone);const credential=await createUserWithEmailAndPassword(auth,$('registerEmail').value.trim(),$('registerPassword').value);await updateProfile(credential.user,{displayName:name});await sendEmailVerification(credential.user,{url:location.origin+'/account.html'});message('Verification link sent. Check your email before creating the wallet.');}catch(error){message(emailAuthErrorMessage(error),true);}});
$('emailLoginForm').addEventListener('submit',async event=>{event.preventDefault();try{const credential=await signInWithEmailAndPassword(auth,$('loginEmail').value.trim(),$('loginPassword').value);if(!credential.user.emailVerified)message('Verify your email before creating or opening a wallet.',true);else{showVerifiedCustomer(credential.user);message('Signed in.');}}catch(error){message(emailAuthErrorMessage(error),true);}});
$('forgotPassword').addEventListener('click',async()=>{const email=$('loginEmail').value.trim()||$('registerEmail').value.trim();try{if(!email)throw new Error('Enter your email address first.');await sendPasswordResetEmail(auth,email,{url:location.origin+'/account.html'});message('Password reset email sent if the account exists.');}catch(error){message(error.message==='Enter your email address first.'?error.message:emailAuthErrorMessage(error),true);}});
$('checkEmailVerification').addEventListener('click',async()=>{try{await auth.currentUser.reload();await auth.currentUser.getIdToken(true);if(!auth.currentUser.emailVerified)throw new Error('Email is not verified yet. Open the link and try again.');showVerifiedCustomer(auth.currentUser);message('Email verified. You can now create your wallet.');}catch(error){message(error.message,true);}});
$('resendEmailVerification').addEventListener('click',async()=>{try{await sendEmailVerification(auth.currentUser,{url:location.origin+'/account.html'});message('A new verification link was sent.');}catch(error){message(emailAuthErrorMessage(error),true);}});
$('verificationSignOut').addEventListener('click',()=>signOut(auth));
$('sendCode').addEventListener('click',async()=>{const button=$('sendCode');try{button.disabled=true;if(!window.walletRecaptcha)window.walletRecaptcha=new RecaptchaVerifier(auth,'recaptcha',{});confirmation=await signInWithPhoneNumber(auth,normalizePhone($('walletPhone').value),window.walletRecaptcha);$('confirmCode').disabled=false;message('Verification code sent.');}catch(error){confirmation=null;$('confirmCode').disabled=true;window.walletRecaptcha?.clear();window.walletRecaptcha=null;message(phoneAuthErrorMessage(error),true);}finally{button.disabled=false;}});
$('confirmCode').addEventListener('click',async()=>{try{if(!confirmation)throw new Error('Send a verification code first.');await confirmation.confirm($('verificationCode').value.trim());message('Phone verified. Complete free registration.');}catch(error){message(error.message==='Send a verification code first.'?error.message:phoneAuthErrorMessage(error),true);}});
$('registerWallet').addEventListener('click',async()=>{try{const contactPhone=auth.currentUser.phoneNumber?'':localPhone($('walletContactPhone').value);await api('wallet-register',{name:$('walletName').value.trim(),contactPhone});sessionStorage.removeItem('walletPendingProfile');message('Wallet created with a 0.00 ETB balance.');await refresh();}catch(error){message(error.message,true);}});
$('submitDeposit').addEventListener('click',async()=>{try{if(!walletCapabilities.deposits||!walletCapabilities.receiver?.configured)throw new Error('Wallet deposits are not available.');const data=await api('wallet-deposit',{amountEtb:$('depositAmount').value,reference:$('depositReference').value.trim(),legalName:$('walletName').value.trim()});message(data.message||'Deposit submitted.');await refresh();}catch(error){message(error.message,true);}});
$('copyWalletAccount').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(String(walletCapabilities.receiver.account||''));message('CBE account number copied.');}catch{message('Could not copy automatically. Select and copy the account number.',true);}});
$('walletSignOut').addEventListener('click',()=>signOut(auth));
loadCapabilities();
