import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';

const firebaseConfig = {
  apiKey: 'AIzaSyC_D-mWZWEhEnfNbx99tmi8svD5smSkmq4',
  authDomain: 'tigiray-lottery.firebaseapp.com',
  projectId: 'tigiray-lottery',
  storageBucket: 'tigiray-lottery.firebasestorage.app',
  messagingSenderId: '474510516322',
  appId: '1:474510516322:web:797adc0f38ff54c30ff13b'
};

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Used only by General Admin to create a second Firebase Auth user
// without logging the current General Admin out.
export function createSecondaryAuth(name = `creator_${Date.now()}`) {
  const secondaryApp = initializeApp(firebaseConfig, name);
  return getAuth(secondaryApp);
}
