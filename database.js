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

    // Table des logs
    db.run(`CREATE TABLE IF NOT EXISTS connection_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        device_id TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS apps (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        appName TEXT,
        package TEXT UNIQUE
    )`);

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

    console.log("✅ Base de données SQLite prête.");
});

module.exports = db;