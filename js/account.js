import {auth} from '../firebase.js';
import {RecaptchaVerifier,signInWithPhoneNumber,signInWithCustomToken,onAuthStateChanged,signOut} from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import {phoneAuthErrorMessage} from './phoneAuthErrors.mjs';
const $=id=>document.getElementById(id),esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let confirmation=null,afroChallengeId=null;
let walletCapabilities={registration:false,deposits:false,purchases:false,afroOtp:false};
auth.useDeviceLanguage();
function normalizePhone(value){const digits=String(value||'').replace(/\D/g,'');if(/^0[79]\d{8}$/.test(digits))return '+251'+digits.slice(1);if(/^251[79]\d{8}$/.test(digits))return '+'+digits;throw new Error('Enter a valid Ethiopian mobile number (09 or 07).');}
async function loadCapabilities(){
 try{
  const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'wallet-status'})});
  const data=await response.json();if(!response.ok||!data.ok)throw new Error('Status unavailable');
  walletCapabilities={registration:data.capabilities?.registration===true,deposits:data.capabilities?.deposits===true,purchases:data.capabilities?.purchases===true,afroOtp:data.capabilities?.afroOtp===true};
 }catch{walletCapabilities={registration:false,deposits:false,purchases:false,afroOtp:false};}
 $('afroOtpOption').hidden=!walletCapabilities.afroOtp;
 $('sendAfroCode').disabled=!walletCapabilities.afroOtp;
 $('registerWallet').disabled=!walletCapabilities.registration;
 $('depositAmount').disabled=!walletCapabilities.deposits;$('depositReference').disabled=!walletCapabilities.deposits;
 $('submitDeposit').disabled=!walletCapabilities.deposits;$('submitDeposit').textContent=walletCapabilities.deposits?'Submit deposit':'Deposits unavailable';
 $('depositAvailability').textContent=walletCapabilities.deposits?'Deposits are open. Use only the official receiving account shown by Tigray Lottery.':'Wallet deposits are not yet available. The official receiving account and ownership checks must be verified first.';
}
async function api(action,body={}){const token=await auth.currentUser.getIdToken();const response=await fetch('/api/customer/create-request',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify({action,...body})});const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Wallet request failed.');return data;}
function message(text,error=false){$('walletMessage').innerHTML=`<div class="${error?'error':'success'}">${esc(text)}</div>`;}
async function refresh(){try{const data=await api('wallet-summary');$('registration').hidden=true;$('walletDashboard').hidden=false;$('walletBalance').textContent=(Number(data.balanceSantim)/100).toFixed(2)+' ETB';$('walletActivity').innerHTML=[...data.deposits.map(x=>`<p>Deposit ${esc(x.reference)} · ${(Number(x.amountSantim)/100).toFixed(2)} ETB · ${esc(x.status)}</p>`),...data.ledger.map(x=>`<p>${esc(x.type)} · ${(Number(x.amountSantim)/100).toFixed(2)} ETB</p>`)].join('')||'<p class="form-note">No activity yet.</p>';}catch(error){if(/Register/.test(error.message)){$('registration').hidden=false;$('walletDashboard').hidden=true;}else message(error.message,true);}}
onAuthStateChanged(auth,async current=>{
 const hasPhone=!!current?.phoneNumber;
 $('signedOut').hidden=hasPhone;
 if(!hasPhone){
  $('registration').hidden=true;
  $('walletDashboard').hidden=true;
  if(current)message('This session is not phone-verified. Enter your phone number to continue.');
  return;
 }
 await refresh();
});
$('sendCode').addEventListener('click',async()=>{const button=$('sendCode');try{button.disabled=true;if(!window.walletRecaptcha)window.walletRecaptcha=new RecaptchaVerifier(auth,'recaptcha',{});confirmation=await signInWithPhoneNumber(auth,normalizePhone($('walletPhone').value),window.walletRecaptcha);$('confirmCode').disabled=false;message('Verification code sent.');}catch(error){confirmation=null;$('confirmCode').disabled=true;window.walletRecaptcha?.clear();window.walletRecaptcha=null;message(phoneAuthErrorMessage(error),true);}finally{button.disabled=false;}});
// Alternative OTP uses the same Firebase project, but never puts the
// AfroMessage credential or the provider's verificationId in the browser.
async function afroApi(action,body){
 const response=await fetch('/api/customer/create-request',{method:'POST',
  headers:{'content-type':'application/json'},body:JSON.stringify({action,...body})});
 const data=await response.json().catch(()=>({}));
 if(!response.ok||!data.ok)throw new Error(data.error||'SMS verification is temporarily unavailable.');
 return data;
}
$('sendAfroCode').addEventListener('click',async()=>{
 const button=$('sendAfroCode');
 try{
  button.disabled=true;afroChallengeId=null;$('verifyAfroCode').disabled=true;
  const data=await afroApi('afro-otp-start',{phone:normalizePhone($('walletPhone').value)});
  afroChallengeId=data.challengeId;
  $('verifyAfroCode').disabled=false;
  message('SMS request accepted. Enter the code delivered to your phone.');
 }catch(error){message(error.message,true)}
 finally{button.disabled=!walletCapabilities.afroOtp;}
});
$('verifyAfroCode').addEventListener('click',async()=>{
 const button=$('verifyAfroCode');
 try{
  if(!afroChallengeId)throw new Error('Request a verification code first.');
  button.disabled=true;
  const data=await afroApi('afro-otp-verify',{challengeId:afroChallengeId,
   code:$('verificationCode').value.trim()});
  afroChallengeId=null;
  // Firebase issues its normal ID token with this phone-linked account's UID.
  await signInWithCustomToken(auth,data.customToken);
  message('Phone verified. Complete free registration.');
 }catch(error){message(error.message,true)}
 finally{button.disabled=!afroChallengeId;}
});
$('confirmCode').addEventListener('click',async()=>{try{if(!confirmation)throw new Error('Send a verification code first.');await confirmation.confirm($('verificationCode').value.trim());message('Phone verified. Complete free registration.');}catch(error){message(error.message==='Send a verification code first.'?error.message:phoneAuthErrorMessage(error),true);}});
$('registerWallet').addEventListener('click',async()=>{try{await api('wallet-register',{name:$('walletName').value.trim()});message('Wallet created.');await refresh();}catch(error){message(error.message,true);}});
$('submitDeposit').addEventListener('click',async()=>{try{if(!walletCapabilities.deposits)throw new Error('Wallet deposits are not yet available.');const data=await api('wallet-deposit',{amountEtb:$('depositAmount').value,reference:$('depositReference').value.trim(),legalName:$('walletName').value.trim()});message(data.message||'Deposit submitted.');await refresh();}catch(error){message(error.message,true);}});
$('walletSignOut').addEventListener('click',()=>signOut(auth));
loadCapabilities();
