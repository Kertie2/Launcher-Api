const jwt = require('jsonwebtoken');
const crypto = require('crypto');

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    // Pas de valeur par défaut connue : sans JWT_SECRET, une clé aléatoire est tirée
    // à chaque démarrage (les sessions ouvertes sont alors perdues au redémarrage).
    JWT_SECRET = crypto.randomBytes(32).toString('hex');
    console.warn("⚠️ JWT_SECRET non défini : clé aléatoire générée pour cette exécution.");
}

function generateToken(user) {
    return jwt.sign(
        { username: user.username, role: user.role },
        JWT_SECRET,
        { expiresIn: '8h' }
    );
}

function requireAuth(req, res, next) {
    const header = req.headers['authorization'];
    if (!header) return res.status(401).json({ error: "Token manquant" });

    const token = header.split(' ')[1]; // "Bearer <token>"
    if (!token) return res.status(401).json({ error: "Format invalide" });

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ error: "Token invalide ou expiré" });
    }
}

function requireAdmin(req, res, next) {
    if (req.user?.role !== 'ADMIN') {
        return res.status(403).json({ error: "Accès réservé aux admins" });
    }
    next();
}

module.exports = { generateToken, requireAuth, requireAdmin };