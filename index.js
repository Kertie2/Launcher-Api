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