# Launcher — API et console d'administration

Serveur du **Launcher**, une application Android qui remplace l'écran d'accueil des tablettes d'un établissement scolaire et n'affiche que les applications autorisées. L'application elle-même est dans le dépôt [Launcher-App](https://github.com/Kertie2/Launcher-App).

Ce serveur fournit :

- la **connexion par Active Directory** : les élèves et les professeurs utilisent leurs identifiants habituels ; le rôle (administrateur ou élève) est déduit des groupes AD ;
- le **catalogue d'applications** : dépôt d'APK, lecture automatique du nom et de l'icône, recherche des informations sur le Play Store, vérification des mises à jour ;
- le **suivi des tablettes** : présence (heartbeat), utilisateur connecté, applications ouvertes, ouverture forcée du launcher, déconnexion à distance ;
- les **notifications** envoyées aux tablettes et une **liste de blocage** d'utilisateurs ;
- la **mise à jour du launcher** lui-même ;
- une **console d'administration** web (`/login`, `/dashboard`) réservée aux administrateurs ;
- une **sauvegarde** de la base toutes les 6 heures (dossier `backups/`).

Stack : Node.js, Express, SQLite, ldapjs, JSON Web Tokens.

## Installation

```sh
npm install
cp .env.example .env     # puis renseigner les valeurs de l'établissement
node index.js            # écoute sur le port 3000
```

Le logo de l'établissement, s'il y en a un, se place dans `public/images/logo.png` (ce fichier n'est pas versionné). Sans logo, l'emplacement est simplement masqué.

## Configuration

Les réglages se font par variables d'environnement, ou dans un fichier `.env` à côté de `index.js`. Les variables du système ou du service sont prioritaires sur le fichier.

| Variable | Obligatoire | Rôle |
|---|---|---|
| `AD_URL` | oui | Adresse du contrôleur de domaine (`ldap://…`) |
| `AD_BASE_DN` | oui | Base de recherche dans l'annuaire (`DC=…,DC=…`) |
| `AD_DOMAINE_UPN` | oui | Domaine ajouté à l'identifiant pour se connecter (`identifiant@domaine`) |
| `AD_GROUPE_ADMIN` | non | Groupe AD des administrateurs (par défaut `g_profs`) |
| `AD_GROUPE_ELEVE` | non | Groupe AD des élèves (par défaut `g_eleves`) |
| `JWT_SECRET` | conseillé | Clé de signature des sessions. Sans elle, une clé aléatoire est tirée à chaque démarrage et les sessions sont perdues au redémarrage |
| `DB_PATH` | non | Fichier de la base SQLite (par défaut `./launcher.sqlite`) |

Le serveur refuse de démarrer si une variable obligatoire manque.

## Mise à jour d'une installation existante

Les versions précédentes avaient la configuration de l'annuaire écrite dans le code. Après la mise à jour :

1. créer le fichier `.env` à partir de `.env.example` (ou définir les variables dans le service) avec les valeurs de l'établissement ;
2. si la base existante porte un autre nom que `launcher.sqlite`, l'indiquer dans `DB_PATH` (ou renommer le fichier) ;
3. définir `JWT_SECRET` ;
4. replacer le logo dans `public/images/logo.png` ;
5. redémarrer le service.
