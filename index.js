const express = require('express');
const { checkUser } = require('./auth-ad');
const db = require('./database');
const app = express();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const upload = multer({ dest: 'uploads/apks/' });
const { generateToken, requireAuth, requireAdmin } = require('./middleware/auth');
const gplay = require('google-play-scraper');
const AdmZip = require('adm-zip');
const uploadWeb = multer({ dest: 'uploads/tmp/' });
const https = require('https');


const { exec } = require('child_process');

// Dossier de backup
if (!fs.existsSync('./backups')) fs.mkdirSync('./backups');

function runBackup() {
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const backupPath = `./backups/bdd_stex_${timestamp}.sqlite`;

    // Copie simple du fichier SQLite
    fs.copyFile('./bdd_stex.sqlite', backupPath, (err) => {
        if (err) {
            console.error("❌ Erreur backup BDD:", err.message);
            return;
        }
        console.log(`✅ Backup BDD créé : ${backupPath}`);
        cleanOldBackups();
    });
}

function cleanOldBackups() {
    // Garde seulement les 10 derniers backups
    const files = fs.readdirSync('./backups')
        .filter(f => f.endsWith('.sqlite'))
        .map(f => ({
            name: f,
            time: fs.statSync(`./backups/${f}`).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time); // Plus récent en premier

    if (files.length > 10) {
        const toDelete = files.slice(10);
        toDelete.forEach(f => {
            fs.unlink(`./backups/${f.name}`, (err) => {
                if (!err) console.log(`🗑️ Ancien backup supprimé : ${f.name}`);
            });
        });
    }
}

// Backup au démarrage du serveur
runBackup();

// Backup toutes les 6 heures
setInterval(runBackup, 6 * 60 * 60 * 1000);

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

// Helper log
function logActivity(username, deviceId, eventType, details = {}, ip = null) {
    db.run(
        "INSERT INTO activity_logs (username, device_id, event_type, details, ip) VALUES (?, ?, ?, ?, ?)",
        [username, deviceId, eventType, JSON.stringify(details), ip],
        (err) => { if (err) console.error("❌ Erreur log:", err.message); }
    );
}

// Helper : extrait le package name et la version depuis l'APK
async function extractApkInfo(apkPath) {
    try {
        const zip = new AdmZip(apkPath);
        const manifestEntry = zip.getEntry('AndroidManifest.xml');
        if (!manifestEntry) throw new Error('AndroidManifest.xml introuvable');

        // Parse binaire du manifest Android
        const manifestBuffer = manifestEntry.getData();
        const result = parseAndroidManifest(manifestBuffer);
        return result;
    } catch (e) {
        console.error('❌ Erreur extraction APK info:', e.message);
        return null;
    }
}

// Parser minimal du AndroidManifest.xml binaire
function parseAndroidManifest(buffer) {
    try {
        // Cherche le package name et versionName dans le binaire
        const str = buffer.toString('utf8');
        const latin = buffer.toString('latin1');

        // Extraction via regex sur les strings du binaire
        const packageMatch = latin.match(/([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)/g);
        const versionMatch = latin.match(/versionName[\x00-\x1f]+([0-9][^\x00-\x1f]{0,20})/);

        // Filtre pour trouver le vrai package (pas les imports android.*)
        const packageName = packageMatch?.find(p =>
            !p.startsWith('android.') &&
            !p.startsWith('com.android.') &&
            !p.startsWith('dalvik.') &&
            !p.startsWith('java.') &&
            p.includes('.') &&
            p.length > 5
        );

        const version = versionMatch?.[1]?.replace(/[^\x20-\x7E]/g, '').trim();

        return { packageName, version };
    } catch (e) {
        return { packageName: null, version: null };
    }
}

// Helper : récupère les infos Play Store
async function getPlayStoreInfo(packageName) {
    try {
        const result = await gplay.app({
            appId: packageName,
            lang: 'fr',
            country: 'fr'
        });
        return {
            version: result.version,
            icon: result.icon,
            title: result.title
        };
    } catch (e) {
        console.log(`⚠️ App ${packageName} non trouvée sur Play Store`);
        return null;
    }
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

app.delete('/api/devices/:deviceId', requireAuth, requireAdmin, (req, res) => {
    const { deviceId } = req.params;
    db.run("DELETE FROM devices WHERE device_id = ?", [deviceId], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        // Nettoie aussi les apps et la blacklist associées
        db.run("DELETE FROM device_apps WHERE device_id = ?", [deviceId]);
        db.run("DELETE FROM devices_blacklist WHERE device_id = ?", [deviceId]);
        console.log(`🗑️ Tablette supprimée : ${deviceId}`);
        res.json({ success: true });
    });
});

// Lister les backups disponibles
app.get('/api/backups', requireAuth, requireAdmin, (req, res) => {
    const files = fs.readdirSync('./backups')
        .filter(f => f.endsWith('.sqlite'))
        .map(f => {
            const stats = fs.statSync(`./backups/${f}`);
            return {
                name: f,
                size: stats.size,
                createdAt: stats.mtime
            };
        })
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(files);
});

// Télécharger un backup
app.get('/api/backups/:filename', requireAuth, requireAdmin, (req, res) => {
    const filename = req.params.filename;

    // Sécurité : empêche les path traversal
    if (filename.includes('/') || filename.includes('..') || !filename.endsWith('.sqlite')) {
        return res.status(400).json({ error: "Fichier invalide" });
    }

    const filePath = path.join(__dirname, 'backups', filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: "Backup introuvable" });
    }

    res.download(filePath, filename);
});

// Forcer un backup manuel
app.post('/api/backups', requireAuth, requireAdmin, (req, res) => {
    try {
        runBackup();
        res.json({ success: true, message: "Backup lancé" });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/devices/logout', requireAuth, (req, res) => {
    const { deviceId } = req.body;
    if (!deviceId) return res.status(400).json({ error: "deviceId manquant" });

    logActivity(req.user.username, deviceId, 'logout', {}, req.ip);

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

app.post('/api/logs/app', requireAuth, (req, res) => {
    const { deviceId, packageName, appName, action } = req.body;
    if (!deviceId || !packageName || !action) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    logActivity(req.user.username, deviceId, `app_${action}`, {
        packageName,
        appName
    }, req.ip);

    // Garde aussi dans app_usage_logs pour l'historique élève
    db.run(
        "INSERT INTO app_usage_logs (username, device_id, package_name, app_name, action) VALUES (?, ?, ?, ?, ?)",
        [req.user.username, deviceId, packageName, appName, action],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ success: true });
        }
    );
});

app.get('/api/logs/activity', requireAuth, requireAdmin, (req, res) => {
    const { username, event_type, device_id, limit = 100 } = req.query;

    let query = "SELECT * FROM activity_logs WHERE 1=1";
    const params = [];

    if (username) { query += " AND username = ?"; params.push(username); }
    if (event_type) { query += " AND event_type = ?"; params.push(event_type); }
    if (device_id) { query += " AND device_id = ?"; params.push(device_id); }

    query += " ORDER BY timestamp DESC LIMIT ?";
    params.push(parseInt(limit));

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        // Parse le JSON des détails
        const parsed = rows.map(r => ({
            ...r,
            details: r.details ? JSON.parse(r.details) : {}
        }));
        res.json(parsed);
    });
});

// Récupérer l'historique — filtrable par utilisateur
app.get('/api/logs/apps', requireAuth, requireAdmin, (req, res) => {
    const { username } = req.query;
    const query = username
        ? "SELECT * FROM app_usage_logs WHERE username = ? ORDER BY timestamp DESC LIMIT 200"
        : "SELECT * FROM app_usage_logs ORDER BY timestamp DESC LIMIT 200";
    const params = username ? [username] : [];

    db.all(query, params, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Envoyer une notification
app.post('/api/notifications', requireAuth, requireAdmin, (req, res) => {
    const { message, deviceId } = req.body;
    if (!message) return res.status(400).json({ error: "Message manquant" });

    db.run(
        "INSERT INTO notifications (target_device_id, message, created_by) VALUES (?, ?, ?)",
        [deviceId || null, message, req.user.username],
        function(err) {
            if (err) return res.status(500).json({ error: err.message });
            console.log(`📢 Notification envoyée : "${message}" -> ${deviceId || 'toutes les tablettes'}`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Récupérer les notifications en attente pour une tablette
app.get('/api/notifications/pending', requireAuth, (req, res) => {
    const { deviceId } = req.query;
    if (!deviceId) return res.status(400).json({ error: "deviceId manquant" });

    db.all(
        `SELECT * FROM notifications 
         WHERE is_read = 0 
         AND (target_device_id = ? OR target_device_id IS NULL)
         ORDER BY created_at DESC`,
        [deviceId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Marquer une notification comme lue
app.post('/api/notifications/:id/read', requireAuth, (req, res) => {
    db.run("UPDATE notifications SET is_read = 1 WHERE id = ?", [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Forcer l'ouverture du launcher sur une tablette
app.post('/api/devices/:deviceId/force-open', requireAuth, requireAdmin, (req, res) => {
    const { deviceId } = req.params;
    // On envoie une notification spéciale de type "force_open"
    db.run(
        "INSERT INTO notifications (target_device_id, message, created_by) VALUES (?, ?, ?)",
        [deviceId, '__FORCE_OPEN__', req.user.username],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
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

// Nouvelle route upload — étape 1 : upload APK et extraction auto
app.post('/api/apps/web/upload', requireAuth, requireAdmin, uploadWeb.single('apk'), async (req, res) => {
    const { appName } = req.body;
    const apkFile = req.file;

    if (!apkFile) return res.status(400).json({ error: "APK manquant" });
    if (!appName) return res.status(400).json({ error: "Nom manquant" });

    try {
        console.log(`📦 Extraction infos APK : ${apkFile.originalname}`);

        // 1. Extraire package + version depuis l'APK
        const apkInfo = await extractApkInfo(apkFile.path);
        console.log(`📋 Info APK extraites :`, apkInfo);

        if (!apkInfo?.packageName || !isValidPackageName(apkInfo.packageName)) {
            // Fallback : demande à l'utilisateur
            return res.json({
                success: true,
                needsPackageName: true,
                tmpApk: path.basename(apkFile.path),
                version: apkInfo?.version || null,
                message: "Impossible d'extraire le package name automatiquement"
            });
        }

        // 2. Récupérer icône + version Play Store
        console.log(`🔍 Recherche Play Store : ${apkInfo.packageName}`);
        const playInfo = await getPlayStoreInfo(apkInfo.packageName);

        // 3. Télécharger l'icône Play Store si disponible
        let iconSaved = false;
        if (playInfo?.icon) {
            try {
                const iconResponse = await new Promise((resolve, reject) => {
                    https.get(playInfo.icon, resolve).on('error', reject);
                });
                const iconPath = path.join(__dirname, 'uploads', `${apkInfo.packageName}.png`);
                const iconStream = fs.createWriteStream(iconPath);
                iconResponse.pipe(iconStream);
                await new Promise((resolve) => iconStream.on('finish', resolve));
                iconSaved = true;
                console.log(`🖼️ Icône Play Store sauvegardée pour ${apkInfo.packageName}`);
            } catch (e) {
                console.log(`⚠️ Impossible de télécharger l'icône Play Store : ${e.message}`);
            }
        }

        // 4. Si pas d'icône Play Store, extraire depuis l'APK
        if (!iconSaved) {
            const zip = new AdmZip(apkFile.path);
            const entries = zip.getEntries();
            const iconPriority = ['mipmap-xxxhdpi', 'mipmap-xxhdpi', 'mipmap-xhdpi', 'mipmap-hdpi'];
            let iconEntry = null;

            for (const priority of iconPriority) {
                iconEntry = entries.find(e =>
                    e.entryName.includes(priority) &&
                    (e.entryName.endsWith('.png') || e.entryName.endsWith('.webp')) &&
                    !e.entryName.includes('9.png')
                );
                if (iconEntry) break;
            }

            if (iconEntry) {
                const iconPath = path.join(__dirname, 'uploads', `${apkInfo.packageName}.png`);
                fs.writeFileSync(iconPath, iconEntry.getData());
                console.log(`🖼️ Icône extraite depuis APK : ${iconEntry.entryName}`);
            }
        }

        res.json({
            success: true,
            needsPackageName: false,
            tmpApk: path.basename(apkFile.path),
            packageName: apkInfo.packageName,
            version: apkInfo.version,
            playStoreVersion: playInfo?.version || null,
            playStoreName: playInfo?.title || null,
            iconFromPlayStore: iconSaved
        });

    } catch (e) {
        console.error('❌ Erreur upload:', e.message);
        res.status(500).json({ error: e.message });
    }
});

// Nouvelle route upload — étape 2 : confirmer l'ajout
app.post('/api/apps/web/confirm', requireAuth, requireAdmin, (req, res) => {
    const { appName, packageName, tmpApk, version, playStoreVersion } = req.body;

    if (!appName || !packageName || !tmpApk) {
        return res.status(400).json({ error: "Données manquantes" });
    }

    if (!isValidPackageName(packageName)) {
        return res.status(400).json({ error: "Nom de package invalide" });
    }

    const srcApk = path.join(__dirname, 'uploads/tmp', tmpApk);
    const destApk = path.join(__dirname, 'uploads/apks', `${packageName}.apk`);
    if (fs.existsSync(srcApk)) fs.renameSync(srcApk, destApk);

    db.run(
        "INSERT OR REPLACE INTO apps (appName, package, version, play_store_version, last_checked) VALUES (?, ?, ?, ?, datetime('now'))",
        [appName, packageName, version || null, playStoreVersion || null],
        function(err) {
            if (err) return res.status(400).json({ error: err.message });
            console.log(`✅ App confirmée : ${appName} (${packageName}) v${version}`);
            res.json({ success: true, id: this.lastID });
        }
    );
});

// Route pour vérifier les MAJ Play Store (toutes les apps)
app.post('/api/apps/check-updates', requireAuth, requireAdmin, async (req, res) => {
    db.all("SELECT id, appName, package, version, play_store_version FROM apps", [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });

        const results = [];
        for (const app of rows) {
            try {
                const playInfo = await getPlayStoreInfo(app.package);
                if (playInfo) {
                    db.run(
                        "UPDATE apps SET play_store_version = ?, last_checked = datetime('now') WHERE id = ?",
                        [playInfo.version, app.id]
                    );
                    results.push({
                        package: app.package,
                        appName: app.appName,
                        currentVersion: app.version,
                        playStoreVersion: playInfo.version,
                        hasUpdate: playInfo.version !== app.version
                    });
                }
            } catch (e) {
                console.log(`⚠️ Erreur check update ${app.package}: ${e.message}`);
            }
        }
        res.json(results);
    });
});

// Route pour récupérer les apps avec info de version
app.get('/api/apps', requireAuth, (req, res) => {
    db.all("SELECT id, appName, package as packageName, version, play_store_version FROM apps", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
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

app.post('/api/login', async (req, res) => {
    const { username, password, deviceId } = req.body;
    console.log(`📡 Tentative de connexion : ${username} sur ${deviceId}`);

    const authResult = await checkUser(username, password);

    if (authResult.success) {
        db.get("SELECT * FROM users_blacklist WHERE username = ?", [username], (err, row) => {
            if (row) {
                logActivity(username, deviceId, 'blocked', { reason: row.reason }, req.ip);
                console.log(`🚫 Compte bloqué : ${username}`);
                return res.status(403).json({
                    success: false,
                    message: `Votre compte a été bloqué. Raison : ${row.reason || 'Non précisée'}`
                });
            }

            // Log connexion réussie
            logActivity(username, deviceId, 'login', {
                role: authResult.role,
                displayName: authResult.displayName
            }, req.ip);

            db.run("INSERT INTO connection_logs (username, device_id) VALUES (?, ?)", [username, deviceId]);
            db.run("UPDATE devices SET assigned_user = ? WHERE device_id = ?", [authResult.displayName, deviceId]);

            const token = generateToken(authResult);
            console.log(`✅ ${authResult.displayName} (${authResult.role}) connecté !`);
            res.json({ ...authResult, token });
        });
    } else {
        // Log tentative échouée
        logActivity(username, deviceId, 'login_failed', { reason: authResult.message }, req.ip);
        res.status(401).json(authResult);
    }
});

// Lister les comptes bloqués
app.get('/api/users/blacklist', requireAuth, requireAdmin, (req, res) => {
    db.all("SELECT * FROM users_blacklist ORDER BY blocked_at DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Bloquer un compte
app.post('/api/users/blacklist', requireAuth, requireAdmin, (req, res) => {
    const { username, reason } = req.body;
    if (!username) return res.status(400).json({ error: "username manquant" });

    db.run(
        "INSERT OR REPLACE INTO users_blacklist (username, reason, blocked_by) VALUES (?, ?, ?)",
        [username, reason || "Aucune raison", req.user.username],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            console.log(`🚫 Compte bloqué : ${username}`);
            res.json({ success: true });
        }
    );
});

// Débloquer un compte
app.delete('/api/users/blacklist/:username', requireAuth, requireAdmin, (req, res) => {
    db.run("DELETE FROM users_blacklist WHERE username = ?", [req.params.username], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
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
}, 30000);

app.listen(3000, '0.0.0.0', () => {
    console.log("🚀 Serveur actif sur le port 3000");
});