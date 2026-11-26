const express = require('express');
const path = require('path');
const cors = require('cors');
const { db } = require('./firebase');
const crypto = require('crypto');
const app = express();

// --- CONFIGURATION ---
app.use(cors());
app.use(express.json());

// Session storage (en mémoire)
const sessions = new Map();

// Helper pour la clé de la semaine (ex: week_2026_20)
function getWeekKey() {
    const now = new Date();
    const oneJan = new Date(now.getFullYear(), 0, 1);
    const numberOfDays = Math.floor((now - oneJan) / (24 * 60 * 60 * 1000));
    const week = Math.ceil((now.getDay() + 1 + numberOfDays) / 7);
    return `week_${now.getFullYear()}_${week}`;
}

// Helper pour Firestore (remplace les caractères spéciaux)
function keyToDocId(key) {
    return key ? key.replace(/:/g, '__COLON__') : "unknown_key";
}

// Helper pour hasher le code secret
function hashSecret(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
}

// Helper pour générer un token de session
function generateSessionToken() {
    return crypto.randomBytes(32).toString('hex');
}

// Helper pour normaliser les pseudos
function normalizePseudo(pseudo) {
    return pseudo.toLowerCase().trim();
}

// Helper pour valider et sécuriser un profil joueur
function validateAndSecureProfile(profile) {
    if (!profile || typeof profile !== 'object') {
        console.error('Profil invalide:', profile);
        return null;
    }

    profile.wallet = Math.floor(Number(profile.wallet) || 0);
    profile.totalEarned = Math.floor(Number(profile.totalEarned) || 0);
    profile.bestScore = Math.floor(Number(profile.bestScore) || 0);

    if (!Array.isArray(profile.ownedSkins)) profile.ownedSkins = ['classic'];
    if (!Array.isArray(profile.ownedRocketSkins)) profile.ownedRocketSkins = ['r_classic'];
    if (!Array.isArray(profile.ownedMusic)) profile.ownedMusic = ['m_rocket_default', 'm_td_default'];

    profile.activeSkin = profile.activeSkin || 'classic';
    profile.activeRocketSkin = profile.activeRocketSkin || 'r_classic';
    profile.activeRocketMusic = profile.activeRocketMusic || 'm_rocket_default';
    profile.activeTDMusic = profile.activeTDMusic || 'm_td_default';

    if (!profile.creditedScores || typeof profile.creditedScores !== 'object') {
        profile.creditedScores = {};
    }

    if (Number.isNaN(profile.wallet) || Number.isNaN(profile.totalEarned) || Number.isNaN(profile.bestScore)) {
        console.error('Profil contient des NaN après sécurisation:', profile);
        return null;
    }

    return profile;
}

// Helper pour sauvegarder un profil dans Firestore
async function saveProfileToFirestore(pseudo, profile) {
    const playerKey = `player:${normalizePseudo(pseudo)}`;
    const validated = validateAndSecureProfile(profile);
    if (!validated) throw new Error('Validation du profil échouée');
    await db.collection('storage').doc(keyToDocId(playerKey)).set({
        value: JSON.stringify(validated),
        key: playerKey,
        shared: false,
        updatedAt: Date.now()
    });
    return validated;
}

// Helper pour lire un profil depuis Firestore
async function loadProfileFromFirestore(pseudo) {
    const playerKey = `player:${normalizePseudo(pseudo)}`;
    const doc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
    if (!doc.exists) return null;
    const raw = doc.data().value;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

// Middleware d'authentification
function requireAuth(req, res, next) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: "Token manquant" });
    const session = sessions.get(token);
    if (!session) return res.status(401).json({ error: "Session invalide ou expirée" });
    req.session = session;
    next();
}

// --- ROUTES AUTH ---

// POST /api/register
app.post('/api/register', async (req, res) => {
    try {
        const { pseudo, pin } = req.body;
        if (!pseudo || !pin) return res.status(400).json({ error: "Pseudo et code secret requis" });

        const normalizedPseudo = normalizePseudo(pseudo);
        const playerKey = `player:${normalizedPseudo}`;

        const existingDoc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        if (existingDoc.exists) return res.status(409).json({ error: "Ce pseudo existe déjà" });

        const newProfile = {
            name: pseudo,
            pin: hashSecret(pin),
            wallet: 0,
            totalEarned: 0,
            bestScore: 0,
            creditedScores: {},
            ownedSkins: ['classic'],
            activeSkin: 'classic',
            ownedRocketSkins: ['r_classic'],
            activeRocketSkin: 'r_classic',
            ownedMusic: ['m_rocket_default', 'm_td_default'],
            activeRocketMusic: 'm_rocket_default',
            activeTDMusic: 'm_td_default',
            createdAt: Date.now()
        };

        const validated = await saveProfileToFirestore(pseudo, newProfile);

        const sessionToken = generateSessionToken();
        sessions.set(sessionToken, { pseudo: normalizedPseudo, name: pseudo, createdAt: Date.now() });

        console.log(`[REGISTER] Compte créé : ${normalizedPseudo}`);
        res.json({ success: true, token: sessionToken, profile: { ...validated, pin: undefined } });
    } catch (e) {
        console.error("Erreur register:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/login
app.post('/api/login', async (req, res) => {
    try {
        const { pseudo, pin } = req.body;
        if (!pseudo || !pin) return res.status(400).json({ error: "Pseudo et code secret requis" });

        const normalizedPseudo = normalizePseudo(pseudo);
        const profile = await loadProfileFromFirestore(normalizedPseudo);
        if (!profile) return res.status(404).json({ error: "Compte introuvable" });

        if (profile.pin !== hashSecret(pin)) return res.status(401).json({ error: "Code secret incorrect" });

        const sessionToken = generateSessionToken();
        sessions.set(sessionToken, { pseudo: normalizedPseudo, name: profile.name, createdAt: Date.now() });

        console.log(`[LOGIN] Connexion : ${normalizedPseudo}`);
        res.json({ success: true, token: sessionToken, profile: { ...profile, pin: undefined } });
    } catch (e) {
        console.error("Erreur login:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/profile
app.get('/api/profile', requireAuth, async (req, res) => {
    try {
        const profile = await loadProfileFromFirestore(req.session.pseudo);
        if (!profile) return res.status(404).json({ error: "Profil introuvable" });
        res.json({ success: true, profile: { ...profile, pin: undefined } });
    } catch (e) {
        console.error("Erreur profile:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// POST /api/logout
app.post('/api/logout', async (req, res) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token) sessions.delete(token);
    res.json({ success: true });
});

// POST /api/profile/update — mise à jour générale (skins, musique, etc.)
app.post('/api/profile/update', requireAuth, async (req, res) => {
    try {
        const updates = req.body;
        const profile = await loadProfileFromFirestore(req.session.pseudo);
        if (!profile) return res.status(404).json({ error: "Profil introuvable" });

        // Champs interdits côté client (calculés côté serveur uniquement)
        delete updates.wallet;
        delete updates.totalEarned;
        delete updates.bestScore;
        delete updates.creditedScores;
        delete updates.createdAt;

        const updatedProfile = { ...profile, ...updates };
        if (updates.pin) updatedProfile.pin = hashSecret(updates.pin);

        const validated = await saveProfileToFirestore(req.session.pseudo, updatedProfile);
        console.log(`[PROFILE UPDATE] ${req.session.pseudo}`);
        res.json({ success: true, profile: { ...validated, pin: undefined } });
    } catch (e) {
        console.error("Erreur profile update:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- ROUTE POINTS BOUTIQUE ---
// POST /api/credit-points — crédite des points sur le wallet (appelé par le frontend après une partie)
// Gère la déduplication via creditedScores[runKey]
app.post('/api/credit-points', requireAuth, async (req, res) => {
    try {
        const { runKey, points, bestScore } = req.body;

        if (!runKey || typeof points !== 'number' || points < 0) {
            return res.status(400).json({ error: "runKey et points valides requis" });
        }

        const profile = await loadProfileFromFirestore(req.session.pseudo);
        if (!profile) return res.status(404).json({ error: "Profil introuvable" });

        // Déduplication : cette run a-t-elle déjà été créditée ?
        profile.creditedScores = profile.creditedScores || {};
        if (profile.creditedScores[runKey]) {
            return res.json({ success: true, credited: 0, reason: 'Points déjà crédités pour cette partie.', profile: { ...profile, pin: undefined } });
        }

        const pointsToAdd = Math.floor(points);
        profile.creditedScores[runKey] = pointsToAdd;
        profile.wallet = Math.floor(profile.wallet || 0) + pointsToAdd;
        profile.totalEarned = Math.floor(profile.totalEarned || 0) + pointsToAdd;

        if (bestScore !== undefined) {
            profile.bestScore = Math.max(Math.floor(profile.bestScore || 0), Math.floor(bestScore));
        }

        const validated = await saveProfileToFirestore(req.session.pseudo, profile);
        console.log(`[CREDIT POINTS] ${req.session.pseudo} +${pointsToAdd} pts (runKey: ${runKey}) → wallet: ${validated.wallet}`);

        res.json({ success: true, credited: pointsToAdd, reason: `+${pointsToAdd} points boutique ajoutés.`, profile: { ...validated, pin: undefined } });
    } catch (e) {
        console.error("Erreur credit-points:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- ROUTE BOUTIQUE ACHAT ---
// POST /api/shop/buy
app.post('/api/shop/buy', requireAuth, async (req, res) => {
    try {
        const { itemId, itemType, price } = req.body;
        if (!itemId || !itemType || typeof price !== 'number') {
            return res.status(400).json({ error: "itemId, itemType et price requis" });
        }

        const profile = await loadProfileFromFirestore(req.session.pseudo);
        if (!profile) return res.status(404).json({ error: "Profil introuvable" });

        // Vérifier si déjà possédé
        const ownedKey = itemType === 'skin' ? 'ownedSkins' : itemType === 'rocket' ? 'ownedRocketSkins' : 'ownedMusic';
        if (!Array.isArray(profile[ownedKey])) profile[ownedKey] = [];
        if (profile[ownedKey].includes(itemId)) {
            return res.status(409).json({ error: "Item déjà possédé" });
        }

        // Vérifier le solde
        if ((profile.wallet || 0) < price) {
            return res.status(402).json({ error: "Points insuffisants", wallet: profile.wallet });
        }

        // Effectuer l'achat
        profile.wallet = Math.floor(profile.wallet) - Math.floor(price);
        profile[ownedKey].push(itemId);

        const validated = await saveProfileToFirestore(req.session.pseudo, profile);
        console.log(`[SHOP BUY] ${req.session.pseudo} achète ${itemId} (${price} pts) → wallet: ${validated.wallet}`);

        res.json({ success: true, profile: { ...validated, pin: undefined } });
    } catch (e) {
        console.error("Erreur shop/buy:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// --- LEADERBOARD FUSÉE ---

// GET /api/leaderboard
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
    } catch (e) {
        console.error("Erreur leaderboard:", e.message);
        res.status(500).json([]);
    }
});

// POST /api/save-score — sauvegarde le score fusée (leaderboard uniquement, PAS les points)
// Les points sont gérés par /api/credit-points appelé séparément depuis le front
app.post(['/api/storage', '/api/save-score'], async (req, res) => {
    try {
        const b = req.body;
        const finalName = b.name || b.pseudo || b.blaze || "PiloteAnonyme";
        let finalValue = 0;
        if (b.value !== undefined && !Number.isNaN(Number(b.value))) finalValue = Number(b.value);
        else if (b.score !== undefined && !Number.isNaN(Number(b.score))) finalValue = Number(b.score);
        finalValue = Math.floor(finalValue);

        const finalKey = b.key || `score:${getWeekKey()}:${finalName}`;

        // On ne sauvegarde le score que si c'est un record (ou nouvelle entrée)
        const existingDoc = await db.collection('storage').doc(keyToDocId(finalKey)).get();
        let isRecord = true;
        if (existingDoc.exists) {
            const existingScore = Number(existingDoc.data().value) || 0;
            if (finalValue <= existingScore) {
                isRecord = false;
            }
        }

        if (isRecord) {
            await db.collection('storage').doc(keyToDocId(finalKey)).set({
                value: finalValue,
                key: finalKey,
                shared: true,
                updatedAt: Date.now()
            });
            console.log(`[SAVE SCORE] Nouveau record : ${finalName} - ${finalValue}`);
        } else {
            console.log(`[SAVE SCORE] Pas de record pour ${finalName} : ${finalValue}`);
        }

        res.json({ success: true, isRecord, savedAs: finalName });
    } catch (e) {
        console.error("Erreur save-score:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// GET /api/storage — récupération générique (rétro-compatibilité)
app.get('/api/storage', async (req, res) => {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: "Clé manquante" });
    try {
        const doc = await db.collection('storage').doc(keyToDocId(key)).get();
        if (!doc.exists) return res.status(404).json({ error: "Non trouvé" });
        res.json(doc.data());
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- TOWER DEFENSE ---

// GET /api/td-scores
app.get('/api/td-scores', async (req, res) => {
    try {
        const snapshot = await db.collection('scores_td').orderBy('score', 'desc').limit(8).get();
        res.json(snapshot.docs.map(doc => doc.data()));
    } catch (e) {
        res.status(500).json([]);
    }
});

// POST /api/td-save-score — sauvegarde score TD (leaderboard uniquement, PAS les points)
// Les points TD sont gérés par /api/credit-points séparément
app.post('/api/td-save-score', async (req, res) => {
    const { name, score, wave } = req.body;
    try {
        const existing = await db.collection('scores_td').where('name', '==', name).get();
        let bestPrev = -1;
        existing.forEach(d => { if (d.data().score > bestPrev) bestPrev = d.data().score; });

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

        console.log(`[TD SAVE] Nouveau record TD : ${name} - ${Math.floor(score)}`);
        res.json({ success: true, isRecord: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- REDIRECTION FINALE ---
app.use(express.static(path.join(__dirname, '../public')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

// --- LANCEMENT ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Serveur Selenetykos ON (Port ${PORT})`);
});
