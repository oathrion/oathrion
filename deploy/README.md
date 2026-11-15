# Kit de déploiement Oathrion (un serveur, PostgreSQL, TLS)

Architecture : **proxy TLS (Caddy) → Oathrion → PostgreSQL**. Plusieurs entreprises
(organisations) partagent l'instance ; chacune est isolée des autres (voir
`PHASE-13-MULTI-TENANT-PRODUCTION-REPORT.md`).

> **La pile est vérifiée de bout en bout** : `npm run verify:compose` monte les quatre
> services, prouve que la migration garde le démarrage d'Oathrion, que le proxy sert en
> HTTPS avec HSTS et redirige le port 80, que le durcissement annoncé est réel, qu'un
> parcours client complet passe par le proxy, et qu'une panne de base donne 503 sans
> tuer le processus. **20 contrôles.** Le script refuse de tourner si `placet.env` existe
> déjà : il écraserait les secrets d'un déploiement réel.
>
> **Un point reste non prouvé : le certificat public.** La vérification tourne avec
> `OATHRION_DOMAIN=localhost`, donc la CA interne de Caddy. Obtenir un certificat
> Let's Encrypt exige un nom DNS public pointant sur la machine et un port 80 joignable
> depuis l'extérieur — le seul pas que cette machine ne peut pas faire. Au premier
> déploiement sur un vrai domaine, surveillez `docker compose logs proxy` : un défi ACME
> qui échoue le dit bruyamment, il ne retombe pas en silence sur un certificat
> auto-signé.

---

## Démarrage rapide — une commande, en local

Pour **voir le produit tourner** sans nom de domaine, sans TLS et sans rien remplir :

```bash
npm run pilot:up          # ou OATHRION_PILOT_PORT=5055 npm run pilot:up si 5000 est pris
```

La commande génère des secrets frais dans `deploy/placet.local.env` (mode 600,
git-ignoré), construit l'image, applique les migrations, démarre, **attend que
`/api/ready` réponde 200**, puis affiche l'URL et les identifiants administrateur. Si la
sonde ne passe pas, elle échoue en montrant les journaux : « c'est parti » n'est pas
« ça marche ».

```
  Oathrion répond sur  http://127.0.0.1:5000
  Console            http://127.0.0.1:5000/console
  PostgreSQL          127.0.0.1:55433

npm run pilot:logs       suivre les journaux
npm run pilot:down       arrêter les conteneurs — LES DONNÉES SONT CONSERVÉES
npm run pilot:destroy    arrêter ET SUPPRIMER le volume de données (irréversible)
```

La base est **vide** : `OATHRION_SEED=` est posé à vide, donc aucun agent, aucune
politique, aucune donnée de démonstration. Un pilote voit sa base, pas la nôtre.

### Ce que cette pile n'est pas

`docker-compose.local.yml` **n'est pas une configuration de production**, et les
différences sont délibérées :

| | pile locale | pile de production |
|---|---|---|
| TLS | **aucun** — HTTP sur la boucle locale | Caddy, certificat ACME, HSTS |
| PostgreSQL | publié sur `127.0.0.1:55433` pour `psql` | **non publié** |
| Secrets | générés, écrits en mode 600 | `placet.env` que vous remplissez |
| Durcissement du processus | **conservé** : rootfs en lecture seule, non-root, `no-new-privileges` | identique |

Un credential qui traverse le port local traverse du clair : cette pile ne doit porter
aucune donnée réelle. Pour un pilote chez un client, c'est `docker-compose.yml`
ci-dessous, avec un domaine.

### Vérifier soi-même que la sécurité est active

Sur la pile locale, une fois démarrée (remplacez le port si vous l'avez changé) :

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5000/api/agents          # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer faux' \
  http://127.0.0.1:5000/api/agents                                                 # 401
```

Puis, avec un jeton `viewer` créé depuis la console, une écriture répond **403** : le
RBAC n'est pas une étiquette, c'est `requireCapability` sur chaque route.

---

| Fichier | Rôle |
|---|---|
| `docker-compose.local.yml` | **Pile locale en une commande** : PostgreSQL + migration + Oathrion sur `127.0.0.1`. Pas de TLS, pas de domaine. Lancée par `npm run pilot:up` |
| `docker-compose.yml` | PostgreSQL 17 + migration one-shot + Oathrion (rootfs lecture seule, utilisateur `node`) + Caddy (80/443) |
| `Caddyfile` | TLS automatique, HSTS, redirection HTTP→HTTPS, sonde `/api/ready` |
| `placet.env.example` | gabarit des variables ; copier en `placet.env` (jamais versionné, refusé par l'empaquetage) |
| `scripts/generate-secrets.sh` | imprime des valeurs aléatoires (n'écrit rien sur disque) |
| `scripts/backup.sh` / `restore.sh` | sauvegarde `pg_dump -Fc` + SHA-256 + rétention ; restauration dans une base **vide** |
| `scripts/check-health.sh` | vivacité / disponibilité |

## Installation (Docker Compose)

```bash
cd deploy
cp placet.env.example placet.env && chmod 600 placet.env
./scripts/generate-secrets.sh          # copier les valeurs dans placet.env (n'écrase rien)
$EDITOR placet.env                       # OATHRION_DOMAIN, OATHRION_ACCOUNTS=database, OATHRION_PUBLIC_URL
docker compose --env-file placet.env up -d --build
OATHRION_URL=https://$OATHRION_DOMAIN ./scripts/check-health.sh
```

**Inviter un client pilote** — aucun mot de passe dans l'environnement, aucun accès à la
base depuis l'extérieur : la commande est livrée dans l'image.

```bash
docker compose --env-file placet.env exec placet \
  node dist/workspace-create.cjs --org "Acme" --email admin@acme.com
```

Elle crée l'organisation et imprime **un lien** (7 jours, une utilisation). Le client
l'ouvre, choisit son nom et son mot de passe, et le démarrage guidé le prend en main
(`docs/DEMARRAGE.md`). `OATHRION_CONSOLE_USERS` reste accepté, mais met un mot de passe en
clair dans l'environnement : à réserver à un essai local.

## Réseau — écoute, publication, proxy : trois décisions distinctes

| Décision | Où | Production (`docker-compose.yml`) | Pilote local (`docker-compose.local.yml`) | Sans Docker |
|---|---|---|---|---|
| **Écoute** : sur quelle adresse le processus accepte des connexions | `OATHRION_HOST` (défaut `127.0.0.1`) | `0.0.0.0` **dans le conteneur**, écrit dans le Compose et l'image | `0.0.0.0` dans le conteneur | `127.0.0.1` par défaut ; derrière un proxy sur la même machine, le laisser ainsi |
| **Publication** : ce qui atteint le conteneur depuis l'hôte | `ports:` / `expose:` | **rien** : `expose: 5000`, joignable seulement par le réseau Compose | `127.0.0.1:5000` (ou `OATHRION_PILOT_PORT`) : la machine seule | — |
| **Porte publique** | le proxy | Caddy, ports 80 et 443, HTTPS | aucune | votre proxy |

Écouter sur `0.0.0.0` dans un conteneur n'est **pas** une exposition publique : c'est la
condition pour que le proxy ou la publication de port atteigne le processus. C'est en
revanche une exposition sur une machine nue — le serveur l'écrit au démarrage
(`listening on 0.0.0.0:5000 — NOT loopback`). `OATHRION_HOST` n'accepte qu'une adresse IP ou
`localhost` ; un nom d'hôte est refusé au démarrage. L'authentification est exigée quelle
que soit l'interface (`verify:compose` vérifie un 401 à travers le proxy).

Vérifié par `npm run verify:compose` (écoute lue dans le noyau du conteneur, aucun port de
Oathrion publié, connexion directe de l'hôte refusée, seul le proxy publié) et par
`server/test/server-binding.test.ts` (connexion par l'interface réseau de la machine
refusée par défaut, acceptée avec `OATHRION_HOST=0.0.0.0`).

## Installation sans Docker (systemd)

```bash
npm ci && npm run build                     # sur la machine de build
DATABASE_URL=postgres://... node dist/migrate.cjs   # avant chaque démarrage d'une nouvelle version
sudo systemctl enable --now placet            # unité : DEPLOYMENT.md §8
```

`node dist/migrate.cjs` n'exige ni tsx ni les sources : il est bundlé dans `dist/`.

## Ce qui a été réellement vérifié (Phase 13)

| Élément | Statut |
|---|---|
| Image Docker construite depuis ce dépôt | **PASS** |
| Base PostgreSQL vide → `node dist/migrate.cjs` dans l'image → version 16 | **PASS** |
| Conteneur Oathrion, rootfs lecture seule, utilisateur `node` → `/api/ready` 200, connexion admin, `HEALTHCHECK` healthy, aucun fichier `.db` | **PASS** |
| Caddy (`caddy:2`) avec ce `Caddyfile` devant Oathrion → HTTPS 200, HSTS, HTTP→HTTPS 308 | **PASS** (CA interne, `OATHRION_DOMAIN=localhost`) |
| `docker compose up` de bout en bout | **NON TESTÉ** : ni plugin compose ni réseau bridge dans l'environnement de build. Les services ont été validés un par un (lignes ci-dessus), le fichier a été validé syntaxiquement. |
| Certificat public Let's Encrypt | **NON TESTÉ** (exige un vrai nom DNS) |
| `backup.sh` / `restore.sh` tels quels | **NON TESTÉ** ; les mêmes commandes `pg_dump`/`pg_restore` sont PASS dans `npm run e2e:multitenant` |

## Démarrages dangereux refusés

`npm run verify:prod-config` lance le bundle réel avec **une** mauvaise valeur à la
fois et vérifie qu'il refuse de démarrer en nommant la cause (22 cas : SQLite en
production, opt-in SQLite inerte, plans d'identité / d'autorité / de rate limit hors
PostgreSQL, secret de session absent ou de démonstration, clé faible, faute de frappe
dans `RATE_LIMIT_FAIL_MODE` ou `OATHRION_UNDECLARED_ACTION`, destination non rattachée à
une organisation, PostgreSQL injoignable…), puis deux contrôles positifs (la bonne
configuration démarre, y compris depuis un autre répertoire de travail).
