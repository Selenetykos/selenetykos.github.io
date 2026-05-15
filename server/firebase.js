const admin = require("firebase-admin");
require("dotenv").config();

// On récupère la clé secrète depuis les variables d'environnement
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
module.exports = { db };