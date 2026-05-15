const express = require('express');
const path = require('path');
const cors = require('cors');
const { db } = require('./firebase'); // Importe la config de firebase.js
const app = express();

// --- CONFIGURATION ---
app.use(cors());
app.use(express.json());

// Sert tous les fichiers du dossier /public (index.html, boutique, images, js...)
app.use(express.static(path.join(__dirname, '../public')));

// Helper pour calculer la clé de la semaine (format: week_2024_45)
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

// Récupérer une donnée spécifique
app.get('/api/storage', async (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "Clé manquante" });
    try {
        const doc = await db.collection('storage').doc(keyToDocId(key)).get();
        if (!doc.exists) return res.status(404).json({ error: "Non trouvé" });
        res.json(doc.data());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sauvegarder une donnée
app.post('/api/storage', async (req, res) => {
    const { key, value, shared } = req.body;
    try {
        await db.collection('storage').doc(keyToDocId(key)).set({
            value, key, shared, updatedAt: Date.now()
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lister les clés (pour le leaderboard Rocket hebdomadaire)
app.get('/api/storage/list', async (req, res) => {
    const { prefix } = req.query;
    try {
        const snapshot = await db.collection('storage').get();
        const keys = [];
        snapshot.forEach(d => {
            const originalKey = d.data().key;
            if (originalKey && originalKey.startsWith(prefix)) {
                keys.push(originalKey);
            }
        });
        res.json({ keys });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supprimer une clé
app.delete('/api/storage', async (req, res) => {
    const { key } = req.query;
    try {
        await db.collection('storage').doc(keyToDocId(key)).delete();
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// --- ROUTES API : TOWER DEFENSE (Scores Classiques) ---

// Récupérer le leaderboard TD
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

// Sauvegarder un score TD (avec vérification de record)
app.post('/api/td-save-score', async (req, res) => {
    const { name, score, wave } = req.body;
    try {
        const existing = await db.collection('scores_td').where('name', '==', name).get();
        let bestPrev = -1;
        existing.forEach(d => { if(d.data().score > bestPrev) bestPrev = d.data().score; });

        // Si le nouveau score n'est pas meilleur, on refuse
        if (bestPrev !== -1 && score <= bestPrev) {
            return res.json({ isRecord: false, best: bestPrev });
        }

        // Sinon, on nettoie les anciens scores de ce joueur
        const batch = db.batch();
        existing.forEach(d => batch.delete(d.ref));
        await batch.commit();

        // Et on ajoute le nouveau record
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

// Si l'utilisateur tape une URL qui n'existe pas, on renvoie l'index
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
    Mode    : Anti-Blocage Scolaire
    Statut  : Prêt à recevoir des requêtes
    ===========================================
    `);
});