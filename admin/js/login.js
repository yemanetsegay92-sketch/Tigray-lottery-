import { auth, db } from '../../firebase.js';
import { signInWithEmailAndPassword, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';
import { doc, getDoc } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
const $=id=>document.getElementById(id);
const form=$('loginForm'),msg=$('message');
async function routeUser(u){
  const snap=await getDoc(doc(db,'users',u.uid));
  if(!snap.exists()) throw new Error('Your Firebase account has no admin profile yet.');
  const p=snap.data();
  if(p.role==='generalAdmin') location.href='general.html';
  else if(p.role==='lotteryAdmin') location.href='lottery.html';
  else throw new Error('This account is not assigned an admin role.');
}
onAuthStateChanged(auth, u=>{ if(u) routeUser(u).catch(e=>{console.error(e);}); });
form.addEventListener('submit',async e=>{e.preventDefault();msg.innerHTML='<div class="success">Signing in…</div>';try{const c=await signInWithEmailAndPassword(auth,$('email').value.trim(),$('password').value);await routeUser(c.user);}catch(err){console.error(err);msg.innerHTML=`<div class="error">${err.code==='auth/invalid-credential'?'Incorrect email or password.':err.message}</div>`;}});
