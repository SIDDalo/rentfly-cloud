require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");
const WebSocket = require("ws");
const path = require("path");

// 1. Cliente de Supabase (PostgreSQL)
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || ""
).trim();

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Faltan variables de entorno de Supabase.");
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  realtime: {
    transport: WebSocket,
  },
});

// 2. Cliente de Firebase Admin (Firestore: Nube via env var o Local via JSON)
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");
  serviceAccount = require(serviceAccountPath);
}

const firebaseApp =
  getApps().length === 0
    ? initializeApp({
        credential: cert(serviceAccount),
        projectId: process.env.FIREBASE_PROJECT_ID || serviceAccount.project_id,
      })
    : getApps()[0];

const dbFirestore = getFirestore(firebaseApp);

module.exports = { supabase, dbFirestore };