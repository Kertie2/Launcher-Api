const express = require('express');
const { checkUser } = require('./auth-ad');
const db = require('./database');
const app = express();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const upload = multer({ dest: 'uploads/apks/' });
const { generateToken, requireAuth, requireAdmin } = require('./middleware/auth');
const ApkReader = require('adbkit-apkreader');
const uploadWeb = multer({ dest: 'uploads/tmp/' });
const https = require('https');

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

app.post('/api/apps', requireAuth, requireAdmin, upload.single('apk'), (req, res) => {
    console.log("📥 [POST /api/apps] Requête reçue");
    console.log("📋 Headers:", req.headers['authorization'] ? "Token présent" : "❌ Pas de token");
    console.log("📋 Body fields:", { appName: req.body.appName, package: req.body.package, iconBase64: req.body.iconBase64 ? "présent" : "absent" });
    console.log("📁 Fichier APK:", req.file ? `${req.file.originalname} (${req.file.size} bytes)` : "❌ Absent");

    const { appName, package: packageName, iconBase64 } = req.body;
    const apkFile = req.file;

    if (!appName || !packageName || !apkFile) {
        console.log("❌ Données manquantes:", { appName: !!appName, packageName: !!packageName, apkFile: !!apkFile });
        return res.status(400).json({ error: "Données ou APK manquants" });
    }

    console.log("✅ Données présentes:", { appName, packageName });

    if (!isValidPackageName(packageName)) {
        console.log("❌ Package name invalide:", packageName);
        return res.status(400).json({ error: "Nom de package invalide" });
    }

    console.log("✅ Package name valide:", packageName);

    if (iconBase64) {
        try {
            const iconPath = path.join(__dirname, 'uploads', `${packageName}.png`);
            const base64Data = iconBase64.replace(/^data:image\/png;base64,/, "");
            fs.writeFileSync(iconPath, Buffer.from(base64Data, 'base64'));
            console.log("✅ Icône sauvegardée:", iconPath);
        } catch (e) {
            console.error("❌ Erreur sauvegarde icône:", e.message);
        }
    } else {
        console.log("⚠️ Pas d'icône fournie");
    }

    try {
        const finalApkPath = path.join(__dirname, 'uploads/apks', `${packageName}.apk`);
        fs.renameSync(apkFile.path, finalApkPath);
        console.log("✅ APK déplacé vers:", finalApkPath);
    } catch (e) {
        console.error("❌ Erreur déplacement APK:", e.message);
        return res.status(500).json({ error: "Erreur lors du déplacement de l'APK" });
    }

    db.run("INSERT OR REPLACE INTO apps (appName, package) VALUES (?, ?)", [appName, packageName], function(err) {
        if (err) {
            console.error("❌ Erreur BDD:", err.message);
            return res.status(400).json({ error: err.message });
        }
        console.log(`✅ App insérée en BDD : ${appName} (${packageName}) — ID: ${this.lastID}`);
        res.json({ id: this.lastID, success: true });
    });
});

app.post('/api/devices/logout', requireAuth, (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId manquant" });

    db.run(
        "UPDATE devices SET adb_status = 'Disconnected', assigned_user = NULL WHERE device_id = ?",
        [deviceId],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            console.log(`📴 Tablette déconnectée : ${deviceId}`);
            res.json({ success: true });
        }
    );
});

// 4. Supprimer une app
app.delete('/api/apps/:id', requireAuth, requireAdmin, (req, res) => {
    const id = req.params.id;
    db.run("DELETE FROM apps WHERE id = ?", id, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Vérifier si une tablette est blacklistée (appelé au login)
app.get('/api/devices/:deviceId/status', requireAuth, (req, res) => {
    const { deviceId } = req.params;
    db.get("SELECT * FROM devices_blacklist WHERE device_id = ?", [deviceId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ blacklisted: !!row, reason: row?.reason || null });
    });
});

// Heartbeat — la tablette signale qu'elle est active + envoie ses apps installées
app.post('/api/devices/heartbeat', requireAuth, (req, res) => {
    const { deviceId, installedApps } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId manquant" });

    const now = new Date().toISOString();

    // Met à jour la tablette
    db.run(`INSERT INTO devices (device_id, adb_status, assigned_user, last_seen) 
        VALUES (?, 'Connected', ?, datetime('now'))
        ON CONFLICT(device_id) DO UPDATE SET 
        adb_status = 'Connected',
        assigned_user = excluded.assigned_user,
        last_ip = ?,
        last_seen = datetime('now')`,
    [deviceId, req.user.username, req.ip],
        (err) => { if (err) console.error(err); }
    );

    // Met à jour les apps installées
    if (installedApps && Array.isArray(installedApps)) {
        // Supprime les anciennes apps de cette tablette
        db.run("DELETE FROM device_apps WHERE device_id = ?", [deviceId], () => {
            // Réinsère les apps actuelles
            const stmt = db.prepare(
                "INSERT OR REPLACE INTO device_apps (device_id, package_name, app_name) VALUES (?, ?, ?)"
            );
            installedApps.forEach(app => {
                stmt.run(deviceId, app.packageName, app.appName);
            });
            stmt.finalize();
        });
    }

    // Vérifie si la tablette est blacklistée
    db.get("SELECT * FROM devices_blacklist WHERE device_id = ?", [deviceId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ 
            success: true,
            blacklisted: !!row,
            reason: row?.reason || null
        });
    });
});

// Récupérer toutes les tablettes avec leurs infos
app.get('/api/devices', requireAuth, requireAdmin, (req, res) => {
    db.all(`
        SELECT 
            d.*,
            CASE WHEN b.device_id IS NOT NULL THEN 1 ELSE 0 END as blacklisted,
            b.reason as blacklist_reason
        FROM devices d
        LEFT JOIN devices_blacklist b ON d.device_id = b.device_id
        ORDER BY d.device_id
    `, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Récupérer les apps installées d'une tablette
app.get('/api/devices/:deviceId/apps', requireAuth, requireAdmin, (req, res) => {
    db.all("SELECT * FROM device_apps WHERE device_id = ?", 
        [req.params.deviceId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Blacklister une tablette
app.post('/api/devices/:deviceId/blacklist', requireAuth, requireAdmin, (req, res) => {
    const { deviceId } = req.params;
    const { reason } = req.body;
    db.run(
        "INSERT OR REPLACE INTO devices_blacklist (device_id, reason, blocked_by) VALUES (?, ?, ?)",
        [deviceId, reason || "Aucune raison", req.user.username],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

// Débloquer une tablette
app.delete('/api/devices/:deviceId/blacklist', requireAuth, requireAdmin, (req, res) => {
    db.run("DELETE FROM devices_blacklist WHERE device_id = ?", 
        [req.params.deviceId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.get('/api/logs', requireAuth, requireAdmin, (req, res) => {
    db.all(
        "SELECT * FROM connection_logs ORDER BY timestamp DESC LIMIT 50",
        [], (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Étape 1 : Upload APK et retourne les icônes disponibles
app.post('/api/apps/web/preview', requireAuth, requireAdmin, uploadWeb.single('apk'), async (req, res) => {
    const apkFile = req.file;
    if (!apkFile) return res.status(400).json({ error: "APK manquant" });

    try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(apkFile.path);
        const entries = zip.getEntries();

        // Collecte toutes les icônes PNG/WEBP
        const icons = [];
        const iconPriority = [
            'mipmap-xxxhdpi', 'mipmap-xxhdpi', 'mipmap-xhdpi', 'mipmap-hdpi',
            'drawable-xxxhdpi', 'drawable-xxhdpi', 'drawable-xhdpi', 'drawable-hdpi',
            'mipmap-anydpi', 'mipmap-mdpi', 'drawable-mdpi'
        ];

        for (const entry of entries) {
            if (
                (entry.entryName.endsWith('.png') || entry.entryName.endsWith('.webp')) &&
                !entry.entryName.includes('9.png') // Exclut les 9-patch
            ) {
                // Sauvegarde temporairement l'icône
                const tmpName = `tmp_${Date.now()}_${icons.length}.png`;
                const tmpPath = path.join(__dirname, 'uploads/tmp', tmpName);
                fs.writeFileSync(tmpPath, entry.getData());

                // Calcule la priorité
                const priority = iconPriority.findIndex(p => entry.entryName.includes(p));

                icons.push({
                    path: entry.entryName,
                    tmpFile: tmpName,
                    priority: priority === -1 ? 999 : priority,
                    url: `/uploads/tmp/${tmpName}`
                });
            }
        }

        // Trie par priorité
        icons.sort((a, b) => a.priority - b.priority);

        // Sauvegarde le chemin de l'APK temporaire pour l'étape 2
        res.json({
            success: true,
            tmpApk: path.basename(apkFile.path),
            icons: icons.slice(0, 20) // Max 20 icônes affichées
        });

    } catch (e) {
        console.error(e);
        res.status(500).json({ error: e.message });
    }
});

// Étape 2 : Confirme l'ajout avec l'icône choisie
app.post('/api/apps/web/confirm', requireAuth, requireAdmin, (req, res) => {
    const { appName, packageName, tmpApk, selectedIcon } = req.body;

    if (!appName || !packageName || !tmpApk) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    if (!isValidPackageName(packageName)) {
        return res.status(400).json({ error: "Nom de package invalide" });
    }

    // Copie l'icône choisie
    if (selectedIcon) {
        const srcIcon = path.join(__dirname, 'uploads/tmp', selectedIcon);
        const destIcon = path.join(__dirname, 'uploads', `${packageName}.png`);
        if (fs.existsSync(srcIcon)) fs.copyFileSync(srcIcon, destIcon);
    }

    // Déplace l'APK
    const srcApk = path.join(__dirname, 'uploads/tmp', tmpApk);
    const destApk = path.join(__dirname, 'uploads/apks', `${packageName}.apk`);
    if (fs.existsSync(srcApk)) fs.renameSync(srcApk, destApk);

    // Nettoie les icônes temporaires
    const tmpDir = path.join(__dirname, 'uploads/tmp');
    fs.readdirSync(tmpDir).forEach(f => {
        if (f.startsWith('tmp_')) fs.unlinkSync(path.join(tmpDir, f));
    });

    db.run(
        "INSERT OR REPLACE INTO apps (appName, package) VALUES (?, ?)",
        [appName, packageName],
        function(err) {
            if (err) return res.status(400).json({ error: err.message });
            console.log(`📦 App confirmée : ${appName} (${packageName})`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

app.get('/api/launcher/latest', requireAuth, async (req, res) => {
    try {
        const options = {
            hostname: 'api.github.com',
            path: '/repos/Kertie2/Launcher-App/releases/latest',
            headers: { 'User-Agent': 'Launcher-MDM' }
        };

        const data = await new Promise((resolve, reject) => {
            https.get(options, (response) => {
                let body = '';
                response.on('data', chunk => body += chunk);
                response.on('end', () => resolve(JSON.parse(body)));
            }).on('error', reject);
        });

        res.json({
            version: data.tag_name,         // ex: "v1.0.10"
            downloadUrl: data.assets?.[0]?.browser_download_url,
            publishedAt: data.published_at,
            name: data.name
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

setInterval(() => {
    db.run(`
        UPDATE devices 
        SET adb_status = 'Disconnected'
        WHERE last_seen IS NULL 
        OR last_seen < datetime('now', '-2 minutes')
    `, (err) => {
        if (err) console.error("Erreur heartbeat check:", err.message);
        else console.log("🔄 Check heartbeat effectué");
    });
}, 60000);

app.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Serveur actif sur le port 3000");
});