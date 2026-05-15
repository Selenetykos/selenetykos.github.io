const express = require('express');
const path = require('path');
const cors = require('cors');
const { db } = require('./firebase');
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

function getWeekKey() {
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((now - oneJan) / (24 * 60 * 60 * 1000));
    const week = Math.ceil((now.getDay() + 1 + numberOfDays) / 7);
    return `week_${now.getFullYear()}_${week}`;
}

function keyToDocId(key) {
    return key.replace(/:/g, '__COLON__');
}

// --- ROUTES POUR LA FUSÉE (ROCKET) ---

// Route pour l'historique/leaderboard
app.get('/api/leaderboard', async (req, res) => {
    try {
        const prefix = `score:${getWeekKey()}:`;
        const snapshot = await db.collection('storage').get();
        const scores = [];
        snapshot.forEach(d => {
            const data = d.data();
            if (data.key && data.key.startsWith(prefix)) {
                scores.push({ name: data.key.split(':').pop(), score: data.value });
            }
        });
        scores.sort((a, b) => b.score - a.score);
        res.json(scores.slice(0, 10));
    } catch (e) { res.status(500).json([]); }
});

// Route générique de sauvegarde (Storage)
app.post(['/api/storage', '/api/save-score'], async (req, res) => {
    const { key, value, shared } = req.body;
    // Si le jeu envoie juste name et score (format simple)
    const finalKey = key || `score:${getWeekKey()}:${req.body.name}`;
    const finalValue = value !== undefined ? value : req.body.score;

    try {
        await db.collection('storage').doc(keyToDocId(finalKey)).set({
            value: finalValue,
            key: finalKey,
            shared: shared || true,
            updatedAt: Date.now()
        });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Récupération de profil ou score
app.get('/api/storage', async (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "Clé manquante" });
    try {
        const doc = await db.collection('storage').doc(keyToDocId(key)).get();
        if (!doc.exists) return res.status(404).json({ error: "Non trouvé" });
        res.json(doc.data());
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ROUTES TOWER DEFENSE ---

app.get('/api/td-scores', async (req, res) => {
    try {
        const snapshot = await db.collection('scores_td').orderBy('score', 'desc').limit(8).get();
        res.json(snapshot.docs.map(doc => doc.data()));
    } catch (e) { res.status(500).json([]); }
});

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

        await db.collection('scores_td').add({ name, score: Math.floor(score), wave: wave || 0, date: Date.now() });
        res.json({ success: true, isRecord: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- ROUTE DE SECOURS (DOIT RESTER EN DERNIER) ---
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => { console.log(`Serveur prêt sur le port ${PORT}`); });
