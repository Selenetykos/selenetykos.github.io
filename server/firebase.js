const admin = require("firebase-admin");

// Cette ligne va lire la variable que tu as créée sur Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
module.exports = { db };
