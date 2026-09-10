import { initializeApp } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyC_D-mWZWEhEnfNbx99tmi8svD5smSkmq4",
  authDomain: "tigiray-lottery.firebaseapp.com",
  projectId: "tigiray-lottery",
  storageBucket: "tigiray-lottery.firebasestorage.app",
  messagingSenderId: "474510516322",
  appId: "1:474510516322:web:797adc0f38ff54c30ff13b"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
