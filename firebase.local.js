import { initializeApp, getApps, getApp } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js';

const allowedHosts=new Set(['127.0.0.1','localhost']);
if(!allowedHosts.has(location.hostname))throw new Error('Local Firebase configuration refuses non-local hosts.');
const health=await fetch('/__local/health',{cache:'no-store'});
if(!health.ok)throw new Error('Both Firebase emulators must be available before this page can start.');
const status=await health.json();
if(status.projectId!=='demo-tigray-wallet'||status.firestore!==true||status.auth!==true)
 throw new Error('Local emulator identity check failed.');

const firebaseConfig={
 apiKey:'demo-tigray-wallet-local-only',authDomain:'demo-tigray-wallet.localhost',
 projectId:'demo-tigray-wallet',storageBucket:'demo-tigray-wallet.localhost',
 messagingSenderId:'000000000000',appId:'1:000000000000:web:localwallet'
};
const app=getApps().length?getApp():initializeApp(firebaseConfig);
export const db=getFirestore(app);
export const auth=getAuth(app);
connectFirestoreEmulator(db,'127.0.0.1',8080);
connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});

export function createSecondaryAuth(name=`local_creator_${Date.now()}`){
 const secondary=initializeApp(firebaseConfig,name),secondaryAuth=getAuth(secondary);
 connectAuthEmulator(secondaryAuth,'http://127.0.0.1:9099',{disableWarnings:true});
 return secondaryAuth;
}
