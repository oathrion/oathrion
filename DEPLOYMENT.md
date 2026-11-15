# Oathrion — Déploiement d'un pilote interne

Ce document décrit l'installation d'Oathrion sur un serveur unique pour un pilote
interne. Il est destiné à une équipe qui n'a pas écrit le code.

Chaque procédure décrite ici a été exécutée contre le code de ce dépôt. Les
comportements décrits sont ceux du code actuel, pas ceux d'une feuille de route.

**Aucun secret de ce document n'est réel.** Toutes les valeurs affichées sont des
exemples à remplacer. Les commandes de génération produisent vos propres valeurs.

---

> **Phase 13.** Kit prêt à l'emploi (Docker Compose, TLS, sauvegarde, restauration) :
> `deploy/README.md`. Exploitation (RPO/RTO, export de tenant, incidents) :
> `docs/OPERATIONS.md`. Preuve multi-tenant : `PHASE-13-MULTI-TENANT-PRODUCTION-REPORT.md`.

## 1. Périmètre et limites du pilote

Oathrion est un plan de contrôle : un agent lui soumet une action envisagée,
Oathrion décide `ALLOW`, `APPROVAL_REQUIRED` ou `BLOCK`, et n'appelle l'outil
sous-jacent que dans le premier cas.

Ce que cette installation **est en production** :

- un ou plusieurs processus Oathrion derrière un load balancer ;
- une base de données PostgreSQL partagée (décisions, identité, audit, limitations de débit) ;
- une gestion de comptes et de clés d'API persistée dans PostgreSQL et partagée entre répliques ;
- une autorité d'action garantissant la consommation unique des grants ;
- un journal d'audit chaîné par hachage (tamper-evident) ;
- une notification sortante optionnelle par webhook signé.

Modes de déploiement supportés :

1. **Production (PostgreSQL)** : `DATABASE_DRIVER=postgres`, `OATHRION_IDENTITY_PLANE=postgres`,
   `OATHRION_ACTION_AUTHORITY_DRIVER=postgres`, `RATE_LIMIT_STORE=postgres`.
   Les sessions, clés d'API, autorisations et limitations de débit sont partagées
   immédiatement entre toutes les instances.
2. **Développement local / Tests (SQLite)** : réservé aux tests unitaires et démos
   mono-processus. Il est toujours refusé en production : aucun opt-in ne le réactive.

Conséquence directe : **exposez ce service sur un réseau interne, derrière un
reverse proxy qui termine TLS.** Ne le publiez pas sur l'Internet ouvert sans protection TLS.

---

## 2. Prérequis

| Élément | Version / exigence |
| --- | --- |
| Node.js | 20.x ou supérieur (testé sur 20.20) |
| npm | **10 ou supérieur** (fourni avec Node 20). npm 9 échoue à l'installation avec un message trompeur — cause et correctif dans `README.md` §3 |
| Système | Linux ou macOS ; chaîne de compilation C nécessaire pour `better-sqlite3` |
| Disque | quelques centaines de Mo ; la base croît avec le journal d'audit |
| Réseau | un port TCP libre (5000 par défaut) ; sortie HTTPS si vous utilisez le webhook |

Vérification :

```bash
node --version   # doit afficher v20.x ou plus
npm --version
```

---

## 3. Installation

```bash
git clone <votre-dépôt> placet
cd placet
npm install
```

`npm install` doit se terminer sans erreur et sans `--legacy-peer-deps`.

Construisez ensuite les artefacts servis en production :

```bash
npm run build
```

La commande produit `dist/index.cjs` (le serveur) et `dist/public/` (la console
web). C'est cet artefact que `npm start` exécute.

---

## 4. Variables d'environnement

### 4.1 Obligatoires

Le serveur **refuse de démarrer** si l'une de ces variables est absente ou
invalide. Il écrit la liste des problèmes sur la sortie d'erreur et termine avec
un code de sortie non nul. C'est délibéré : une mauvaise configuration
d'authentification ou de base de données doit arrêter le déploiement, pas produire un service ouvert ou incohérent.

| Variable | Rôle | Contrainte vérifiée au démarrage |
| --- | --- | --- |
| `DATABASE_DRIVER` | Moteur de données | En production : `postgres`. SQLite (`sqlite`) est refusé en `NODE_ENV=production`. |
| `DATABASE_URL` | Chaîne de connexion PostgreSQL | Format `postgres://user:pass@host:5432/db` obligatoire si `DATABASE_DRIVER=postgres` |
| `OATHRION_IDENTITY_PLANE` | Magasin du plan d'identité | En production : `postgres`. Partage les utilisateurs, sessions, clés d'API et révocations entre répliques. |
| `OATHRION_ACTION_AUTHORITY_DRIVER` | Autorité d'action | En production : `postgres`. Garantit la consommation unique des Action Grants. |
| `RATE_LIMIT_STORE` | Magasin de limitation de débit | En production : `postgres`. Compteurs atomiques partagés entre répliques. |
| `OATHRION_SESSION_SECRET` | Clé HMAC signant les jetons de session console | 16 caractères minimum ; valeurs de démonstration refusées |
| `OATHRION_API_KEYS` | Identités machine d'amorçage | format `Nom:rôle:secret`, séparées par des virgules ; secret de 12 caractères minimum |
| `OATHRION_CONSOLE_USERS` | Identités humaines console | format `email:rôle:mot_de_passe` (ou utiliser `npm run bootstrap:admin`) |

Au moins une identité ou un compte amorcé doit être défini, sinon personne ne peut agir.

Rôles valides : `viewer` (lecture), `operator` (lecture + exécution),
`approver` (lecture + approbation), `admin` (tout). Un rôle inconnu n'est pas
accepté au démarrage.

Les secrets suivants sont refusés explicitement, quelle que soit leur longueur :
`placet-demo`, `placet-dev-key`, `changeme`, `change-me`, `password`,
`secret`, `admin`, `test`.

### 4.1bis Plafonds du limiteur de débit

Facultatifs : sans eux, les valeurs livrées s'appliquent, identiques à ce qui était codé
en dur auparavant. Une valeur invalide **refuse le démarrage** en nommant la variable.

| Variable | Défaut | Bornes |
| --- | --- | --- |
| `RATE_LIMIT_DECISION` | 120 par fenêtre | ≥ 1 |
| `RATE_LIMIT_WRITE` | 30 | ≥ 1 |
| `RATE_LIMIT_APPROVAL` | 60 | ≥ 1 |
| `RATE_LIMIT_WINDOW_MS` | 60000 | 1000 à 3600000 |

Mesurez le trafic attendu de l'agent du client **avant** la mise en service : un agent
qui dépasse le plafond reçoit des 429, et un 429 inattendu ressemble à une panne côté
client. Les plafonds en vigueur sont écrits au démarrage, ligne `[rate-limit]`.

Ils valent pour le **déploiement**, jamais pour un locataire : le plafond contractuel
d'un client est un quota (§ 15), pas une limite de débit.

### 4.1ter Page de métriques

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `OATHRION_METRICS_TOKEN` | *absente* | Jeton exigé par `GET /api/metrics`. **Absente, la route n'est pas montée.** Minimum 32 caractères |

```bash
OATHRION_METRICS_TOKEN=$(openssl rand -hex 32)
```

Trois comportements à connaître, parce que chacun se diagnostique mal sans :

- **Sans la variable, `/api/metrics` n'existe pas.** Elle répond alors exactement ce que
  répond n'importe quelle URL inexistante sous `/api` — 401 sans credential, 404 avec.
  Un collecteur qui reçoit 401 doit faire soupçonner la variable avant le proxy. La ligne
  de démarrage tranche : `metrics: page NOT MOUNTED`.
- **Un jeton de moins de 32 caractères refuse le démarrage**, en nommant la variable. Un
  jeton court n'est pas une protection faible mais une protection qui en a l'air :
  l'exploitant croit sa page fermée, et c'est cette croyance qui est dangereuse. Une
  valeur recopiée de cette documentation (`changeme…`) est refusée quelle que soit sa
  longueur.
- **La page est protégée parce qu'elle porte des comptes.** `/api/live` et `/api/ready`
  sont délibérément ternes — une sonde ne porte aucun credential, donc son corps ne doit
  rien révéler. Une page de métriques est l'exact contraire : c'est le volume d'affaires
  du déploiement. Elle hérite donc de la règle inverse.

Aucune série ne porte d'identifiant de locataire — ni pour la cardinalité, ni pour la
discrétion. Les chiffres **d'un** client se lisent sur ses propres routes
(`GET /api/usage`, `GET /api/actions/receipts/verify`), avec un credential de son
organisation.

La configuration du collecteur, les sept règles d'alerte et les deux lignes de cron sont
dans [`docs/ON-CALL.md`](docs/ON-CALL.md).

### 4.2 Optionnelles et durcissement

| Variable | Défaut | Rôle |
| --- | --- | --- |
| `PORT` | `5000` | Port d'écoute |
| `OATHRION_HOST` | `127.0.0.1` | Adresse d'écoute. `0.0.0.0` dans un conteneur (l'image et les Compose le fixent) ; sur une machine nue, toute autre valeur que la boucle locale expose Oathrion au réseau. IP ou `localhost` seulement. Voir `deploy/README.md`, « Réseau » |
| `NODE_ENV` | — | Mettre `production` ; active HSTS et la CSP stricte |
| `OATHRION_DB` | `data.db` | Chemin du fichier SQLite (développement/tests uniquement) |
| `RATE_LIMIT_FAIL_MODE` | `closed` | Comportement en cas de panne du rate limiter (`closed` = fail-closed 503) |
| `OATHRION_UNDECLARED_ACTION` | `block` | Posture pour verbe non déclaré (`block` = fail-closed par défaut) |
| `OATHRION_MCP_ALLOWED_ORIGINS` | — | Origines autorisées pour MCP HTTP (défaut loopback ; restreindre en prod) |
| `OATHRION_SESSION_TTL_MS` | 12 h | Durée de vie d'une session console |
| `OATHRION_TRUST_PROXY` | `false` | À régler si un reverse proxy est présent (voir §4.3) |
| `OATHRION_TOOL_STALE_MS` | 60 000 | Délai au-delà duquel une exécution d'outil est considérée bloquée |
| `OATHRION_MAX_TOOL_ATTEMPTS` | 5 | Nombre maximal de tentatives d'appel d'outil par exécution (plafond dur : 20) |
| `OATHRION_SHUTDOWN_TIMEOUT_MS` | 15 000 | Délai maximal de drainage à l'arrêt (plafond dur : 120 000) |
| `OATHRION_SEED` | `none` | `none`, `config` ou `demo` (voir §7) |
| `OATHRION_WEBHOOK_URL` | — | Destination des notifications (voir §9) |
| `OATHRION_WEBHOOK_SECRET` | — | Clé de signature du webhook |
| `OATHRION_WEBHOOK_TIMEOUT_MS` | 5 000 | Délai d'attente par livraison |
| `OATHRION_WEBHOOK_ALLOW_PRIVATE` | `false` | Autorise une destination loopback / réseau privé (voir §9) |

### 4.3 Reverse proxy

`OATHRION_TRUST_PROXY` vaut `false` par défaut : l'adresse IP du client est
l'adresse de la connexion TCP. Si un proxy se trouve devant Oathrion, cette
adresse est celle du proxy, et la limitation de débit sur la connexion console
comptera tous les utilisateurs comme un seul.

Réglez la variable selon votre topologie : un entier (nombre de proxies à
traverser, par exemple `1`) ou une expression de sous-réseau reconnue par
Express (par exemple `10.0.0.0/8`).

Ne mettez pas une valeur permissive « au cas où » : un client peut alors
usurper son adresse via l'en-tête `X-Forwarded-For` et échapper à la limitation.

---

## 5. Génération des secrets

N'inventez pas de mots de passe à la main. Générez-les :

```bash
# Secret de session (43 caractères)
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"

# Clé d'API pour un service
node -e "console.log('placet_' + require('crypto').randomBytes(24).toString('base64url'))"

# Mot de passe pour un utilisateur console
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"
```

### Où stocker ces valeurs

Ces secrets sont lus depuis l'environnement du processus. Placez-les dans le
gestionnaire de secrets que votre équipe utilise déjà, ou à défaut dans un
fichier lisible par le seul utilisateur du service :

```bash
sudo install -o placet -g placet -m 600 /dev/null /etc/placet/placet.env
```

**Identité persistante :** les comptes console vivent dans PostgreSQL et leurs mots de passe y sont hachés ; sessions et révocations sont partagées entre répliques. `OATHRION_CONSOLE_USERS` reste un mécanisme d.amorçage/compatibilité, donc sa valeur demeure un secret à protéger comme une clé privée.

---

## 6. Création des identités

Les identités persistantes sont des enregistrements PostgreSQL partagés par les répliques. `OATHRION_API_KEYS` et `OATHRION_CONSOLE_USERS` sont des mécanismes d’amorçage/compatibilité, non le magasin d’identité principal.

```bash
# /etc/placet/placet.env
OATHRION_SESSION_SECRET=<valeur générée en §5>
OATHRION_API_KEYS=Pilot Agent:operator:<clé générée>,Bootstrap:admin:<clé générée>
# L'identifiant de connexion est l'ADRESSE, et le préfixe « Société/ » désigne
# le locataire. Sans préfixe, le compte atterrit dans l'organisation par défaut.
OATHRION_CONSOLE_USERS=Acme/admin@acme.example:admin:<mot de passe>,Acme/approbateur@acme.example:approver:<autre mot de passe>
```

> **Deux comptes ne peuvent pas partager un secret.** Un porteur est reconnu à sa seule
> valeur, donc un secret commun ferait de deux rôles un seul. Le démarrage le refuse,
> en nommant les deux comptes.

Notes vérifiées sur le code :

- le **nom** est l'identité inscrite au journal d'audit. Choisissez des noms que
  vous voudrez lire dans une revue six mois plus tard ;
- le nom du rôle **n'est pas** déductible du secret : c'est le deuxième champ
  qui fait autorité ;
- un agent doit avoir le rôle `operator` au minimum pour soumettre une action.
  Un `viewer` reçoit `403` ;
- créer un agent ou une policy exige le rôle `admin`. Une clé `operator` reçoit
  `403` sur `POST /api/agents`.

### Premier administrateur

Il n'existe **aucun compte par défaut** et aucun mot de passe par défaut : un
identifiant par défaut dans un produit d'approbation est un contournement du
moteur de politique qui attend d'être trouvé.

Deux chemins existent. Le premier est recommandé.

**1. Commande d'amorçage (recommandé).** Le secret n'entre jamais dans
l'environnement du processus, ni dans un fichier, ni dans un argument :

```bash
npm run bootstrap:admin -- --email vous@exemple.com --org "Votre Société"
```

Le mot de passe est demandé sur l'entrée standard, deux fois, masqué. Pour un
provisionnement automatisé, redirigez-le :

```bash
printf '%s' "$OATHRION_BOOTSTRAP_PASSWORD" \
  | npm run bootstrap:admin -- --email vous@exemple.com --org "Votre Société"
```

Il n'existe pas d'option `--password` : un secret passé en argument est visible
dans `ps`, dans `/proc/<pid>/cmdline` et dans l'historique du shell. La commande
intercepte cet argument et refuse de continuer.

Le compte créé porte `password_source = user`, ce qui le rend immunisé contre
`OATHRION_CONSOLE_USERS` : aucun redémarrage ne réécrira son mot de passe.

La commande **refuse** de s'exécuter si l'organisation a déjà un administrateur
actif, ou si l'adresse existe déjà. `--force` lève ce refus et sert uniquement à
récupérer un accès perdu ; l'ancien mot de passe cesse alors de fonctionner et
les sessions ouvertes avec lui sont invalidées.

**2. `OATHRION_CONSOLE_USERS` (déploiements automatisés existants).** Toujours
supporté, mais le mot de passe est alors lisible partout où l'environnement du
processus est lisible : le fichier `.env`, une image de conteneur, une variable
de CI, un cliché de plantage. Préférez le chemin 1.

Vérifiez la connexion — l'adresse est l'identifiant, et **il n'y a pas d'autre champ** :

```bash
curl -s -X POST http://localhost:5000/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"vous@exemple.com","password":"<votre mot de passe>"}'
```

> **Ce document portait ici une commande qui ne pouvait pas fonctionner.** Elle
> envoyait un troisième champ, `"organization":"org_votre_societe"`. Le corps est validé
> par un schéma strict, et la réponse est alors :
>
> ```
> 401 {"code":"invalid_credentials","message":"Invalid credentials"}
> ```
>
> Pas « champ inconnu » : **« identifiants invalides »**. Le refus est délibérément muet
> pour ne pas révéler si un compte existe — c'est le bon choix de sécurité, et c'est
> aussi ce qui envoie l'exploitant vérifier son mot de passe pendant une heure. Le
> locataire ne se nomme pas à la connexion : il est déduit du compte.

La réponse contient `token`, `expiresAt` et `identity`. Le rôle renvoyé dans
`identity.role` doit être `admin`. `organization` est facultatif quand le compte
n'appartient qu'à une seule organisation active ; il est **obligatoire** au-delà,
car une session est liée à exactement un locataire et deviner lequel placerait
la personne dans le mauvais.

### Écrire un secret correctement (« mot de passe incorrect »)

Historiquement, la panne la plus fréquente n'était pas un bug de connexion mais
une ambiguïté de configuration : le serveur démarrait sain, la configuration
validait, et **toutes** les connexions échouaient. Les trois causes sont
désormais refusées au démarrage, avec un message explicite. Le serveur ne
démarre pas tant qu'elles ne sont pas corrigées.

| Ce que vous écrivez | Pourquoi c'est refusé |
| --- | --- |
| `Ops Admin:admin: mon-secret` (espace après le `:`) | Le secret réellement voulu est ambigu. Avant, l'espace était supprimé en silence : la valeur stockée différait de celle de votre fichier `.env`, et chaque connexion échouait sans aucune trace. |
| `Ops Admin:admin:mon,secret` (virgule dans le secret) | La virgule sépare les entrées : le secret est découpé en fragments. Le message nomme désormais la virgule au lieu de se plaindre d'une longueur. |
| Le même secret pour deux identités | La connexion s'effectue sur le mot de passe seul, sans nom d'utilisateur. Deux identités partageant un secret signifie que l'une reçoit silencieusement le rôle de l'autre. |

Ce qui reste **autorisé** :

- les `:` dans un secret (`Ops:admin:a:b:c` → secret `a:b:c`) ;
- les espaces **internes**, donc les phrases de passe (`quatre mots communs pris au hasard`) ;
- les espaces autour du **nom** et du **rôle**, qui ne sont pas des secrets ;
- les retours à la ligne autour d'une entrée, pour écrire la liste sur plusieurs lignes.

Aucun message d'erreur de configuration ne contient de secret, même partiel :
seuls les noms d'identité sont cités.

En cas de doute, entourez la valeur entière de guillemets simples pour empêcher
votre shell d'ajouter des espaces :

```bash
OATHRION_CONSOLE_USERS='Ops Admin:admin:<mot de passe généré>'
```

Aucun repli permissif n'a été ajouté : le mot de passe soumis n'est jamais
nettoyé côté connexion, et il n'existe aucun compte par défaut.

---

## 6bis. Onboarder une entreprise cliente

Cette section est une **transcription** : chaque commande a été exécutée contre le
bundle de production et un PostgreSQL réel, et chaque sortie montrée est celle qui a
été obtenue. Comptez quinze minutes.

Deux choses la rendent moins évidente qu'elle n'en a l'air, et les deux sont des
conséquences assumées de choix de conception :

1. **l'identifiant d'un locataire est opaque et ne se devine pas** (migration 18) ;
2. **une destination doit nommer ses locataires**, donc elle ne peut être déclarée
   qu'après que le locataire existe. D'où un démarrage en deux temps.

### Étape 1 — migrer, avant tout démarrage

```bash
DATABASE_URL=postgres://… node dist/migrate.cjs
# [oathrion:migrate] applied 18 migration(s); the database is at version 18.
```

Oathrion refuse de démarrer sur un schéma en retard ou plus récent que le sien.

### Étape 2 — déclarer le premier administrateur du client

Dans `placet.env`, **avec le préfixe de l'organisation** :

```bash
OATHRION_CONSOLE_USERS=Acme/admin@acme.example:admin:<mot de passe>
```

> **Le piège du premier client.** Sans préfixe, le compte atterrit dans
> l'organisation par défaut, dont l'identifiant est le littéral `org_default` —
> le réservoir d'avant le multi-locataire. C'est visible dans la transcription
> ci-dessous : un compte déclaré sans préfixe a rendu `org_default`, celui
> préfixé a rendu `org_hrogy4n8kywctw4qtb8e`. Sur un déploiement destiné à
> plusieurs entreprises, **préfixez dès le premier client**, y compris le vôtre.

Puis démarrez. À ce stade, aucune destination n'est déclarée, et c'est normal : leurs
identifiants de locataire n'existent pas encore.

### Étape 3 — lire l'identifiant opaque

```bash
TOKEN=$(curl -s -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' \
  -d '{"email":"admin@acme.example","password":"<mot de passe>"}' | jq -r .token)

curl -s "$BASE/api/auth/session" -H "Authorization: Bearer $TOKEN" | jq -r .identity.organizationId
# org_hrogy4n8kywctw4qtb8e
```

Notez cet identifiant : il ne se recalcule pas. Il n'existe **aucune route qui liste
les organisations**, et c'est délibéré — elle livrerait à chaque client le nom de tous
les autres. `npm run bootstrap:admin` l'imprime aussi, si vous avez pris ce chemin.

### Étape 4 — déclarer la destination, puis redémarrer

```bash
OATHRION_DESTINATIONS=[{"id":"acme-erp","url":"https://mcp.erp.acme.example","organizations":["org_hrogy4n8kywctw4qtb8e"]}]
OATHRION_MCP_ALLOWED_DESTINATIONS=https://mcp.erp.acme.example
```

Une entrée sans `organizations` **refuse le démarrage en production** : une destination
sans propriétaire serait utilisable par tous les locataires. Pour une destination en
loopback — un serveur MCP sur la même machine — c'est `OATHRION_LOCAL_MCP_URL`, qui exige
alors `OATHRION_LOCAL_MCP_ORGANIZATIONS`.

Vérifiez le cloisonnement immédiatement :

```bash
curl -s "$BASE/api/actions/destinations" -H "Authorization: Bearer $TOKEN_ACME"
# {"destinations":[{"id":"local-fixture","label":"Local MCP fixture", …}]}
curl -s "$BASE/api/actions/destinations" -H "Authorization: Bearer $TOKEN_AUTRE"
# {"destinations":[]}
```

### Étape 5 — agent, règle, credential

```bash
curl -X POST "$BASE/api/agents"          -H "Authorization: Bearer $TOKEN" …   # 201
curl -X PUT  "$BASE/api/action-policies" -H "Authorization: Bearer $TOKEN" …   # 200
curl -X POST "$BASE/api/keys"            -H "Authorization: Bearer $TOKEN" \
     -d '{"name":"Clé agent","role":"operator","agentId":"agt_pilot"}'         # 201
```

La clé n'est montrée **qu'une fois**. Émettre un credential exige une **session de
console** : une clé d'API ne peut pas en fabriquer d'autres, sans quoi elle serait une
clé d'escalade.

### Étape 6 — la première action, et la preuve

```bash
curl -X POST "$BASE/api/actions/authorize" -H "Authorization: Bearer $CLE" …
# {"decision":"ALLOW","grantId":"grant_…","actionHash":"fc960a13…"}

curl -X POST "$BASE/api/actions/execute" -H "Authorization: Bearer $CLE" …
# {"executed":true,"receiptId":"rcpt_…","outcome":"succeeded"}
```

Puis la seule commande que le client doit connaître — **il vérifie sa propre trace** :

```bash
curl -s "$BASE/api/actions/receipts/verify" -H "Authorization: Bearer $TOKEN"
# {"ok":true,"entries":1,"headHash":"957812c7…","brokenAt":null,"reason":null}
```

### Contrôle final

```bash
ls data.db            # aucun fichier : en production, rien n'écrit en SQLite
```

Et la ligne de démarrage dit ce qui est en vigueur :

```
[quotas]     mode=enforce, defaults: agents=500 policies=500 executions=100000
[rate-limit] fenêtre 60000 ms, decision=120, write=30, approval=60
```

Si un de ces plafonds ne convient pas au trafic attendu de l'agent du client,
réglez-le **avant** la mise en service (§4.1bis) : un 429 inattendu ressemble à
une panne côté client.

### Ce que cette procédure ne couvre pas encore

- **L'invitation n'est pas envoyée par e-mail.** Le jeton est rendu par l'API ; vous le
  transmettez vous-même. Pour un pilote accompagné c'est cinq minutes ; c'est
  intenable à partir du cinquième client.
- **La devise d'un locataire est fixée à sa création** et mise en cache par processus :
  la changer demande un redémarrage, et ne reconvertit aucun montant déjà enregistré.
- **La suspension d'un client** est appliquée à chaque requête mais ne se pose que par
  SQL : aucune route ne l'expose.

Ces trois points disparaissent avec l'API d'administration des locataires, qui est
l'étape suivante du chantier 1 et n'est volontairement pas faite tant qu'il n'y a pas
assez de clients pour que l'onboarding manuel coûte plus cher que son automatisation.

---

## 6ter. Brancher les outils du client

Le §6bis onboarde un locataire. Celui-ci le branche sur **ses** outils — l'autre moitié
du chemin, et la promesse commerciale elle-même : « Oathrion décide et trace, vos outils
restent les vôtres ».

### Ce que le client doit écrire

Un serveur MCP qui répond à trois méthodes : `initialize`, `tools/list`, `tools/call`.
Rien de plus. Un exemple complet et exécutable, qui n'importe **rien** d'Oathrion, est livré
dans [`examples/mcp-server/`](examples/mcp-server/README.md) — une page de `node:http`,
à lire comme un cahier des charges plutôt que comme une dépendance.

Les trois points sur lesquels une intégration se trompe, dans l'ordre de fréquence :

| | |
| --- | --- |
| **La révision du protocole** | Oathrion envoie `MCP-Protocol-Version: 2026-07-28` et rien d'autre. Un serveur permissif laisse passer un client d'une autre révision, et le désaccord ressort beaucoup plus tard, sur un champ. Refusez l'en-tête absent ou différent. |
| **Un refus métier n'est pas une panne** | `isError: true` **dans** le `result`, jamais une erreur de transport. Oathrion écrit alors un reçu `outcome: "failed"`, consomme le grant et **ne réessaie pas**. Un refus signalé en 500 est enregistré comme un incident d'exécution. |
| **L'idempotence est chez le client** | ARIA garantit qu'un grant n'est consommé qu'une fois. Il ne peut pas garantir qu'un effet chez un tiers n'a lieu qu'une fois : si votre serveur débite et que la réponse se perd, ARIA voit un échec. La clé arrive dans `X-ARIA-Execution-Id` (forme `axn_<32 hex>`) et dans le `id` JSON-RPC (`aria-<clé>`). Stockez-la dans la **même transaction** que l'effet, avec une contrainte d'unicité. |

### Déclarer la destination

Pour un serveur du client joignable par le réseau, c'est `OATHRION_DESTINATIONS` (§6bis,
étape 4). Pour un serveur sur la même machine — le cas d'un pilote — c'est la paire :

```bash
OATHRION_LOCAL_MCP_URL=http://127.0.0.1:7801/
OATHRION_LOCAL_MCP_ORGANIZATIONS=org_hrogy4n8kywctw4qtb8e
```

`OATHRION_LOCAL_MCP_ORGANIZATIONS` est **obligatoire en production**. Sans elle, la
destination serait enregistrée pour tous les locataires sans que personne ne l'ait
déclaré — c'est le défaut qu'elle ferme.

### La preuve, avant de livrer

```bash
npm run build
DATABASE_URL=postgres://user:pass@host:5432/postgres npm run verify:mcp
# 37/37 contrôles passés
```

Ce harnais démarre le **bundle livré** en `NODE_ENV=production` sur PostgreSQL, pointe
`OATHRION_LOCAL_MCP_URL` sur `examples/mcp-server/`, et mesure le parcours complet contre un
serveur qui ne partage **aucune ligne** avec Oathrion : ALLOW atteint l'outil exactement une
fois · BLOCK jamais, et sans délivrer de grant · APPROVAL_REQUIRED rien avant l'humain,
puis une fois et pas deux · un grant rejoué est refusé avec le bon code · un refus métier
donne un reçu `failed` sans nouvel essai · et les en-têtes sont vérifiés tels que le
serveur tiers les a reçus.

Pourquoi un serveur indépendant plutôt que la fixture du dépôt : jusqu'ici tout le chemin
aval était prouvé contre `server/mcp-local/`, écrit par la même main que la passerelle.
Une mélecture partagée du protocole aurait rendu les deux côtés verts **et faux ensemble**.

Ce que cela ne prouve pas : qu'un serveur MCP tiers *quelconque* fonctionne. Un serveur
indépendant écarte la mélecture partagée ; il n'écarte pas un désaccord avec une
implémentation particulière du marché. Prévoyez une demi-journée d'intégration avec le
premier fournisseur réel du pilote.

### Brancher l'outil du client — sans toucher au code

`verify:mcp` ci-dessus prouve le **transport**. Il reste la question qu'un pilote pose
en premier : « comment mon verbe `refund` appelle-t-il `refunds.create` chez moi ? » La
réponse est `OATHRION_TOOLS`, lu dans l'environnement comme les destinations :

```bash
OATHRION_TOOLS='[{"id":"acme_refund","label":"Acme refunds","destination":"acme-erp",
  "tool":"refunds.create","actions":["refund"],
  "arguments":{"customer":"target","amount":"metadata.amount","currency":"currency"}}]'
```

| | |
| --- | --- |
| `destination` | Un identifiant du registre de l'étape 4. **Même porte, mêmes règles** : l'allowlist et les règles d'adresse s'appliquent sans changement, et une déclaration n'ouvre aucune nouvelle surface sortante. Un identifiant absent du registre **arrête le démarrage**, en listant ceux qui existent. |
| `tool` | Le nom que **le fournisseur** donne à son outil. Volontairement distinct du verbe : `refund` est ce qu'Oathrion gouverne, `refunds.create` est ce que le fournisseur écoute. |
| `actions` | Les verbes servis. Un verbe absent de `shared/policy/actions.ts` est refusé au démarrage — c'est cette entrée qui fait appliquer la portée de permission, le plafond de mandat et l'allowlist de domaine. Un outil déclaré qui revendique un verbe déjà câblé le **remplace** : c'est l'effet voulu. |
| `arguments` | `{ nom chez le fournisseur: source chez Oathrion }`. Les sources permises sont `target`, `currency`, `agentId`, `agentName`, `action`, `executionId`, `metadata.<clé>` — rien d'autre, et une source inconnue arrête le démarrage. Oathrion **projette**, il ne devine jamais : inventer le contenu d'une instruction qu'il signe est la seule chose qu'un connecteur générique ne doit pas faire. |

`GET /api/tools` rend, par outil, s'il est simulé et quels verbes il sert — de quoi
confirmer qu'une déclaration a pris effet sans passer d'appel.

```bash
npm run build
DATABASE_URL=postgres://user:pass@host:5432/postgres npm run verify:tools
# 41/41 contrôles passés
```

Ce harnais déclare un outil que le dépôt ne connaît pas, le pointe sur
`examples/mcp-server/`, et mesure : l'appel arrive sous le nom d'outil **du
fournisseur** · les arguments reçus sont **exactement** la projection déclarée, pas un
champ de plus · la devise transmise est celle du locataire, pas une littérale · la clé
d'idempotence reçue **est** l'identifiant d'exécution qu'Oathrion annonce · un BLOCK
n'atteint personne · une action retenue n'atteint le fournisseur qu'après l'humain · et
un argument déclaré sans valeur **arrête la dépêche** au lieu d'envoyer une instruction
à moitié remplie.

Ce que cela ne prouve pas : qu'un fournisseur du marché est branché par CETTE voie.
Et une déclaration ne sait pas transformer une valeur — ni formater, ni convertir une
unité, ni poser un défaut. Un fournisseur qui attend des centimes là où Oathrion détient
des unités demande un adaptateur devant lui ; voir `docs/limitations.md`.

### 6ter. Connecter GitHub — un connecteur réel, pas une déclaration

`OATHRION_TOOLS` branche n'importe quel serveur MCP. Un CONNECTEUR fait ce qu'un MCP
générique ne peut pas : distinguer un quota dépassé d'une permission manquante, lire les
portées réelles d'un jeton, dire quelles capacités sont indisponibles et pourquoi. Il y en
a un dans ce build, et c'est GitHub.

**1. La clé du coffre, d'abord.** Un connecteur stocke un credential, donc il lui faut une
clé de chiffrement. Sans elle la connexion répond **503** en nommant la variable — Oathrion
ne garde jamais un jeton en clair, pas même en attendant :

```bash
OATHRION_KEK=$(node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))")
```

**2. Le jeton GitHub**, à portée fine, sur votre dépôt de test seulement :
<https://github.com/settings/personal-access-tokens/new> → *Repository access* → votre
dépôt → *Repository permissions* → `Issues: Read and write`, `Metadata: Read-only`.
N'accordez rien d'autre.

**3. Dans la console**, écran **Connecteurs** → collez le jeton → **Connecter**. Oathrion le
vérifie contre GitHub **avant** de le stocker : un jeton refusé ne laisse aucune ligne.
Il est ensuite scellé en AES-256-GCM, jamais réaffiché, et seuls six caractères de son
SHA-256 sont montrés pour que vous le reconnaissiez.

**4. Le mandat de l'agent** doit lister `github.com` dans `allowedDomains`, et l'agent doit
détenir `write:repository`. Les cibles s'écrivent `github.com/owner/repo` — l'hôte est
obligatoire parce que c'est lui que l'allowlist de domaine du mandat autorise. C'est cette
barrière qui décide où un agent peut agir.

| | |
| --- | --- |
| **Ce qu'Oathrion contrôle** | ALLOW atteint GitHub une fois · BLOCK jamais · APPROVAL_REQUIRED rien avant l'humain, puis une fois · un rejet jamais · un locataire n'atteint pas le connecteur d'un autre. Mesuré par `server/test/connector-control-point.test.ts` |
| **Ce qu'Oathrion ne contrôle pas** | Un agent qui détient SON PROPRE jeton GitHub appelle l'API directement et Oathrion ne voit rien. Le contrôle existe parce que le credential ne vit que dans le coffre : c'est une propriété de votre déploiement, pas une garantie du logiciel |
| **Déconnecter** | Oathrion écrase l'enveloppe et refuse les actions suivantes. GitHub, lui, **considère le jeton toujours valide** : aucune API ne permet à un tiers de l'annuler. Supprimez-le sur <https://github.com/settings/tokens>. La console le dit en rouge |

```bash
npm run verify:github
# 12/12 sans jeton — appels réels, sortie 2 (« impossible à mettre en place »)

OATHRION_GITHUB_TEST_TOKEN=github_pat_… OATHRION_GITHUB_TEST_REPO=vous/depot-de-test \
  npm run verify:github
# le parcours complet : compte réel, capacités, lecture, issue, commentaire, 404, révocation
```

L'inventaire complet — chaque chemin vers un système extérieur, son classement et la
commande qui le vérifie — est dans **`docs/connectors.md`**.

---

## 6quater. Deux surfaces sur un seul domaine

Depuis l'ajout du site public, le serveur sert **deux documents distincts** :

| Chemin | Document | Qui le lit |
|---|---|---|
| `/`, `/pilot`, `/developers`… | le site public (`dist/public/site/index.html`) | un visiteur |
| `/console`, et tout ce qui commence par `/console/` | la console d'exploitation (`dist/public/index.html`) | vous |

**La console a changé d'adresse.** Elle était à la racine ; elle est désormais sur
`/console`, et son routage interne reste par hash — donc `/console#/dashboard`,
`/console#/approvals`. Mettez à jour vos signets et tout lien que vous auriez partagé.

Pourquoi ce découpage plutôt qu'une seule application : la console et le site n'ont ni le
même public, ni les mêmes dépendances. Deux entrées Vite produisent deux bundles, et un
visiteur venu lire une page ne télécharge pas la console — mesuré, le site charge 87 ko de
code applicatif contre 190 ko pour la console, sans sa bibliothèque de graphiques (404 ko)
ni ses primitives d'interface (113 ko).

Si `dist/public/site/index.html` n'existe pas — une installation bâtie avant l'existence
du site — la racine sert la console comme avant. L'absence du site n'est pas une panne.

---

## 7. Initialisation de la base de données

En production, PostgreSQL doit être migré **avant** le démarrage des répliques : `DATABASE_URL=... node dist/migrate.cjs` (bundlé par `npm run build`, fonctionne sans tsx ni sources, donc aussi dans l'image Docker : `docker run --rm -e DATABASE_URL=... placet node dist/migrate.cjs`). Depuis les sources, `npm run migrate:postgres` fait la même chose. L.application vérifie `schema_migrations` au démarrage et refuse un schéma absent ou en retard. `OATHRION_DB` ne concerne que développement et tests SQLite.

**Un pilote démarre avec un registre vide.** C'est le comportement voulu et il
a été vérifié : sans `OATHRION_SEED`, `GET /api/agents`, `GET /api/executions`,
`GET /api/approvals` renvoient des listes vides et `GET /api/audit` renvoie
`{"total":0,"events":[]}`.

`OATHRION_SEED` accepte trois valeurs :

| Valeur | Effet | Usage |
| --- | --- | --- |
| `none` (défaut) | Aucune donnée insérée | **Pilote** |
| `config` | Insère les agents et policies de référence | Développement |
| `demo` | Insère en plus un historique d'exécutions fictif | Démonstration uniquement |

N'utilisez ni `config` ni `demo` en pilote. Les données insérées sont
inventées ; elles fausseraient toute mesure tirée du pilote.

### Créer les premiers agents et policies

Créez la policy d'organisation d'abord, puis l'agent qui la référence. Les deux
appels exigent une clé `admin`. Les corps ci-dessous sont ceux qui ont été
acceptés par le serveur (`201`) ; les schémas sont stricts et rejettent tout
champ inconnu avec un `400` décrivant le premier problème.

```bash
ADMIN=<votre clé admin>

curl -s -X POST http://localhost:5000/api/policies \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{
  "id": "pol_cap",
  "name": "Organisation spend ceiling",
  "description": "No single purchase above 1000 EUR, whatever the agent mandate allows.",
  "type": "MAX_TRANSACTION_AMOUNT",
  "condition": { "kind": "amountAtMost", "max": 1000, "currency": "EUR" },
  "scope": "organization",
  "appliesTo": "All agents",
  "effect": "block",
  "status": "enabled",
  "action": "BLOCK",
  "risk": "high",
  "priority": 40
}'

curl -s -X POST http://localhost:5000/api/agents \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{
  "id": "agt_pilot",
  "name": "Pilot Agent",
  "description": "Procurement agent for the internal pilot.",
  "provider": "openai",
  "model": "gpt-4o",
  "status": "active",
  "owner": "Ops Admin",
  "mandate": {
    "maxTransactionAmount": 500,
    "currency": "EUR",
    "allowedCategories": ["Software"],
    "blockedCategories": [],
    "allowedDomains": ["vendor.example.com"]
  },
  "permissions": [],
  "policyIds": ["pol_cap"],
  "tags": []
}'
```

### Une seule unité de compte

La devise de l'organisation est **EUR** et il n'y a **aucune conversion de
change**. Si une policy ou un mandat déclare une autre devise que celle de
l'organisation, la limite est considérée comme inapplicable et l'action est
refusée plutôt qu'évaluée sur des montants non comparables. Déclarez tout en
EUR pour le pilote.

---

## 8. Démarrage

### Lancement manuel

```bash
set -a && . /etc/placet/placet.env && set +a
npm start
```

Le serveur écrit `serving on port <PORT>` quand il est prêt.

### Service systemd

```ini
# /etc/systemd/system/placet.service
[Unit]
Description=Oathrion control plane
After=network.target

[Service]
Type=simple
User=placet
WorkingDirectory=/opt/placet
EnvironmentFile=/etc/placet/placet.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node dist/index.cjs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now placet
sudo journalctl -u placet -f
```

`WorkingDirectory` est indiqué par prudence, mais le serveur localise la console
web par rapport à son propre fichier : il démarre même si le répertoire courant
est ailleurs.

### Plafond de tentatives

Une exécution dont l'outil échoue peut être relancée, mais pas indéfiniment.
`OATHRION_MAX_TOOL_ATTEMPTS` fixe le nombre total de tentatives par exécution ;
au-delà, `POST /api/executions/:id/retry` répond **409** en indiquant le plafond
atteint, et l'exécution reste en `failed`.

Ce plafond n'est pas un réglage de confort. Sans lui, un outil de paiement qui
échoue *après* avoir déjà débité peut être relancé sans limite : l'argent part
plusieurs fois et la piste d'audit enregistre plusieurs tentatives d'une action
que l'opérateur croit unique.

Le plafond est appliqué **dans la clause `WHERE` du verrou SQL**, pas dans la
route : un futur appelant qui contournerait la route ne peut pas contourner le
plafond. Une valeur invalide ou absente retombe sur 5 — jamais sur « illimité ».
Le maximum accepté est 20 ; au-delà, la valeur est ramenée à 20.

### Arrêt gracieux

À la réception de `SIGTERM` ou `SIGINT` :

1. `/api/health` répond immédiatement **503** avec `checks.accepting.ok = false`.
   Le répartiteur de charge cesse d'envoyer du trafic **avant** la fermeture de
   la socket ; sans cette fenêtre, les clients reçoivent des `connection reset`
   à chaque déploiement.
2. Le serveur cesse d'accepter de nouvelles connexions et attend la fin des
   réponses en cours. Les connexions keep-alive inactives sont fermées.
3. Les handles de persistance sont fermés proprement. En production, cela ferme le worker d’identité PostgreSQL et les pools ; la procédure SQLite/WAL ne concerne que développement et tests.
4. Si le drainage dépasse `OATHRION_SHUTDOWN_TIMEOUT_MS`, le processus sort en
   code **1** avec une ligne de journal expliquant pourquoi.

Pourquoi cela compte ici plus qu'ailleurs : un `SIGTERM` reçu pendant un appel
d'outil signifie qu'un effet réel a pu avoir lieu — un paiement, un e-mail —
sans que l'entrée d'audit ni le statut final soient écrits. L'exécution reste
`running` et la trace de l'action manque.

Réglez la période de grâce de l'orchestrateur **au-dessus** de
`OATHRION_SHUTDOWN_TIMEOUT_MS`, sinon le `SIGKILL` arrive avant la fin du
drainage et le délai ne sert à rien. Avec systemd :

```ini
# à ajouter dans [Service]
KillSignal=SIGTERM
TimeoutStopSec=30
```

Un second signal pendant un drainage est ignoré : il ne relance pas le drainage
et ne réarme pas le délai.

### Rejets et exceptions non gérés

Une promesse rejetée sans gestionnaire, ou une exception non capturée, déclenche
le même drainage puis une sortie en code **1**. Le processus ne continue pas à
servir : à ce stade son état est inconnu, et servir des actions gouvernées depuis
un état inconnu est pire qu'un redémarrage. Avec `Restart=on-failure`, systemd
relance le service ; l'écran de reprise ci-dessous s'applique alors.

### Sondes : vivacité et disponibilité sont deux questions différentes

Les trois points d'entrée sont publics — une sonde n'a pas de justificatif — et
aucun ne révèle de version, de chemin de fichier, de nom d'hôte, d'état de schéma
ni de compteur de données. Le détail d'une erreur va uniquement dans le journal
serveur.

| Point d'entrée | Question | Échoue quand |
| --- | --- | --- |
| `GET /api/live` | Ce processus doit-il être redémarré ? | Jamais, tant que le processus répond |
| `GET /api/ready` | Cette instance doit-elle recevoir du trafic ? | Base injoignable, ou arrêt en cours |
| `GET /api/health` | Alias historique de `/api/ready` | Idem `/api/ready` |

**Cette version corrige une consigne erronée.** Cette section disait « utilisez
`/api/health` à la fois comme sonde de vivacité et de disponibilité », et le §14
répondait « le service est-il vivant ? → `GET /api/health` ». Or `/api/health`
interroge la base et renvoie `503` quand elle est injoignable. Suivez cette
consigne dans un `livenessProbe` Kubernetes et la panne s'amplifie d'elle-même :

1. la base devient injoignable (bascule, volume plein, coupure réseau) ;
2. toutes les instances répondent `503` ;
3. le kubelet en conclut que tous les conteneurs sont morts et les redémarre ;
4. chaque redémarrage rejoue les migrations au démarrage contre la base déjà en
   difficulté, et jette les requêtes en vol qui auraient survécu.

Un redémarrage ne répare pas une dépendance extérieure au conteneur. La règle :
**une sonde de vivacité ne doit échouer que pour une cause qu'un redémarrage peut
réellement corriger.** Tout le reste relève de la disponibilité.

`/api/live` répond `200` même pendant un drainage, et c'est volontaire : un `503`
à ce moment ferait tuer le conteneur en pleine extinction propre, ce qui annule
exactement ce que `server/lifecycle.ts` protège — un appel d'outil gouverné ne
doit pas être coupé entre son effet réel et son entrée d'audit.

Réponses de `/api/ready` :

| Réponse | Signification |
| --- | --- |
| `200` `{"status":"ok"}` | Base joignable, instance acceptant du trafic |
| `503` `checks.database.ok = false` | Base injoignable ou schéma absent |
| `503` `checks.accepting.ok = false` | Arrêt en cours (déploiement, drainage) |

Les deux indicateurs restent séparés pour qu'un opérateur distingue un
déploiement d'une panne réelle de dépendance.

```bash
curl -fsS http://127.0.0.1:5000/api/live     # le processus répond-il
curl -fsS http://127.0.0.1:5000/api/ready    # doit-il recevoir du trafic
```

Kubernetes :

```yaml
livenessProbe:
  httpGet: { path: /api/live, port: 5000 }
  periodSeconds: 10
  failureThreshold: 3
readinessProbe:
  httpGet: { path: /api/ready, port: 5000 }
  periodSeconds: 5
  failureThreshold: 2
startupProbe:
  # Les migrations tournent au démarrage : laissez-leur le temps avant que le
  # livenessProbe ne commence à compter des échecs.
  httpGet: { path: /api/live, port: 5000 }
  periodSeconds: 5
  failureThreshold: 12
# Doit rester supérieur à OATHRION_SHUTDOWN_TIMEOUT_MS (15 s par défaut).
terminationGracePeriodSeconds: 30
```

`/api/health` est conservé tel quel : il est référencé par des déploiements
existants, et le renommer aurait fait passer chaque instance en état malsain au
moment de prendre cette version.

### Identifiant de corrélation

Chaque réponse porte un en-tête `X-Request-Id`, et chaque erreur le répète dans
son corps (`requestId`). Il apparaît en tête de la ligne de journal de la requête
et de la trace d'exception correspondante — c'est la clé qui relie les deux :

```
[req_9f1c…] POST /api/execute 500 in 42ms
[req_9f1c…] [api] POST /api/execute Error: …
```

Un utilisateur qui signale une erreur cite cet identifiant ; vous le cherchez
dans le journal. Un `X-Request-Id` fourni par un proxy est repris s'il est
sûr, et **remplacé** sinon : la valeur est écrite dans les journaux, donc un
retour à la ligne injecté y forgerait des lignes entières. L'identifiant est une
clé de corrélation, jamais une preuve d'identité : rien dans le système ne prend
de décision à partir de lui.

### Codes d'erreur stables

Toute erreur renvoie `{ error, message, code, requestId }`. `code` est le
contrat : `unauthenticated`, `invalid_credentials`, `forbidden_capability`,
`not_found`, `bad_request`, `rate_limited`, `login_throttled`, `internal_error`,
`unavailable`, `conflict`, `unsupported_api_version`. Les textes `error` et `message` sont écrits pour un
humain et peuvent être reformulés — n'y accrochez aucune logique. Un code inconnu
doit être traité comme « erreur de ce statut HTTP » : de nouveaux codes seront
ajoutés avec les conditions qui les produisent.

### Versionnage de l'API — ce qu'un exploitant doit savoir

Deux préfixes servent **le même code** : `/api/v1/...` (version épinglée, recommandée aux
intégrations) et `/api/...` (alias implicite de la version courante, **non déprécié**).
Détail complet et politique de dépréciation : README §12.0.

Conséquences concrètes pour un déploiement :

- **Aucune action requise sur un déploiement existant.** Les chemins non versionnés
  fonctionnent à l'identique. Le `HEALTHCHECK` du `Dockerfile`, vos sondes, vos runbooks et
  vos intégrations actuelles restent valides sans modification.
- **Les sondes répondent sous les deux formes**, sans identifiant :
  `/api/live` et `/api/v1/live`, `/api/ready` et `/api/v1/ready`. Une sonde de vivacité
  pointée sur la forme versionnée ne reçoit pas `401` — c'est vérifié par un test dédié,
  parce qu'un `401` sur une sonde de vivacité fait redémarrer des instances saines pendant
  une panne de dépendance.
- **Les quotas sont partagés** entre les deux préfixes. Un appelant ne double pas son
  allocation en alternant les formes. Si vous mesuriez un trafic par chemin, notez que
  deux écritures de chemin désignent désormais la même route.
- **Les lignes de journal** conservent la forme que l'appelant a réellement utilisée, ce
  qui permet de mesurer combien d'intégrations sont encore non versionnées avant
  d'envisager une `v2`.
- **Une version non servie** (`/api/v2/...`) répond `404` avec
  `code: "unsupported_api_version"`, `requestedVersion` et `supportedVersions`. Dans un
  ticket, ce code désigne une erreur de configuration du client, pas un problème de
  droits ni un chemin inexistant.

### Reprise après incident

Au démarrage, toute exécution restée à l'état `running` — signe que le processus
s'est arrêté pendant un appel d'outil — est basculée en `failed`. Une exécution
interrompue n'est jamais reprise silencieusement.

---

## 9. Configuration du webhook

Le webhook est **optionnel**. Sans `OATHRION_WEBHOOK_URL`, aucun canal n'est
enregistré et rien n'est envoyé.

```bash
OATHRION_WEBHOOK_URL=https://interne.exemple.org/placet/events
OATHRION_WEBHOOK_SECRET=<valeur générée comme en §5>
OATHRION_WEBHOOK_TIMEOUT_MS=5000
```

Comportement vérifié :

- l'URL est validée au démarrage (schéma, hôte, adresse). Si elle est refusée,
  la raison est journalisée et **aucun canal n'est enregistré** — le serveur
  démarre quand même, mais rien n'est envoyé (échec fermé, jamais permissif) ;
- trois événements sont émis : `approval.requested`, `action.blocked`,
  `approval.resolved` ;
- l'émission a toujours lieu **après** l'écriture durable de la décision. Une
  décision n'attend pas la notification ;
- si le destinataire est absent, lent ou répond par une erreur, **la décision
  est inchangée**. L'échec est enregistré comme livraison échouée, pas propagé ;
- la requête est abandonnée au-delà du délai configuré.

### Destinations refusées (protection SSRF)

Ce canal est un client HTTP **signé, exécuté côté serveur, à l'intérieur de la
frontière de confiance du plan de contrôle**. Celui qui décide de son URL décide
de ce que le plan de contrôle contacte. Auparavant, la seule validation était
`/^https?:\/\//`, ce qui acceptait `http://169.254.169.254/` — le service de
métadonnées d'instance, qui distribue des identifiants IAM à tout processus
capable d'émettre une requête depuis l'hôte. Comme chaque décision approuvée ou
bloquée est envoyée à cette URL, le canal était aussi un chemin d'exfiltration.

Sont désormais refusés :

| Catégorie | Exemples |
| --- | --- |
| Schémas non HTTP | `file:`, `gopher:`, `ftp:`, `data:` |
| Identifiants dans l'URL | `http://admin:secret@hôte/` |
| Loopback | `localhost`, `127.0.0.0/8`, `::1`, `::ffff:127.0.0.1`, `127.1`, `2130706433` |
| Adresse non spécifiée | `0.0.0.0`, `::` |
| Métadonnées cloud | `169.254.169.254`, `metadata.google.internal`, `instance-data` |
| Link-local | `169.254.0.0/16`, `fe80::/10` |
| Réseaux privés | `10/8`, `172.16/12`, `192.168/16`, `100.64/10`, `fc00::/7` |
| Suffixes internes réservés | `.local`, `.internal`, `.localhost`, `.home.arpa` |

Deux couches, parce qu'aucune ne suffit seule :

1. **validation de la chaîne**, une fois à l'enregistrement, pour que la
   configuration échoue bruyamment au démarrage et non silencieusement à la
   première notification attendue ;
2. **vérification de l'adresse au moment de la connexion**, appliquée à *chaque*
   adresse résolue. Un nom d'hôte n'est pas une adresse : un enregistrement DNS
   contrôlé par un attaquant peut renvoyer une adresse publique au premier appel
   et `127.0.0.1` au suivant (*DNS rebinding*). Seule une vérification dans le
   chemin de connexion ne peut pas être contournée par cette course.

De plus, **les redirections ne sont pas suivies**. `fetch` les suit par défaut,
donc un hôte public validé répondant `302 Location: http://169.254.169.254/`
atteignait le service de métadonnées alors que tous les contrôles préalables
avaient réussi. Une réponse `3xx` est désormais rapportée telle quelle et
comptée comme livraison non réussie — un destinataire de webhook qui redirige
est mal configuré. Le corps de réponse est également plafonné (64 kio) puis
ignoré, pour qu'un destinataire hostile ne puisse pas faire croître la mémoire
du processus.

### Destination locale volontaire

Certains déploiements font tourner le destinataire sur le même hôte. C'est
légitime, mais cela doit être un choix explicite :

```bash
OATHRION_WEBHOOK_URL=http://127.0.0.1:9000/placet/events
OATHRION_WEBHOOK_ALLOW_PRIVATE=true
```

La valeur doit valoir exactement `true`. Elle n'est **jamais déduite** de l'URL :
la déduire signifierait que la protection se désactive elle-même précisément
quand elle est nécessaire. Les contrôles de schéma et d'identifiants restent
appliqués dans tous les cas.

### Vérifier la signature côté destinataire

Chaque requête porte :

| En-tête | Contenu |
| --- | --- |
| `X-ARIA-Event` | Type d'événement |
| `X-ARIA-Delivery` | Identifiant de livraison, pour la déduplication |
| `X-ARIA-Signature` | `sha256=<hex>` — HMAC-SHA256 du corps brut |

Le destinataire doit recalculer le HMAC sur le **corps brut**, avant tout
décodage JSON, et comparer en temps constant :

```js
const expected = "sha256=" + crypto.createHmac("sha256", SECRET).update(rawBody).digest("hex");
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(received));
```

Si `OATHRION_WEBHOOK_SECRET` n'est pas défini, aucune signature n'est envoyée et
le destinataire ne peut pas authentifier l'appel. Définissez-le.

### Traçabilité

`GET /api/notifications` (rôle `read`) renvoie les canaux enregistrés et les
50 dernières livraisons, chacune avec son résultat. C'est là qu'on regarde
quand une équipe dit ne rien recevoir.

---

## 10. Vérification après installation

À faire une fois, avant d'ouvrir le pilote. Toutes ces réponses ont été
observées sur une installation neuve.

```bash
OP=<clé operator>
BASE=http://localhost:5000
```

**1. Le service répond**

```bash
curl -s $BASE/api/health          # {"status":"ok"}
```

**2. L'authentification est exigée**

```bash
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/agents        # 401
```

**3. Les en-têtes de sécurité sont présents**

```bash
curl -sI $BASE/ | grep -iE 'content-security-policy|x-frame-options|x-content-type|strict-transport'
```

**4. Le scénario de décision**

Avec l'agent et la policy du §7 :

```bash
decide () {
  curl -s -X POST $BASE/api/executions -H "Authorization: Bearer $OP" \
    -H 'Content-Type: application/json' -d "$1"
}

decide '{"agentId":"agt_pilot","action":"purchase","target":"vendor.example.com","amount":40,"currency":"EUR","category":"Software"}'
decide '{"agentId":"agt_pilot","action":"purchase","target":"vendor.example.com","amount":700,"currency":"EUR","category":"Software"}'
decide '{"agentId":"agt_pilot","action":"purchase","target":"vendor.example.com","amount":1500,"currency":"EUR","category":"Software"}'
decide '{"agentId":"agt_pilot","action":"purchase","target":"vendor.example.com","amount":40,"currency":"EUR","category":"Cryptocurrency"}'
```

Résultats attendus :

| Cas | `decision` | `executed` | `toolId` |
| --- | --- | --- | --- |
| 40 € | `ALLOW` | `true` | `purchase_tool` |
| 700 € | `APPROVAL_REQUIRED` | `false` | absent |
| 1 500 € | `BLOCK` | `false` | absent |
| Catégorie hors mandat | `BLOCK` | `false` | absent |

L'absence de `toolId` dans les trois derniers cas est le point à contrôler :
c'est la preuve qu'aucun outil n'a été appelé.

**5. Le journal d'audit est renseigné**

```bash
curl -s -H "Authorization: Bearer $OP" "$BASE/api/audit?limit=20"
```

Vérifiez que le champ `actor` porte le nom de l'identité authentifiée. Ce nom
est dérivé côté serveur du secret présenté ; un client ne peut pas le choisir.
Envoyer un champ `actor` dans un corps de requête produit un `400`.

---

## 11. Rotation et révocation des identités

Les utilisateurs, organisations, memberships, sessions, clés d.API et révocations vivent dans PostgreSQL et sont partagés entre répliques. Les opérations persistantes prennent effet sans redémarrage ; les variables d.environnement ne servent qu.à l.amorçage/compatibilité.

### Ajouter ou retirer une identité

Émettez, gérez et révoquez les identités persistantes via les routes d.administration. Modifiez les variables d.environnement seulement pour les identités d.amorçage existantes ; cela nécessite alors un redémarrage contrôlé.

### Révoquer une session console sans redémarrer

Les sessions console sont stockées en base et peuvent être révoquées une par
une, sans interruption de service :

```bash
curl -s -H "Authorization: Bearer $ADMIN" $BASE/api/auth/sessions
curl -s -X DELETE -H "Authorization: Bearer $ADMIN" $BASE/api/auth/sessions/<id>
```

### Changer le secret de session

Modifier `OATHRION_SESSION_SECRET` invalide **toutes** les sessions console en
cours : les jetons existants ne vérifient plus. C'est le levier à utiliser en
cas de compromission. Les clés d'API ne sont pas affectées.

### En cas de fuite d'une clé d'API

1. révoquez la clé via l.API d.administration des clés d.API ;
2. vérifiez depuis une autre réplique que la même clé est rejetée ;
3. relisez `GET /api/audit` en filtrant sur le nom porté par cette clé pour établir ce qui a été fait avec.

Ne retirez pas une clé persistante uniquement de `OATHRION_API_KEYS` : ce fichier ne remplace pas la révocation PostgreSQL.

---

## 12. Sauvegarde et restauration (PostgreSQL)

En production, la persistance repose sur PostgreSQL. Le journal d'audit chaîné,
les comptes, les clés d'API, les décisions et les Action Grants sont stockés
dans la base de données PostgreSQL (`DATABASE_URL`).

### Sauvegarde à chaud (pg_dump)

Pour un snapshot cohérent sans interruption de service (format personnalisé compressé) :

```bash
pg_dump -Fc -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "/var/backups/placet-$(date +%F-%H%M).dump"
```

Automatisation recommandée (cron horaire) :

```cron
15 * * * * pg_dump -Fc -h 127.0.0.1 -U postgres -d placet -f "/var/backups/placet-$(date +\%F-\%H).dump"
```

> **RPO / RTO :** Pour un RPO tendant vers zéro, configurez l'archivage continu des
> WAL PostgreSQL (`archive_mode = on`, `archive_command = '...'`) ou un outil tel que
> `pgBackRest` / `WAL-G`. Avec un dump horaire, le RPO maximal est de 1 heure.
> Le RTO (restauration d'un dump) est généralement de l'ordre de 1 à 3 minutes.

### Restauration

Pour restaurer une sauvegarde dans un environnement de test ou de reprise :

```bash
# 1. Arrêter les répliques Oathrion
sudo systemctl stop placet

# 2. Restaurer la base avec pg_restore
pg_restore -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" --clean --if-exists "/var/backups/placet-2026-09-06-1400.dump"

# 3. Vérifier les migrations appliquées
DATABASE_URL=postgres://user:password@host:5432/placet npm run migrate:postgres

# 4. Redémarrer Oathrion
sudo systemctl start placet
```

Vérifiez ensuite l'état du service et l'intégrité du journal d'audit :

```bash
curl -s http://localhost:5000/api/ready     # doit renvoyer HTTP 200 {"status":"ok", ...}
# la chaîne d'audit se vérifie par exécution (il n'existe pas de route globale) :
curl -s -H "Authorization: Bearer $ADMIN_KEY" http://localhost:5000/api/executions/<id>/audit/verify
```

---

## 13. Migrations et retour arrière

Oathrion utilise un système de migrations versionnées géré dans `server/migrations/`
(table de registre `schema_migrations`, version actuelle : 16 — la 16 rend `action_policies` unique par organisation).

**Avant tout déploiement :**

1. Sauvegarder la base PostgreSQL (§12) :
   ```bash
   pg_dump -Fc -h "$DB_HOST" -U "$DB_USER" -d "$DB_NAME" -f "/var/backups/pre-deploy-$(date +%F-%H%M).dump"
   git rev-parse HEAD > /var/backups/pre-deploy-revision.txt
   ```
2. Appliquer les migrations avant de démarrer les nouvelles instances :
   ```bash
   DATABASE_URL=postgres://... npm run migrate:postgres
   ```

**Retour au code précédent (Rollback) :**

```bash
sudo systemctl stop placet
cd /opt/placet
git checkout $(cat /var/backups/pre-deploy-revision.txt)
npm ci && npm run build
sudo systemctl start placet
curl -s http://localhost:5000/api/ready
```

Si la nouvelle version contenait des migrations de schéma incompatibles avec l'ancienne,
restaurez également le dump PostgreSQL pris avant déploiement (§12).

---

## 14. Exploitation courante

| Question | Où regarder |
| --- | --- |
| Le service est-il vivant ? | `GET /api/live` — **jamais** `/api/health`, voir § Sondes |
| Doit-il recevoir du trafic ? | `GET /api/ready` |
| À quelle requête correspond cette erreur ? | Cherchez son `requestId` dans le journal |
| Qu'a fait un agent ? | `GET /api/audit?limit=200` |
| Qu'attend une décision humaine ? | `GET /api/approvals` |
| Les notifications partent-elles ? | `GET /api/notifications` |
| Le serveur a-t-il refusé de démarrer ? | `journalctl -u placet` — la cause est écrite explicitement |
| Quels plafonds sont actifs ? | La ligne `[quotas]` au démarrage, ou `GET /api/usage` par organisation |
| Un client approche-t-il d'un plafond ? | `GET /api/usage` — champs `remaining` et `refusals` |

`GET /api/audit` est paginé : il renvoie `total`, `limit`, `offset`,
`windowTruncated` et `events`. `total` est compté avant découpage. Si
`windowTruncated` vaut `true`, la fenêtre d'analyse a été bornée et vous ne
voyez pas tout l'historique — affinez la requête.

La base PostgreSQL grandit sans purge automatique. Surveillez sa taille ; il n'y
a pas de rotation intégrée, et il ne faut pas en supprimer des lignes sans avoir
d'abord archivé le journal d'audit.


---

## 15. Quotas par organisation

Trois plafonds bornent ce qu'**une seule** organisation peut détenir ou consommer,
pour qu'un locataire ne dégrade pas le service des autres. Détail du mécanisme
dans le README § 25 ; ci-dessous, uniquement les gestes d'exploitation.

### 15.1 Lire l'état

Au démarrage, le service imprime la configuration retenue :

```
[quotas] mode=enforce · défauts agents=500, policies=500, executions=100000/mois
```

Lisez cette ligne après chaque déploiement. C'est le seul endroit où un
identifiant d'organisation mal tapé se voit : `org_acmee:executions=250000` est
syntaxiquement valide, donc accepté, et ne s'appliquera simplement jamais à
personne.

Par organisation, en tant que membre avec la capacité `read` :

```bash
curl -s -H "Authorization: Bearer $CLE" https://placet.exemple.com/api/usage | jq
```

`refusals` est un compteur cumulatif de dépassements par période. Un `refusals`
qui monte est le signal qu'un client est en train d'être refusé — c'est
l'indicateur à surveiller, pas la taille de la base.

Ce compteur est indicatif : il est écrit juste après le refus, hors transaction,
et un arrêt brutal du processus entre les deux perd un refus. Lisez-le comme une
tendance, pas comme une facture. La décision de refuser, elle, est toujours prise
sur un comptage exact.

### 15.2 Modifier un plafond

Depuis la migration 17, les plafonds **par organisation** sont stockés en base
(`organization_quotas`) et relus à chaque écriture contrôlée par toutes les
instances. Les entrées `org_x:` de `OATHRION_QUOTAS` y sont synchronisées à chaque
démarrage ; les entrées `default:` restent dans l'environnement. Il n'existe pas
encore de route d'API pour les modifier : la procédure reste donc d'éditer et de
redémarrer.

```bash
sudo -e /etc/placet/placet.env
#   OATHRION_QUOTAS=default:executions=20000,org_acme:executions=250000
sudo systemctl restart placet
journalctl -u placet -n 20      # vérifier la ligne [quotas]
```

Une entrée nommant une organisation précise l'emporte sur `default`. Une valeur
modifiée met à jour la ligne qu'elle avait importée ; une entrée retirée supprime
cette ligne. Le changement prend effet au redémarrage, et le redémarrage est propre
(SIGTERM, drainage, aucune perte — voir § 13). La ligne `[quotas]` du journal
indique combien de plafonds ont été importés, mis à jour ou retirés.

**Conflit : le démarrage est refusé.** Si une entrée de `OATHRION_QUOTAS` contredit un
plafond écrit par l'application (colonne `source = 'api'`), le service ne démarre
pas et le journal nomme l'organisation, le compteur et les deux valeurs. Retirez
l'entrée de `OATHRION_QUOTAS` (ou alignez-la sur la valeur en base) et redémarrez.

**Une valeur invalide empêche le démarrage.** C'est voulu : un quota
silencieusement ignoré est pire qu'un quota absent, puisque vous croiriez le
plafond en place. Si le service ne remonte pas, la cause est écrite en clair dans
le journal ; corrigez la valeur et redémarrez. Sont refusés : un compteur inconnu,
une valeur négative ou fractionnaire, une notation `1e3`, un `0` mal placé comme
`5O`, une portée vide, un `OATHRION_QUOTA_MODE` autre que `enforce` ou `observe`.

### 15.3 Geler un client sans rien supprimer

`0` est une valeur valide et signifie « plus aucune création ». C'est la façon de
suspendre un client en défaut de paiement sans toucher à ses données : ses agents
continuent de tourner, il ne peut plus rien créer.

```
OATHRION_QUOTAS=org_client_impaye:agents=0,org_client_impaye:policies=0
```

Pour l'arrêter complètement, ajoutez `org_client_impaye:executions=0`. Rien n'est
effacé ; le gel s'annule en retirant la ligne.

### 15.4 Activer les quotas sur un déploiement déjà en service

N'activez pas `enforce` en aveugle sur des clients existants : vous ne savez pas
encore qui dépasse, et le premier refus serait découvert par le client.

1. Déployez avec `OATHRION_QUOTA_MODE=observe` et les plafonds visés. Les écritures
   sont **autorisées**, les dépassements sont **comptés**.
2. Laissez tourner une période de facturation complète — un mois, puisque le
   compteur `executions` est mensuel. Une semaine ne dit rien d'un plafond
   mensuel.
3. Relevez `GET /api/usage` pour chaque organisation. Tout `refusals > 0` est un
   client qui *aurait* été refusé.
4. Pour ceux-là : soit relevez leur plafond nominativement, soit prévenez-les
   avant la bascule. Les deux sont défendables ; les refuser sans préavis ne
   l'est pas.
5. Passez à `OATHRION_QUOTA_MODE=enforce` et redémarrez.

### 15.5 Ce que voit le client refusé

Code HTTP **409** pour `agents` et `policies` (un plafond sur des lignes vivantes
ne se libère pas en attendant : le remède est une suppression), **429** avec un
en-tête `Retry-After` pour `executions` (là, attendre est bien le remède). Dans
les deux cas, le corps porte `"code": "quota_exceeded"` — jamais
`"rate_limited"`. Si un client vous signale du `rate_limited`, c'est le limiteur
de débit (§ trafic), pas un quota : les deux se règlent à des endroits
différents.
