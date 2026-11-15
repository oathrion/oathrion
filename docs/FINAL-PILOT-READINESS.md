# Placet — état vérifié pour un pilote client contrôlé

**Version mesurée : code `acf5b84`** (branche `import/chantier-1-etape-1`), le 20 octobre
2026. Le commit qui porte ce document ne modifie que `docs/`, le `README.md` et le compte
des tests dans un texte du site (`client/site/pages/home.tsx`). Ce document est la
**seule** référence des résultats de cette version ; le § B dit, ligne par ligne, sur
quelle révision chaque mesure a été prise. Chaque passage d'endurance, de charge, de panne
et contre un vrai service — échecs et passages invalides compris — est dans
`docs/STRESS-TEST-LOG.md`.

Environnement : portable Linux, 2 processeurs, 7 Go de RAM (≈ 1–3 Go disponibles selon
l'heure, 4 Go de swap), Node 22.23.2, Docker. PostgreSQL 17 **jetable**, dans deux
conteneurs dédiés aux preuves (`placet-proof-pg`, port 55498 ; `placet-proof-pg-redemarrage`,
port 55497, pour les tests qui arrêtent la base) — aucune base, aucun conteneur et aucun
volume de l'utilisateur n'ont été utilisés, arrêtés ou modifiés. Sorties complètes sous
`~/.cache/placet-suite/` sur la machine de mesure.

---

## A. Statut final

# VALIDATION EXTERNE EN ATTENTE

**Ce qui passe sur `acf5b84`** : la porte de régression complète (16 commandes, toutes en
sortie 0 — § B.1), dont **tous** les tests PostgreSQL ; la pile Docker de production avec
l'écoute réseau vérifiée ; **GitHub de bout en bout contre le vrai service** (§ B.1) ; un
vrai client MCP (Cursor) contre le build local et des services simulés ; **Slack et Linear
de bout en bout contre les vrais services** (`verify:launch` 47/47 avec les trois
connecteurs, `verify:slack` 28/28 — sur `cdc206b`, même serveur) ; une répétition de
la recette utilisateur dans le vrai navigateur.

**Ce que la campagne de pannes a trouvé et corrigé** : couper PostgreSQL 15 s sous trafic
**arrêtait Placet** une fois sur cinq (connexion coupée au milieu d'une transaction,
exception non attrapée) — corrigé et reproduit à coup sûr par un test ; et Placet répondait
500 au lieu de 503 pendant la coupure — corrigé. Dernier passage : 0 réponse 500, processus
vivant, reçus égaux aux exécutions, chaîne vérifiée (`STRESS-TEST-LOG` § 5.9).

**Ce qui n'est pas résolu localement** : la croissance de mémoire résidente. Elle est
localisée (mémoire native anonyme, hors des deux tas V8 et hors du worker d'identité) mais
**non attribuée**. Le passage de 12 heures a été **interrompu** après 1 h 32 par un arrêt
de la machine (0 erreur, mémoire par paliers puis redescente) : rien n'est conclu (§ E,
blocage 3).

**Ce qui manque et qui est externe** : une instance hébergée avec un domaine ; des
applications OAuth enregistrées ; un second client MCP (Claude Desktop) ; une vraie personne
pour la recette ; douze heures de machine branchée.

Aucun défaut P0 ou P1 connu ne reste ouvert dans le code. Placet n'est **pas** « prêt pour
un pilote contrôlé » au sens strict : les trois connecteurs (GitHub, Slack, Linear) sont
éprouvés contre les vrais services, mais rien n'a encore été démontré sur une instance
hébergée ni par un utilisateur.

### Les six niveaux de preuve, séparés

| Niveau | État sur `acf5b84` |
|---|---|
| **Tests locaux** | ✅ 2 891 réussis, 0 échec ; garde-fous structurels ; bancs locaux (§ B.1) |
| **Intégration avec une vraie base** | ✅ PostgreSQL 17 réel : 111/111 + 2/2 (redémarrage réel du serveur de base), migrations neuves et mise à niveau ; **coupure de la base sous trafic continu** : 0 réponse 500, processus vivant, reprise seule |
| **Fournisseurs externes réels** | ✅ **GitHub, Slack et Linear de bout en bout** : `verify:launch` **47/47** avec les trois ensemble, `verify:github` 36/36, `verify:slack` 28/28 ; idempotence de la création Linear démontrée ; seul l'OAuth en un clic reste simulé. Stripe (mode test) 30/30 sur `8a49b30` (paquet du pare-feu) ; **connecteur natif Stripe** : parcours complet vert contre Stripe en mode test, idempotence rendue par Stripe (`STRESS-TEST-LOG` § 5.12), passage entier à 56/60 — 4 délais réseau en phase 0 |
| **Client MCP réel** | ◐ Cursor `cursor-agent` 2026.08.11 contre le build local et des services **simulés** ; Claude Desktop non testé |
| **Déploiement hébergé** | ❌ aucune instance ; pile Docker éprouvée localement (`verify:compose` 35/35), certificat public jamais obtenu |
| **Usage humain** | ❌ aucune recette ; une répétition par l'équipe (blocage trouvé et corrigé) |

---

## B. Registre des vérifications

### B.1 Porte de régression — `acf5b84`, arbre propre (20 octobre 2026)

`porte-finale.sh`, 23:38:28 → 23:47:47 UTC, sur secteur, rien d'autre en cours.

| Commande | Sortie | Résultat |
|---|---|---|
| `typecheck` · `lint` · `build` · `scan:secrets` | 0 · 0 · 0 · 0 | |
| `npm test` | 0 | **2 891 réussis, 0 échec, 81 ignorés** — tous PostgreSQL, exécutés ci-dessous |
| 9 fichiers PostgreSQL, dont `postgres-connection-loss` | 0 | **111/111**, aucun ignoré |
| `phase12-restart-reconnect` (conteneur jetable) | 0 | 2/2 |
| `smoke` · `smoke:postgres` · `e2e` | 0 · 0 · 0 | 26/26 · 21/21 · 63/63 |
| `verify:upgrade` · `e2e:multitenant` · `verify:mcp` | 0 · 0 · 0 | 17/17 · 98/98 · 37/37 |
| `chaos` · `chaos:postgres` | 0 · 0 | 26 gérées, 0 silencieux · 15/15 |
| `verify:compose` | **1** puis **0** | premier passage : `registry-1.docker.io` non résolu (« server misbehaving », DNS du Wi-Fi), 0/1 — conservé ; relancé seul une fois le DNS revenu : **35/35** |

Contre le **vrai GitHub** (jeton à portée fine limité au dépôt de test
`<compte-de-test>/<dépôt-de-test>`), `STRESS-TEST-LOG` § 5.10 :

| Commande | Code | Résultat |
|---|---|---|
| `verify:launch` | `67e804e` | sortie 2, **31/31** : GitHub éprouvé ; Slack et Linear non fournis |
| `verify:github` | `f9b5b21` | sortie 0, **36/36** (après correction du banc : cinq verbes, pas trois) |

Le dépôt de test porte trois issues, toutes fermées, et aucune autre écriture.

### B.1-bis Porte de régression — `7d90970`, arbre propre (19 octobre 2026)

`~/.cache/placet-suite/outils/porte-finale.sh` : chaque commande l'une après l'autre,
19 octobre 2026, 20:21:57 → 20:33:32 UTC, rien d'autre en cours sur la machine.

| Commande | Sortie | Résultat |
|---|---|---|
| `npm run typecheck` · `lint` · `build` · `scan:secrets` | 0 · 0 · 0 · 0 | |
| `npm test` (sans base) | 0 | **2 882 réussis, 0 échec, 80 ignorés** — 148 fichiers, 6 ignorés ; les 80 sont tous des tests PostgreSQL (rapport JSON), exécutés ci-dessous |
| 8 fichiers PostgreSQL, base dédiée, `PLACET_TEST_IDENTITY_PG_URL` compris | 0 | **110/110**, aucun ignoré |
| `phase12-restart-reconnect` (`PLACET_TEST_PG_DOCKER`, conteneur jetable dédié) | 0 | **2/2** — base réellement arrêtée puis redémarrée deux fois |
| `npm run smoke` · `smoke:postgres` · `e2e` | 0 · 0 · 0 | 26/26 · 21/21 · 63/63 |
| `npm run verify:upgrade` | 0 | 17/17 — mise à niveau d'une base existante |
| `npm run e2e:multitenant` | 0 | 98/98, sauvegarde et restauration comprises |
| `npm run verify:mcp` | 0 | 37/37 |
| `npm run chaos` | 0 | 26 pannes gérées, 0 cryptique, **0 échec silencieux**, 2 non simulables |
| `npm run chaos:postgres` | 0 | 15/15 |
| `npm run verify:compose` | 0 | **35/35** — dont l'écoute réseau : `0.0.0.0:5000` dans le conteneur, aucun port de Placet publié, connexion directe de l'hôte refusée, seul le proxy publié, 401 à travers le proxy |

Mesures prises sur `0b7f03e` → `7d90970` (code identique sauf la page de détail d'une
exécution), hors de cette porte :

| Mesure | Résultat |
|---|---|
| Écoute réseau sur le vrai serveur | par défaut `127.0.0.1` : connexion par l'interface réseau **refusée** ; `PLACET_HOST=0.0.0.0` : acceptée ; 401 sans credential dans les deux cas (`STRESS-TEST-LOG` § 5.1) |
| Mémoire, 40 min ×2 avec sonde | tas V8 principal et du worker **plats** ; +45 Mo (défaut) / +40,5 Mo (`MALLOC_ARENA_MAX=2`) de mémoire anonyme native ; non attribuée (§ 5.2) |
| Cursor de bout en bout | `initialize` 2025-11-25 → 2025-06-18 ; 14 outils ; simulé, réel, bloqué, retenu, **refus du fournisseur**, **effet inconnu** (Cursor ne réessaie pas) ; approbations concurrentes → 1 exécution ; rejeu de l'inconnu refusé sans attestation (§ 5.4) |
| Répétition de la recette (navigateur, vrai serveur) | 8 étapes ; **blocage à l'étape 8 trouvé et corrigé** (§ 5.5) |

### B.2 Mesuré sur `075c896`, avant cette porte

Les bancs ont tourné sur l'arbre de travail avant le commit ; le code de `075c896` y est
identique fichier par fichier (diff des fichiers modifiés et SHA-256 des fichiers nouveaux
comparés après le commit). Le commit suivant ne touche que `docs/`.

| Commande | Sortie | Résultat mesuré |
|---|---|---|
| `npm run typecheck` · `lint` · `build` | 0 · 0 · 0 | |
| `npm test` (sans base, comme en CI), sur `075c896` | 0 | **2 859 réussis, 0 échec, 80 ignorés** — 145 fichiers, 6 ignorés ; les 80 sont tous des tests PostgreSQL (rapport JSON, sur `075c896` commité ; aucun test LangChain parmi eux, contrairement à `8a49b30`). Un premier passage avait 1 échec : la garde structurelle refusait la nouvelle sonde `ping()` (requête sans prédicat de locataire) ; l'entrée de sa liste fermée a été mise à jour avec sa raison, la suite relancée |
| 9 fichiers PostgreSQL (base dédiée, `PLACET_TEST_IDENTITY_PG_URL` compris) | 0 | 7 fichiers 0 échec ; `phase11-postgres-core` 29/29 après correction de MON test trop strict (§ STRESS-TEST-LOG 2.6) ; `tenant-quota-config-postgres` 3/3 ; `phase12-restart-reconnect` (2) **non exécuté** : exige `pg_ctlcluster` sur l'hôte |
| `npm run chaos` | 0 | 26 pannes gérées, 0 cryptique, **0 échec silencieux**, 2 non simulables |
| `npm run chaos:postgres` | 0 | 15/15 — base réellement arrêtée puis relancée sous une instance vivante |
| `npm run e2e:multitenant` | 0 | 98/98 |
| `LOAD_MODE=execute LOAD_LEVELS=1,4,16,32,64 verify:load` | 0 | 7/7 ; ~55 cycles/s dès 16 clients (sérialisation voulue par locataire), 0 erreur, retour au repos après le pic ; **identique à `620ed27`** à ce volume |
| `LOAD_MODE=decide LOAD_LEVELS=1,8,32,64,128,256 verify:load` | 0 | 0 erreur / 10 532 ; saturation ~150–160 décisions/s dès 8–32 clients ; RSS ≤ 232 Mo |
| `SOAK_MINUTES=60 verify:soak` — référence, code `620ed27` | **1** | 16/17 : **deux `500`** en 32 552 cycles, trace capturée → défaut D1 |
| `SOAK_MINUTES=60 verify:soak` — après correctifs, passage 1 | **1** | **invalide** : machine mise en veille (couvercle fermé) 12:42 → 14:54 UTC ; 0 erreur sur les 29 min effectives |
| `SOAK_MINUTES=60 verify:soak` — après correctifs, passage 2 (valide, 0 veille) | **1** | 16/17 : **0 erreur sur 243 030 requêtes, aucune `500`** ; p95 du relais 67 → 96 ms ; **échec du contrôle de mémoire résidente** : 262 → 328 Mo (+25,1 %, seuil 25 %) — même forme qu'avant correctifs (+21,4 %) |
| Diagnostic mémoire, 40 min, ramasse-miettes forcé | 0 | 17/17, 0 erreur ; tas JavaScript utilisé après GC **plat** (18,6–20,7 Mo) ; la croissance est **hors du tas** (~120 → ~160 Mo), non attribuée |
| Cursor (`cursor-agent` 2026.08.11), services simulés | — | `initialize` 2025-11-25 → **2025-06-18** ; 12 outils ; ALLOW exécuté une fois, BLOCK et APPROVAL_REQUIRED sans aucun appel au service ; approbation → une seule exécution, la seconde sans effet |
| Tête de chaîne à 200 000 reçus (`EXPLAIN ANALYZE`) | — | **68,6 ms → 0,047 ms** par écriture |
| `npm run smoke` · `e2e` · `scan:secrets` | 0 · 0 · 0 | 26/26 · 63/63 · 650 fichiers, 0 secret (un premier lancement de `smoke` et `e2e` sans `DATABASE_URL` sortait en 2 : erreur de lancement de ma part, conservée) |
| `npm run verify:compose` | 0 | **29/29** — image `placet:local` reconstruite depuis ce code (worker et texte MCP vérifiés dans l'image) |

### B.3 Mesuré sur `8a49b30`, NON relancé depuis

Les lignes ci-dessous datent de `8a49b30`. Les correctifs depuis touchent le plan
d'identité, la lecture des reçus, la sonde de santé et le texte des réponses MCP ; les bancs
qui les exercent ont été relancés au § B.1. Les autres n'ont pas été relancés.

Toutes les commandes ont été lancées depuis la racine du dépôt, sur `8a49b30`, arbre propre.
« PG jetable » = `DATABASE_URL` vers le serveur de preuves ; `PLACET_PG_CONTAINER=placet-proof-pg`
fournit `pg_dump`/`pg_restore`, absents de l'hôte.

### Qualité et suite

| Commande | Sortie | Résultat mesuré |
|---|---|---|
| `npm run typecheck` | 0 | aucune erreur |
| `npm run lint` | 0 | aucune erreur ni avertissement |
| `npm run build` | 0 | `dist/index.cjs`, `dist/migrate.cjs`, `dist/workspace-create.cjs`, client |
| `npm run scan:secrets` | 0 | 646 fichiers livrables balayés, aucun secret |
| `npm test` (sans base, comme en CI) | 0 | **2 842 réussis, 0 échec, 78 ignorés** — 143 fichiers exécutés, 6 ignorés |
| `bash script/run-suite-per-file.sh` (un processus par fichier) | 0 | **149/149 fichiers, 2 842 tests, 0 échec** |
| `PLACET_TEST_POSTGRES_URL=… PLACET_TEST_PG_URL=… PLACET_REQUIRE_POSTGRES=true npx vitest run` les 5 fichiers PostgreSQL ignorés ci-dessus | 0 | **76/76, 0 ignoré** (PG jetable) |

Les 78 tests ignorés par `npm test` : 76 sont les fichiers PostgreSQL, qui se mettent en pause
sans base et ont été exécutés à part (ligne ci-dessus) ; **2** sont l'exemple LangChain, ignoré
parce que la dépendance optionnelle `langchain` n'est pas installée — **non exécutés**.

### Bancs officiels (`npm run …`)

| Commande | Sortie | Résultat | Environnement |
|---|---|---|---|
| `smoke` | 0 | 26/26 | bundle, SQLite |
| `smoke:postgres` | 0 | 21/21 | PG jetable |
| `test:postgres` | 0 | 25/25 | PG jetable |
| `verify:upgrade` | 0 | 17/17 | mise à niveau d'une base existante, PG jetable |
| `verify:prod-config` | 0 | 41/41 configurations se comportent comme exigé | bundle |
| `e2e` | 0 | 63/63 | bundle |
| `e2e:currency` | 0 | 13/13 | PG jetable |
| `e2e:instances` | 0 | 6/6 | deux processus, une base migrée dédiée |
| `e2e:identity` | 0 | 12/12 | deux processus, une base migrée dédiée |
| `e2e:multitenant` | 0 | 98/98, sauvegarde et restauration comprises | bundle production, PG jetable |
| `chaos` | 0 | 26 pannes gérées, 0 message cryptique, **0 échec silencieux**, 2 non simulables (disque plein, base passée en lecture seule — exigent des privilèges) | SQLite |
| `chaos:postgres` | 0 | 15/15 — base réellement arrêtée puis relancée | conteneur jetable arrêté/redémarré |
| `conformance` | 0 | **CONFORME** — 21 propriétés du cœur et 6 étendues, 0 échec, 0 ignorée | instances SQLite, sans `DATABASE_URL` |
| `conformance -- --mutants` | **1** | 25 mutants : 23 attrapés par leur propriété cible, 1 limite déclarée (`verificateur-complaisant`), **1 attrapé par une autre propriété** : `bloque-executable` vise C3 et fait tomber C1, prérequis de C3 — l'action BLOCK rendue exécutable est donc détectée, mais pas par la propriété qui la vise, et le banc compte cela comme un échec. **Identique sur le commit de départ `c75406a`** (vérifié dans une copie de travail séparée) : défaut d'attribution du kit, antérieur à ce chantier, non corrigé ici | sans `DATABASE_URL`, trois exécutions identiques |
| `verify:mcp` | 0 | 37/37 | serveur MCP indépendant |
| `verify:tools` | 0 | 49/49 | |
| `verify:intercept` | 0 | 67/67 | |
| `verify:chain-audit` | 0 | 10/10 | PG jetable |
| `verify:erasure` | 0 | 20/20 | PG jetable |
| `verify:dr` | 0 | 28/28 — restauration sur une machine de remplacement | PG jetable + conteneur de rechange |
| `verify:obs` | 0 | 61/61 | |
| `verify:backup` | 0 | 24/24 — `deploy/scripts/backup.sh` et `restore.sh` tels quels | PG jetable |
| `verify:load` | 0 | 6/6 — 86 → 176 req/s de 1 à 64 clients, **sur cette machine** | |
| `verify:compose` | 0 | 29/29 — voir § I | pile Docker de production complète |
| `SOAK_MINUTES=10 verify:soak` | 0 | 17/17 — voir ci-dessous (remplacé par § B.1) | bundle, PG jetable |
| `verify:launch` | **2** | 15/15 ; **NON ÉPROUVÉ** contre GitHub, Slack, Linear — credential de test absent | bundle, PG jetable, services réels |
| `verify:github` | **2** | 12/12 sans jeton ; parcours avec jeton non exécuté | GitHub réel |
| `verify:slack` (paquet pare-feu) | **2** | 18/18 sans jeton de bot ; parcours avec jeton non exécuté | Slack réel |
| `verify:stripe` | 0 | **30/30 contre Stripe réel, mode test** | Stripe réel |
| `verify:openai` | **1** | 22/29 — les 7 échecs sont `429 You have no credits remaining` ; injection, refus et relais vérifiés | OpenAI réel |

**Endurance (`SOAK_MINUTES=10 npm run verify:soak`)** : 10,0 min, 8 346 cycles (~13,9/s), chaque
cycle = décider, exécuter, relayer, lire les reçus, scruter les métriques. RSS 134 Mo au
démarrage puis stable autour de 235–242 Mo ; 36 descripteurs ; p95 du relais 33 → 37 ms ;
**0 erreur** ; chaîne de reçus vérifiée à la fin ; aucun secret dans la sortie.
**Écart honnête** : un passage précédent du même banc (sur `71a2e95`) a relevé **deux 500**
sur `GET /api/actions/receipts` en 5 736 cycles, et un passage plus ancien un seul. Un nouveau
passage instrumenté (7 804 cycles) puis celui-ci (8 346) n'en ont produit aucun. **Cause non
identifiée** — voir § E. Dix minutes ne prouvent pas vingt-quatre heures : la commande longue
est `SOAK_MINUTES=720 npm run verify:soak`, **non exécutée**.

**Correction de mesure.** Une première exécution de `conformance -- --mutants` dans le lot
rendait 0 et « 25/25 » : le lanceur avait exporté `DATABASE_URL`, et 26 instances SQLite du kit
avaient refusé de démarrer. Ce résultat, produit dans un environnement faux, est **écarté** ;
les deux lignes ci-dessus viennent d'exécutions sans cette variable. Aucun autre banc du lot
ne porte ce refus dans sa sortie (vérifié fichier par fichier).

### Ce qui n'a pas pu être exécuté

| Vérification | Pourquoi |
|---|---|
| GitHub, Slack, Linear de bout en bout | aucun credential de test (`~/.config/placet/*-test.env` : seuls Stripe et OpenAI existent ; le jeton Slack fourni est un jeton UTILISATEUR, refusé par conception) |
| OAuth Slack / Linear réel | pas d'URL HTTPS publique, pas d'application enregistrée |
| Clients MCP réels autres que Cursor | Claude Desktop non installé ici |
| Certificat public Let's Encrypt | exige un nom DNS public ; la pile est vérifiée avec la CA interne de Caddy |
| Endurance de plusieurs heures (`SOAK_MINUTES=720`) | lancée le 20 octobre, **interrompue** à 1 h 32 par un arrêt de la machine ; à relancer machine branchée et allumée (§ E, blocage 3) |
| Délai incertain contre un vrai fournisseur | non provocable sans risque ; éprouvé contre des services simulés seulement |
| Exemple LangChain | dépendance optionnelle absente |
| Test par des utilisateurs non techniques | non réalisé ; procédure prête (`docs/PILOTE-RECETTE-UTILISATEUR.md`), répétée par l'équipe |
| Allocateur alternatif (jemalloc) pour le diagnostic mémoire | non installé sur la machine ; non installé |

### Après la mesure de `8a49b30` (commit `27823ab`)

Le commit qui porte ce rapport (enfant direct de `8a49b30`) ne modifie que de la
documentation (`docs/`, `README.md`) et des textes du site (`client/site/pages/home.tsx`,
`roadmap.tsx`). Ce qu'il pouvait invalider a été relancé dessus : `npm run typecheck` 0,
`npm run lint` 0, `npm run build` 0, `npm test` 0 — **2 842 réussis, 0 échec, 78 ignorés**,
identique.

---

## C. Matrice des chemins critiques

| Capacité | Statut | Preuve | Limite connue | Pour finir |
|---|---|---|---|---|
| **Autorisation avant exécution** (ALLOW n'appelle l'outil qu'une fois ; BLOCK zéro appel) | VALIDÉE | `connector-launch-path.test.ts`, `e2e:multitenant` (« authorization alone calls nothing »), `connector-control-point.test.ts` | Ne couvre que ce qui passe par Placet (§ D) | — |
| **Approbation** : rien avant, une seule exécution, rejet et rejeu sans effet, liée à l'action exacte et aux arguments stockés | VALIDÉE | `connector-launch-path.test.ts`, `e2e:multitenant` (hash d'action, rejeu, approbation d'une autre action refusée) | Une valeur non scalaire est conservée sérialisée en texte ; les arguments des connecteurs sont scalaires | — |
| **Résultat incertain** (requête partie, réponse absente) | VALIDÉE localement — pour GitHub depuis le 27 octobre 2026 seulement : jusque-là un `return` sans `await` contournait le correctif (`STRESS-TEST-LOG` §5.39) | `unknown-effect.test.ts` (Slack et GitHub), parcours de lancement « EFFET INCONNU » ; console : liste, détail, démarrage guidé ; **MCP : `effect: unknown`, « Do not retry »**, Cursor ne réessaie pas (§ B.1) | Éprouvé contre des services simulés | Observer un vrai délai d'un fournisseur |
| **Sûreté du rejeu** | VALIDÉE localement | seules les lectures sont rejouables automatiquement ; relance d'un effet inconnu uniquement par attestation d'une personne ayant `approve`, inscrite au journal | L'attestation est HUMAINE : Placet n'a pas la preuve que rien n'a eu lieu | — |
| **Isolation entre organisations** | VALIDÉE | `tenant-isolation-structural.test.ts` (toutes les routes GET rejouées comme une autre organisation), `e2e:multitenant` 98/98, approbation étrangère refusée en 404 | — | — |
| **Secrets** | VALIDÉE | coffre AES-256-GCM (`connector-vault.test.ts`), jeton absent des réponses et journaux (tests et bancs), `scan:secrets` 0 | Clé maîtresse dans l'environnement ; pas de gestionnaire de secrets cloud | — |
| **Connecteur GitHub** | **VALIDÉE contre le vrai service** | `verify:launch` 31/31 et `verify:github` 36/36 sur un dépôt de test réel : connexion vérifiée par GitHub, lecture, blocage sans appel, approbation puis création relue chez GitHub, seconde approbation sans effet, refus réel de GitHub, audit (`STRESS-TEST-LOG` § 5.10) | Délai incertain réel non provocable sans risque (éprouvé en simulé) ; pas de GitHub App | — |
| **Connecteur Slack** | **VALIDÉE contre le vrai service** | `verify:launch` 47/47 et `verify:slack` 28/28 avec un jeton de bot réel : lecture, blocage hors périmètre sans appel, approbation puis publication relue chez Slack, refus `200 + ok:false` enregistré comme échec, jeton injecté par Placet et absent de la base et des journaux (`STRESS-TEST-LOG` § 5.11) | OAuth en un clic non éprouvé (instance hébergée requise) | — |
| **Connecteur Linear** | **VALIDÉE contre le vrai service** | `verify:launch` 47/47 : tâche retenue, approuvée, créée et relue chez Linear ; **un second `issueCreate` au même identifiant est refusé par Linear** (idempotence démontrée) ; seconde approbation sans effet (`STRESS-TEST-LOG` § 5.11) | OAuth en un clic non éprouvé ; la création reste exclue du rejeu automatique (décision de produit à prendre) | — |
| **Connecteur Stripe** | **PARTIELLEMENT VALIDÉE — mode test** | `verify:launch` n° 1 : connexion vérifiée par Stripe, lecture des paiements, remboursement hors périmètre bloqué sans appel, remboursement retenu (relu chez Stripe : rien de parti), approuvé, **relu chez Stripe**, seconde approbation sans effet, **même remboursement rendu par Stripe à la même clé d'idempotence** ; `connector-stripe.test.ts` 44, `connector-stripe-launch-path.test.ts` 17 (`STRESS-TEST-LOG` § 5.12) | Passage entier à 56/60 (quatre délais réseau en phase 0) : un passage entièrement vert reste à faire ; mode réel jamais éprouvé (refusé sans `PLACET_STRIPE_ALLOW_LIVE`) ; remboursement exclu du rejeu automatique | Connexion stable |
| **OAuth Slack / Linear** | PARTIELLEMENT VALIDÉE | `state` à usage unique, cookie du navigateur, jeton vérifié avant scellement — fournisseur simulé | Jamais éprouvé contre Slack/Linear réels | URL HTTPS + applications enregistrées |
| **MCP : outils exposés** | VALIDÉE (protocole) | `mcp-connector-exposure.test.ts` : absent, non vérifié, connecté, accès perdu, autre organisation, agent sans portée, reconnexion ; SDK officiel ; `verify:mcp` 37/37 (sur `8a49b30`) ; `mcp-legacy-compat.test.ts` | Révisions `2026-07-28`, `2025-06-18`, `2025-03-26` | — |
| **MCP : clients réels** | PARTIELLEMENT VALIDÉE | Cursor (`cursor-agent` 2026.08.11) contre le **bundle de production** sur PostgreSQL : 14 outils ; simulé, réel, bloqué, retenu, refus du fournisseur, effet inconnu ; approbations concurrentes → 1 exécution ; audit conforme (§ B.1) | Services simulés, instance locale ; Claude Desktop non testé | Cursor contre une instance hébergée et de vrais services ; Claude Desktop |
| **MCP : vérité du résultat** | VALIDÉE | `connector-launch-path.test.ts` : `mode: CONNECTOR` pour un connecteur, exécuté ou non ; `effect: applied / none / unknown` ; un effet inconnu dit « Outcome UNKNOWN … Do not retry » | — | — |
| **Écoute réseau** | VALIDÉE | `server-binding.test.ts` (vrai serveur, interface réseau refusée par défaut), `deploy-binding.test.ts`, `verify:compose` 35/35 | Le choix `0.0.0.0` hors conteneur reste possible, et annoncé au démarrage | — |
| **Coupure de la base sous trafic continu** | VALIDÉE localement | 15 s de coupure pendant `verify:soak` : 2 184 réponses 503, 0 réponse 500, 0 exception non attrapée, processus vivant et repris seul, reçus = exécutions, chaîne vérifiée ; `postgres-connection-loss.test.ts` (`STRESS-TEST-LOG` § 5.9) | Coupure longue, base lente à revenir, plusieurs instances, réseau dégradé : non éprouvés | — |
| **Plan d'identité sur PostgreSQL sous trafic continu** | VALIDÉE localement | `sync-postgres-protocol.test.ts` (réveil tardif, réponse orpheline, 1 000 requêtes) ; 0 `500` sur 243 030 + 177 378 + 172 668 requêtes après correctif ; **redémarrage réel de la base** : reconnexion sans relance, identité refusée pendant la panne (golden AI/AJ, 2/2) | — | Passage long (`SOAK_MINUTES=720`) |
| **Démarrage guidé** (lien → compte → outils → périmètre → agent → scénario → reçu) | PARTIELLEMENT VALIDÉE | API : `workspace-invite.test.ts`, `verify:launch` sur le bundle ; **répétition des 8 étapes** dans le navigateur, vrai serveur, faux GitHub ; blocage de l'étape 8 corrigé (`execution-detail-lookup.test.ts`) | Pas de test d'utilisateurs ; scénario réel non joué ; écran de détail en anglais | Credentials + 3 à 5 testeurs (`docs/PILOTE-RECETTE-UTILISATEUR.md`) |
| **Migrations** (base neuve, mise à niveau) | VALIDÉE | `verify:upgrade` 17/17, tests PostgreSQL sur bases neuves, schéma 24 après `chaos:postgres` (sur `7d90970`) ; aucune migration ajoutée | — | — |
| **Démarrage Docker, prêt, arrêt, persistance** | VALIDÉE | `verify:compose` 35/35 sur `7d90970` | Certificat public non obtenu | Domaine réel |
| **Sauvegarde / restauration** | VALIDÉE | `verify:backup` 24/24, `verify:dr` 28/28 | — | — |
| **Endurance** | **NON VALIDÉE** | 60 min avant correctifs (deux `500`, cause trouvée et corrigée) ; 60 min après : 0 erreur, **contrôle de mémoire échoué** (+25,1 %) ; 2 × 40 min de diagnostic ; 12 h **interrompu** à 1 h 32 par un arrêt de la machine (0 erreur) | Croissance de mémoire native non attribuée ; tas V8 et worker écartés ; arènes de l'allocateur pas la cause principale ; aucun passage de plusieurs heures | `SOAK_MINUTES=720` sur machine éveillée ; si la croissance ne se borne pas : profil natif (heaptrack) ou allocateur alternatif |
| **Charge** | VALIDÉE localement | `verify:load` jusqu'à 256 clients : 0 erreur, saturation mesurée, retour au repos | Une machine de 2 processeurs ; un seul locataire | Mesure sur la machine cible |

---

## D. Validation externe et périmètre de contrôle

| Niveau | Ce qui l'atteint |
|---|---|
| **Unitaire / simulé** | `connector-slack.test.ts` (24), `connector-linear.test.ts` (31), `connector-github-errors.test.ts`, `unknown-effect.test.ts`, `mcp-connector-exposure.test.ts` — serveurs locaux qui répondent comme les services |
| **Intégration locale** | `connector-launch-path.test.ts` : API, passerelle, moteur, coffre, approbations réels ; services simulés ; bundle de production sur PostgreSQL dans les bancs |
| **Services réels** | Stripe (mode test) 30/30 et OpenAI partiel, sur `8a49b30` ; GitHub, Slack, Linear : **refus d'une clé fabriquée seulement** ; procédure prête : `docs/PILOTE-VALIDATION-CONNECTEURS.md` |
| **Clients MCP réels** | **Cursor** seulement, contre le build local (bundle de production, PostgreSQL) et des services simulés |
| **Déploiement hébergé** | aucun ; liste de l'exploitant prête : `docs/PILOTE-CHECKLIST-EXPLOITANT.md` |
| **Usage humain** | aucune recette ; **kit de séance prêt** (`docs/PILOTE-RECETTE-UTILISATEUR.md`) : préparation sur le poste de l'exploitant sans hébergement, commandes par séance, animation, débriefing, synthèse de 3 à 5 testeurs et règle de décision. Prérequis relevé : reconstruire l'instance locale (son image datait du 18 octobre) |

**Ce que Placet contrôle, et ce qu'il ne contrôle pas.** Placet décide des actions qui passent
par ses chemins configurés : les connecteurs, la passerelle MCP, `POST /api/execute`, le
pare-feu. Un agent qui garde ses propres identifiants GitHub, Slack ou Linear et appelle ces
services directement n'est ni vu ni bloqué. Les outils intégrés de paiement et de courriel sont
simulés et se déclarent tels.

---

## E. Blocages restants — impact et condition exacte pour les lever

| # | Blocage | Impact | Ce qu'il faut pour le lever |
|---|---|---|---|
| 1 | **Aucune instance hébergée** | Un client ne peut pas ouvrir de lien | Une machine (2 vCPU, 4 Go), un nom DNS, les ports 80/443, un stockage de sauvegarde hors machine ; `docs/PILOTE-CHECKLIST-EXPLOITANT.md` |
| 2 | OAuth Slack / Linear non éprouvé contre les vrais fournisseurs | La connexion en un clic n'est pas proposable ; le jeton guidé reste possible | L'instance hébergée (HTTPS), deux applications enregistrées avec l'URL de retour, leurs identifiants dans `placet.env` |
| 3 | **Mémoire native non attribuée** ; endurance d'une heure en sortie 1 sur ce contrôle ; passage de 12 h interrompu à 1 h 32 | Risque inconnu sur une instance qui tourne des jours : une croissance non bornée finirait par un redémarrage | `SOAK_MINUTES=720 npm run verify:soak`, machine sur secteur **et laissée branchée**, couvercle ouvert, **jamais éteinte** pendant douze heures ; si la croissance ne se borne pas : profil natif (heaptrack) ou jemalloc, à installer par l'exploitant |
| 4 | **Aucune recette par un utilisateur** | On ne sait pas si un client s'en sort seul | 3 à 5 personnes, un observateur, l'instance du pilote et GitHub de test ; `docs/PILOTE-RECETTE-UTILISATEUR.md` |
| 5 | Claude Desktop jamais testé | Les clients qui l'utilisent n'ont pas de preuve | Une installation de Claude Desktop et une instance joignable ; consigner `initialize`, `tools/list` et une action de chaque décision |
| 6 | Mutant `bloque-executable` attribué à C1 et non à C3 (`conformance -- --mutants` sort en 1, déjà le cas sur `c75406a`) | Défaut d'attribution du kit de conformité, pas du produit | Revoir le mutant ou la dépendance C3 → C1 dans `conformance/` ; ne pas assouplir le critère |

Les anciens blocages « GitHub jamais éprouvé » et « Slack et Linear jamais éprouvés » sont **levés** : les trois connecteurs passent ensemble contre les vrais services (`STRESS-TEST-LOG` § 5.11).
L'ancien blocage « le serveur écoute sur `0.0.0.0` » est **levé** (`PLACET_HOST`, § B.1).
L'ancien blocage « 500 intermittent » est **levé** depuis `075c896` (course du plan
d'identité, § F.2).

---

## F. Changements

### F.1 Porte de lancement du pilote (`dbe6bc6` → `7d90970`)

| Défaut | Gravité | Correctif | Test |
|---|---|---|---|
| Le serveur écoutait sur `0.0.0.0` en dur : une instance de développement ou de démonstration était joignable du réseau local | P2 (exposition, l'authentification restait exigée) | `PLACET_HOST`, défaut `127.0.0.1`, IP ou `localhost` seulement ; `0.0.0.0` écrit dans l'image et les Compose, pour le conteneur ; le serveur annonce son écoute | `server-binding.test.ts` (échoue sur l'ancien code), `deploy-binding.test.ts`, `config-validation.test.ts`, `verify:compose` |
| MCP : un effet inconnu était dit « the execution did not complete » | P1 (un agent réessaie, doublon possible) | « Outcome UNKNOWN … Do not retry », champ `effect` | `connector-launch-path.test.ts` (échoue sur l'ancien routeur) |
| Console : le reçu d'une exécution récente affichait « Execution not found » | P2 (étape 8 de la recette impossible) | la page demande l'exécution au serveur ; « introuvable » seulement sur 404 | `execution-detail-lookup.test.ts` (échoue sur l'ancien code), vérifié dans le navigateur |
| Les deux tests de redémarrage PostgreSQL ne pouvaient s'exécuter sans PostgreSQL installé sur l'hôte | — (preuve manquante) | `PLACET_TEST_PG_DOCKER` | exécutés : 2/2 |

`verify:launch` éprouve désormais le refus réel de GitHub (non exécuté faute de
credential). Procédures du pilote : `docs/PILOTE-VALIDATION-CONNECTEURS.md`,
`docs/PILOTE-CHECKLIST-EXPLOITANT.md`, `docs/PILOTE-RECETTE-UTILISATEUR.md`.

### F.2 Campagne d'endurance (`620ed27` → `075c896`)

Aucune migration ajoutée. Chaque test ci-dessous a été exécuté contre l'ancien code et y
échoue.

| Défaut | Gravité | Correctif | Test |
|---|---|---|---|
| D1 — Course dans le protocole synchrone du plan d'identité : une notification tardive réveillait la requête suivante avant sa réponse (`JSON.parse("")`, la `500` intermittente, 2 en 60 min) ; après un délai dépassé, la réponse orpheline de la requête N était rendue à la requête N+1 | **P1** (lignes d'identité rendues à une autre requête ; 500 sur des lectures authentifiées) | génération + identifiant de requête dans l'en-tête partagé ; réveils sans réponse et réponses étrangères ignorés ; worker strictement séquentiel (`server/identity/sync-postgres{.ts,-worker.cjs}`) | `sync-postgres-protocol.test.ts` (worker de substitution déterministe) |
| D2 — Tête de chaîne des reçus et liste des reçus lues par parcours séquentiel + tri de tous les reçus du locataire, sous son verrou ; sonde de santé `count(*)` sur toutes les exécutions | P2 (débit d'écriture d'un locataire borné par son historique : 68,6 ms par écriture à 180 000 reçus) | lecture indexée des reçus numérotés, repli sur les reçus antérieurs à la migration 13 seulement s'il manque des lignes ; `LIMIT 1` (`server/authority/store.ts`, `server/repositories/{postgres,sqlite}.ts`) | `phase11-postgres-core.test.ts` : EXPLAIN des requêtes réellement émises ; ordre inchangé avec des reçus sans numéro |
| D3 — MCP annonçait « executed (SIMULATED) », `simulated: true`, pour un appel réel de connecteur ; consignes du serveur « every tool is SIMULATED » | P1 (un agent qui croit à une simulation peut recommencer pour de vrai) | `mode: "CONNECTOR"`, « REAL call to the connected service » (`server/mcp/router.ts`) | `connector-launch-path.test.ts` |
| D4 — Même défaut pour un appel bloqué ou retenu (rien n'a tourné, mais l'outil n'est pas simulé) | P3 | mode tiré de la fiche du catalogue | `connector-launch-path.test.ts` |
| Cursor ne pouvait pas se connecter (poignée de main `initialize`) | P1 | mode de compatibilité `2025-06-18` / `2025-03-26` (commit `620ed27`) | `mcp-legacy-compat.test.ts`, Cursor réel |

`script/verify-load.ts` gagne `LOAD_LEVELS`, `LOAD_MODE=execute`, le détail des erreurs par
étape et statut, et un palier de retour au calme vérifié.

### F.3 Chantier précédent (`c75406a..8a49b30`, 22 commits, 89 fichiers)

Aucune migration ajoutée. Aucun secret dans le diff (vérifié par recherche des préfixes de
jetons et par `scan:secrets`).

**Défauts corrigés, avec leur test de régression**

| Défaut | Gravité | Correctif | Test |
|---|---|---|---|
| Un délai dépassé APRÈS l'envoi était rapporté « rien envoyé » et restait rejouable (doublon possible) | P0 (reçu faux) | `transport-failure.ts`, `requestMayHaveReached` ; `dispatched:"unknown"` ; rejeu refusé sauf lectures ; relance sur attestation `approve` | `unknown-effect.test.ts`, parcours de lancement |
| La création Linear était présumée idempotente sans preuve | P2 | retirée de la liste rejouable ; `verify:launch` éprouve le doublon contre Linear | `unknown-effect.test.ts` |
| La garde anti-SSRF de la socket ne voyait pas les IP littérales | P2 (défense en profondeur ; chemins des locataires déjà protégés en amont) | refus avant toute socket | `unknown-effect.test.ts` |
| MCP : connecteurs invisibles (registre global), arguments refusés, tout décrit « SIMULATED » | P1 | registre du locataire, `action-arguments.ts`, description réelle | parcours de lancement § 6 |
| MCP : actions d'un connecteur non connecté annoncées | P1 | filtrage sur l'état vérifié, relu au plus toutes les 15 s, dégradé sur refus d'authentification du service | `mcp-connector-exposure.test.ts` |
| Impossible d'inviter un client sur l'image de production | P1 | `dist/workspace-create.cjs` | `verify:compose`, `verify:launch` |
| Le serveur refusait de démarrer sans mot de passe dans l'environnement | P1 | `PLACET_ACCOUNTS=database` (opt-in explicite) | `rbac.test.ts` |
| `PLACET_KEK` commentée dans le gabarit de production (connecteurs en 503) | P1 | obligatoire dans `placet.env.example` | — |
| `pilot:down` décrit comme destructeur dans trois textes | P2 | textes corrigés | `pilot-commands-docs.test.ts` |
| Deux copies du dépôt se volaient la pile `placet-local` | P2 | `pilot-up.sh` refuse | — |
| « Acme Corp » en dur dans la console ; « Bad credentials » brut ; liste affichant « Failed » pour un effet inconnu | P3 | corrigés | `run-presentation.test.ts` |

**Fichiers principaux** : `server/connectors/{slack,linear,oauth-install,guardrails,transport-failure,timeouts}.ts`,
`server/connectors/{github,connector-tool,index}.ts`, `server/gateway/{agent-gateway,retryability}.ts`,
`server/mcp/{action-arguments,router,tool-catalog}.ts`, `server/notifications/webhook-transport.ts`,
`server/{scenario,workspace-invite,routes,routes-connectors,auth}.ts`, `shared/policy/{rules,types,actions}.ts`
(`exceptTargets`), `client/src/pages/{welcome,onboarding,execution-detail,executions}.tsx`,
`client/src/components/onboarding/*`, `script/{workspace-create,verify-launch,build,verify-compose,verify-soak,e2e-multitenant}.ts`,
`deploy/{placet.env.example,README.md,scripts/*}`, `docs/{DEMARRAGE,connectors,FINAL-PILOT-READINESS}.md`.

---

## G. Prochaines actions

**1. Terminé et prouvé (localement)** : tout ce qui est « VALIDÉE » au § C ; les mesures du
§ B.1 sur `7d90970`, celles des § B.2 et B.3 sur `075c896` et `8a49b30`.

**2. Exige l'exploitant, un compte externe ou une personne** : blocages 1, 2, 4 et 5 du § E ;
le passage d'endurance long (blocage 3) exige une machine branchée et allumée douze heures.

**3. Empêche un pilote réel aujourd'hui** : l'absence d'instance hébergée (blocage 1),
l'absence de recette (blocage 4) et la mémoire non attribuée (blocage 3). Les trois
connecteurs, eux, sont éprouvés contre les vrais services.

**4. Ordre conseillé** : endurance de 12 heures (une nuit, machine branchée) → instance
hébergée → recette avec 3 à 5 personnes.

---

## H. Le chemin d'un client pilote

**Exploitant (avant le client)** — terminal, Docker, domaine :

1. Machine avec Docker, nom DNS public pointant dessus, ports 80/443 ouverts.
2. `cd deploy && cp placet.env.example placet.env && chmod 600 placet.env`, puis
   `./scripts/generate-secrets.sh` (n'écrase rien) ; renseigner `PLACET_DOMAIN`,
   `PLACET_PUBLIC_URL`, `POSTGRES_PASSWORD`, `PLACET_SESSION_SECRET`, `PLACET_KEK`.
   **Ne jamais régénérer `PLACET_KEK` sur une base existante.**
3. Optionnel : applications OAuth Slack et Linear (`PLACET_SLACK_CLIENT_ID/SECRET`,
   `PLACET_LINEAR_CLIENT_ID/SECRET`).
4. `docker compose --env-file placet.env up -d --build` ; `./scripts/check-health.sh`.
5. Sauvegardes : `deploy/scripts/backup.sh` (prouvé par `verify:backup`).
6. Inviter : `docker compose --env-file placet.env exec placet node dist/workspace-create.cjs --org "Client" --email admin@client.com`,
   remettre le lien imprimé par un canal de confiance (7 jours, une utilisation).

**Client (sans terminal)** — `docs/DEMARRAGE.md` :

1. Ouvrir le lien, choisir nom et mot de passe : connecté.
2. Démarrage guidé : inviter un approbateur ; connecter GitHub, Slack, Linear (OAuth si
   l'exploitant l'a configuré, sinon jeton guidé pas à pas) ; choisir dépôt, canal, équipe et le
   sort des écritures ; créer l'agent et copier sa configuration ; lancer le scénario.
3. Première action gouvernée : la lecture passe, les écritures attendent l'approbation dans la
   page, la tentative hors périmètre est bloquée sans appel, chaque résultat porte le lien vers
   le service et le reçu d'audit.

Liste détaillée de l'exploitant : `docs/PILOTE-CHECKLIST-EXPLOITANT.md`.

Restent à la charge du client : créer un jeton si l'OAuth n'est pas configuré, inviter le bot
Slack dans ses canaux, brancher son propre agent (client MCP — révisions `2025-06-18`,
`2025-03-26` ou `2026-07-28` ; vérifié avec Cursor —, ou API HTTP).

---

## I. Déploiement — ce que `verify:compose` a établi (35/35 sur `7d90970`)

Démarrage ordonné (migration ponctuelle avant Placet, schéma 24) ; HTTPS 200, HSTS, en-tête
`Server` retiré, port 80 → 308 ; processus non root, système de fichiers en lecture seule,
`no-new-privileges`, écriture dans `/app` refusée, PostgreSQL non publié ; parcours client à
travers le proxy ; invitation d'un client par la commande de l'image ; base arrêtée : `/api/ready`
503, `/api/live` 200, reprise sans redémarrage ; `docker compose down` (sans `-v`) puis `up` :
administrateur et compte client se reconnectent, fichier de secrets inchangé. Le banc supprime
ensuite **ses propres** volumes (projet `placet`, créé par lui). Sur `7d90970`, s'y ajoutent
les contrôles réseau : écoute `0.0.0.0:5000` lue dans le noyau du conteneur, aucun port de
Placet publié sur l'hôte, connexion directe de l'hôte refusée, seul le proxy publié (80, 443),
401 à travers le proxy sans credential (35/35).
