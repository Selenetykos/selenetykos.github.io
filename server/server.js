const express = require('express');
const path = require('path');
const cors = require('cors');
const { db } = require('./firebase');
const crypto = require('crypto');
const app = express();

// --- CONFIGURATION ---
app.use(cors());
app.use(express.json());

// Session storage (en mémoire pour l'instant)
const sessions = new Map();

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
    
    // Sécuriser toutes les valeurs numériques
    profile.wallet = Number(profile.wallet) || 0;
    profile.totalEarned = Number(profile.totalEarned) || 0;
    profile.bestScore = Number(profile.bestScore) || 0;
    
    // S'assurer que les tableaux existent
    if (!Array.isArray(profile.ownedSkins)) profile.ownedSkins = ['classic'];
    if (!Array.isArray(profile.ownedRocketSkins)) profile.ownedRocketSkins = ['r_classic'];
    if (!Array.isArray(profile.ownedMusic)) profile.ownedMusic = ['m_rocket_default', 'm_td_default'];
    
    // S'assurer que les chaînes existent
    profile.activeSkin = profile.activeSkin || 'classic';
    profile.activeRocketSkin = profile.activeRocketSkin || 'r_classic';
    profile.activeRocketMusic = profile.activeRocketMusic || 'm_rocket_default';
    profile.activeTDMusic = profile.activeTDMusic || 'm_td_default';
    
    // S'assurer que l'objet creditedScores existe
    if (!profile.creditedScores || typeof profile.creditedScores !== 'object') {
        profile.creditedScores = {};
    }
    
    // Vérifier qu'aucune valeur n'est NaN après sécurisation
    if (Number.isNaN(profile.wallet) || Number.isNaN(profile.totalEarned) || Number.isNaN(profile.bestScore)) {
        console.error('Profil contient des NaN après sécurisation:', profile);
        return null;
    }
    
    return profile;
}

// --- AUTH ROUTES ---

// 1. Register - Créer un nouveau compte
app.post('/api/register', async (req, res) => {
    try {
        const { pseudo, pin } = req.body;
        
        if (!pseudo || !pin) {
            return res.status(400).json({ error: "Pseudo et code secret requis" });
        }
        
        const normalizedPseudo = normalizePseudo(pseudo);
        const playerKey = `player:${normalizedPseudo}`;
        
        // Vérifier si le compte existe déjà
        const existingDoc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        if (existingDoc.exists) {
            return res.status(409).json({ error: "Ce pseudo existe déjà" });
        }
        
        // Créer le nouveau profil
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
        
        // Valider le profil avant sauvegarde
        const validatedProfile = validateAndSecureProfile(newProfile);
        if (!validatedProfile) {
            return res.status(500).json({ error: "Erreur de validation du profil" });
        }
        
        const profileString = JSON.stringify(validatedProfile);
        console.log(`[REGISTER] Sauvegarde profil pour ${normalizedPseudo}:`, {
            wallet: validatedProfile.wallet,
            totalEarned: validatedProfile.totalEarned,
            bestScore: validatedProfile.bestScore,
            stringLength: profileString.length
        });
        
        await db.collection('storage').doc(keyToDocId(playerKey)).set({
            value: profileString,
            key: playerKey,
            shared: false,
            updatedAt: Date.now()
        });
        
        // Créer une session
        const sessionToken = generateSessionToken();
        sessions.set(sessionToken, {
            pseudo: normalizedPseudo,
            name: pseudo,
            createdAt: Date.now()
        });
        
        console.log(`Compte créé : ${normalizedPseudo}`);
        res.json({ 
            success: true, 
            token: sessionToken,
            profile: { ...validatedProfile, pin: undefined } // Ne pas renvoyer le hash
        });
    } catch (e) {
        console.error("Erreur register:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 2. Login - Se connecter à un compte existant
app.post('/api/login', async (req, res) => {
    try {
        const { pseudo, pin } = req.body;
        
        if (!pseudo || !pin) {
            return res.status(400).json({ error: "Pseudo et code secret requis" });
        }
        
        const normalizedPseudo = normalizePseudo(pseudo);
        const playerKey = `player:${normalizedPseudo}`;
        
        // Récupérer le profil
        const doc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        if (!doc.exists) {
            return res.status(404).json({ error: "Compte introuvable" });
        }
        
        const profileData = doc.data().value;
        const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
        
        // Vérifier le code secret
        if (profile.pin !== hashSecret(pin)) {
            return res.status(401).json({ error: "Code secret incorrect" });
        }
        
        // Créer une session
        const sessionToken = generateSessionToken();
        sessions.set(sessionToken, {
            pseudo: normalizedPseudo,
            name: profile.name,
            createdAt: Date.now()
        });
        
        console.log(`Connexion : ${normalizedPseudo}`);
        res.json({ 
            success: true, 
            token: sessionToken,
            profile: { ...profile, pin: undefined } // Ne pas renvoyer le hash
        });
    } catch (e) {
        console.error("Erreur login:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 3. Profile - Récupérer le profil connecté
app.get('/api/profile', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: "Token manquant" });
        }
        
        const session = sessions.get(token);
        if (!session) {
            return res.status(401).json({ error: "Session invalide ou expirée" });
        }
        
        const playerKey = `player:${session.pseudo}`;
        const doc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        
        if (!doc.exists) {
            return res.status(404).json({ error: "Profil introuvable" });
        }
        
        const profileData = doc.data().value;
        const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
        
        res.json({ 
            success: true, 
            profile: { ...profile, pin: undefined }
        });
    } catch (e) {
        console.error("Erreur profile:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 4. Logout - Déconnexion
app.post('/api/logout', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (token) {
            sessions.delete(token);
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 5. Update Profile - Mettre à jour le profil
app.post('/api/profile/update', async (req, res) => {
    try {
        const token = req.headers.authorization?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: "Token manquant" });
        }
        
        const session = sessions.get(token);
        if (!session) {
            return res.status(401).json({ error: "Session invalide ou expirée" });
        }
        
        const updates = req.body;
        const playerKey = `player:${session.pseudo}`;
        
        // Récupérer le profil actuel
        const doc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        if (!doc.exists) {
            return res.status(404).json({ error: "Profil introuvable" });
        }
        
        const profileData = doc.data().value;
        const profile = typeof profileData === 'string' ? JSON.parse(profileData) : profileData;
        
        // Appliquer les mises à jour (sauf le pin)
        const updatedProfile = { ...profile, ...updates };
        if (updates.pin) {
            updatedProfile.pin = hashSecret(updates.pin);
        }
        
        // Valider et sécuriser le profil avant sauvegarde
        const validatedProfile = validateAndSecureProfile(updatedProfile);
        if (!validatedProfile) {
            console.error(`[PROFILE UPDATE] Validation échouée pour ${session.pseudo}`);
            return res.status(500).json({ error: "Erreur de validation du profil" });
        }
        
        const profileString = JSON.stringify(validatedProfile);
        console.log(`[PROFILE UPDATE] Sauvegarde profil pour ${session.pseudo}:`, {
            wallet: validatedProfile.wallet,
            totalEarned: validatedProfile.totalEarned,
            bestScore: validatedProfile.bestScore,
            stringLength: profileString.length
        });
        
        await db.collection('storage').doc(keyToDocId(playerKey)).set({
            value: profileString,
            key: playerKey,
            shared: false,
            updatedAt: Date.now()
        });
        
        console.log(`Profil mis à jour : ${session.pseudo}`);
        res.json({ 
            success: true, 
            profile: { ...validatedProfile, pin: undefined }
        });
    } catch (e) {
        console.error("Erreur profile update:", e.message);
        res.status(500).json({ error: e.message });
    }
});

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
        
        // On cherche le score avec validation stricte
        let finalValue = 0;
        if (b.value !== undefined && b.value !== null && !Number.isNaN(Number(b.value))) {
            finalValue = Number(b.value);
        } else if (b.score !== undefined && b.score !== null && !Number.isNaN(Number(b.score))) {
            finalValue = Number(b.score);
        }
        
        finalValue = Math.floor(finalValue);
        
        // On construit la clé
        const finalKey = b.key || `score:${getWeekKey()}:${finalName}`;

        // Sauvegarder le score
        await db.collection('storage').doc(keyToDocId(finalKey)).set({
            value: finalValue,
            key: finalKey,
            shared: true,
            updatedAt: Date.now()
        });

        console.log(`[SAVE SCORE] Score enregistré : ${finalName} - ${finalValue}`);

        // Ajouter les points au wallet du joueur (toujours, même si pas record)
        const playerKey = `player:${finalName.toLowerCase()}`;
        const playerDoc = await db.collection('storage').doc(keyToDocId(playerKey)).get();
        let profile = playerDoc.exists ? playerDoc.data().value : null;
        
        if (profile) {
            try {
                profile = typeof profile === 'string' ? JSON.parse(profile) : profile;
                
                // Sécuriser les valeurs avant calcul
                const currentWallet = Number(profile.wallet) || 0;
                const currentTotalEarned = Number(profile.totalEarned) || 0;
                const pointsToAdd = finalValue;
                
                // Vérifier que les valeurs sont valides avant addition
                if (Number.isNaN(currentWallet) || Number.isNaN(currentTotalEarned) || Number.isNaN(pointsToAdd)) {
                    console.error(`[SAVE SCORE] Valeurs NaN détectées pour ${finalName}:`, {
                        currentWallet,
                        currentTotalEarned,
                        pointsToAdd
                    });
                    throw new Error('Valeurs invalides détectées');
                }
                
                profile.wallet = currentWallet + pointsToAdd;
                profile.totalEarned = currentTotalEarned + pointsToAdd;
                
                // Valider et sécuriser le profil avant sauvegarde
                const validatedProfile = validateAndSecureProfile(profile);
                if (!validatedProfile) {
                    console.error(`[SAVE SCORE] Validation échouée pour ${finalName}`);
                    throw new Error('Validation du profil échouée');
                }
                
                const profileString = JSON.stringify(validatedProfile);
                console.log(`[SAVE SCORE] Sauvegarde profil pour ${finalName}:`, {
                    wallet: validatedProfile.wallet,
                    totalEarned: validatedProfile.totalEarned,
                    bestScore: validatedProfile.bestScore,
                    pointsAdded,
                    stringLength: profileString.length
                });
                
                await db.collection('storage').doc(keyToDocId(playerKey)).set({
                    value: profileString,
                    key: playerKey,
                    shared: false,
                    updatedAt: Date.now()
                });
                
                console.log(`Wallet mis à jour pour ${finalName}: ${validatedProfile.wallet} points`);
            } catch (e) {
                console.error("Erreur wallet update:", e.message);
            }
        }

        res.json({ success: true, savedAs: finalName, pointsAdded: finalValue });
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
