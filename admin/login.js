import { auth } from '../firebase.js';
import { signInWithEmailAndPassword } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';

const form = document.getElementById('loginForm');
const emailInput = document.getElementById('email');
const passwordInput = document.getElementById('password');
const message = document.getElementById('message');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  message.innerHTML = '<p>Signing in…</p>';
  try {
    await signInWithEmailAndPassword(auth, emailInput.value.trim(), passwordInput.value);
    window.location.href = 'dashboard.html';
  } catch (err) {
    console.error(err);
    let text = 'Login failed. Check your email and password.';
    if (err.code === 'auth/invalid-credential') text = 'Incorrect email or password.';
    if (err.code === 'auth/too-many-requests') text = 'Too many attempts. Please wait and try again.';
    message.innerHTML = `<p class="error">${text}</p>`;
  }
});
