const express = require('express');
const path = require('path');
const cors = require('cors');
const { db } = require('./firebase');
const app = express();

// --- CONFIGURATION ---
app.use(cors());
app.use(express.json());

// Sert les fichiers statiques du dossier /public
app.use(express.static(path.join(__dirname, '../public')));

// Helper pour la clé de la semaine (ex: week_2026_20)
function getWeekKey() {
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((now - oneJan) / (24 * 60 * 60 * 1000));
    const week = Math.ceil((now.getDay() + 1 + numberOfDays) / 7);
    return `week_${now.getFullYear()}_${week}`;
}

// Helper pour Firestore (remplace les : par des tirets)
function keyToDocId(key) {
    return key ? key.replace(/:/g, '__COLON__') : "unknown_key";
}

// --- ROUTES API ---

// 1. Leaderboard Fusée (GET)
app.get('/api/leaderboard', async (req, res) => {
    try {
        const prefix = `score:${getWeekKey()}:`;
        const snapshot = await db.collection('storage').get();
        const scores = [];
        snapshot.forEach(d => {
            const data = d.data();
            if (data.key && data.key.startsWith(prefix)) {
                scores.push({
                    name: data.key.split(':').pop(),
                    score: data.value
                });
            }
        });
        scores.sort((a, b) => b.score - a.score);
        res.json(scores.slice(0, 10));
    } catch (e) {
        res.status(500).json([]);
    }
});

// 2. Sauvegarde de score (POST) - VERSION ANTI-UNDEFINED + WALLET POINTS
app.post(['/api/storage', '/api/save-score'], async (req, res) => {
    try {
        const b = req.body;
        
        // On cherche le pseudo partout où il pourrait être caché
        const finalName = b.name || b.pseudo || b.blaze || b.pseudoInput || b['pseudo-input'] || "PiloteAnonyme";
        
        // On cherche le score
        const finalValue = b.value !== undefined ? b.value : (b.score !== undefined ? b.score : 0);
        
        // On construit la clé
        const finalKey = b.key || `score:${getWeekKey()}:${finalName}`;

        // Sauvegarder le score
        await db.collection('storage').doc(keyToDocId(finalKey)).set({
            value: Number(finalValue),
            key: finalKey,
            shared: true,
            updatedAt: Date.now()
        });

        console.log(`Score enregistré : ${finalName} - ${finalValue}`);

        // Ajouter les points au wallet du joueur (toujours, même si pas record)
        const playerKey = `player:${finalName.toLowerCase()}`;
        const playerDoc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        let profile = playerDoc.exists ? playerDoc.data().value : null;
        
        if (profile) {
            try {
                profile = typeof profile === 'string' ? JSON.parse(profile) : profile;
                profile.wallet = (profile.wallet || 0) + Math.floor(Number(finalValue));
                profile.totalEarned = (profile.totalEarned || 0) + Math.floor(Number(finalValue));
                
                await db.collection('storage').doc(keyToDocId(playerKey)).set({
                    value: JSON.stringify(profile),
                    key: playerKey,
                    shared: false,
                    updatedAt: Date.now()
                });
                
                console.log(`Wallet mis à jour pour ${finalName}: ${profile.wallet} points`);
            } catch (e) {
                console.error("Erreur wallet update:", e.message);
            }
        }

        res.json({ success: true, savedAs: finalName, pointsAdded: Math.floor(Number(finalValue)) });
    } catch (e) {
        console.error("Erreur save:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 3. Récupération de profil (GET)
app.get('/api/storage', async (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "Clé manquante" });
    try {
        const doc = await db.collection('storage').doc(keyToDocId(key)).get();
        if (!doc.exists) return res.status(404).json({ error: "Non trouvé" });
        res.json(doc.data());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4. Leaderboard Tower Defense (GET)
app.get('/api/td-scores', async (req, res) => {
    try {
        const snapshot = await db.collection('scores_td').orderBy('score', 'desc').limit(8).get();
        res.json(snapshot.docs.map(doc => doc.data()));
    } catch (e) { res.status(500).json([]); }
});

// 5. Sauvegarde Tower Defense (POST)
app.post('/api/td-save-score', async (req, res) => {
    const { name, score, wave } = req.body;
    try {
        const existing = await db.collection('scores_td').where('name', '==', name).get();
        let bestPrev = -1;
        existing.forEach(d => { if(d.data().score > bestPrev) bestPrev = d.data().score; });
        if (bestPrev !== -1 && score <= bestPrev) return res.json({ isRecord: false, best: bestPrev });

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

// --- REDIRECTION FINALE ---
// Si aucune route n'a matché, on renvoie l'index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// --- LANCEMENT ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur Selenetykos ON (Port ${PORT})`);
});
