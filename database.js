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

    console.log("✅ Base de données SQLite prête.");
});

module.exports = db;