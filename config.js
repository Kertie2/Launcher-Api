// Configuration de l'établissement, lue dans les variables d'environnement
// ou dans un fichier .env placé à côté de index.js (voir .env.example).
const fs = require('fs');
const path = require('path');

const fichierEnv = path.join(__dirname, '.env');
if (fs.existsSync(fichierEnv)) {
    for (const ligne of fs.readFileSync(fichierEnv, 'utf8').split(/\r?\n/)) {
        const m = ligne.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!m || process.env[m[1]] !== undefined) continue;
        process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
    }
}

function requis(nom) {
    const valeur = process.env[nom];
    if (!valeur) {
        console.error(`❌ Variable d'environnement manquante : ${nom} (voir .env.example)`);
        process.exit(1);
    }
    return valeur;
}

module.exports = {
    ad: {
        url: requis('AD_URL'),
        baseDN: requis('AD_BASE_DN'),
        domaineUPN: requis('AD_DOMAINE_UPN'),
        groupeAdmin: (process.env.AD_GROUPE_ADMIN || 'g_profs').toLowerCase(),
        groupeEleve: (process.env.AD_GROUPE_ELEVE || 'g_eleves').toLowerCase(),
    },
    baseDeDonnees: process.env.DB_PATH || './launcher.sqlite',
};
