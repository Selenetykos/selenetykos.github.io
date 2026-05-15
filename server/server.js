const express = require('express');
const path = require('path');
const cors = require('cors');
const { db } = require('./firebase'); // Importe la config de firebase.js
const app = express();

// --- CONFIGURATION ---
app.use(cors());
app.use(express.json());

// Sert tous les fichiers du dossier /public (index.html, boutique, images, js...)
// Note : Vérifie bien que ton dossier s'appelle "public" sur GitHub (minuscules)
app.use(express.static(path.join(__dirname, '../public')));

// Helper pour calculer la clé de la semaine (format: week_2026_20)
function getWeekKey() {
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((now - oneJan) / (24 * 60 * 60 * 1000));
    const week = Math.ceil((now.getDay() + 1 + numberOfDays) / 7);
    return `week_${now.getFullYear()}_${week}`;
}

// Helper pour transformer les clés ":" en format compatible Firestore
function keyToDocId(key) {
    return key.replace(/:/g, '__COLON__');
}

// --- ROUTES API : SYSTEME STORAGE (Rocket Game & Compatibilité) ---

// 1. Récupérer le leaderboard (La route qui manquait et causait l'erreur JSON !)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const prefix = `score:${getWeekKey()}:`;
        const snapshot = await db.collection('storage').get();
        const scores = [];
        
        snapshot.forEach(d => {
            const data = d.data();
            // On vérifie si la clé commence par le score de la semaine actuelle
            if (data.key && data.key.startsWith(prefix)) {
                scores.push({
                    name: data.key.split(':').pop(),
                    score: data.value
                });
            }
        });

        // Tri décroissant (plus gros score en premier)
        scores.sort((a, b) => b.score - a.score);
        
        // On renvoie les 10 meilleurs
        res.json(scores.slice(0, 10));
    } catch (e) {
        console.error("Erreur API Leaderboard:", e);
        res.status(500).json([]); // Renvoie un tableau vide pour éviter de faire planter le JS client
    }
});

// 2. Récupérer une donnée spécifique (ex: profil joueur)
app.get('/api/storage', async (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "Clé manquante" });
    try {
        const doc = await db.collection('storage').doc(keyToDocId(key)).get();
        if (!doc.exists) return res.status(404).json({ error: "Non trouvé" });
        res.json(doc.data());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3. Sauvegarder une donnée
app.post('/api/storage', async (req, res) => {
    const { key, value, shared } = req.body;
    try {
        await db.collection('storage').doc(keyToDocId(key)).set({
            value, key, shared, updatedAt: Date.now()
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Lister les clés (Utile pour certaines fonctions de reset)
app.get('/api/storage/list', async (req, res) => {
    const { prefix } = req.query;
    try {
        const snapshot = await db.collection('storage').get();
        const keysList = [];
        snapshot.forEach(d => {
            const originalKey = d.data().key;
            if (originalKey && originalKey.startsWith(prefix)) {
                keysList.push(originalKey);
            }
        });
        res.json({ keys: keysList });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 5. Supprimer une clé
app.delete('/api/storage', async (req, res) => {
    const { key } = req.query;
    try {
        await db.collection('storage').doc(keyToDocId(key)).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- ROUTES API : TOWER DEFENSE ---

app.get('/api/td-scores', async (req, res) => {
    try {
        const snapshot = await db.collection('scores_td')
            .orderBy('score', 'desc')
            .limit(8)
            .get();
        const scores = snapshot.docs.map(doc => doc.data());
        res.json(scores);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/td-save-score', async (req, res) => {
    const { name, score, wave } = req.body;
    try {
        const existing = await db.collection('scores_td').where('name', '==', name).get();
        let bestPrev = -1;
        existing.forEach(d => { if(d.data().score > bestPrev) bestPrev = d.data().score; });

        if (bestPrev !== -1 && score <= bestPrev) {
            return res.json({ isRecord: false, best: bestPrev });
        }

        const batch = db.batch();
        existing.forEach(d => batch.delete(d.ref));
        await batch.commit();

        await db.collection('scores_td').add({
            name,
            score: Math.floor(score),
            wave: wave || 0,
            date: Date.now()
        });

        res.json({ success: true, isRecord: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- GESTION DES PAGES HTML ---

// IMPORTANT : Cette route doit rester EN DERNIER. 
// Elle renvoie l'index si aucune route API n'a été trouvée.
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// --- LANCEMENT ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    ===========================================
    🚀 SERVEUR PROXY SELENETYKOS ACTIF
    Port    : ${PORT}
    Statut  : Prêt pour le réseau scolaire
    ===========================================
    `);
});
