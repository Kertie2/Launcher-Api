const express = require('express');
const { checkUser } = require('./auth-ad');
const db = require('./database'); // Ton fichier SQLite
const app = express();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const upload = multer({ dest: 'uploads/apks/' }); // Dossier temporaire pour les APK

app.use(express.json({ limit: '10mb' }));

// Pour servir les images publiquement
app.use('/uploads', express.static('uploads'));

app.use(express.static('public'));

// Créer le dossier s'il n'existe pas
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./uploads/apks')) fs.mkdirSync('./uploads/apks', { recursive: true });

app.get('/', (req, res) => {
    res.status(200).json({
        status: "success",
        message: "API Fonctionnelle",
        timestamp: new Date().toISOString()
    });
});

// ROUTE : Connexion depuis la tablette
app.post('/api/login', async (req, res) => {
    const { username, password, deviceId } = req.body;

    console.log(`📡 Tentative de connexion : ${username} sur ${deviceId}`);

    // 1. Vérification AD
    const authResult = await checkUser(username, password);

    if (authResult.success) {
        // 2. Log de la connexion dans SQLite
        db.run("INSERT INTO connection_logs (username, device_id) VALUES (?, ?)", 
               [username, deviceId]);

        // 3. Mise à jour de la tablette (on associe le dernier utilisateur)
        db.run("UPDATE devices SET assigned_user = ? WHERE device_id = ?", 
               [authResult.displayName, deviceId]);

        console.log(`✅ ${authResult.displayName} (${authResult.role}) connecté !`);
        res.json(authResult);
    } else {
        res.status(401).json(authResult);
    }
});

app.get('/api/apps', (req, res) => {
    // Utilisation de "package as packageName" pour correspondre à ton code Flutter
    db.all("SELECT id, appName, package as packageName FROM apps", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 3. ROUTE FUSIONNÉE : Ajouter une app avec gestion d'icône
app.post('/api/apps', upload.single('apk'), (req, res) => {
    const { appName, package, iconBase64 } = req.body;
    const apkFile = req.file;

    if (!appName || !package || !apkFile) {
        return res.status(400).json({ error: "Données ou APK manquants" });
    }

    // 1. Sauvegarde de l'icône (existant)
    if (iconBase64) {
        const iconPath = path.join(__dirname, 'uploads', `${package}.png`);
        const base64Data = iconBase64.replace(/^data:image\/png;base64,/, "");
        fs.writeFileSync(iconPath, Buffer.from(base64Data, 'base64'));
    }

    // 2. Déplacement de l'APK vers son nom définitif
    const finalApkPath = path.join(__dirname, 'uploads/apks', `${package}.apk`);
    fs.renameSync(apkFile.path, finalApkPath);

    // 3. Insertion en BDD
    db.run("INSERT OR REPLACE INTO apps (appName, package) VALUES (?, ?)", [appName, package], function(err) {
        if (err) {
            console.error("❌ Erreur BDD:", err.message);
            return res.status(400).json({ error: "L'application existe déjà" });
        }
        console.log(`📦 APK et Icône reçus pour : ${appName} (${package})`);
        res.json({ id: this.lastID, success: true });
    });
});

// 4. Supprimer une app
app.delete('/api/apps/:id', (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM apps WHERE id = ?", id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Serveur actif sur le port 3000");
});