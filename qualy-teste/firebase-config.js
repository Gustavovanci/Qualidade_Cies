// firebase-config.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-database.js";

// MESMA CONFIG QUE VOCÊ JÁ ESTÁ USANDO
const firebaseConfig = {
  apiKey: "AIzaSyC83yVn1KPosgCDtOnvBpVmfdqJSkPlots",
  authDomain: "qflow-glass.firebaseapp.com",
  databaseURL: "https://qflow-glass-default-rtdb.firebaseio.com",
  projectId: "qflow-glass",
  storageBucket: "qflow-glass.firebasestorage.app",
  messagingSenderId: "841998306234",
  appId: "1:841998306234:web:1087a998bd2be099e66b83"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { app, auth, db };
