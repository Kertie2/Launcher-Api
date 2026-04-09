const express = require('express');
const { checkUser } = require('./auth-ad');
const db = require('./database');
const app = express();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const upload = multer({ dest: 'uploads/apks/' });
const { generateToken, requireAuth, requireAdmin } = require('./middleware/auth');

app.use(express.json({ limit: '10mb' }));

// Pour servir les images publiquement
app.use('/uploads', express.static('uploads'));

app.use(express.static('public'));

// Créer le dossier s'il n'existe pas
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
if (!fs.existsSync('./uploads/apks')) fs.mkdirSync('./uploads/apks', { recursive: true });

function isValidPackageName(packageName) {
    const regex = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    return regex.test(packageName);
}

app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'login.html'));
});

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'dashboard.html'));
});

// Redirige la racine vers le dashboard
app.get('/', (req, res) => {
    res.redirect('/dashboard');
});

// ROUTE : Connexion depuis la tablette
app.post('/api/login', async (req, res) => {
    const { username, password, deviceId } = req.body;

    console.log(`📡 Tentative de connexion : ${username} sur ${deviceId}`);

    const authResult = await checkUser(username, password);

    if (authResult.success) {
        db.run("INSERT INTO connection_logs (username, device_id) VALUES (?, ?)", 
               [username, deviceId]);
        db.run("UPDATE devices SET assigned_user = ? WHERE device_id = ?", 
               [authResult.displayName, deviceId]);

        const token = generateToken(authResult); // <- nouveau
        console.log(`✅ ${authResult.displayName} (${authResult.role}) connecté !`);
        res.json({ ...authResult, token }); // <- on ajoute le token à la réponse
    } else {
        res.status(401).json(authResult);
    }
});

app.get('/api/apps', requireAuth, (req, res) => {
    // Utilisation de "package as packageName" pour correspondre à ton code Flutter
    db.all("SELECT id, appName, package as packageName FROM apps", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 3. ROUTE FUSIONNÉE : Ajouter une app avec gestion d'icône
app.post('/api/apps', requireAuth, requireAdmin, upload.single('apk'), (req, res) => {
    const { appName, package, iconBase64 } = req.body;
    const apkFile = req.file;

    if (!appName || !package || !apkFile) {
        return res.status(400).json({ error: "Données ou APK manquants" });
    }

    if (!isValidPackageName(packageName)) {
        return res.status(400).json({ error: "Nom de package invalide" });
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
app.delete('/api/apps/:id', requireAuth, requireAdmin, (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM apps WHERE id = ?", id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Serveur actif sur le port 3000");
});