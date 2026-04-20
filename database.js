const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./bdd_stex.sqlite');

db.serialize(() => {
    // Table des tablettes
    db.run(`CREATE TABLE IF NOT EXISTS devices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT UNIQUE,     -- L'ID unique de la tablette
        model TEXT,                -- Lenovo, etc.
        last_ip TEXT,              -- Pour savoir où envoyer les commandes ADB
        adb_status TEXT DEFAULT 'Disconnected',
        assigned_user TEXT         -- Dernier élève connecté
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        device_id TEXT,
        event_type TEXT,  -- 'login', 'logout', 'app_open', 'app_install', 'blocked', 'update'
        details TEXT,     -- JSON avec infos supplémentaires
        ip TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appName TEXT,
        package TEXT UNIQUE,
        version TEXT,
        play_store_version TEXT,
        icon_url TEXT,
        last_checked DATETIME
    )`);

    // Migration si la table existe déjà
    db.run(`ALTER TABLE apps ADD COLUMN version TEXT`, () => {});
    db.run(`ALTER TABLE apps ADD COLUMN play_store_version TEXT`, () => {});
    db.run(`ALTER TABLE apps ADD COLUMN icon_url TEXT`, () => {});
    db.run(`ALTER TABLE apps ADD COLUMN last_checked DATETIME`, () => {});

    // Blacklist des tablettes
    db.run(`CREATE TABLE IF NOT EXISTS devices_blacklist (
        device_id TEXT PRIMARY KEY,
        reason TEXT,
        blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        blocked_by TEXT
    )`);

    // Apps installées par tablette
    db.run(`CREATE TABLE IF NOT EXISTS device_apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT,
        package_name TEXT,
        app_name TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(device_id, package_name)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS users_blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        reason TEXT,
        blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        blocked_by TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS app_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        device_id TEXT,
        package_name TEXT,
        app_name TEXT,
        action TEXT,  -- 'open' ou 'close'
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        target_device_id TEXT,  -- NULL = toutes les tablettes
        message TEXT,
        created_by TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_read INTEGER DEFAULT 0
    )`);

    console.log("✅ Base de données SQLite prête.");
});

module.exports = db;