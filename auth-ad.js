const ldap = require('ldapjs');

const AD_CONFIG = {
    url: 'ldap://0676A-SRVPEDA',
    baseDN: 'DC=eple0110676a,DC=local'
};

function formatName(rawName) {
    if (!rawName) return "Élève";
    const parts = rawName.split(' ');
    const nom = parts[0].toUpperCase();
    const prenom = parts.length > 1 ? parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase() : "";
    return `${nom} ${prenom}`.trim();
}

function checkUser(username, password) {
    return new Promise((resolve) => {
        const client = ldap.createClient({ url: AD_CONFIG.url });
        const userUPN = `${username}@eple0110676a.local`;

        client.bind(userUPN, password, (err) => {
            if (err) {
                client.unbind();
                return resolve({ success: false, message: "Identifiants AD incorrects" });
            }

            const opts = {
                filter: `(userPrincipalName=${userUPN})`,
                scope: 'sub',
                attributes: ['displayName', 'description', 'memberOf']
            };

            client.search(AD_CONFIG.baseDN, opts, (err, res) => {
                let userInfo = { success: true, username: username, role: 'unknown' };

                res.on('searchEntry', (entry) => {
                    const rawName = entry.attributes.find(a => a.type === 'displayName')?.values[0];
                    userInfo.displayName = formatName(rawName);

                    userInfo.details = entry.attributes.find(a => a.type === 'description')?.values[0] || "N/A";

                    const groups = entry.attributes.find(a => a.type === 'memberOf')?.values || [];
                    
                    const groupsString = groups.join(',').toLowerCase();
                    
                    if (groupsString.includes('g_profs')) {
                        userInfo.role = 'ADMIN';
                    } else if (groupsString.includes('g_eleves')) {
                        userInfo.role = 'STUDENT';
                    } else {
                        userInfo.role = 'GUEST';
                    }
                });

                res.on('end', () => {
                    client.unbind();
                    resolve(userInfo);
                });
            });
        });
    });

    // MOCK pour tests sans AD
    // return new Promise((resolve) => {
    //     if (username === "admin" && password === "admin") {
    //         resolve({ success: true, username: "admin", displayName: "Admin", role: "ADMIN", details: "Professeur de test" });
    //     } else if (username === "eleve" && password === "eleve") {
    //         resolve({ success: true, username: "eleve", displayName: "Élève Test", role: "STUDENT", details: "Élève de test" });
    //     } else {
    //         resolve({ success: false, message: "Identifiants incorrects" });
    //     }
    // });
}

module.exports = { checkUser };