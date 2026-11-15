# Journal des tests d'endurance, de charge et de panne

Chaque passage est consigné avec sa commande, sa révision, son environnement et son
résultat — **échecs compris**. Rien n'est retiré ni réécrit pour rendre l'historique propre.

## Environnement commun

- Machine : Linux, **2 processeurs, 7 Go de RAM (~1 Go disponible au repos)**, Docker.
- Node 22.23.2. Bundle de production `dist/index.cjs` construit depuis la révision indiquée.
- PostgreSQL 17 **jetable** dans un conteneur dédié aux preuves (`placet-proof-pg`, boucle
  locale, port 55498), supprimé après usage. Aucune base ni aucun volume existants touchés.
- Les services externes (GitHub, Slack, Linear) ne reçoivent **jamais** de trafic de charge :
  les bancs emploient un serveur aval local qui n'importe rien de Placet.
- Sorties complètes conservées sous `~/.cache/placet-suite/<révision>/` sur la machine.

---

## 1. Historique antérieur à la campagne (19 octobre 2026)

Tous : `SOAK_MINUTES=… npm run verify:soak`, un cycle = décider, exécuter, relayer, lire les
reçus (`GET /api/actions/receipts`), scruter les métriques ; un seul client à la fois.

| # | Révision du bundle | Fin (UTC) | Durée | Sortie | Cycles | Résultat |
|---|---|---|---|---|---|---|
| H1 | `a7c8838` (serveur ≡ `71a2e95`) | 05:35 | 10 min | **1** | 5 736 (~9,6/s) | **16/17 — deux `500` sur `GET /api/actions/receipts`** (cycles 963 à 89 s et 3 390 à 322 s). Corps : `internal_error`. Cause non capturée : le banc n'imprimait que les 40 dernières lignes du serveur |
| H2 | même bundle, banc instrumenté | 05:47 | 10 min | 0 | 7 804 (~13,0/s) | 17/17, 0 erreur |
| H3 | `8a49b30` | 06:21 | 10 min | 0 | 8 346 (~13,9/s) | 17/17, 0 erreur ; p95 du relais 33 → 37 ms |
| H4 | `27823ab` (code ≡ `8a49b30`) | 07:07 | 20 min | 0 | 14 314 (~11,9/s) | 17/17, 0 erreur ; **p95 du relais 33 → 57 ms** |

Un passage plus ancien (avant ce chantier, cité dans le source du banc) avait relevé une
lecture des reçus non-200. Entre le bundle de H1 et `8a49b30`, le serveur ne diffère que
par un message de démarrage et un libellé d'audit de relance : aucun changement sur le
chemin de lecture des reçus. **Le défaut n'est donc pas corrigé ; il est intermittent.**

---

## 2. Campagne — révision `620ed27`

### 2.0 Porte d'entrée

| Commande | Sortie | Résultat |
|---|---|---|
| `npm run typecheck` · `lint` · `build` | 0 · 0 · 0 | |
| `npx vitest run` des fichiers ciblés (effet inconnu, rejeu, parcours de lancement, exposition MCP, compatibilité MCP, isolation, isolation structurelle, concurrence, expiration des approbations, client) | 0 | 12 fichiers, **237/237** |
| `PLACET_TEST_PG_URL=… PLACET_REQUIRE_POSTGRES=true npx vitest run server/test/postgres.test.ts` | 0 | **25/25** |

Aucun autre processus de test, aucune base d'un autre projet ou client en cours d'usage.

### 2.1 Reproduction du `500` sur les reçus — tentative A, sous contention CPU

Hypothèse : le `500` de H1 vient d'un délai (pool, verrou, horloge) qui n'apparaît que
lorsque la machine est saturée. Deux boucles `node -e "for(;;){}"` occupent les deux
processeurs pendant tout le passage.

| | |
|---|---|
| Commande | `DATABASE_URL=…55498… SOAK_MINUTES=15 npm run verify:soak` + 2 brûleurs CPU |
| Révision | `620ed27`, bundle construit à 10:12 UTC |
| Début / fin | 10:13:29 → 10:28:38 UTC |
| Sortie | **0** — 17/17 |
| Cycles | 5 989 en 15 min (~6,7/s, contre ~12/s sans contention) — 35 934 requêtes, **0 erreur** |
| Relais à travers Placet | p50 46 ms · p95 100 ms · p99 173 ms · max 1 082 ms ; amont direct p50 3 ms |
| Surcoût médian | 43 ms (5 611 appels appariés) |
| p95 du relais, début → fin | 79 → 114 ms (sous le seuil de dérive du banc) |
| Mémoire résidente | 229 → 237 Mo (+3,7 %) ; descripteurs 36 → 36 ; connexions PG ≤ 6 |
| Vérification de chaîne | 21 ms (1 reçu) → 567 ms (5 859 reçus), ~97 µs/reçu : O(n), attendu |

**Résultat : `500` non reproduit.** La contention CPU seule ne le déclenche pas.

**Erreur de mesure, consignée.** L'échantillonneur externe (`sampler.sh`, relevé toutes les
5 s) cherchait le processus par `pgrep -f "node .*dist/index.cjs"` et a mesuré **un autre
processus** : un conteneur Docker de l'utilisateur (répertoire `/app`) exécute aussi
`node dist/index.cjs`. Les colonnes « Placet » de `attempt-a-samples.csv` (RSS 39–59 Mo)
sont donc **fausses** et ne sont pas utilisées ; les colonnes machine et PostgreSQL restent
valides, et les chiffres de mémoire ci-dessus viennent du banc lui-même. L'échantillonneur
ne retient désormais que le bundle lancé depuis le dépôt. Le conteneur de l'utilisateur n'a
été ni arrêté ni modifié.

### 2.2 Endurance 60 minutes — **référence AVANT correctifs** (code de `620ed27`)

Le service mesuré exécute le bundle construit depuis `620ed27` (10:12 UTC), **avant** les
correctifs du §2.3 : aucun résultat de ce passage ne leur est attribué.

| | |
|---|---|
| Commande | `DATABASE_URL=…55498/postgres SOAK_MINUTES=60 npm run verify:soak` (base jetable créée et supprimée par le banc) |
| Révision / bundle | `620ed27`, `dist/index.cjs` du 19 oct. 10:12:25 UTC |
| Début / fin | 10:35:25 → 11:35:31 UTC (60,0 min) |
| Sortie | **1** — **16/17** |
| Cycles | 32 552 (~9,0/s) ; un cycle = décider, exécuter, relayer, lire les reçus, scruter |
| Erreurs | **`GET /api/actions/receipts` → 500 × 2** (cycle 10 823 à 870 s ; cycle 29 689 à 3 196 s). Aucune autre |
| Relais à travers Placet (régime établi, 31 710 appels) | p50 32 ms · p95 78 ms · p99 114 ms · max 413 ms ; amont direct p50 2 ms · p95 4 ms |
| Surcoût médian | 30 ms |
| p95 du relais, premier → dernier relevé | 54 → 89 ms (sous le seuil de dérive du banc) |
| Mémoire résidente (banc) | 134 Mo au démarrage ; 248–260 Mo jusqu'à ~1 450 s ; palier à 365 Mo de ~1 650 à ~2 700 s ; puis 272–300 Mo. Non monotone — elle redescend : ramasse-miettes, pas une fuite démontrée. Verdict du banc : 273 → 331 Mo (+21,4 %), sous son seuil |
| Descripteurs / connexions PG | 36 → 36 ; ≤ 7 |
| Vérification de chaîne | 786 ms pour 32 387 reçus |
| Machine (échantillonneur corrigé, 575 relevés) | RAM disponible minimale 1 116 Mo ; charge 1 min max 6,38 ; CPU moyen du processus Placet 28 % ; PostgreSQL ≤ 228 Mio, ≤ 8 connexions. Swap : 1,9 Go utilisés sur 4 Go à la fin |

**Le `500` est reproduit, et cette fois la trace est capturée** (le banc imprime les lignes du
serveur autour de chaque requête en échec) :

```
[req_05297dde…] Unhandled error: SyntaxError: Unexpected end of JSON input
    at JSON.parse (<anonymous>)
    at m (dist/index.cjs:211:1808)
    at Object.run (dist/index.cjs:211:2395)
    at Object.resolveActive (dist/index.cjs:1120:1027)   ← authentification de la requête
[req_20237c3d…] Unhandled error: SyntaxError: Unexpected end of JSON input
    at Object.get … at Object.membership …               ← appartenance à l'organisation
```

Ce n'est donc **pas** la lecture des reçus : c'est l'authentification de la requête, par le
plan d'identité synchrone (`server/identity/sync-postgres.ts`). Le point d'entrée des reçus
est simplement la requête authentifiée la plus fréquente du banc. Sortie originale conservée
en lecture seule : `~/.cache/placet-suite/620ed27/campagne/soak60.original.txt`.

### 2.3 Défauts trouvés par la campagne, et leurs correctifs (non encore mesurés en charge)

**D1 — Course dans le protocole du plan d'identité (cause du `500`).** Le worker publiait
l'état « terminé » puis notifiait, en deux instructions ; le thread principal remettait la
même case à « en attente » avant chaque requête. Quand le thread principal voyait l'état
avant la notification, il passait à la requête suivante, et la notification tardive
réveillait l'attente de CELLE-CI avant toute réponse : longueur 0, `JSON.parse("")`, 500.
Le même défaut avait une forme plus grave : après un délai dépassé, la réponse tardive de
la requête N était lue comme celle de la requête N+1 — des lignes d'identité rendues à une
autre requête. Correctif : un compteur de génération sur lequel seul le thread principal
attend, l'identifiant de la requête renvoyé par le worker, une boucle qui ignore tout
réveil sans nouvelle réponse et toute réponse qui n'est pas la sienne ; le worker traite
une requête à la fois. Test `sync-postgres-protocol.test.ts` (worker de substitution
déterministe) : **sur l'ancien code, 2 échecs sur 3** — `SyntaxError: Unexpected end of JSON
input` et `expected { echo: 'slow' } to deeply equal { echo: 'lent-frais' }` ; sur le
nouveau, 3/3.

**D2 — Lecture de la tête de chaîne des reçus en O(n), sous le verrou du locataire.**
`ORDER BY entry_seq DESC NULLS LAST, …` ne correspond à aucun index : `EXPLAIN ANALYZE` sur
la base du passage en cours (432 reçus) montre un parcours séquentiel puis un tri top-N
(0,88 ms), contre un parcours d'index arrière (0,05 ms) pour la lecture scindée. Correctif
dans `server/authority/store.ts` : lecture des reçus numérotés par l'index, puis, seulement
s'il manque des lignes, des reçus sans numéro (antérieurs à la migration 13). La sonde
`ping()` comptait toutes les exécutions de tous les locataires : remplacée par `LIMIT 1`.

**D3 — MCP annonçait « SIMULATED » pour un appel réel de connecteur.** Relevé en relisant ce
que Cursor recevait : `Allowed and executed (SIMULATED)` et `simulated: true` pour un message
Slack réellement publié. Un agent qui croit à une simulation peut recommencer pour de vrai.
Correctif : `mode: "CONNECTOR"`, texte « REAL call to the connected service », consignes du
serveur corrigées. Test ajouté au parcours de lancement.

**D4 — MCP : un appel BLOQUÉ ou RETENU sur un connecteur se disait « SIMULATED ».** Relevé
par le relais de Cursor après le correctif D3 : sans résultat d'outil (rien n'a tourné), le
mode retombait sur « SIMULATED ». Il vient désormais de la fiche du catalogue reçue par
l'agent (`CONNECTOR` pour un connecteur). Test : parcours de lancement, appel bloqué.

Vérification que chaque test discrimine (exécuté contre l'ancien code, fichier remis
ensuite) : D1 2 échecs sur 3 ; D2 l'EXPLAIN montre `Sort Key: entry_seq DESC NULLS LAST…` ;
D3 `"mode": "SIMULATED", "simulated": true` pour une issue Linear réellement créée.

### 2.4 D2 mesuré : lecture de la tête de chaîne à 200 000 reçus

Table jetable copiée du schéma migré (`LIKE action_receipts INCLUDING ALL`), 180 000 reçus
pour le locataire mesuré, `EXPLAIN (ANALYZE)` sur PostgreSQL 17 :

| Lecture | Avant | Après |
|---|---|---|
| Tête de chaîne (à chaque écriture, sous le verrou du locataire) | **68,6 ms** — parcours séquentiel parallèle + tri top-N | **0,047 ms** — parcours d'index arrière |
| Liste des 100 derniers (`GET /api/actions/receipts`) | 64,6 ms | 0,11 ms |
| Sonde `ping()` | 32,8 ms (`count(*)`) | 0,025 ms (`LIMIT 1`) |

Avant correctif, un locataire à 180 000 reçus ne pouvait donc pas dépasser ~15 écritures/s,
quelle que soit la machine : le verrou du locataire est tenu pendant ce tri.

### 2.5 Charge progressive — `verify:load` (bundle de production, PG jetable)

Même banc (`script/verify-load.ts` de l'arbre de travail, copié dans la copie de
`620ed27`), même machine, l'un après l'autre, rien d'autre en cours. Garde mémoire : refus
de démarrer sous 900 Mo disponibles, arrêt du banc sous 400 Mo. **Aucun arrêt déclenché.**

**Voie d'écriture** — `LOAD_MODE=execute LOAD_LEVELS=1,4,16,32,64 LOAD_SECONDS=15` ; un
cycle = autoriser puis exécuter (un reçu écrit) ; base neuve à chaque passage.

| Clients | AVANT (`620ed27`) cycles/s · p50 · p95 · p99 | APRÈS (correctifs) cycles/s · p50 · p95 · p99 |
|---|---|---|
| 1 | 29 · 31 · 54 · 100 ms | 33 · 29 · 43 · 52 ms |
| 4 | 48 · 72 · 144 · 259 ms | 54 · 70 · 109 · 152 ms |
| 16 | 49 · 294 · 575 · 856 ms | 52 · 279 · 414 · 1 088 ms |
| 32 | 54 · 586 · 718 · 783 ms | 56 · 549 · 739 · 918 ms |
| 64 | 54 · 1 160 · 1 364 · 1 427 ms | 58 · 1 076 · 1 344 · 1 441 ms |
| retour au calme (1) | 33 · 28 · 48 · 75 ms | 36 · 24 · 45 · 93 ms |
| Erreurs | 0 / 3 576 | 0 / 3 867 |
| Sortie | 0 (7/7) | 0 (7/7) |

À ce volume (~3 800 reçus par passage) les deux versions sont **équivalentes** à la marge
de bruit près : le coût corrigé par D2 est proportionnel au nombre de reçus et ne pèse
qu'au-delà de quelques dizaines de milliers (§2.4). La saturation de la voie d'écriture,
~55 cycles/s dès 16 clients sur un seul locataire, vient de la sérialisation voulue de la
chaîne par locataire (verrou consultatif), pas d'une ressource machine : RAM disponible
minimale 2 172 Mo (avant) et 2 206 Mo (après), boucle d'événements p99 24–25 ms.

**Voie de décision, rampe jusqu'à 256 clients** — APRÈS seulement,
`LOAD_MODE=decide LOAD_LEVELS=1,8,32,64,128,256 LOAD_SECONDS=12` :

| Clients | req/s | p50 | p95 | p99 | sonde `/api/live` p95 |
|---|---|---|---|---|---|
| 1 | 84 | 11 ms | 17 ms | 25 ms | 8 ms |
| 8 | 148 | 50 ms | 84 ms | 133 ms | 27 ms |
| 32 | 158 | 181 ms | 357 ms | 486 ms | 63 ms |
| 64 | 145 | 394 ms | 743 ms | 1 040 ms | 92 ms |
| 128 | 158 | 774 ms | 1 099 ms | 1 376 ms | 57 ms |
| 256 | 161 | 1 545 ms | 2 163 ms | 2 897 ms | 52 ms |
| calme (1) | 101 | 9 ms | 16 ms | 27 ms | 7 ms |

0 erreur sur 10 532 requêtes, sortie 0. **Point de saturation : ~150–160 décisions/s dès
8 à 32 clients** sur cette machine ; au-delà la latence croît linéairement (file), sans
erreur ni rejet, et revient à la valeur de repos après le pic. Retard de boucle p99 49 ms,
max 685 ms. RSS max 232 Mo ; RAM disponible minimale 2 181 Mo ; connexions PG ≤ 15.

### 2.6 Pannes et reprise — code APRÈS correctifs (`620ed27` + arbre de travail)

| Commande | Sortie | Résultat |
|---|---|---|
| `npm run chaos` (sans `DATABASE_URL`) | 0 | 26 pannes gérées, 0 message cryptique, **0 échec silencieux**, 2 non simulables (disque plein, base en lecture seule : privilèges requis) |
| `npm run chaos:postgres` (base migrée dédiée, `PLACET_TEST_PG_DOCKER=placet-proof-pg`) | 0 | 15/15 — le conteneur de preuves réellement arrêté sous une instance vivante puis relancé ; le même processus redevient prêt sans redémarrage |
| `npm run e2e:multitenant` | 0 | 98/98, sauvegarde et restauration comprises |
| Tests PostgreSQL (8 fichiers, base dédiée, `PLACET_TEST_IDENTITY_PG_URL` compris) | 1 puis 0 | premier passage : **1 échec — mon propre test** D2, trop strict (il refusait le tri de la lecture de repli des reçus sans numéro, qui suit l'index temporel et ne s'exécute que si la page n'est pas remplie). Assertion corrigée, fichier relancé : 29/29. Les 7 autres fichiers : 0 échec. `phase12-restart-reconnect` (2 tests) **non exécuté** : il exige `pg_ctlcluster` sur l'hôte |

### 2.7 Client MCP réel — Cursor, de bout en bout, sur services simulés isolés

`cursor-agent` **2026.08.11-e8db854** (s'annonce `Cursor 1.0.0`), projet temporaire
(`.cursor/mcp.json` du projet, approbation propre à ce projet ; aucun réglage global de
Cursor modifié — pas de `~/.cursor/mcp.json`). Instance Placet isolée (SQLite jetable,
port 5099), connecteurs pointés sur de **faux** services locaux (7101–7103) qui consignent
service, méthode et canal, jamais de corps. Un relais journalisant intercalé n'écrivait
qu'une liste blanche de champs (noms, versions, statuts, booléens de gouvernance — aucune
valeur d'argument, aucun texte de résultat, aucun en-tête d'autorisation), dans un
répertoire `700` ; relais et journaux **supprimés** après extraction du résumé.

| Étape | Résultat mesuré |
|---|---|
| `initialize` | 5 fois, 200 ; révision demandée `2025-11-25` → **négociée `2025-06-18`** ; Cursor poursuit avec l'en-tête `MCP-Protocol-Version: 2025-06-18` |
| `GET /api/mcp` (flux SSE) | 405, attendu ; Cursor continue |
| `tools/list` | 12 outils — les trois connecteurs connectés, rien d'autre |
| `tools/call slack.message.post` → canal choisi | **ALLOW**, attempted, succeeded, `mode: CONNECTOR` ; faux Slack : **1** `chat.postMessage channel=C0PRODUIT01` |
| `tools/call slack.message.post` → `#general` | **BLOCK**, attempted false ; faux Slack : **0** appel |
| `tools/call github.issue.create` | **APPROVAL_REQUIRED**, attempted false ; faux GitHub : **0** appel |
| Approbation dans Placet, puis seconde approbation | 1re : attempted, succeeded, **1** `POST /repos/kryxor/produit/issues` ; 2e : attempted false, aucun appel |

Défauts trouvés par ce test : D3 (texte et mode « SIMULATED » pour un appel réel) et D4
(même chose pour un appel bloqué ou retenu) — corrigés, l'instance isolée relancée, l'appel
bloqué rejoué par Cursor : `mode: CONNECTOR, simulated: false`, toujours 0 appel au service.

Observation, non corrigée : le serveur écoute sur `0.0.0.0` sans option pour une boucle
locale ; l'instance de test était donc joignable du réseau local pendant le test (~10 min,
services simulés, clé de test).

### 2.8 Endurance 60 minutes APRÈS correctifs — passage n° 1, **INVALIDE (machine mise en veille)**

| | |
|---|---|
| Commande | identique au §2.2 : `DATABASE_URL=…55498/postgres SOAK_MINUTES=60 npm run verify:soak` |
| Source | `620ed27` + arbre de travail : correctifs D1–D4 non commités (empreinte du diff `3e06824f22fe`, conservé avec les SHA-256 des fichiers nouveaux) ; bundle construit à 12:12:41 UTC |
| Début / fin | 12:13:02 → 14:54:21 UTC — **161,2 min** au lieu de 60 |
| Sortie | **1** — 16/17 |
| Cause | journal système : `Lid closed` → `Suspending...` à **12:42:29**, `suspend exit` à **14:54:18**. Le service n'a tourné qu'environ 29 min ; au réveil l'échéance du banc était passée |

Ce que ce passage montre, et seulement pour les 29 minutes avant la veille : 22 986 cycles,
**0 erreur sur 137 916 requêtes**, p95 du relais 43 → 63 ms, descripteurs 36 → 36, RAM
disponible minimale 1 771 Mo. Le contrôle échoué (« mémoire résidente 243 → 307 Mo,
+26 % ») et le maximum de latence (7 907 873 ms, un appel resté en vol pendant la veille)
sont **produits par la veille** : le dernier relevé est pris au réveil. Mémoire résidente
observée avant la veille : 242–248 Mo de 240 à 1 020 s, puis un palier à 323 Mo dès
1 142 s, stable jusqu'à la veille — même forme que le palier du passage de référence
(260 → 365 Mo à ~1 650 s, puis redescente), ce qui désigne un agrandissement du tas plutôt
qu'une fuite, **sans le démontrer**.

Ce passage ne compte ni comme réussite ni comme preuve de correction : 0 `500` en
29 minutes est compatible avec le correctif, mais le passage de référence en a produit
deux en 60 minutes, soit ~1 attendu en 29 — l'absence n'a rien de significatif. La preuve
de D1 est le test déterministe du §2.3. Le passage est relancé en entier ci-dessous.

### 2.9 Endurance 60 minutes APRÈS correctifs — passage n° 2 (valide)

| | |
|---|---|
| Commande | identique au §2.2 |
| Source | identique au §2.8 (diff `3e06824f22fe`, bundle de 12:12:41 UTC) |
| Début / fin | 14:55:51 → 15:55:58 UTC (60,0 min) ; **0 mise en veille** (journal système vérifié par le script) ; maintien éveillé demandé à l'application |
| Sortie | **1** — **16/17** |
| Cycles | 40 505 (~11,3/s) — **0 erreur sur 243 030 requêtes**, aucune `500` |
| Relais (39 624 appels en régime établi) | p50 34 ms · p95 90 ms · p99 119 ms · max 1 423 ms ; amont direct p50 2 ms |
| Surcoût médian | 32 ms |
| p95 du relais, premier → dernier relevé | 67 → 96 ms (sous le seuil) |
| **Contrôle échoué** | **mémoire résidente 262 → 328 Mo (+25,1 %)**, au-dessus du seuil du banc |
| Mémoire résidente, relevés | 244–254 Mo jusqu'à ~1 260 s ; 304–326 Mo de ~1 440 à ~1 800 s ; 299–310 Mo jusqu'à ~2 520 s ; 357–360 Mo de ~2 700 à ~3 070 s ; 332 Mo à la fin. Non monotone, mais en hausse sur l'heure |
| Descripteurs / connexions PG | 36 → 36 ; ≤ 6 |
| Vérification de chaîne | 670 ms pour 40 190 reçus |
| Machine | RAM disponible min 1 297 Mo ; charge 1 min max 6,41 ; PostgreSQL ≤ 224 Mio |

**Comparaison avec la référence (§2.2), même commande, même machine** : `500` 2 → **0** ;
cycles 32 552 → 40 505 (+24 %) ; p50/p95/p99 du relais 32/78/114 → 34/90/119 ms (la charge de
la machine différait : poste de travail utilisé en parallèle) ; mémoire résidente : même
forme en paliers dans les deux versions (référence 273 → 331 Mo, +21,4 %, passé de justesse ;
ici +25,1 %, échoué). La croissance de mémoire **n'est pas introduite** par les correctifs —
elle est présente avant — mais elle **n'est pas expliquée** : voir §2.10.

### 2.10 Diagnostic de la mémoire résidente

But : savoir si la hausse de mémoire résidente est une fuite JavaScript (le tas encore
utilisé APRÈS un ramasse-miettes complet monte) ou une croissance hors tas (capacité du
tas, allocateur, thread du plan d'identité). Méthode : le même banc, avec une sonde
préchargée par `NODE_OPTIONS="--expose-gc --require heap-probe.cjs"` dans le seul processus
du bundle — toutes les 30 s, un ramasse-miettes complet puis `process.memoryUsage()` et
`v8.getHeapSpaceStatistics()`. Ni le code ni le banc ne sont modifiés ; le ramasse-miettes
forcé perturbe un peu la latence, donc ce passage ne sert **pas** de mesure de latence.

**Passage A — INTERROMPU.** `SOAK_MINUTES=30`, début 16:01:31 UTC. La machine a été
**éteinte** (`systemd-poweroff`, arrêt normal, ni plantage ni manque de mémoire) à
16:18:06 UTC, vers 962 s, avant la zone où le palier apparaissait dans les passages
précédents (1 100–1 650 s). Pas de ligne de sortie. Ce qu'il a relevé jusque-là : mémoire
résidente 223 → 238 Mo ; tas utilisé après ramasse-miettes **19,2 → 20,5 Mo**, plat ;
`ArrayBuffer` 32 Mo constants (le tampon partagé de 32 Mio du plan d'identité) ; externe
2,6 → 3,5 Mo. Le redémarrage a vidé `/tmp` (outils et copie de travail de `620ed27`
perdus ; résultats intacts sous `~/.cache/placet-suite/`) ; le conteneur de preuves,
arrêté par l'extinction, a été relancé. Les conteneurs `placet-local` de l'utilisateur
sont repartis seuls (leur politique de redémarrage) ; ils n'ont pas été touchés.

**Passage B — 40 minutes, complet.** `SOAK_MINUTES=40` avec la sonde, 16:29:50 → 17:09:56
UTC, 0 mise en veille, machine non redémarrée pendant le passage. Code identique (`3e06824f22fe`).
Sortie 0, 17/17, 29 820 cycles, **0 erreur sur 178 920 requêtes**. Le contrôle de mémoire
passe ici (220 → 249 Mo, +13,1 %) **parce que** le ramasse-miettes forcé toutes les 30 s
contient la capacité du tas : ce passage ne remplace donc pas le §2.9, qui reste un échec.

| t (s) | RSS | tas utilisé après GC | tas alloué (`heapTotal`) | `ArrayBuffer` | reste (RSS − tas alloué − `ArrayBuffer`) |
|---|---|---|---|---|---|
| 30 | 206,6 | 18,6 | 54,2 | 33,3 | 119 |
| 510 | 220,3 | 20,5 | 61,5 | 32,0 | 127 |
| 990 | 221,3 | 20,4 | 59,7 | 32,0 | 130 |
| 1 230 | 245,1 | 20,5 | 58,2 | 32,0 | 155 |
| 1 470 | 245,9 | 20,4 | 71,7 | 32,0 | 142 |
| 1 950 | 247,1 | 20,4 | 69,5 | 32,0 | 146 |
| 2 191 | 249,8 | 20,4 | 65,0 | 32,0 | 153 |
| 2 401 | — | — | — | — | 192 (dernier relevé, pendant la vérification finale de chaîne) |

(en Mo ; 80 relevés dans `memoire/soak40-heap.csv`)

**Conclusion.** Le tas JavaScript du thread principal **ne fuit pas** : la mémoire encore
utilisée après un ramasse-miettes complet reste entre 18,6 et 20,7 Mo sur 40 minutes. Ce
qui croît est **hors de ce tas** : de ~120–133 Mo pendant les 1 200 premières secondes à
~145–160 Mo ensuite, par paliers. Ce reste comprend le code, le tas propre du worker du
plan d'identité (que `process.memoryUsage()` ne détaille pas) et l'allocateur natif. **Cette
croissance n'est pas attribuée** ; elle n'est pas démontrée bornée sur plusieurs heures.
Prochaine mesure : faire rapporter au worker d'identité ses propres statistiques de tas,
comparer avec `MALLOC_ARENA_MAX=2`, et un passage de plusieurs heures.

### 2.11 Pile de déploiement sur le code final

`npm run verify:compose`, 17:11:27 → 17:12:59 UTC, code `3e06824f22fe` : sortie **0, 29/29**.
L'image `placet:local` (construite à 17:11:58) contient bien le nouveau worker d'identité et
le texte MCP corrigé (vérifié dans l'image). Le banc a supprimé ses propres conteneurs et
volumes (projet `placet`) ; les conteneurs `placet-local` de l'utilisateur sont restés en
marche.

## 3. Commit

Les correctifs D1–D4 et les tests sont commités en `075c896`. Son code est identique, fichier
par fichier, au source exécuté par les passages §2.4 à §2.11 (diff `3e06824f22fe` des
fichiers modifiés, SHA-256 des fichiers nouveaux).

## 4. Ce qui reste ouvert après la campagne

- **Mémoire résidente** : contrôle échoué de justesse après correctifs (+25,1 %, §2.9) ;
  pas de fuite du tas JavaScript (§2.10) ; croissance hors tas non attribuée ; aucun
  passage de plusieurs heures.
- **Aucun service réel** n'a reçu de trafic de cette campagne, par principe : GitHub,
  Slack et Linear restent non éprouvés de bout en bout faute de credential de test.
- Les chiffres de débit et de latence sont ceux d'un portable à 2 processeurs, utilisé en
  parallèle par son propriétaire ; ils décrivent une forme, pas une capacité de production.

---

## 5. Porte de lancement du pilote (19 octobre 2026, soir)

### 5.1 Écoute réseau — `PLACET_HOST` (commit `0b7f03e`)

Mesuré sur le vrai serveur (`server/index.ts`, mode développement, SQLite jetable), à
travers l'interface réseau de la machine (192.168.1.24) :

| Configuration | Écoute (`ss`) | par 127.0.0.1 | par 192.168.1.24 | route protégée sans credential |
|---|---|---|---|---|
| défaut | `127.0.0.1:5391` | 200 | **refusée** | 401 |
| `PLACET_HOST=0.0.0.0` | `0.0.0.0:5391` | 200 | 200 | 401 (les deux interfaces) |
| `PLACET_HOST=intranet.exemple` | démarrage refusé, sortie 1, message nommant la variable | | | |

`server-binding.test.ts` le rejoue à chaque suite ; contre l'ancien `server/index.ts`, la
connexion par l'interface réseau ABOUTIT (`expected true to be false`). Pile de
production, `npm run verify:compose` : **35/35** — écoute `0.0.0.0:5000` lue dans
`/proc/net/tcp` du conteneur, `docker port placet-placet-1` vide, connexion directe de
l'hôte à `127.0.0.1:5000` échouée, seul le proxy publié (80, 443), 401 à travers le proxy.
Pilote local : le rendu de `docker-compose.local.yml` donne `PLACET_HOST=0.0.0.0` dans le
conteneur et une publication `127.0.0.1:5000` seulement ; la pile `placet-local` en marche
de l'utilisateur (image antérieure) publie `127.0.0.1:5055` et `127.0.0.1:55433` — lue,
pas modifiée.

### 5.2 Mémoire — sonde n° 2 : le worker d'identité mesuré à part

La sonde n° 2 ajoute le tas PROPRE du worker d'identité (`worker.getHeapStatistics()`,
constructeur `Worker` intercepté dans le préchargement — le produit n'est pas modifié) et
la mémoire résidente découpée par le noyau (`/proc/self/status` : anonyme, fichiers,
partagée). L'échantillonneur sélectionne le processus par son répertoire de travail (le
dépôt) et non par sa ligne de commande — l'erreur du §2.1, où un conteneur de
l'utilisateur avait été mesuré, ne peut plus se produire.

**Passage C — défaut.** `SOAK_MINUTES=40`, 17:55:24 → 18:35:31 UTC, 0 veille, bundle
construit à 17:55 depuis l'arbre de travail d'alors (écoute réseau incluse ; le changement
de texte MCP, venu ensuite, n'y est pas — sans effet sur la mémoire). Sortie 0, 17/17,
29 563 cycles, 0 erreur sur 177 378 requêtes, mémoire 230 → 254 Mo (+10,2 %).

| t (s) | RSS | anonyme | fichiers | tas principal après GC | tas principal alloué | worker : utilisé / alloué | `ArrayBuffer` |
|---|---|---|---|---|---|---|---|
| 30 | 216,8 | 159,1 | 58,0 | 18,6 | 60,0 | 11,7 / 25,6 | 32,0 |
| 480 | 228,8 | 170,9 | 58,1 | 20,4 | 57,5 | 8,4 / 11,6 | 32,0 |
| 960 | 231,2 | 173,2 | 58,1 | 20,5 | 59,7 | 8,1 / 11,6 | 32,0 |
| 1 200 | 251,1 | **193,1** | 58,1 | 20,5 | 57,2 | 8,4 / 11,6 | 32,0 |
| 1 920 | 252,7 | 194,8 | 58,1 | 20,4 | 58,7 | 8,4 / 10,6 | 32,0 |
| 2 400 | 262,1 | **204,2** | 58,1 | 20,6 | 68,2 | 8,1 / 10,6 | 32,0 |

Lecture : toute la croissance (+45 Mo) est de la mémoire **anonyme**, **hors des deux tas
V8** — le tas du thread principal est plat, **le tas du worker d'identité est plat**
(~8 Mo utilisés, il est donc écarté), les `ArrayBuffer` constants, la mémoire externe
faible, la mémoire de fichiers constante. Reste l'allocation native (malloc). La marche de
~20 Mo entre 960 et 1 200 s a la forme d'une arène d'allocateur.

**Passage D — `MALLOC_ARENA_MAX=2`.** Même banc, même bundle, même durée, 18:53:51 →
19:33:58 UTC, 0 veille, seul sur la machine. Sortie 0, 17/17, 28 778 cycles, 0 erreur sur
172 668 requêtes, mémoire 218 → 236 Mo (+8,2 %).

| t (s) | anonyme — défaut (C) | anonyme — `MALLOC_ARENA_MAX=2` (D) |
|---|---|---|
| 30 | 159,1 | 149,3 |
| 960 | 173,2 | 158,6 |
| 1 200 | 193,1 | 171,6 |
| 1 920 | 194,8 | 175,5 |
| 2 400 | 204,2 | 189,8 |
| croissance | **+45,1** | **+40,5** |

Les tas V8 (principal, worker) restent plats dans les deux passages.

**Conclusion à ce stade.** Limiter les arènes de l'allocateur abaisse le niveau d'environ
10 Mo mais **ne supprime pas** la croissance par paliers : les arènes de glibc ne sont pas
la cause principale. Ce qui croît est de la mémoire native anonyme, hors des deux tas V8,
hors du worker d'identité, hors des `ArrayBuffer` — **cause non attribuée**. Aucun défaut
de code n'est démontré ; aucun n'est écarté. Un allocateur alternatif (jemalloc) n'est pas
installé sur la machine et n'a pas été installé. La question décisive — la croissance se
borne-t-elle ? — demande un passage long : c'est l'objet du passage de 12 heures (§5.5).
Le problème de mémoire n'est **pas** classé résolu.

### 5.3 Les deux tests PostgreSQL jamais exécutés — exécutés

`server/test/phase12-restart-reconnect.test.ts` : **golden AI** (une instance vivante
traverse un vrai arrêt/redémarrage de PostgreSQL et se reconnecte sans être relancée) et
**golden AJ** (base absente : l'identité n'est pas devinée, l'appelant n'est pas
authentifié, rien n'est écrit dans un SQLite local). Ils exigeaient `sudo pg_ctlcluster`
sur un PostgreSQL installé sur l'hôte — absent ici (ni `pg_ctlcluster` ni `pg_isready`).
Le fichier accepte désormais `PLACET_TEST_PG_DOCKER=<conteneur>` : `docker stop`/`start`
d'un conteneur jetable, assertions inchangées (commit `0b7f03e`).

Exécution : conteneur dédié `placet-proof-pg-redemarrage` (PostgreSQL 17, boucle locale,
port 55497, créé pour ce test), base `placet_p12_restart`.
`PLACET_TEST_IDENTITY_PG_URL=… PLACET_TEST_PG_RESTART=1 PLACET_TEST_PG_DOCKER=placet-proof-pg-redemarrage npx vitest run server/test/phase12-restart-reconnect.test.ts`
→ **sortie 0, 2/2**. Les événements Docker confirment deux cycles réels : arrêt 19:38:37,
redémarrage 19:38:41 (AI) ; arrêt 19:38:44, redémarrage 19:38:47 (AJ). Aucun conteneur
de l'utilisateur n'a été arrêté.

### 5.4 Cursor de bout en bout, sur le build local (`0b7f03e`)

`cursor-agent` **2026.08.11-e8db854** (s'annonce `Cursor 1.0.0`), projet temporaire neuf
(`.cursor/mcp.json` du projet ; aucun `~/.cursor/mcp.json` ; aucun réglage global modifié —
Cursor a seulement créé son propre dossier de projet sous `~/.cursor/projects/`). Instance
isolée : **bundle de production sur PostgreSQL** (base dédiée `placet_cursor_e2e`), écoute
**127.0.0.1** seulement, connecteurs pointés sur de FAUX services locaux qui consignent
service, méthode, chemin et canal — jamais un corps. Relais de liste blanche entre Cursor
et Placet (noms, versions, statuts, booléens) ; relais, journaux, clés et projet supprimés
après extraction du résumé (`gate-final/cursor-resume-assaini.txt`, mode 600).

| Étape | Mesuré |
|---|---|
| `initialize` (×3) | révision demandée `2025-11-25` → **négociée `2025-06-18`**, 200 ; requêtes suivantes avec `MCP-Protocol-Version: 2025-06-18` |
| `tools/list` | **14** outils : les 12 des connecteurs connectés + `purchase`, `refund` (simulés, permis par le mandat) |
| `purchase` (simulé) | ALLOW, `effect: applied`, `mode: SIMULATED`, `simulated: true` ; aucun service appelé |
| `slack.message.post` → canal choisi | ALLOW, `effect: applied`, `mode: CONNECTOR` ; faux Slack : 1 `chat.postMessage channel=C0PRODUIT01` |
| `slack.message.post` → `#general` | **BLOCK**, `effect: none`, `mode: CONNECTOR` ; faux Slack : 0 appel |
| `github.issue.create` | **APPROVAL_REQUIRED**, rien envoyé |
| `github.issue.comment` (issue 999999) | APPROVAL_REQUIRED, rien envoyé |
| `slack.message.post` « PENDRE » (le faux Slack reçoit et ne répond jamais) | ALLOW, attempted, **`effect: unknown`**, texte « Outcome UNKNOWN … Do not retry » ; **Cursor n'a pas réessayé** : 1 seul envoi |
| Deux approbations **concurrentes** de la création d'issue | une 200 `attempted/succeeded`, l'autre 200 sans tentative ; faux GitHub : **1** `POST …/issues` |
| Approbation du commentaire sur l'issue inexistante | **refus réel du faux fournisseur** : 404 reçu, `attempted: true, succeeded: false`, `code: not_found`, `dispatched: true` (pas « inconnu ») ; 1 appel |
| Rejeu de l'effet inconnu SANS attestation | **409** « the action may already have taken effect » ; 0 envoi |
| Rejeu AVEC attestation (`confirmNotApplied`, rôle admin) | 200 ; **1** envoi (le faux Slack se tait encore → de nouveau inconnu) ; l'audit porte « Human attestation: unknown effect reported absent » |
| Audit, par exécution | bloquée : `Action blocked`, aucune exécution ; approuvée : `Approval granted → Tool execution completed` ; refusée par le fournisseur : `… Tool execution failed` ; effet inconnu : `Tool execution failed` + `dispatched=unknown` + attestation |

Ce test prouve la compatibilité de Cursor avec ce protocole et la sémantique des réponses
contre des services **simulés**. Il ne prouve ni une instance hébergée, ni de vraies
actions GitHub, Slack ou Linear. Observation : pour l'effet inconnu, l'API garde
`status: failed` à côté de `dispatched: unknown` ; la console affiche « Résultat
inconnu » (règle d'affichage), et MCP dit désormais `effect: unknown`.

### 5.5 Répétition de la recette utilisateur — par l'équipe, PAS une recette

Le parcours de `docs/PILOTE-RECETTE-UTILISATEUR.md`, joué dans le navigateur intégré contre
le vrai serveur (bundle de production, PostgreSQL, `PLACET_ACCOUNTS=database`, faux
GitHub local), à partir d'un lien produit par `node dist/workspace-create.cjs`. Ce n'est
pas une recette : la personne qui l'a jouée connaît le produit.

| # | Étape | Résultat |
|---|---|---|
| 1 | ouvrir l'invitation | la page nomme l'espace, l'adresse et le rôle |
| 2 | se connecter | compte créé, arrivée dans le démarrage guidé de **cet** espace |
| 3 | connecter GitHub | étapes de création du jeton affichées ; « Connecté · demo » après vérification par le service |
| 4 | régler le périmètre | dépôt coché, écritures « sur approbation », « Enregistré. Les agents n'agissent que sur 1 dépôt. » |
| 5 | brancher l'agent | agent et clé créés ; configuration MCP prête à copier, consignes Cursor |
| 6–7 | faire agir, voir les trois décisions | scénario : Autorisé, Approbation requise (approuvée dans la page : « exécutée par le service »), Bloqué (« rien n'a été envoyé au service ») |
| 8 | retrouver le reçu | **BLOCAGE TROUVÉ, CORRIGÉ** (ci-dessous) ; après correction : reçu complet, approbateur nommé, « Issue #43 ouverte » ; reçu de l'action bloquée : « denied before reaching the tool », 0 tentative |

Faux GitHub : 3 approbations → 3 `POST /repos/kryxor/produit/issues` ; **0** sur
`kryxor/site` (la ressource non choisie).

**Blocage trouvé — étape 8.** Le lien « Reçu d'audit » du démarrage menait à « Execution
not found » pour une exécution qui venait d'avoir lieu : la page de détail ne cherchait
que dans la liste chargée à la connexion. Corrigé dans l'écran existant
(`client/src/pages/execution-detail.tsx`) : absente du cache, l'exécution est demandée au
serveur ; « introuvable » seulement sur un 404 ; une panne réseau dite comme telle ; aucune
boucle de rechargement possible. Garde : `server/test/execution-detail-lookup.test.ts`
(échoue sur l'ancien code). Vérifié dans le navigateur après reconstruction du bundle et
redémarrage de la seule instance isolée.

**Observations, non corrigées** (à mesurer par une vraie recette avant d'y toucher) :
l'écran de détail d'une exécution est en anglais alors que le démarrage est en français ;
l'étape 5 ne passe jamais à « fait » ; les résultats du scénario ne restent pas affichés
après un rechargement de la page ; un rechargement complet déconnecte (choix de sécurité
documenté : la session n'est gardée que dans l'onglet) — la consigne au testeur doit le
dire.

Nettoyage : instance, faux services, lien d'invitation et journaux arrêtés ou supprimés ;
la base `placet_recette` reste dans le conteneur de preuves jetable.

### 5.6 Porte de régression finale — `7d90970`

16 commandes l'une après l'autre, arbre propre, 20:21:57 → 20:33:32 UTC, toutes en sortie
**0** : typecheck, lint, build, `scan:secrets` ; `npm test` 2 882 réussis / 0 échec / 80
ignorés (tous PostgreSQL) ; tests PostgreSQL 110/110 ; redémarrage réel de la base 2/2 ;
smoke 26/26 ; smoke:postgres 21/21 ; e2e 63/63 ; verify:upgrade 17/17 ; e2e:multitenant
98/98 ; verify:mcp 37/37 ; chaos 26 gérées / 0 silencieux ; chaos:postgres 15/15 ;
verify:compose 35/35. Sorties : `~/.cache/placet-suite/7d90970/porte/`.

### 5.7 Endurance de 12 heures — NON LANCÉE au moment de ce commit

Préparée, pas exécutée. Commande : `SOAK_MINUTES=720 npm run verify:soak` (script officiel,
sans plafond de durée ni sonde forçant le ramasse-miettes, pour ne pas fausser son contrôle
de mémoire), base jetable créée par le banc, échantillonneur externe toutes les 60 s
(`sampler-v2.sh` : mémoire résidente anonyme et fichiers, fils, descripteurs, RAM et swap
de la machine, charge, mises en veille). Prérequis observés : machine sur secteur, couvercle
**ouvert** (sa fermeture a mis la machine en veille au §2.8), rien d'autre de lourd en cours.
Attendu et à vérifier : la vérification de chaîne, en O(n), dépassera vraisemblablement le
seuil de 5 s du banc vers quelques centaines de milliers de reçus — ce serait une mesure
réelle, pas un artefact. **Aucun résultat n'est annoncé avant la fin du passage.**

### 5.8 Endurance de 12 heures — passage n° 1, INTERROMPU (arrêt de la machine)

`SOAK_MINUTES=720 npm run verify:soak` sur `67e804e` (bundle construit le 20 octobre à
17:15 UTC, serveur identique au commit), lancé détaché à **19:43:19 UTC** sur secteur,
couvercle ouvert. Le chargeur a été débranché vers 20:14 UTC (alerte de la surveillance) ;
la machine a ensuite été **arrêtée normalement** (`systemd-poweroff`, 21:16:14 UTC — ni
plantage, ni batterie vide d'après le journal). Le passage a donc duré **5 532 s
(≈ 1 h 32)** et ne compte ni comme réussite ni comme échec.

Jusqu'à l'arrêt : 57 570 reçus, **0 `500`, aucune erreur de requête**. Mémoire résidente
(relevés du banc) : 247–261 Mo jusqu'à ~1 000 s ; 317–335 Mo de ~1 050 à ~2 500 s ;
404–429 Mo de ~2 850 à ~3 940 s ; puis **redescente** à 353–426 Mo jusqu'à 5 532 s.
Paliers puis oscillation : pas de fuite démontrée, pas de borne démontrée non plus.
Machine pendant le passage : swap utilisé 1,1 → 2,8 Go (autres applications ouvertes),
RAM disponible jusqu'à ~1,7 Go.

Erreur de mesure, consignée : l'échantillonneur externe écrivait ses décimales avec une
virgule (paramètres régionaux français), ce qui décalait les colonnes du CSV ; les valeurs
brutes restent lisibles (RSS ≈ 392,6 Mo, anonyme ≈ 377,1 Mo à 21:15). Corrigé
(`LC_ALL=C`) pour le prochain passage.

Prérequis du prochain passage, confirmés par celui-ci : chargeur branché **et laissé
branché**, couvercle ouvert, machine non arrêtée pendant douze heures.

### 5.9 Coupure de la base SOUS trafic continu — six passages, trois défauts corrigés

`chaos:postgres` coupait la base sans trafic ; ici, `verify:soak` (6 min, un client en
boucle : décider, exécuter, relayer, lire les reçus) tourne pendant que le conteneur
jetable de la base est arrêté **15 s** à +90 s (`docker stop`, puis `docker start`).
Outil : `~/.cache/placet-suite/outils/panne-sous-charge.sh`. Batterie, sans secteur.

| # | Code | Résultat pendant la coupure | Processus | Reçus = exécutions, chaîne |
|---|---|---|---|---|
| 1 | `f40b486` | **~699 × 500** par type de requête (une 503 du limiteur) | vivant, reprise seule | 4 825 = 4 825, vérifiée |
| 2 | 503 global (non commité, ≡ `17f69e5`) | 809 × 503 par type ; **6 × 500** non identifiables (le banc ne gardait que 3 fenêtres) | vivant | 5 478 = 5 478, vérifiée |
| 3 | `17f69e5` + journal complet | 709 × 503 par type ; **1 × 500** : le relais répond lui-même `intercept_gateway_failed` | vivant | — |
| 4 | relais corrigé (≡ `c72c5c0`) | 709 × 503 ; **5 × 500** : 4 du plan d'identité (`read ECONNRESET`), 1 de `handle()` | vivant | 4 771 = 4 771, vérifiée |
| 5 | `c72c5c0` + identité/`handle()` | **LE PROCESSUS S'EST ARRÊTÉ** : `uncaught exception — shutting down: Connection terminated unexpectedly` (client `pg` emprunté par une transaction, sans écouteur d'erreur) ; le banc s'arrête sur `fetch failed` | **ARRÊTÉ** | — |
| 6 | ≡ `cb51644` (diff serveur `b56d49a50704`, vérifié identique) | **2 184 × 503, 0 × 500, 0 exception non attrapée** | **vivant**, reprise seule | **4 884 = 4 884, vérifiée** |

Défauts corrigés, chacun avec son test :

- **500 au lieu de 503** pendant une indisponibilité de la base — gestionnaire global
  (`17f69e5`), relais d'interception seulement quand rien n'est parti (`c72c5c0`),
  `handle()` et coupures relayées par le plan d'identité (`cb51644`). Un échec d'une autre
  nature reste 500 ; une requête relayée qui a atteint le fournisseur reste 500 « ne
  réessayez pas ». `database-unavailable.test.ts`.
- **Arrêt du processus** quand une connexion est coupée pendant qu'une transaction attend
  entre deux requêtes (`abd888b`) — le défaut le plus grave de la campagne : un simple
  redémarrage de la base pouvait abattre Placet, une fois sur cinq dans ces conditions.
  `postgres-connection-loss.test.ts` le reproduit à coup sûr (`pg_terminate_backend`) :
  contre l'ancien code, « Unhandled Errors: Connection terminated unexpectedly ».
- Outillage : le banc lui-même tombait sur une coupure (`9a73a67`) et ne montrait que
  trois échecs (`c210da1`, `SOAK_SERVER_LOG`).

Ce que ces passages ne prouvent pas : une coupure plus longue, une base qui revient
lentement, plusieurs instances de Placet, une perte réseau partielle (paquets perdus
plutôt que connexion refusée). Le message 503 ne prétend pas que rien n'a eu lieu : une
exécution coupée après l'appel au fournisseur reste possible en principe ; dans les
quatre passages mesurés jusqu'au bout, reçus et exécutions sont restés égaux.

### 5.10 GitHub réel — `verify:launch` et `verify:github`

Credential : jeton GitHub *fine-grained* de l'utilisateur, limité au seul dépôt de test
`<compte-de-test>/<dépôt-de-test>` (Issues R/W, Metadata R), lu depuis
`~/.config/placet/github-test.env` (600), jamais affiché ; aucune occurrence du préfixe du
jeton dans les sorties (vérifié à chaque passage).

| Passage | Code | Sortie | Résultat |
|---|---|---|---|
| `verify:launch` n° 1 | `67e804e` | 1 (10/18) | section 0 : les trois sondes « clé fabriquée » expirées — Wi-Fi déconnecté puis instable (journal système, 17:00) ; section 2 : le dépôt s'appelait en réalité `-placet-essai.` (nom transformé à la création), donc absent de la liste. Renommé par l'utilisateur |
| `verify:launch` n° 2 | `67e804e` | **2** (31/31) | **GitHub éprouvé de bout en bout** : espace par lien, credential vérifié par GitHub et scellé, périmètre en politiques, lecture autorisée et réussie, action hors périmètre bloquée sans appel, issue retenue puis approuvée et **relue chez GitHub**, seconde approbation sans effet, **refus réel de GitHub** (commentaire sur une issue inexistante : tentative, échec, pas d'« effet inconnu »), audit, nettoyage. Sortie 2 : Slack et Linear non fournis |
| `verify:github` n° 1 | `67e804e` | 1 (35/36) | seul échec : le banc attendait **trois** verbes, le connecteur en déclare cinq depuis `8ed1e35` — défaut du banc, jamais vu faute d'avoir tourné avec un vrai jeton. Corrigé (`a855116`) |
| `verify:github` n° 2 | `a855116` | 2 (7/7) | réseau : `api.github.com` injoignable (latences de 4 à 15 s mesurées à côté) ; rien d'éprouvé |
| `verify:github` n° 3 | `f9b5b21` | 2 (7/7) | réseau, de nouveau |
| `verify:github` n° 4 | `f9b5b21` | **0 (36/36)** | les cinq verbes exactement ; lecture, 404 sur un dépôt absent, ouverture d'issue, commentaire, refus locaux, révocation locale (GitHub considère le jeton toujours valide — le banc le dit) |

État du dépôt de test chez GitHub après les passages : issues #1, #2, #3, **toutes
fermées** (`not_planned`) ; #1 sans commentaire (le commentaire sur l'issue inexistante a
bien été refusé), #2 et #3 un commentaire chacune (celui du banc). Aucune autre écriture.

Ce qui reste non éprouvé contre GitHub : un délai incertain réel (non provocable sans
risque) ; l'OAuth (GitHub n'en a pas : jeton à portée fine, choix assumé).

### 5.11 GitHub, Slack et Linear ensemble, contre les vrais services

Credentials de test créés le 21 octobre, chacun lu depuis son fichier
`~/.config/placet/<service>-test.env` (600), jamais affiché ; les préfixes `github_pat_`,
`xoxb-`, `lin_api_` sont absents de chaque sortie (vérifié). Préparation dans le navigateur
de l'utilisateur, avec son accord pour chaque création : application Slack « Placet essai »
dans l'espace `kryxor`, créée depuis un manifeste avec exactement cinq portées de bot
(`chat:write`, `channels:read`, `channels:history`, `groups:read`, `groups:history`),
installée et jeton copié **par l'utilisateur** ; canal `#placet-essai` (`<canal-de-test>`) ;
espace Linear « Placet essai » (région UE) et son équipe par défaut `PLA`, clé d'API créée
et copiée **par l'utilisateur**. Aucune connexion Linear ↔ GitHub ou Slack activée, aucune
invitation, e-mails d'accueil désactivés.

| Commande | Code | Sortie | Résultat |
|---|---|---|---|
| `verify:launch`, trois services | `cdc206b` | **0** | **47/47** — voir ci-dessous |
| `verify:slack`, jeton de bot réel | `cdc206b` | **0** | **28/28** |

`verify:launch`, ce que les vrais services ont fait :

- **Slack** : connecté comme bot `placet_essai` ; lecture du canal autorisée et réussie ;
  message vers un canal hors périmètre **bloqué, jamais tenté** ; résumé retenu avant
  approbation, puis publié, **relu chez Slack**, supprimé.
- **Linear** : tâche retenue, approuvée, créée (`PLA-5`), **relue chez Linear** ; **Linear
  refuse un second `issueCreate` au même identifiant** (« conflict on insert of Issue ») —
  la garantie d'idempotence sur laquelle la règle de rejeu refusait de se fier tant qu'elle
  n'était pas démontrée ; seconde approbation sans effet ; tâche archivée.
- **GitHub** : issue retenue, approuvée, créée (#4), relue, fermée ; refus réel de GitHub
  sur une issue inexistante, enregistré comme un échec.

`verify:slack` : jetons utilisateur, d'application et de renouvellement refusés ; jeton de
bot accepté ; injection du jeton par Placet prouvée par la nature du refus de Slack
(`invalid_auth`, pas `not_authed`) ; canal réservé refusé (403, rien de parti) ; chemin non
couvert (créer un canal) refusé ; refus de Slack en `200 + ok:false` enregistré comme
**échoué** ; avec le vrai jeton, message publié puis supprimé ; jeton absent de la base, du
journal et de la sortie.

État laissé chez les services : canal `#placet-essai` sans aucun message du bot (deux
messages « a rejoint le canal ») ; Linear `PLA-5` archivée (`PLA-1` à `PLA-4` sont les tâches
d'exemple créées par Linear avec l'espace) ; GitHub #4 fermée. Rien d'autre.

Ce qui reste non éprouvé contre les vrais services : un délai incertain réel ; l'OAuth en un
clic de Slack et de Linear (exige une instance hébergée en HTTPS). La création Linear reste
exclue du rejeu automatique : l'idempotence est maintenant démontrée, mais lever cette
exclusion est une décision de produit, pas un effet de bord d'un test.

### 5.12 Stripe, connecteur natif, contre le vrai service (mode test)

Demande de l'utilisateur : Stripe dans la liste des connecteurs, fonctionnel comme les
trois autres. Connecteur `server/connectors/stripe.ts` (quatre verbes : solde, paiements,
clients, **remboursement** — financier), catalogue, permissions `read:payments` /
`execute:payments`, politiques de périmètre et d'écriture, arguments MCP, démarrage guidé,
scénario (lecture des paiements seulement ; tentative hors périmètre sur un compte non
choisi), section Stripe de `verify:launch`. Clé de test lue depuis
`~/.config/placet/stripe-test.env` (600), jamais affichée ; le préfixe `sk_test_` n'apparaît
dans aucune sortie sinon masqué (`sk_test_***`, vérifié par le banc).

Compte de test : `<identifiant retiré>` (« environnement de test placet »). Arbre de
travail sur `74422a2`, bundle reconstruit, PostgreSQL jetable (`placet-proof-pg`).

| Passage | Code | Sortie | Résultat |
|---|---|---|---|
| `verify:launch` n° 1, quatre services | arbre de travail | **1** | **56/60** — tout le parcours Stripe vert ; GitHub, Slack, Linear verts ; **4 échecs en phase 0** : sondes à clé fabriquée Linear (« socket hang up ») et Stripe (délai de 15 s dépassé) |
| sondes de la phase 0 rejouées seules, 3 fois | arbre de travail | — | **3/3** : Linear et Stripe refusent la clé fabriquée, `unauthorized`, motif cité (4 à 6 s par aller-retour : réseau lent) |
| `verify:launch` n° 2, quatre services | arbre de travail | **1** | **INVALIDE — réseau** : 23/37, les quatre services injoignables dès la phase 0 (délais de 15 s), connexion GitHub impossible, scénario sans réponse. Mesuré juste après : `api.github.com` sans réponse en 20 s |

`verify:launch` n° 1, ce que le vrai Stripe a fait :

- connexion vérifiée par Stripe (`GET /v1/account`), compte listé comme seule ressource,
  périmètre écrit en deux politiques ;
- scénario guidé : **lecture des paiements autorisée et réussie** chez Stripe ;
- remboursement sur un compte non choisi : **bloqué, jamais tenté** ;
- remboursement de 1,00 EUR : **retenu** avant approbation, et **relu chez Stripe** : aucun
  remboursement parti ; approuvé : `re_3US9leJzLw74jVWQ0RRQZ3Q2`, **relu chez Stripe** :
  100 centimes, sur le paiement choisi, métadonnée `placet_execution` = l'exécution ;
- seconde approbation : rien ;
- **la même requête rejouée directement avec `Idempotency-Key: placet-<exécution>` : Stripe
  rend le même remboursement**, aucun doublon.

Vérifications après les deux passages, directement chez les services : un seul
remboursement porte une marque Placet (celui ci-dessus) — le passage n° 2 n'a rien
remboursé ; les huit autres remboursements du compte (paires de 10 € et 5 €, 18 et
19 octobre, sans métadonnée) viennent de `verify:stripe`, le banc du paquet de règles du
pare-feu. Canal Slack : aucun message du bot. Linear : aucune tâche non archivée hormis les
quatre tâches d'exemple. GitHub : issue #5 (passage n° 1) fermée.

Un remboursement ne s'annule pas : `re_3US9leJzLw74jVWQ0RRQZ3Q2` (1,00 EUR, mode test)
reste dans le compte de test. Aucun argent réel.

Tests ajoutés : `connector-stripe.test.ts` (44, Stripe simulé) et
`connector-stripe-launch-path.test.ts` (17, API, passerelle, moteur, coffre et approbations
réels). Le second a corrigé deux de mes attentes, pas le code : au-delà du plafond de
l'agent, la règle existante demande une **approbation** (elle ne bloque pas) ; et le
scénario relit le compte pour chercher une cible hors périmètre réelle. Le garde-fou
`connector-single-path.test.ts` (qui ouvre le coffre) inclut maintenant `stripe.ts`, un
connecteur.

Reste à faire : un passage de `verify:launch` entièrement vert avec les quatre services,
sur une connexion stable. Non éprouvé : le mode réel de Stripe (refusé par conception),
une clé restreinte réelle (la clé de test fournie est une clé secrète), Stripe Connect.

### 5.13 Mémoire native — attribution par la carte mémoire du processus

Outil nouveau : `smaps-sampler.sh`, échantillonneur EXTERNE (lecture seule de
`/proc/<pid>/smaps`, toutes les 30 s), et `smaps-analyse.py`, qui classe chaque zone :
**V8** (réservations placées par V8 sous `0x400000000000`, `kAllocationRandomAddressMax`
sur x64), **malloc du thread principal** (`[heap]`), **arènes glibc** des autres threads
(zones alignées sur 64 Mio en haut de l'espace), **grandes allocations natives**, fichiers.
Ni le code ni le banc ne sont modifiés ; aucune sonde dans le processus, aucun
ramasse-miettes forcé (les §2.10 et 5.2 en forçaient un toutes les 30 s, ce qui masquait
la croissance du tas).

Défaut d'outil, consigné : au passage E, le premier échantillonneur s'est attaché au shell
lanceur (sa ligne de commande contenait `dist/index.cjs`) ; arrêté après un relevé,
corrigé (processus `node` exigé), relancé 44 s après le début. Instantanés du faux départ
conservés à part.

| Passage | Code | Durée | Sortie | Mémoire (banc) | V8 (smaps) | malloc / arènes |
|---|---|---|---|---|---|---|
| E | `b6d267e` | 30 min | **1** (seul échec : mémoire) | 225 → 281 Mo (+25 %) | **98 → 233 Mo**, par paliers (≈ 420, 1 050, 1 650 s) | plats (29 / 13–15 Mo) |
| F | `b6d267e` + vérification par lots | 30 min | **0** | 237 → 222 Mo | 99 → 161 Mo, par paliers | plats, puis **chute** à ≈ 1 080 s |

Les deux : 0 erreur (127 026 et 142 026 requêtes), 0 mise en veille, sur batterie
(93 → 78 %, 72 → 58 %), machine maintenue éveillée par l'application.

**Ce qui est établi.** Sans ramasse-miettes forcé, toute la croissance de la mémoire
anonyme est dans les réservations de **V8** ; malloc (thread principal), les arènes des
threads et les grandes allocations natives sont plats. La conclusion des §2.10 et 5.2
(« hors des tas V8 ») venait de passages où la sonde forçait un ramasse-miettes : elle
ne vaut pas pour le fonctionnement normal.

**Ce qui ne l'est pas — et une mesure biaisée.** Au passage F, vers 1 080 s, le malloc du
thread principal passe de 29 à 9,5 Mo et les fichiers de 57 à 17 Mo : ce n'est pas une
libération, c'est le noyau qui **pousse des pages en swap**. Machine relevée juste après :
7 Go de RAM, 1,4 Go disponibles, **swap à 3,9 Go sur 4,1 Go** (navigateur ≈ 2,2 Go).
Les deux passages sont donc biaisés à la baisse, de façon inégale ; la différence E/F
(233 contre 161 Mo pour V8) **n'est pas interprétable**. L'échantillonneur relève
désormais aussi la colonne `Swap` de chaque zone.

**Un défaut réel corrigé en chemin, sans être démontré cause.** `GET
/api/actions/receipts/verify` chargeait toute la chaîne du locataire en un tableau : sa
mémoire suivait la longueur de la chaîne (20 000 reçus à l'heure sous ce banc). Elle lit
maintenant par lots de 1 000 (`receiptChainBatches`, clé de parcours sur l'ordre exact de
la lecture entière) et vérifie un reçu à la fois (`ReceiptChainVerifier`). Verdict
identique : l'ancien algorithme est gardé comme référence dans
`receipt-chain-verify.test.ts`, comparé sur 2 000 chaînes altérées au hasard couvrant les
cinq verdicts (intact, contenu, position, genèse, lien) ; lots de 1, 2, 3 et 1 000 égaux à
la lecture entière, reçus sans position et position négative compris. Sous PostgreSQL, le
passage F a vérifié une chaîne de 23 671 reçus (24 lots) : intacte, 340 ms.

**Kit de conformité.** Deux mutants visaient l'ancienne lecture et ont été reportés sur
la nouvelle (`sans-trace` → C32, `verification-globale` → C33, attrapés). Et un défaut
plus ancien : depuis `075c896` (tête de chaîne en deux lectures), le motif du mutant
`listes-qui-fuient` ne trouvait plus rien et **`--mutants` s'arrêtait là**, sans que rien
ne le signale. Corrigé : la mutation porte sur `listReceipts` seul (C28, attrapé).
`conformance -- --mutants` va de nouveau au bout : 24 mutants conformes à leur cible,
`verificateur-complaisant` limite déclarée, `bloque-executable` attribué à C1 —
l'écart connu depuis `c75406a`, inchangé. Suite complète : 2 960 tests, 0 échec.

**Prochaine mesure, à faire dans de bonnes conditions** : secteur branché, navigateur
fermé (swap libéré), même banc, deux passages de 30 min — code de `b6d267e` puis code
corrigé — avec la sonde n° 3 (compteurs de chaque espace du tas de V8, SANS
ramasse-miettes forcé) et l'échantillonneur avec `Swap`. Elle dira si V8 garde des pages
hors de ses espaces, et ce que le correctif change.

### 5.14 Mémoire — la cause principale attribuée, la comparaison avant/après faite proprement

Conditions corrigées par rapport au §5.13 : secteur branché, navigateur fermé par
l'utilisateur, RAM disponible 2,8–3,1 Go au départ (contre 1,4 Go). Le swap gardait
2,7–3,0 Go d'anciennes pages, sans pression nouvelle : la colonne `Swap` de chaque zone
est désormais comptée. Deux passages de 30 min, même banc, même base jetable, l'un après
l'autre : **H** = code de `b6d267e` (lecture entière de la chaîne), bundle construit dans
une copie de travail séparée (supprimée ensuite) ; **G** = `66d5bd5` (lecture par lots).
Sonde n° 3 dans le processus du bundle : compteurs de chaque espace du tas de V8, du
thread principal et du worker d'identité, **sans ramasse-miettes forcé**. Échantillonneur
externe de la carte mémoire. 0 mise en veille. Incident : à la fin de G, le chargeur se
lit débranché — coupure de courant pendant le passage, machine restée allumée sur
batterie (91 → 100 % relevé ensuite, secteur toujours coupé).

| | H — avant | G — après |
|---|---|---|
| sortie du banc | **1** (mémoire) | **0** |
| requêtes, erreurs | 149 394, 0 | 149 292, 0 |
| mémoire (banc) | 241 → **327 Mo (+35,9 %)** | 248 → **240 Mo (−3,3 %)** |
| zones V8 vues par le noyau | 101 → **247 Mo** | 109 → **168 Mo** |
| ancienne génération (V8, physique) | 21 Mo, avec des pics à **108** et **116 Mo** | **21 Mo**, plate |
| tas de V8 compté par V8 (principal + worker) | 76–81 Mo hors pics | 72–77 Mo |
| écart noyau − V8 | 20 → **172 Mo** | 54 → **94 Mo**, en ralentissant |
| chaîne vérifiée à la fin | 24 899 reçus, intacte | 24 882 reçus, intacte |

**Lecture.**

1. **La cause principale de la croissance mesurée est la vérification de chaîne**, et
   elle est désormais attribuée par la mesure, pas supposée : dans H, chaque vérification
   complète fait monter l'ancienne génération de 21 à plus de 100 Mo (20 000+ reçus
   chargés d'un coup) ; le ramasse-miettes la ramène à 21 Mo, mais **V8 ne rend pas ces
   pages au système** — la mémoire résidente de ses zones suit le PLUS HAUT pic, pas ce
   qui est vivant. Dans G, ces pics ont disparu et le contrôle de mémoire du banc passe.
   Ce n'est pas une fuite au sens strict (les objets sont libérés) ; c'était un coût en
   O(n) dont V8 gardait la trace en mémoire résidente.
2. **V8 garde des pages hors de ses compteurs, et c'est le moteur, pas Placet** :
   reproduit sans Placet (`v8-pool-repro.cjs`, Node 22.23.2, V8 12.4, objets alloués puis
   jetés à débit soutenu, 10 min) — écart de ~20 Mo apparu en une minute puis **constant**
   (zones V8 : 65,0 Mo de 75 à 555 s). Piste `MADV_FREE` écartée : `LazyFree` = 0.
3. **Reste, dans G, une croissance lente qui ralentit** (écart +40 Mo en 30 min, dont +4 Mo
   sur les 6 dernières minutes). Compatible avec le même mécanisme (V8 garde les pages de
   ses pics les plus hauts ; l'application en a de plus variés que le script), **non
   démontrée bornée**. Seul un passage long le dira — c'est le passage de 12 heures, qui
   a maintenant un sens : la cause principale est corrigée.

**Conditions nécessaires pour le passage de 12 heures, établies par ces mesures** :
secteur stable (deux coupures relevées ce jour), navigateur fermé (sous pression mémoire,
le noyau pousse le processus en swap et la mesure ne vaut plus rien — §5.13), machine
maintenue éveillée.

### 5.15 Séance à blanc du kit de recette — deux blocages trouvés, corrigés, revérifiés

Le kit de `docs/PILOTE-RECETTE-UTILISATEUR.md` suivi à la lettre, dans le navigateur
intégré, par l'équipe (ce n'est pas une recette). Compte de test local, mot de passe généré
et jamais affiché ; jeton GitHub de test lu depuis son fichier, **connexion faite par l'API
locale** et non collée dans l'écran (l'écran de connexion n'est donc pas éprouvé ici ; il
l'avait été au §5.5). Dépôt de test `placet-essai` ; le jeton n'en atteint qu'un, la
tentative hors périmètre vise donc un identifiant d'exemple (le kit demande un jeton qui
atteint deux dépôts pour les vraies séances).

**Passage 1 — la pile locale de l'utilisateur** (lancée depuis
`~/Téléchargements/placet-74422a2`, image reconstruite le jour même ; non reconstruite par
moi : elle appartient à ce dossier). Espace « Recette 0 (a blanc) » et son lien créés par la
commande du kit (lien correct). Constats :

| Étape du kit | Résultat |
|---|---|
| 1 invitation · 2 connexion | ✅ |
| 3 GitHub (par l'API) | ✅ côté serveur ; l'écran ne relit pas une connexion faite ailleurs (cache sans échéance) — sans effet pour un testeur qui connecte par l'écran |
| 4 règle | ✅ enregistrée (« Enregistré. Les agents n'agissent que sur 1 dépôt. »), ❌ **l'écran Politiques affiche « No policies match »** |
| 5 agent · 6–7 trois décisions, approbation | ✅ ; issue #6 créée après approbation |
| 8 reçu | ❌ **Exécutions affiche 0** après le scénario ; ❌ **revenir au démarrage efface les résultats du scénario**, donc les liens « Reçu d'audit » |

**Cause.** La console a deux couches de données : le démarrage lit un cache de requêtes
qu'il invalide après chaque action ; Agents, Politiques, Exécutions et Approbations lisent
un instantané chargé **à la connexion**, que rien ne relisait. Les résultats du scénario
vivaient dans l'état de l'écran, détruit quand on le quitte. Recharger ne sauvait rien :
la session n'est gardée que dans l'onglet. Et le cache de requêtes, sans échéance et
placé au-dessus de l'authentification, n'était pas vidé à la déconnexion : une seconde
personne dans le même onglet voyait ce qu'il tenait de l'espace précédent (le serveur
refusait déjà ces données).

**Correctifs (console seulement)** : `useFreshSnapshot()` — une relecture silencieuse de
l'instantané à l'ouverture des écrans Politiques, Exécutions, Approbations, Agents et
Tableau de bord, et après chaque écriture du démarrage ; résultats du scénario gardés dans
le cache de la console, par agent ; `queryClient.clear()` à la déconnexion. Garde :
`server/test/console-freshness.test.ts` (12, lecture de la source, comme les autres gardes
de l'interface). Suite : 2 972 tests, 0 échec.

**Passage 2 — le code corrigé**, sur une instance jetable (bundle de l'arbre de travail,
port 5331, base jetable dans le conteneur de preuves, `PLACET_ACCOUNTS=database`) :

- déconnexion puis connexion **sans recharger** : l'état relu (« Vos outils (fait) ») — le
  cache vidé ;
- étape 4, test déterministe : règle modifiée (« écritures interdites »), vérifiée côté
  serveur, puis Politiques ouvert **une seule fois** → la nouvelle règle s'affiche ✅.
  Consigné : une première visite de ce passage avait encore montré une liste vide, dans un
  enchaînement où mon clic d'enregistrement a pu précéder l'écriture ; non reproduit ;
- après le scénario : pastille « Approvals, 1 pending » ✅ ; Exécutions montre les trois
  exécutions ✅ ; retour au démarrage (et changement d'étape) : résultats et trois liens
  « Reçu d'audit » présents ✅ ;
- étape 8 par le chemin du kit : Exécutions → détail de l'issue : décision, règle,
  « Approval granted · Testeur à blanc », « Issue #7 ouverte », « SUCCEEDED · 1 attempt » ✅.

Le réseau était instable : la lecture GitHub du scénario a échoué sur un délai de 15 s,
affiché « Autorisée, mais le service a refusé » — ajouté aux observations à surveiller,
avec la durée affichée (36 ms), le motif technique en anglais et l'introduction de
l'étape 5.

Défaut de procédure relevé, kit corrigé : `pilot:up` refuse un port occupé **par sa propre
pile** ; reconstruire = `pilot:down` depuis le dossier qui l'a lancée, puis `pilot:up`.

Nettoyage : issues #6 et #7 fermées (0 ouverte) ; jeton GitHub oublié par Placet dans les
deux espaces de test, sessions fermées ; instance jetable arrêtée, sa base supprimée ;
fichiers de session, de lien et de mot de passe supprimés. L'espace « Recette 0 (a
blanc) » reste dans la base de la pile locale de l'utilisateur, sans credential.

### 5.16 « Ajouter un agent existant » — l'écran, éprouvé dans un navigateur

Demande de l'utilisateur : qu'une entreprise branche ses agents existants sur Placet de la
manière la plus simple possible, et que Placet soit incontournable une fois l'agent soumis.
Livré : l'écran `#/agents/connect` (bouton « Ajouter un agent existant » sur l'écran Agents),
cinq étapes — où vit l'agent (Cursor ; Claude Desktop et « autre outil MCP » marqués **non
vérifiés** ; agent développé en interne) ; ce qu'il fait (outils connectés, règle en vigueur
en clair) ; le brancher (clé liée à cet agent, fichier de configuration à télécharger ou
exemples Python / HTTP déjà remplis) ; **fermer les autres portes** ; vérifier en direct.

Fermer les autres portes : `POST /api/connectors/:id/check-credential` demande AU SERVICE si
l'ancienne clé de l'agent fonctionne encore (`Connector.credentialAlive`, dans les quatre
connecteurs), **sans filtre de forme** — un jeton Slack utilisateur, refusé à la connexion,
est dit vivant s'il ouvre encore la porte. Une panne vaut « inconnu », jamais « morte ». La
clé n'est ni scellée, ni journalisée, ni rendue ; la comparaison avec la clé du coffre passe
par l'empreinte, sans déchiffrement. L'écran n'affirme « incontournable » que si chaque outil
est sans clé déclarée ou vérifié mort (`client/src/lib/agent-doors.ts`).

Premier jet refusé par la suite, à raison : la route ouvrait le coffre (`vault.open`) pour
comparer. Les gardes `connector-vault` et `connector-single-path` l'ont interdit ; réécrite
par l'empreinte, et le garde « routes qui manipulent un secret » passe à quatre avec des
exigences propres à la nouvelle (ne scelle pas, ne déchiffre pas, interroge le service).

Tests : `connector-check-credential.test.ts` (12), `agent-doors.test.ts` (4),
`agent-connect-screen.test.ts` (6) ; suite 2 994 tests, 0 échec.

**Dans un navigateur**, instance jetable (bundle de l'arbre de travail, base jetable, compte
de test local, GitHub connecté par l'API avec le jeton de test, périmètre `placet-essai`) :
le responsable d'une « Entreprise test » choisit « Agent développé en interne », nomme
l'agent, coche GitHub (règle affichée : « 1 ressource autorisée, écritures sur
approbation »), crée l'agent — exemples Python et HTTP remplis avec l'adresse, la clé et le
vrai dépôt. Étape 4 : une clé GitHub fabriquée, jamais valide, présentée comme « ancienne
clé » : réseau instable, d'abord « Impossible de conclure — délai dépassé » (verdict resté
« déclaré », champ vidé), puis **« Morte — GitHub refuse cette clé »** et **« Placet est
incontournable sur ces outils »**. Étape 5 : trois appels de l'« agent » avec sa clé —
lecture **ALLOW** (exécutée chez GitHub), issue dans le dépôt **APPROVAL_REQUIRED** (rien
parti), issue dans un autre dépôt **BLOCK** (rien parti) — affichés d'eux-mêmes en quelques
secondes, avec leur reçu. Trois défauts relevés pendant la séance et corrigés : case
annoncée « on » par un lecteur d'écran, nom proposé « Agent Agent développé en interne »,
phrase de l'étape 5 ; vérifiés après reconstruction.

Non éprouvé : Cursor et Claude Desktop par cet écran (fichiers générés, non installés dans
l'outil réel) ; l'état « portes fermées » n'est pas conservé après avoir quitté l'écran.
Nettoyage : instance arrêtée, base supprimée, clé, mot de passe et session de test effacés,
conteneur de preuves remis à l'arrêt ; l'issue « Proposée par l'assistant support » n'a pas
été créée (retenue, jamais approuvée).

### 5.17 Le vrai Cursor, branché par l'écran « Ajouter un agent existant », contre le vrai GitHub

`cursor-agent` **2026.10.22-27dcf5f**, connecté au compte Cursor de l'utilisateur ; instance
jetable (`e0d8a22`, base jetable, écoute 127.0.0.1) ; **vrai GitHub**, dépôt de test
`placet-essai`, écritures sur approbation. Rien de simulé.

Précaution prise avec l'utilisateur : son `~/.cursor/mcp.json` déclare un serveur global
« placet-local » (vers sa propre instance), que Cursor chargeait aussi dans le projet de
test — l'agent aurait pu agir sur son instance. Sur sa décision, **il l'a lui-même mis de
côté** le temps de l'essai (empreinte relevée avant : `0404a9852c2c9c45`, identique après le
renommage) ; Cursor ne voyait plus que « placet ». Aucun réglage global de Cursor modifié par
l'équipe ; « placet » approuvé pour le seul projet temporaire (`mcp enable`).

| Étape | Mesuré |
|---|---|
| Écran, étapes 1–3 | Cursor choisi ; agent « Agent Cursor », GitHub coché ; `mcp.json` produit par l'écran, posé **tel quel** dans `.cursor/mcp.json` du projet temporaire |
| Découverte | `mcp list-tools placet` : **5 outils**, ceux de GitHub seulement (le seul outil coché), avec leurs arguments |
| 1er appel, sans permission Cursor | **refusé par Cursor lui-même** (« User rejected MCP ») ; Placet : **0** exécution — rien n'est parti. L'agent a attribué ce refus à Placet : faux |
| Permissions du projet : `Mcp(placet:*)` permis, `Shell(*)` et `Write(**)` interdits (plutôt que `--force`) | — |
| Lecture des issues | **ALLOW**, exécutée chez GitHub (7 issues, toutes fermées) ; l'écran l'affiche en direct. Cursor a résumé « 0 issue » : faux — le reçu fait foi |
| Création d'issue dans `placet-essai` | **APPROVAL_REQUIRED**, « the tool was NOT called », relayé tel quel par Cursor, qui n'a pas réessayé |
| Création d'issue dans un autre dépôt | **BLOCK**, « the tool was NOT called » |
| Approbation dans la console (écran Approbations, contenu exact affiché) | Placet exécute : **issue #8 créée**, relue chez GitHub avec la marque `placet-execution`, puis fermée |

Défauts relevés et corrigés : la pastille « Approvals » restait à 0 pendant le direct (la
liste relit désormais l'instantané à chaque nouvelle action) ; les instructions Cursor ne
disaient pas qu'il faut **autoriser l'outil au premier appel** (ajouté, de même pour
Claude Desktop) ; phrase d'exemple « fais Lire les issues ».

Conclusion : un agent Cursor branché par l'écran, avec le fichier qu'il produit, ne peut
agir sur GitHub que par Placet — les trois décisions sont rendues, retenues ou bloquées
avant tout appel, et la seule écriture faite l'a été après une approbation humaine. Non
éprouvé : l'éditeur Cursor graphique (l'essai utilise `cursor-agent`, même moteur) ; Claude
Desktop.

Nettoyage : issue #8 fermée ; instance arrêtée, base supprimée ; projet temporaire, clé et
permissions supprimés ; conteneur de preuves arrêté. Le dossier que Cursor crée pour chaque
projet sous `~/.cursor/projects/` est laissé (état de Cursor, sans secret de Placet). Le
`~/.cursor/mcp.json` de l'utilisateur est à remettre en place par lui.

### 5.18 Les portes de chaque agent, gardées par le serveur

Demande : conserver l'état « portes fermées » au-delà de l'écran. Livré : migration **25**
(`agent_doors`, une ligne par agent et par outil — ce que la personne a DÉCLARÉ, ce que le
SERVICE a répondu, qui, quand ; jamais la clé), le verdict partagé par le serveur et la
console (`shared/agent-doors.ts`), trois routes — `GET /api/agents/:id/doors` (verdict
calculé côté serveur), `PUT …/doors/:connector` (déclaration seule : ne peut pas poser un
résultat de vérification), et `check-credential` avec `agentId`, **seule** à écrire ce que
le service a répondu. Les outils d'un agent sont lus sur l'agent enregistré (ses
permissions), jamais sur la requête. Un panneau réutilisé à l'étape 4 de « Ajouter un agent
existant » et sur la fiche de chaque agent (« Accès directs aux outils », avec pastille).

Gardes : `migration-inspection-coverage` (épingle passée à 25, table inspectée déclarée au
runner PostgreSQL) ; `schema-parity` (table déclarée dans `shared/schema.ts`, comme le
coffre). Tests : 7 de plus dans `connector-check-credential.test.ts` — vérification inscrite
sur l'agent, déclaration qui tente de poser « dead » refusée (400), clé du coffre jamais
inscrite comme vérification, outil que l'agent n'utilise pas (422), agent inconnu (404),
autre organisation (404), lecteur (403 en écriture) ; garde de l'écran mise à jour. Suite :
3 006 tests, 0 échec.

**Dans un navigateur, sur PostgreSQL** (instance jetable, migration 25 appliquée : « the
database is at version 25 ») : agent créé par l'écran ; étape 4 : « Oui — je la révoque »
→ « Déclaré par Responsable portes le 25 oct. 2026, 15:26 » ; clé GitHub fabriquée
présentée → **« Morte — GitHub refuse cette clé »**, « Placet est incontournable », ligne
« vérifié par … ». Puis **sortie de l'écran** → fiche de l'agent : section « Accès directs
aux outils », pastille **« Incontournable »**, même ligne datée ; **rechargement complet et
nouvelle connexion** → identique. En base : une ligne `github | revoked | dead |
Responsable portes | 2026-10-25 15:26:51` ; aucune trace d'un jeton (`github_pat` : 0).

Non fait : réévaluation périodique (une clé révoquée puis recréée chez le fournisseur n'est
pas détectée — c'est la réconciliation, chantier 1 de la feuille de route) ; pastille sur la
liste des agents. Nettoyage : instance arrêtée, base supprimée, fichiers de test effacés,
conteneur de preuves remis à l'arrêt.

### 5.19 La réconciliation — ce qui s'est passé chez le service SANS Placet

Livré : `POST /api/connectors/:id/reconcile` et un panneau « Ce qui s'est passé sans
Placet » sur l'écran Connecteurs (GitHub, Stripe). Le connecteur relit ce que le service a
enregistré **depuis la connexion de l'outil à Placet** (avant, tout était hors Placet par
construction) — GitHub : issues, pull requests et commentaires des dépôts choisis ; Stripe :
remboursements — avec la marque que Placet pose sur chacune de ses écritures
(`<!-- placet-execution: … -->`, `metadata[placet_execution]`). La route classe : marque +
exécution connue dans l'organisation → « via Placet » ; marque d'une exécution inconnue →
alerte ; sans marque sous l'identité de Placet → **alerte « hors Placet »** ; autre compte →
compté, jamais jugé (un collègue). Rien n'est bloqué : la réconciliation rend visible. Ses
limites sont rendues avec le résultat (Stripe ne dit pas QUI a remboursé ; 100 derniers
éléments ; dépôts choisis seulement), et un résultat tronqué est dit « partiel », jamais
« rien ne s'est passé ».

Tests : `connector-reconcile.test.ts` (5) — une issue créée par Placet, une du même compte
sans marque, une d'une collègue, une marque recopiée, une antérieure à la connexion ; un
remboursement marqué et un non marqué ; refus (outil non connecté, lecteur, autre
organisation). Suite : 3 013 tests, 0 échec.

Défaut relevé en chemin, sur la route de vérification des anciennes clés (§5.16, §5.18) :
l'agent et l'outil étaient validés APRÈS la question au service — une demande vouée au refus
présentait quand même la clé à un tiers (et un test appelait ainsi le vrai Linear, ce que le
réseau instable a révélé par un délai dépassé). Validés désormais AVANT tout appel ; un test
le fixe (refus sans aucun appel au service).

**Contre les vrais services** (instance jetable sur PostgreSQL, GitHub `placet-essai`,
Stripe en mode test) : par Placet, une issue (#9) et un remboursement de 1,00 € (retenu par
la règle « pas de plafond, pas d'argent sans approbation » même en écritures libres,
approuvé) ; puis, **en contournant Placet** avec les mêmes clés, une issue (#10) et un
remboursement de 1,00 €.

Premier passage : GitHub « 0 écriture lue » — faux. Cause : sous PostgreSQL, le coffre
rendait `connectedAt` en objet `Date` (colonne `TIMESTAMPTZ`) là où son type et SQLite
promettent du texte ; la borne `since` partait vers GitHub en « Sun Oct 25 2026… », que
GitHub ignorait. Défaut présent depuis la création du coffre, masqué par la sérialisation
JSON des routes et invisible aux tests (SQLite). Corrigé dans le coffre (`isoInstant`), avec
un test qui reproduit une base répondant en `Date`. Stripe, au même passage : délai réseau.

Second passage, sur le code corrigé, depuis la console :

| | Lues depuis la connexion | Via Placet | Signalées hors Placet |
|---|---|---|---|
| GitHub | 2 | 1 (#9) | **#10**, par `<compte-de-test>`, avec son lien |
| Stripe | 2 | 1 | **`re_3US9leJzLw74jVWQ03S9Ehie`**, 1 EUR |

Les remboursements antérieurs à la connexion sont hors fenêtre, comme voulu. Nettoyage :
#9 et #10 fermées ; les deux remboursements de 1,00 € restent dans le compte de test (aucun
argent réel) ; instance arrêtée, base supprimée, fichiers effacés, conteneur arrêté.

Non fait : réconciliation périodique et alerte (Slack, webhook) ; Slack et Linear ;
paiements, virements et clients Stripe.

### 5.20 La réconciliation devient automatique, et alerte une seule fois

Livré : une tâche périodique (`server/connectors/reconcile-scheduler.ts`,
`PLACET_RECONCILE_INTERVAL_MS`, une heure par défaut, `0` la coupe, jamais moins d'une
minute) qui joue, pour chaque organisation active et chaque outil connecté qui sait se
réconcilier, **le même passage que le bouton** (`server/connectors/reconcile.ts`). Premier
passage après un intervalle (le démarrage n'attend aucun service) ; pas d'empilement ;
l'échec d'une organisation n'arrête pas les autres ; rien pendant l'arrêt du serveur.

Migration **26** : `reconcile_runs` (dernier passage par outil) et `reconcile_findings`
(chaque écriture vue hors de Placet, une fois). L'alerte n'est émise que pour les
écritures **nouvelles** : `INSERT … ON CONFLICT DO NOTHING RETURNING` — deux passages
simultanés (deux instances, ou le bouton pendant la tâche) n'alertent qu'une fois.
Nouvel événement `reconciliation.alert`, porté par le webhook de l'exploitant et par son
canal Slack (message sans bouton, avec les liens) ; il nomme l'organisation. La console
montre sans clic le dernier passage (« automatique » ou « lancée depuis la console ») et
toutes les écritures vues, avec leur date de première vue.

Tests : `reconcile-scheduler.test.ts` (6), et dans `connector-reconcile.test.ts` l'alerte
unique (aucune ré-alerte, une alerte pour une nouvelle écriture), la relecture par la
console, l'isolation entre organisations, le format Slack sans bouton. Suite : 3 032
tests, 0 échec.

**Contre les vrais services**, instance jetable sur PostgreSQL (migration 26 : « the
database is at version 26 »), tâche réglée à une minute, et un récepteur local jouant le
webhook de l'exploitant :

| Heure (UTC) | Ce qui s'est passé |
|---|---|
| 17:30:06 | GitHub et Stripe connectés |
| 17:30:55 | 1er passage automatique, GitHub : propre, 0 écriture, aucune alerte |
| 17:31:19 | **issue #11 créée directement avec la clé GitHub, sans Placet** |
| — | un passage : « non vérifié (unreachable) » — réseau ; dit, aucune fausse alerte |
| 17:32:59 | **alerte reçue par le webhook** : « 1 écriture(s) faite(s) hors de Placet sur GitHub (Entreprise surveillee) », #11, son auteur, son lien |
| 17:34 → 17:35 | deux passages de plus : écriture toujours signalée, **aucune ré-alerte** (1 alerte au total) ; Stripe vérifié automatiquement, propre |

Console, sans clic : « Dernière vérification automatique, le 25 oct. 2026, 17:34 », le
verdict, et #11 avec « faite le … · vue le … ». Nettoyage : #11 fermée ; instance,
récepteur et base supprimés ; conteneur de preuves arrêté.

Limite dite dans le code : avec plusieurs instances, chacune interroge les services (les
alertes restent uniques). Non fait : Slack et Linear ; paiements, virements et clients
Stripe.

### 5.21 La réconciliation couvre les quatre outils : Slack et Linear

Slack : les messages des canaux choisis depuis la connexion (`conversations.history`,
`include_all_metadata`) ; Placet marque chacun des siens par des métadonnées
`placet_execution` ; un message du BOT sans cette marque est « hors Placet », un message
d'une personne est compté sans être jugé, un message système (arrivée dans le canal) est
ignoré. Linear : tâches et commentaires des équipes choisies depuis la connexion (filtre
`createdAt`) ; Placet termine chacun des siens par « exécution exe_… » ; une écriture du
même compte sans marque est « hors Placet ». Limite dite avec le résultat, pour Linear et
désormais aussi pour GitHub : avec une clé ou un jeton PERSONNEL, Placet agit sous le compte
d'une personne, et ce qu'elle écrit elle-même apparaît « hors Placet » — un compte dédié ou
une connexion OAuth évite la confusion.

Défaut trouvé par le test simulé, avant le vrai service : la marque Linear est écrite en
italique Markdown (`_… exécution exe_abc_`) ; l'expression admettait `_`, capturait le `_`
qui ferme l'italique, et la tâche de Placet passait pour une « marque inconnue ». Les
identifiants d'exécution sont `exe_` + base 36 (`decision-service.ts`) : l'expression est
resserrée.

Tests : `connector-reconcile-slack-linear.test.ts` (3). Suite : 3 035 tests, 0 échec.

**Contre les vrais services** (instance jetable sur PostgreSQL ; Slack `#placet-essai`,
Linear équipe `PLA`) : par Placet, un message (premier envoi : délai réseau, « rien n'a
été envoyé », renvoyé) et la tâche PLA-9 ; en contournant Placet avec les mêmes clés, un
message posté directement par le bot et la tâche PLA-10.

| | Identité | Lues | Via Placet | Hors Placet |
|---|---|---|---|---|
| Slack | bot `placet_essai` | 2 | 1 (métadonnées relues) | le message direct |
| Linear | le compte de la clé (« Placet essai ») | 2 | 1 (PLA-9 — la marque en italique, reconnue) | **PLA-10** |

Nettoyage : les deux messages supprimés, PLA-9 et PLA-10 archivées ; instance, base et
fichiers supprimés, conteneur arrêté. Les quatre connecteurs savent désormais se
réconcilier, à la demande et automatiquement (§5.20).

### 5.22 Stripe : ce qui fait sortir ou perdre de l'argent sans Placet

Livré dans `StripeConnector.reconcile` : en plus des remboursements, trois lectures sur la
fenêtre (depuis la connexion), toutes en lecture seule.

| Ce qui est lu | Hors Placet (alerte) | Compté, non jugé |
|---|---|---|
| Remboursements (`/v1/refunds`) | sans `metadata[placet_execution]` | — |
| Virements (`/v1/payouts`) | **manuel** : Placet n'a aucun verbe de virement | automatique (calendrier du compte) |
| Journal (`/v1/events`) : paiement annulé, client supprimé, litige clos | déclenché par une **requête** (clé ou tableau de bord) | produit par Stripe seul (`request.id` absent) ; un litige gagné est ignoré |

Ce qui n'est pas jugé, et c'est dit avec le résultat : les nouveaux paiements et nouveaux
clients — un débit fait par un agent avec une clé directe ressemble exactement à celui du
site ; la protection est de retirer la clé (« Accès directs aux outils »). Stripe ne garde
son journal que 30 jours : au-delà, c'est dit. Une clé restreinte qui ne lit pas l'une des
listes ne fait pas échouer le passage : la liste manquante est nommée et le résultat est
**partiel**. L'alerte d'un client supprimé ne porte que son identifiant, ni nom ni adresse.

Tests : `connector-reconcile-stripe-money.test.ts` (3) — virement manuel / automatique,
annulation par requête / par expiration, client supprimé, litige accepté / gagné, marque
inconnue sur un virement, aucune donnée personnelle dans le rapport, journal refusé →
partiel. Suite : 3 038 tests, 0 échec.

**Contre le vrai Stripe** (compte de test, lecture seule, fenêtre de 29 jours) : les trois
lectures acceptées telles quelles (`types[]` et `created[gte]` compris). Lu : 11
remboursements (2 marqués Placet), 0 virement, 0 annulation, 0 litige, et **6 clients
supprimés par requête, les 18 et 19 octobre** — ce sont les nettoyages du banc
`script/verify-stripe.ts`, qui supprime son client de test directement avec la clé. Ils
sont classés hors Placet, et c'est juste : le banc agit sans Placet. Le banc le dit
désormais en commentaire. Rien n'a été créé chez Stripe pour cette vérification.

**Une annulation réelle, provoquée** (demandée en séance,
compte de test) : un paiement de 1 EUR créé puis annulé directement avec la clé, SANS
Placet (`pi_3UUWOWJzLw74jVWQ1srXGvR4`, motif `requested_by_customer`, 18:43:51 UTC). Relu
par le connecteur aussitôt : « Paiement annulé : 1 EUR (motif : requested_by_customer) »,
**hors Placet**, résultat complet (non partiel). Il n'avait jamais été confirmé : aucun
débit, même fictif.

**L'alerte de bout en bout, avec un second paiement** (demandé en séance). Instance
jetable construite depuis `1a3e537` sur PostgreSQL (« the database is at version 26 »),
tâche réglée à une minute, récepteur local jouant le webhook de l'exploitant :

| Heure (UTC) | Ce qui s'est passé |
|---|---|
| 18:46:54 | Stripe connecté (la fenêtre commence ici) |
| 18:47:44 | 1er passage automatique : propre, 0 écriture, aucune alerte |
| 18:47:57 | **paiement de 1 EUR créé puis annulé directement avec la clé, sans Placet** (`pi_3UUWSVJzLw74jVWQ1QxSRhNf`) |
| 18:48:48 | **alerte reçue par le webhook** : « Placet — 1 écriture(s) faite(s) hors de Placet sur Stripe (Entreprise surveillee Stripe) », « Paiement annulé : 1 EUR (motif : requested_by_customer) (hors Placet) », avec le lien du tableau de bord |
| → 18:50:44 | deux passages de plus : toujours signalé, **aucune ré-alerte** (1 alerte au total) |

Les six suppressions de clients du banc (18 et 19 octobre) sont hors fenêtre, comme voulu.
Nettoyage : instance, récepteur et base supprimés ; conteneur de preuves arrêté. Les deux
paiements annulés restent dans le compte de test (Stripe ne supprime pas un paiement) ;
aucun n'a été confirmé.

Non fait : un virement manuel et un litige réels ne sont pas provoqués ; leur forme vient
de la documentation de Stripe et des tests simulés.


### 5.23 Sur l'instance locale de l'utilisateur : Stripe connecté, réconciliation horaire

Instance mise à jour depuis l'archive `placet-252a08f` (aucune nouvelle migration : base
en version 26, trois organisations conservées). Stripe connecté par l'utilisateur dans
l'organisation « Pilote » à 21:11:13 UTC, avec la clé de test, par un script local qui
demande l'adresse et le mot de passe sans écho (deux connexions refusées avant, puis 200 ;
la session ouverte par le script est fermée aussitôt). Ni le mot de passe ni la clé n'ont
été vus ni affichés.

| Heure (UTC) | Ce qui s'est passé |
|---|---|
| 20:50 | redémarrage de la machine (coupure de courant) : la tâche horaire repart de là |
| 21:50:41 | 1er passage automatique, GitHub et Stripe : **« non vérifié (unreachable) »** — `getaddrinfo EAI_AGAIN`, le réseau était coupé. Ni alerte, ni « propre » |
| 22:23 | nouveau redémarrage de la machine : le passage de 22:50 n'a pas lieu |
| 22:40 | lecture directe, hors instance, du compte Stripe sur la même fenêtre (depuis 21:11:13) : 0 écriture, résultat complet |
| 23:24:04 | passage automatique, GitHub (`<compte-de-test>`, depuis le 24 oct. 11:37) : **propre**, 0 écriture |
| 23:24:08 | passage automatique, Stripe (« environnement de test placet ») : **propre**, 0 écriture |

Les deux paiements annulés et les six suppressions de clients du banc (§5.22) sont
antérieurs à la connexion : hors fenêtre, aucune alerte, comme voulu.

Ce que cela montre : sur une machine dont le courant et le réseau coupent, un passage
manqué est dit « non vérifié » et le suivant reprend seul ; une coupure de courant
retarde la tâche horaire d'autant (le minuteur repart au démarrage). Non fait sur cette
instance : aucune alerte n'y a été provoquée — le chemin d'alerte est éprouvé au §5.22.

### 5.24 Endurance de 12 heures : interrompue à 9 h 06 par le banc, pas par Placet

Lancée le 26 octobre à 00:44:39 UTC sur `0506347` (bundle reconstruit, sha256
`bf0567bb7fd39b5a`). Conditions au départ : secteur branché, Chrome fermé, 4 345 Mo de RAM
disponibles, 462 Mo de swap déjà utilisés. Base : conteneur jetable `placet-proof-pg`.
Veille bloquée par `systemd-inhibit --what=sleep:idle:handle-lid-switch`.

**Résultat : non concluant. Le test n'a pas duré 12 h.**

| Heure (UTC) | Ce qui s'est passé |
|---|---|
| 00:44 → 05:30 | trafic continu ; serveur à 135 Mo au démarrage, 285 Mo à 1 h, puis **plat entre 288,6 et 289,1 Mo** ; 36 descripteurs, stables |
| 05:30:59 → 07:24:16 | **mise en veille** (`PM: suspend entry (s2idle)`) malgré le verrou `systemd-inhibit` |
| 07:34 | batterie « en décharge » (upower) : plus de secteur |
| 07:39:54 → 07:48:39 | **deuxième mise en veille** |
| 08:22 | secteur revenu (« en charge ») |
| 09:50:34 | **le banc meurt** : `RangeError: Invalid string length` dans `script/verify-soak.ts` |

**Cause de l'arrêt : un défaut du banc.** Il cumulait tout le journal du serveur dans une
seule chaîne. Au bout de 9 h 06, avec 295 237 reçus, la chaîne a dépassé la taille
maximale d'une chaîne V8. Le serveur Placet, lui, était stable : 289 Mo depuis 7 h 30.

**Corrigé** : le journal gardé en mémoire est maintenant plafonné (8 Mo, ramené à 4 Mo).
Le contexte des trois premiers échecs est capturé au moment où ils se produisent, et le
journal complet reste disponible sur disque avec `SOAK_SERVER_LOG`. Vérifié par un
passage court (3 min) : 17/17 contrôles passés, 2 878 reçus.

**Les mises en veille.** Le verrou `systemd-inhibit` n'a pas empêché les deux veilles.
Elles ressemblent à la mise en veille automatique de GNOME, qui ne connaît que les verrous
de sa propre session (`gnome-session-inhibit`). La perte du secteur pendant la nuit
(07:34 en décharge, retour à 08:22) n'est datée qu'à la minute près, et ce qui a déclenché
la première veille à 05:30 n'est pas établi. Le prochain passage prendra aussi un
verrou `gnome-session-inhibit --inhibit suspend:idle`, sans toucher aux réglages du système.

**Ce que ces 9 h montrent quand même :**
- **Mémoire** : pas de dérive après la montée en régime de la première heure (288,6 →
  289,1 Mo entre 1 h 30 et 9 h).
- **Descripteurs et connexions** : stables.
- **Vérification de toute la chaîne** : 15 ms au départ, environ 3,7 s à 295 000 reçus.
  Elle croît avec le nombre de reçus, ce qui est attendu puisqu'elle relit toute la
  chaîne. Les pics à 5,6 et 6,4 s sont proches des sorties de veille.

**Ce qu'ils ne montrent pas :** 12 h continues. Environ 2 h ont été perdues en veille, et
la fin du passage n'a pas eu de verdict. **Le test de 12 h est à refaire**, sur secteur
stable.

Fichiers bruts : `~/.cache/placet-suite/0506347/soak12h/` (`soak.meta`, `soak.txt`,
`samples.csv`), intacts.

### 5.25 Endurance de 12 heures complète : le serveur tient, un vrai défaut trouvé

Relancée le 26 octobre à 13:05:44 UTC sur `a26562e` (même bundle, sha256 `bf0567bb7fd39b5a`),
avec deux verrous de veille, `systemd-inhibit` et `gnome-session-inhibit` (confirmé par
GNOME : « placet-soak … (suspend, idle) »). Secteur branché, Chrome fermé, 4 170 Mo de RAM
disponibles, swap à 0 au départ.

**720 minutes complètes, 0 veille**, fin à 01:05:50. 403 273 cycles, 1 438 relevés.
Résultat : **14/17**.

| Contrôle | Résultat |
|---|---|
| processus vivant 12 h | ✓ |
| mémoire résidente (régime établi) | ✓ 241 → 204 Mo ; 202 Mo à la fin |
| descripteurs / connexions PostgreSQL / sas / limiteur | ✓ 36 → 36 ; max 9 ; 0 ; 1 |
| p95 du relais sans dérive, p99 < 1 s | ✓ 116 → 102 ms ; p99 157 ms |
| aucun secret dans la sortie | ✓ |
| **aucune erreur sur le passage** | **✗ 303 273 relais en 500, 3 lectures en 401** |
| **vérification de chaîne praticable (< 5 s)** | **✗ 5 392 ms pour 403 148 reçus** |
| **la chaîne vérifie à la fin** | **✗ illisible (401)** |

**1. Un vrai défaut de Placet, révélé par le banc.** Le quota mensuel d'exécutions livré
(100 000) a été atteint au cycle 100 000, à 2 h 42. À partir de là, chaque appel relayé
répondait **« 500 : la décision n'a pas pu être enregistrée »** (`gateway_failed`), alors
que le reste de l'API répond « 429 `quota_exceeded` » avec la limite et la date de remise
à zéro. Rien n'est parti au fournisseur (`forwarded: false`) : le refus était sûr, mais
mal nommé. Un client y aurait lu « Placet est tombé » et aurait réessayé en boucle.
**Corrigé** dans `server/routes-intercept.ts` : 429 `quota_exceeded`, `Retry-After`,
compteur, limite, `forwarded: false`, référence de relais, sans en-tête de décision. Le test
`intercept-gateway-failure.test.ts`, qui se servait du quota pour provoquer une panne
générique et exigeait que le mot « quota » n'apparaisse pas, est réécrit en deux blocs :
le quota (429) et une vraie panne de la passerelle injectée par un espion (500, sans
fuite de détail interne). 8/8. Métrique : deux nouveaux motifs, `quota_exceeded` et
`gateway_failed`.

Question restée ouverte : la voie directe (`/api/actions/authorize` puis `execute`) a
continué de réussir pendant 12 h, sans compter dans ce quota. Le quota « exécutions » ne
couvre donc qu'une voie sur deux. À trancher, pas encore fait.

**2. Deux défauts du banc.**
- **Le quota n'était pas relevé**, contrairement aux limites de débit. Ses neuf dernières heures
  mesuraient un refus, pas le relais. Le banc pose désormais
  `PLACET_QUOTAS=default:executions=100000000`.
- **La session de la console expire à 12 h** (`DEFAULT_TTL_MS`). La fin du passage a donc vu
  trois 401, et la vérification finale est restée illisible. Le banc se reconnecte et
  compte les renouvellements comme normaux. Éprouvé avec une session d'une minute sur
  3 min : 2 renouvellements, 17/17.

**3. Une limite réelle, gardée telle quelle.** La vérification complète de la chaîne
relit tous les reçus (O(n)) : 5,4 s à 403 000 reçus, environ 13 µs par reçu, soit environ 13 s
pour un million. Le seuil de 5 s n'est pas déplacé. Une vérification incrémentale
(points de contrôle) est à concevoir ; en attendant, la vérification complète se planifie
(`audit:chains`).

**Ce que cette passe montre :** 12 h sous trafic continu sans fuite (mémoire stable autour
de 202 à 206 Mo pendant les 8 dernières heures, aucun descripteur ni connexion qui
s'accumule) et sans mise en veille. **Ce qu'elle ne montre pas :** 12 h de RELAIS réussis.
Après 2 h 42, le relais refusait. Une passe de 12 h avec le banc corrigé reste à faire
pour un 17/17.

Fichiers bruts : `~/.cache/placet-suite/a26562e/soak12h/`, intacts. La machine a
redémarré à 01:08, deux minutes après la fin du passage.

### 5.26 Le quota d'exécutions couvre aussi la voie directe

Décision de l'utilisateur, après §5.25 : « compte aussi la voie directe dans le quota ».

**Avant :** le compteur « exécutions » ne lisait que la table `executions`, celle du relais
et de la passerelle. La voie directe (`/api/actions/authorize` puis `execute`) écrit un
reçu dans `action_receipts`, jamais une ligne `executions`. Elle n'avait donc aucune limite.

**Maintenant :**
- **Comptage :** `currentUsage` (SQLite) et `currentUsagePg` (PostgreSQL) additionnent les
  deux tables sur le mois en cours. Les deux voies n'écrivent jamais pour la même action :
  la somme ne compte rien deux fois. `GET /api/usage` montre ce total, et le relais bute
  sur le même plafond.
- **Refus sur la voie directe :** `EnforcementPoint.execute` vérifie le plafond **avant** de
  consommer l'autorisation (`ActionAuthorityStore.executionsSince`). Au-delà, il répond
  429 `quota_exceeded`, avec `Retry-After`, la limite et la remise à zéro. Rien ne part en
  aval, et l'autorisation reste `issued` : le plafond relevé, la même autorisation
  s'exécute. En mode `observe`, l'exécution passe et un avertissement est journalisé.

**Limites, dites dans le code :**
- Le comptage et la consommation ne sont pas dans une même transaction : sous
  concurrence, le plafond peut être dépassé d'au plus le nombre d'exécutions
  simultanées. C'est un quota commercial, pas une garantie de sécurité.
- Si le plan d'autorisation et les dépôts vivent sur deux bases différentes (SQLite d'un
  côté, PostgreSQL de l'autre), chaque voie ne voit que la part de sa base.
- Un refus sur la voie directe n'est pas inscrit dans `usage_counters.refusals`, qui est
  indicatif.

**Vérifié :**
- `quota-direct-path.test.ts` (3/3) : comptage dans l'usage, appel reçu en aval puis plus
  rien après le refus, 429 avec limite et remise à zéro, autorisation intacte et exécutée
  une fois le plafond relevé, mode `observe`.
- Suites PostgreSQL sur une base jetable : 75/76. Le seul échec est un dépassement de délai
  (5 s) quand les suites tournent en parallèle ; le fichier seul passe 10/10.
- Passage court du banc d'endurance sur PostgreSQL : 17/17.
- Suite complète : 3 044 tests.

**À surveiller :** chaque exécution, sur chacune des deux voies, compte maintenant deux
tables sur le mois en cours (index `(organization_id, executed_at)` et
`(organization_id, "timestamp")`). Le passage court a fait 7,0 cycles par seconde, contre
9,9 pour le précédent : l'écart peut venir de la machine, ou du comptage. La prochaine
passe de 12 h le mesurera à 400 000 lignes.

### 5.27 Charge simultanée jusqu'à 1 024 agents : l'intégrité tient, le quota débordait

Machine : 2 cœurs, sur secteur, Chrome fermé. Base PostgreSQL jetable (`placet-proof-pg`),
bundle de production. `verify:load`, paliers de 15 s.

**Voie de décision** (`authorize` seul) :

| Clients | req/s | p50 | p95 | p99 | sonde `/api/live` p95 |
|---|---|---|---|---|---|
| 1 | 92–96 | 10 ms | 16 ms | 21–24 ms | 8 ms |
| 64 | 190 | 332 ms | 394 ms | 436 ms | 39 ms |
| 256 | 157–184 | 1,4–1,5 s | 1,6–2,1 s | 1,8–2,5 s | 44–50 ms |
| 512 | 178 | 3,0 s | 3,3 s | 3,9 s | 47 ms |
| 1 024 | 180 | 5,6 s | 7,3 s | 10,4 s | 50 ms |

**Cycle complet** (`authorize` puis `execute`, un reçu par cycle) :

| Clients | cycles/s | p50 | p95 | p99 |
|---|---|---|---|---|
| 1 | 33–34 | 28 ms | 39 ms | 47 ms |
| 16 | 58 | 266 ms | 328 ms | 360 ms |
| 256 | 60 | 4,2 s | 4,8 s | 5,1 s |
| 512 | 53–57 | 8,3–8,8 s | 10,8–12,5 s | 11,2–12,9 s |
| 1 024 | 57–58 | 15,1–15,8 s | 19,5 s | 19,8–20,4 s |

**Ce qui tient :**
- 0 erreur sur tous ces passages.
- Le processus reste vivant, et revient à sa latence de repos après chaque pic.
- La boucle d'événements n'est pas bloquée : p99 de 24 à 36 ms.
- Saturation de la voie d'écriture vers 55 à 60 cycles par seconde, comme en §2.5 : c'est
  la sérialisation voulue de la chaîne par locataire.

**Nouveau : l'intégrité vérifiée après la pression**, dans le banc lui-même (base et
fournisseur simulé, pas les réponses de Placet). À 1 024 clients, 4 305 exécutions :
- un reçu par exécution acceptée ;
- aucune autorisation consommée deux fois ;
- un seul appel chez le fournisseur par exécution ;
- la chaîne se vérifie de bout en bout.

**Défaut trouvé : le quota débordait sous concurrence.** Avec `LOAD_QUOTA=600`, 1 024
clients ont obtenu **1 279 exécutions pour un plafond de 600**. Le comptage de §5.26 lisait
les reçus avant de consommer, hors transaction ; or le reçu n'est écrit qu'après l'appel au
fournisseur, donc toutes les exécutions en vol étaient invisibles. L'annonce « dépassement
borné par la concurrence » était vraie, mais elle ne valait rien en pratique.

**Corrigé :**
- **Ce qui est compté :** les autorisations **consommées** du mois (`consumed_at`),
  l'instant où l'exécution est décidée, plus les exécutions du relais.
- **Où :** dans la transaction qui consomme (`ActionAuthorityStore.consumeGrant`), sous un
  verrou par locataire (`pg_advisory_xact_lock` ; transaction IMMEDIATE sur SQLite).
- **Partage avec le relais :** le relais prend le même verrou (`assertWithinQuotaPg`).
- **Migration 27 :** index `(organization_id, consumed_at)` sur `action_grants`, sans
  aucune donnée modifiée.
- **Un refus ne consomme rien :** l'autorisation reste `issued`.

**Après :** **600 exécutions pour un plafond de 600** à 1 024 clients, 1 074 refus 429
`quota_exceeded`, 0 erreur, intégrité intacte : 13/13. Le contrôle du banc exige
désormais un dépassement **nul**. Débit du cycle complet après le verrou : 56 cycles/s à
16 et 64 clients (58 avant), 51 à 256 (60 avant).

**Constaté, pas corrigé : aucun délestage.** Sous la charge, Placet fait attendre au lieu de
refuser : p99 de 10 s (décision) et de 20 s (cycle) à 1 024 clients, au-delà du délai de
nombreux clients HTTP. Seul garde-fou : une requête qui attend plus de 5 s une connexion à
la base reçoit 503 avec `Retry-After`, sans rien exécuter (3 fois sur un passage à 1 024).
Un contrôle d'admission (nombre maximal de requêtes en cours, refus immédiat 503 au-delà)
reste à concevoir.

**Non mesuré :** plusieurs organisations à la fois. La sérialisation est par locataire, donc
le débit total devrait croître avec le nombre d'organisations ; aucun banc ne le prouve.

Suites : 3 044 tests ; suites PostgreSQL une par une sur une base jetable, 81/81. Fichiers
bruts : `~/.cache/placet-suite/34f484b/charge/`.

### 5.28 Le refus immédiat quand Placet est débordé, et ce qu'il a révélé

Demandé après §5.27 : sous la charge, Placet faisait attendre au lieu de refuser (p99 de
10 s par décision, 20 s par cycle à 1 024 clients).

**Livré : `server/admission.ts`.**
- **Le plafond :** au-delà de `PLACET_MAX_IN_FLIGHT` requêtes `/api` en cours (256 par
  défaut, `0` coupe), la suivante reçoit aussitôt **503 `overloaded`**, sans rien décider ni
  exécuter, donc le réessai est sûr.
- **Où :** monté tout en haut, avant la lecture du corps, le journal des requêtes et
  l'authentification.
- **Les sondes** (`/api/live`, `/api/ready`, `/api/health`, `/api/metrics`) ne sont jamais
  refusées.
- **Une place se libère** quand la réponse part ou quand le client abandonne.
- **Métrique :** `placet_admission_shed_total{surface}`.

**Ce que les premiers passages ont révélé, dans l'ordre :**

1. **Refuser coûtait trop cher.** Monté après le compteur de réponses, chaque refus lisait
   encore le corps JSON et écrivait sa ligne de journal. À 1 024 clients, le débit utile
   des décisions tombait de 196 à 66 req/s. Déplacé tout en haut de `server/index.ts`.
2. **Grave : des trous dans la chaîne sous pression extrême.** Sur un passage à 1 024
   clients, **32 autorisations consommées sans reçu**, dont **14 exécutées chez le
   fournisseur sans reçu**, plus 36 `execute` en 503. Deux causes, toutes deux des
   attentes de connexion de plus de 5 s sur un pool saturé :
   - **La relecture de l'autorisation** se faisait après la transaction de consommation,
     sur une autre connexion. Quand elle échouait, l'autorisation était dépensée et rien
     ne le disait. Elle se fait maintenant **dans** la transaction : soit rien n'est
     consommé, soit l'autorisation est en main.
   - **L'écriture du reçu** après l'appel au fournisseur échouait sur la même attente.
     Elle est maintenant **réessayée** tant que la base est seulement injoignable, jusqu'à
     `PLACET_RECEIPT_PATIENCE_MS` (60 s). Avant chaque essai, le reçu est recherché : une
     écriture validée dont la réponse s'est perdue n'en produit pas une seconde. Une autre
     erreur remonte aussitôt, avec une ligne de journal qui dit ce qui manque.
   - Tests : `receipt-patience.test.ts` (5).

   Ce défaut ne dépendait pas du plafond : toute saturation du pool pouvait le déclencher.
   Le plafond l'a seulement rendu visible, en ralentissant le processus.
3. **Un `Retry-After` fixe d'une seconde nourrissait la surcharge.** Les ~770 refusés
   revenaient chaque seconde, soit ~700 refus par seconde sur une machine à 2 cœurs qui
   fait aussi tourner les clients du banc. Le délai croît maintenant avec les refus de la
   seconde écoulée : un par place et par seconde reste à 1 s, chaque multiple ajoute une
   seconde, jusqu'à 30 s. Le banc attend le `Retry-After` annoncé, comme un agent correct.

Un plafond de 128 a été essayé et n'aidait pas : le coût venait des refus, pas du plafond.

**Après, mêmes paliers, 15 s chacun :**

| | sans refus immédiat (§5.27) | avec |
|---|---|---|
| Décision, 1 024 clients | 180 req/s, p99 10,4 s | 134 req/s, p99 3,1 s, 5 409 refus |
| Cycle, 1 024 clients | 57 cycles/s, p99 20,4 s | 41 cycles/s, p99 8,9 s, 5 125 refus |
| Décision, 256 clients (sous le plafond) | 184 req/s | 194 req/s, aucun refus |
| Intégrité à 1 024 (cycle) | — | 4 478 reçus = 4 478 exécutions = 4 478 appels en aval, chaîne vérifiée |
| Erreurs | 3 (503 du pool) | **0** |

**Le prix, mesuré :** au pic, le débit utile baisse de 25 à 30 %. Le processus passe une
partie de son temps à refuser, et les 1 024 clients du banc tournent sur la même machine
à 2 cœurs. En échange, l'attente est bornée, aucune erreur, aucun trou. Le contrôle « la
concurrence augmente le débit » se lit désormais au **meilleur** palier, et un nouveau
contrôle exige que le p99 au palier le plus chargé reste dans le double de celui du
dernier palier sans refus. Les deux sont imprimés.

**Limites :**
- Le plafond est par instance et ne répartit pas équitablement entre organisations.
- Le cycle complet sature vers 57 cycles/s par locataire, si bien qu'à 256 requêtes en
  cours son p99 atteint déjà ~6 s. Une instance qui ne sert que des exécutions peut
  abaisser `PLACET_MAX_IN_FLIGHT`.

Suite complète : 3 054 tests. Fichiers bruts : `~/.cache/placet-suite/34f484b/charge/`
(`admission*.txt`).

### 5.29 Pannes provoquées sous la charge : fournisseur muet, processus tué, base coupée

Nouveau banc : **`npm run verify:faults`** (`script/verify-faults.ts`). 32 agents bouclent
« autoriser puis exécuter » pendant que trois pannes sont provoquées l'une après l'autre.
Après chacune, l'intégrité est lue **dans la base et chez le fournisseur simulé**, pas dans
les réponses de Placet. La coupure de la base n'a lieu que si `FAULT_PG_DOCKER` nomme le
conteneur ; sinon elle est sautée et dite.

| Panne | Ce qui est provoqué | Résultat (3e passage, `pannes-3.txt`) |
|---|---|---|
| **Fournisseur** | appels retardés de 2 s pendant 10 s, puis retenus sans réponse pendant 10 s (`PLACET_MCP_TIMEOUT_MS=4000`) | 1 072 exécutions ; les appels restés sans réponse finissent en **96 reçus « échoué »**, aucune attente sans fin ; 0 sans reçu ; 963 actions faites chez le fournisseur = 963 reçus « réussi » |
| **Processus tué** | `SIGKILL` en pleine charge, puis relance sur la même base | relancé et prêt en ~1 s, 1 157 exécutions acceptées après ; aucune autorisation exécutée deux fois ; **5 autorisations consommées sans reçu** (en vol à la mort, borne : 32) ; 5 actions faites chez le fournisseur sans reçu, les mêmes |
| **Base coupée 15 s** | `docker stop` puis `docker start` du conteneur jetable | le MÊME processus reste vivant ; 825 réponses 503 pendant la coupure ; 1 466 exécutions acceptées après ; **0 nouvelle autorisation sans reçu** ; **5 reçus réessayés** sur base indisponible puis écrits, 0 abandon |

Chaîne de reçus vérifiée de bout en bout après chaque panne. Aucun secret dans la sortie.
**24/24.**

**Ce que cela prouve de neuf :**
- **La patience du reçu (§5.28) sert vraiment.** Pendant la coupure, 5 actions déjà
  exécutées chez le fournisseur avaient leur reçu en attente. Elles ont été écrites au retour
  de la base. Sans ce correctif, ces 5 actions seraient restées sans trace.
- **Le seul trou qui reste est celui qu'aucun logiciel ne peut fermer :** un processus tué
  entre l'appel au fournisseur et l'écriture du reçu. Il est borné par le nombre de
  requêtes en vol, et désormais **visible**.

**Ajouté au produit :** `GET /api/actions/receipts/verify` rend en plus
`consumedWithoutReceipt` (le nombre) et `consumedWithoutReceiptSample` (les 20 plus récentes :
autorisation, action, agent, date de consommation). La chaîne prouve que les reçus écrits
n'ont pas été modifiés ; elle ne pouvait rien dire d'un reçu jamais écrit. Un exploitant peut
maintenant les rapprocher de chez le fournisseur. Une autorisation consommée à l'instant peut
y figurer le temps que son reçu s'écrive. Test ajouté dans `receipt-chain-verify.test.ts` :
le compte augmente quand un reçu disparaît, et une autre organisation ne voit pas ces
autorisations.

**Premier passage, échec du banc, pas du produit :** la coupure de base héritait des 6
autorisations sans reçu laissées par le `SIGKILL` précédent. Le banc compte désormais ce que
CHAQUE panne ajoute.

**Non couvert :**
- deux instances sur la même base, dont l'une tuée ;
- une coupure réseau entre Placet et la base (seul l'arrêt propre du conteneur a été provoqué) ;
- disque plein côté base ;
- une alerte automatique sur les autorisations sans reçu : elles sont lisibles, pas encore
  signalées.

Suite complète : 3 055 tests. Fichiers bruts : `~/.cache/placet-suite/34f484b/pannes/`.

### 5.30 L'alerte pour les actions sans reçu

Demandé après §5.29 : les autorisations consommées sans reçu étaient visibles
(`GET /api/actions/receipts/verify`), mais personne n'était prévenu.

**Livré : `server/authority/receipt-gaps.ts`, et une tâche périodique.**
- **Rythme :** toutes les 5 minutes par défaut (`PLACET_RECEIPT_GAP_INTERVAL_MS`, `0` coupe,
  jamais moins d'une minute), pour chaque organisation active.
- **Délai de grâce :** une autorisation consommée n'est signalée que passé ce délai, le temps
  maximal qu'un reçu légitime peut mettre à s'écrire (délai du fournisseur + patience du reçu
  + 30 s, soit 2 min par défaut). Avant, son reçu est peut-être en cours d'écriture.
- **Une seule alerte par autorisation**, même avec plusieurs instances. Elle est gardée dans
  la mémoire de la réconciliation (`reconcile_findings`, source `placet-receipts`, catégorie
  `receipt_gap`), dont l'insertion ne rend que les nouvelles. Aucune migration.
- **Le message :** nouvel événement `receipt.gap`, par le webhook et par Slack (sans bouton).
  Il nomme l'organisation, puis chaque autorisation avec l'action, l'agent et l'instant de
  consommation, jamais les arguments de l'action.
- **La tâche périodique** est généralisée (`label`, `variable`) : la même pour la
  réconciliation et pour cette recherche.
- **Le délai du fournisseur** passe dans `server/gateway/tools/downstream-timeout.ts` : le
  garde-fou `mcp-single-path.test.ts` a refusé que `receipt-gaps.ts` importe le client du
  fournisseur pour le lire. Il avait raison.

**Tests :** `receipt-gaps.test.ts` (6) :
- rien dans le délai de grâce, puis une alerte, une seule fois ;
- une seconde autorisation n'alerte que pour elle ;
- isolation entre organisations ;
- aucun argument d'action dans l'événement ;
- message Slack sans bouton.

Suite complète : 3 060 tests.

**De bout en bout, sur le bundle de production** (`verify:faults`, nouvelle étape 4, avec
une recherche toutes les 60 s, une patience de 30 s et un récepteur local jouant le
webhook) :
- le `SIGKILL` a laissé 6 autorisations sans reçu ;
- l'alerte `receipt.gap` est arrivée à 03:45:07, environ 3 min après la mort du processus,
  et elle nommait **exactement ces 6** ;
- un passage de plus n'a produit **aucune seconde alerte** ;
- pendant la coupure de la base (15 s), 6 reçus ont été réessayés puis écrits, **0
  nouvelle autorisation sans reçu**.

**26/26.** Ce passage a précédé le déplacement du délai du fournisseur dans son propre
module, qui ne change que l'endroit du code.

### 5.31 Charge répartie sur plusieurs organisations : la machine sature avant le verrou

**Hypothèse éprouvée.** La voie d'écriture est sérialisée par locataire : la chaîne de reçus
et le verrou du quota, `pg_advisory_xact_lock` par organisation. Un seul locataire
plafonnait vers 55 à 60 cycles/s (§2.5, §5.27). Si ce verrou était le goulot, le débit
total devait croître avec le nombre d'organisations.

**Banc :** `verify:load` gagne `LOAD_ORGS=n`. Il crée n organisations, chacune avec un
administrateur de console, un agent, une règle et une clé d'opérateur, et répartit les
clients à tour de rôle entre elles. Les chaînes sont vérifiées dans **chaque**
organisation. Premier essai avec des clés de service : refusé, car seul un administrateur
**connecté** peut émettre une clé d'agent (`POST /api/keys`). Le banc utilise donc un compte
de console par organisation.

**Cycle complet** (autoriser puis exécuter), 15 s par palier, même machine (2 cœurs, sur
secteur, Chrome fermé) :

| Clients | 1 organisation | 4 organisations | 8 organisations |
|---|---|---|---|
| 1 | 33 cycles/s | 34 | 35 |
| 16 | 55 | 58 | 59 |
| 64 | 60 | 64 | 65 |
| 256 | 56 · p99 6,1 s | 62 · p99 5,8 s | 63 · p99 5,9 s |

11/11 à chaque fois : 0 erreur, intégrité complète, chaque chaîne vérifiée (4 023 entrées
sur 4 organisations, 4 096 sur 8).

**L'hypothèse n'est PAS confirmée sur cette machine.** Le débit ne gagne que ~8 % de 1 à 8
organisations. Le relevé du processeur pendant le palier à 64 clients et 8 organisations
montre la machine **occupée à 83–87 %** (12–17 % d'inactivité), partagée entre :
- le processus Placet ;
- PostgreSQL (~40 % d'un cœur dans son conteneur) ;
- le banc lui-même (64 clients dans un processus Node) ;
- le bureau (Claude Desktop) et l'instance locale de l'utilisateur.

C'est la machine qui plafonne, avant le verrou par organisation.

**Ce que cela établit quand même :** le verrou par organisation ne **coûte** rien de
mesurable. À 8 organisations, chacune sérialisée à part, le débit est égal ou supérieur à
celui d'une seule, et la latence identique.

**Ce qui reste à prouver, et où :** que le débit total croît avec le nombre d'organisations
quand la machine a de la marge. Il faut plus de cœurs, et le banc de charge sur une autre
machine que Placet. C'est l'une des raisons du serveur de test dans le nuage proposé plus
tôt. L'équité entre organisations (une organisation très active ne doit pas affamer les
autres) n'est pas mesurée non plus : ici toutes demandent autant.

Fichiers bruts : `~/.cache/placet-suite/821a103/multi-org/`.

### 5.32 Le renommage Placet → Oathrion, et une course ancienne dans `pg-pool`

À partir d'ici, le produit s'appelle **Oathrion**. Les sections précédentes gardent le nom
de leur époque. Le détail du renommage (inventaire, décisions, ce qui garde l'ancien nom et
pourquoi) est dans `notes/RENOMMAGE-OATHRION.md` et `docs/limitations.md`.

**Vérifications sur le code renommé :**
- 3 076 tests, lint, typage, build ; SDK Python 25/25 ;
- suites PostgreSQL 101/101 ;
- `verify:intercept` 67/67 ;
- conformance : noyau 21/21, étendu 6/6 ;
- compatibilité : un serveur lancé avec **seulement** des variables `PLACET_*` démarre,
  accepte la connexion, et nomme les 9 variables à renommer dans un seul avertissement ;
- `docker compose config` avec `PLACET_DOMAIN` seul ou `PLACET_PILOT_PORT` seul : les
  anciens noms sont pris, le nouveau gagne quand les deux sont posés.

**`verify:faults` a révélé une course ancienne.** Sur 5 passages de la version renommée,
3 ont vu le processus mourir pendant l'arrêt de la base :
`uncaught exception — shutting down: error: terminating connection due to administrator
command` (57P01). Un diagnostic chargé par `--require`, sans toucher au produit, signale
tout client PostgreSQL qui émet `error` sans écouteur, avec l'endroit où il a été créé.
Résultat :
- le client fautif a été créé par `BoundPool.query` au démarrage du plan d'autorisation ;
- il n'avait **aucune requête active** et **aucun écouteur** au moment du message fatal.

Le pool l'avait déjà retiré, avec ses écouteurs, quand le message de fin de PostgreSQL est
arrivé sur la socket : Node a levé l'erreur, et le cycle de vie a arrêté le processus.

**Ancienne, et sans rapport avec le renommage.** La version d'avant (`2ea6f35`), rejouée
avec le même diagnostic, meurt au 2e passage avec **la même signature**. Avant cette
série, elle avait réussi 4 passages. C'est une course entre `pg` et `pg-pool` pendant
l'arrêt de la base, et le hasard du moment décide. Les passages réussis des §5.29 et
§5.30 ne l'avaient pas rencontrée.

**À corriger dans un lot séparé :** un écouteur d'erreur permanent sur chaque client créé
par les pools (`pool.on("connect", …)`). Pas encore fait.

### 5.33 La course `pg` / `pg-pool` corrigée : 5 coupures de base, 0 arrêt

**La vraie fenêtre**, lue dans le code de `pg-pool` 3.14.0. Le pool pose son écouteur
d'erreur sur une connexion inactive. Quand il la remet à un appelant, il le **retire**
(`_acquireClient`), et `pool.query` ne pose le sien qu'ensuite, dans son rappel. Pendant
cet intervalle, la connexion n'a aucun écouteur. Si le message de fin de PostgreSQL
(57P01) arrive à ce moment, `pg` émet `error` dans le vide et le processus s'arrête.

Ma première hypothèse était fausse : je pensais à une connexion retirée du pool. Le premier
test l'a démentie, car une connexion retirée garde l'écouteur du pool.

**Correctif :** `server/sql/pg-client-guard.ts`. Un écouteur permanent est posé sur chaque
connexion dès sa création (`pool.on("connect")`), dans les quatre pools : base,
autorisation, limiteur, migrations. Il journalise et ne cache rien : une requête en cours
reçoit toujours son erreur, et le pool retire toujours la connexion cassée.

**Test :** `pg-client-guard.test.ts`, sur un vrai `pg-pool` (`OATHRION_TEST_POSTGRES_URL`).
Une connexion tout juste remise a zéro écouteur, et l'erreur est levée sans le garde.
Avec le garde, elle est journalisée et ne lève plus. 3/3.

**Validation, là où la panne se produisait :** `verify:faults` 5 fois de suite, coupure de
base comprise, avec le diagnostic qui signale toute erreur émise sans écouteur.

| Passage | Contrôles | Erreurs sans écouteur | Rattrapées par le garde | Arrêt |
|---|---|---|---|---|
| 1 | 26/26 | 0 | 12 | aucun |
| 2 | 26/26 | 0 | 13 | aucun |
| 3 | 26/26 | 0 | 12 | aucun |
| 4 | 26/26 | 0 | 14 | aucun |
| 5 | 26/26 | 0 | 13 | aucun |

Avant le correctif : 3 arrêts sur 5 (version renommée) et 1 sur 2 (version d'avant).
Suite complète après le correctif : 3 077 tests, lint propre.

### 5.34 Volume : le quota comptait tout le mois à chaque exécution

**Mesure.** Base jetable, une organisation, **1 000 000 d'autorisations consommées dans le
mois** insérées en SQL (28 s pour les actions, 39 s pour les autorisations).
- La requête de comptage du quota, exécutée sous le verrou de l'organisation à chaque
  exécution, prend **550 ms à 2 s**.
- `EXPLAIN ANALYZE` : parcours séquentiel parallèle de `action_grants`, 1,0 s.

Le verrou étant tenu pendant ce temps, une organisation à ce volume plafonnerait autour
d'**une exécution par seconde**. Avec le quota livré (100 000 par mois), le plafond
tomberait vers dix par seconde en fin de mois. Aucun banc ne l'avait vu : leurs bases
contenaient quelques milliers d'actions.

**Corrigé : un compteur par organisation et par mois.**
- **Migration 28 :** table `quota_period_counts`.
- **Module :** `server/sql/execution-quota.ts`.
- **Lecture puis incrément** dans la même transaction que l'écriture comptée, sous le même
  verrou, sur les deux voies : la consommation d'une autorisation (`consumeGrant`,
  seulement si elle a réellement été consommée) et le relais (`assertWithinQuotaPg`, et sa
  version SQLite synchrone dans `server/quotas.ts`).
- **Ouverture paresseuse :** une période s'ouvre par un comptage, une seule fois par mois et
  par organisation. Un rapport d'usage lit le compteur, ou compte, sans rien écrire.
- **Limite dite dans le code :** une exécution écrite hors des deux voies (importation,
  ligne insérée à la main) n'est pas comptée.

**Après, sur la même base d'un million :**

| | Durée |
|---|---|
| comptage (ancienne méthode) | 550 ms |
| 1re exécution du mois (ouverture du compteur) | 354 ms, une fois |
| 200 exécutions suivantes (verrou, lecture, incrément) | p50 5,6 ms · p99 15 ms |

Le compteur final est exact : 1 000 201.

**Ce qui ne change pas :**
- L'exactitude sous concurrence : `LOAD_QUOTA=600` à 1 024 clients donne **600 exécutions
  pour 600**, 0 dépassement, intégrité intacte.
- Le débit, mesuré en A/B dans les mêmes conditions et l'un après l'autre, deux tours :
  avant le compteur 20–21 / 44–46 / 49–50 cycles/s à 1 / 16 / 64 clients ; avec le
  compteur 19–21 / 42–44 / 47. L'écart reste dans le bruit, au plus 5 %.

Ces chiffres sont plus bas que ceux du §5.27 : la machine était sur batterie, avec Chrome
ouvert et une charge de 4. Le passage `LOAD_QUOTA` a ainsi échoué 2 contrôles de débit et
d'attente, qui mesurent la machine. C'est pour cela que la comparaison s'est faite en A/B.

**Tests :**
- `quota-direct-path.test.ts` (5) : un rapport d'usage lit sans ouvrir la période ; une
  exécution l'ouvre au bon total puis l'incrémente ; une autorisation présentée deux fois
  n'est comptée qu'une fois ; le compteur reste égal au comptage.
- Suites PostgreSQL : 104/104. Suite complète : 3 084 tests.

**Reste du volume, non traité :** la vérification COMPLÈTE de la chaîne reste O(n)
(environ 13 µs par reçu, soit environ 13 s par million). Une vérification par étapes
(points de contrôle) est à concevoir, et une politique de conservation des reçus à décider.

### 5.35 La vérification de la chaîne par étapes

**Le besoin (§5.25, §5.34).** La vérification complète relit toute la chaîne d'une
organisation : ~13 µs par reçu. Elle reste faisable la nuit, mais elle devient lourde dès
qu'on veut la lancer souvent.

**Livré :**
- **Migration 29 :** `receipt_chain_checkpoints`, une ligne par organisation : le nombre de
  reçus vérifiés, la position et l'empreinte du dernier, la date de la dernière vérification
  réussie et celle de la dernière vérification COMPLÈTE.
- **`ReceiptChainVerifier` peut reprendre** après une partie déjà vérifiée (`resume`). La
  règle de genèse ne s'applique alors pas.
- **`GET /api/actions/receipts/verify?mode=incremental`** contrôle d'abord l'**ancre** (le
  reçu à la position du point doit avoir la même empreinte, recalculée). Il vérifie ensuite
  les seuls reçus postérieurs, puis avance le point. Sans paramètre, la route garde son
  contrat d'origine (vérification complète), et elle avance aussi le point.
- **Le point de reprise ne recule jamais**, et un échec ne l'avance pas.
- **La réponse dit** `mode`, `verifiedFrom` (les reçus déjà vérifiés, donc non relus) et
  `lastFullVerification`.

**Mesure** (base jetable, une vraie chaîne de reçus aux empreintes valides) :

| | Durée |
|---|---|
| écriture de 300 000 reçus en SQL | 36 s |
| vérification complète, 300 000 reçus | **3,36 s** |
| vérification par étapes après 100 reçus de plus | **3,5 ms** |
| vérification complète de contrôle, 300 100 reçus | 3,16 s, même tête |

**Tests :** `receipt-chain-incremental.test.ts` (6). Ils couvrent :
- sans point de reprise, une vérification complète, qui le dit ;
- seuls les reçus nouveaux sont relus, pour le même total et la même tête ;
- une falsification APRÈS le point est vue ;
- une falsification de l'ANCRE est vue (`checkpoint:`) ;
- un échec n'avance pas le point, et chaque organisation a le sien ;
- **une falsification plus ancienne que l'ancre n'est PAS vue par étapes, et l'est par la
  vérification complète.** C'est la limite du mode, éprouvée plutôt qu'affirmée, et la
  raison de garder une vérification complète planifiée (`docs/ON-CALL.md`).

Les tests sont dans leur propre fichier, et la chaîne y est écrite une seule fois : écrits
à la suite de `receipt-chain-verify.test.ts`, ils butaient sur le limiteur de débit des
décisions, qui n'a pas été relevé.

**Corrigé en passant :** quatre commentaires que la passe de renommage avait rendus faux
sur l'historique. « jusqu'au renommage Oathrion » désignait en réalité le renommage
ARIA → Placet, et « `X-Oathrion-*` » le nom précédent, aujourd'hui `X-Placet-*`. Ils se
trouvaient dans `receipt-chain.ts`, `webhook.ts`, `envelope.ts`, `ON-CALL.md` et
`ANNEXE-PERIMETRE-PILOTE.md`.

**Reste :** une politique de conservation des reçus (rien n'est supprimé aujourd'hui).
Si des reçus anciens sont un jour purgés, le point de reprise et la règle de genèse
devront en tenir compte.

### 5.36 Endurance de 12 heures sur `f46a239` : 16/17, la vérification complète reste trop lente

Lancée le 27 octobre à 07:59:42 UTC sur `f46a239` : la vérification par étapes y est, pas
encore le cookie de session ni la licence. Bundle sha256 `5780391f8bc98b13`, serveur,
client et `shared/` identiques au commit. Base : le conteneur jetable `placet-proof-pg`.
Deux verrous de veille, secteur branché, couvercle ouvert. Au départ : 4 403 Mo de RAM
disponibles, 984 Mo de swap utilisés. Banc corrigé après §5.25 (quota relevé, session
renouvelée).

**720 minutes complètes, 0 veille**, fin à 20:00:00. 360 254 cycles (~8,3 par seconde),
1 438 relevés. Résultat : **16/17**.

| Contrôle | Résultat |
|---|---|
| processus vivant 12 h | ✓ |
| aucune erreur sur le passage | ✓ 2 161 524 requêtes |
| mémoire résidente (régime établi) | ✓ 290 → 244 Mo (−15,6 %) ; plate à 294 Mo jusqu'à ~6 h 40, puis plate à 238–241 Mo |
| descripteurs / connexions PostgreSQL / sas / limiteur | ✓ 36 → 36 ; max 9 ; 0 ; 1 |
| p95 du relais sans dérive | ✓ 85 → 156 ms (borne : le double, ou +25 ms) |
| p99 du relais < 1 s | ✓ 177 ms ; max 2 787 ms |
| la chaîne vérifie à la fin | ✓ 360 254 reçus |
| le fournisseur a reçu le trafic | ✓ 360 254 exécutions |
| aucun secret dans la sortie | ✓ |
| **vérification de chaîne praticable (< 5 s)** | **✗ 8 008 ms pour 360 254 reçus** |

**Ce qui est acquis.** C'est le premier passage de 12 h où le relais réussit du début à la fin
(§5.25 refusait après 2 h 42), et le premier sans aucune erreur. Pas de fuite visible :
la mémoire ne monte pas, rien ne s'accumule. Le quota relevé, la session renouvelée et la
course `pg-pool` corrigée (§5.33) ont tenu 12 h.

**L'échec, tel qu'il est.** Le banc lance une vérification COMPLÈTE toutes les 30 s
(`GET /api/actions/receipts/verify`, sans paramètre). Elle relit toute la chaîne, et elle
le fait sous le trafic du banc :

| Reçus | Vérification complète |
|---|---|
| 44 446 | 692 ms |
| 114 514 | 2 003 ms |
| 200 954 | 2 806 ms |
| 286 814 | 4 931 ms |
| 356 298 | 6 138 ms |
| 360 254 (dernier relevé) | 8 008 ms |

Soit 14 à 22 µs par reçu. C'est plus cher que les 13 µs de §5.25 (déjà sous trafic, 403 000
reçus) et que les 11 µs de §5.35 (base au repos, 300 000 reçus). Deux causes possibles, non
départagées : la vérification complète avance désormais aussi le point de reprise
(migration 29), et la machine swappait plus (984 → 1 253 Mo). La durée est en tout cas
linéaire, sans emballement : 15,6 µs par reçu à 44 000, 17 µs à 356 000, puis un dernier
relevé plus lent.

**Ce que ce passage ne mesure pas : la vérification par étapes** (§5.35), conçue
précisément pour ce cas. Le banc ne l'appelle pas. Le résultat reste donc 16/17, et la
vérification complète reste à planifier hors des heures chargées (`audit:chains`,
`docs/ON-CALL.md`).

Fichiers bruts : `~/.cache/placet-suite/f46a239/soak12h/` (`soak.txt`, `samples.csv`,
`soak.meta`), intacts.

### 5.37 Le banc d'endurance juge la vérification par étapes : 19/19 sur 35 minutes

**Le changement** (`script/verify-soak.ts`, commit `12d272c`) :
- **à chaque relevé**, le banc lance une vérification par étapes
  (`?mode=incremental`). Deux contrôles : elle réussit et relit bien par étapes, et elle
  reste sous 1 s ;
- **la vérification complète** ne tourne plus que tous les 20 relevés (10 minutes), au lieu
  de toutes les 30 s. Le contrôle « moins de 5 s », échoué en §5.36, est remplacé par un
  contrôle de **forme** : le coût par reçu ne doit pas doubler entre la première et la
  dernière mesure au-delà de 10 000 reçus. Son temps reste imprimé, avec l'extrapolation
  à un million de reçus.

Ce changement de seuil est délibéré et dit ici. La vérification complète coûte toujours
O(n), ce n'est pas résolu, mais elle se planifie (`audit:chains`). C'est la vérification
par étapes qui tourne souvent, et c'est donc elle que le banc doit juger praticable.

**Passage de validation**, le 27 octobre de 20:11:38 à 20:46:47 UTC. Serveur de `6e2b7da`,
même code serveur que `12d272c`. Base neuve `soak_etapes` dans le conteneur jetable.
**Sur batterie** (91 → 74 %), donc les temps sont moins représentatifs qu'au secteur.
21 872 cycles (~10,4 par seconde), 70 relevés. Résultat : **19/19**.

| Mesure | Résultat |
|---|---|
| aucune erreur | ✓ 131 232 requêtes |
| mémoire résidente | ✓ 232 → 239 Mo (+2,8 %) |
| vérification par étapes, 68 en régime établi | ✓ toutes réussies, toutes par étapes ; p50 57 ms, p95 139 ms, max 220 ms |
| reçus relus par étape | au plus 424, sur 21 598 |
| vérification complète | 200 ms à 6 770 reçus ; 513 ms à 13 504 ; 485 ms à 19 200 |
| forme de la complète | ✓ 38,0 → 25,3 µs par reçu, pas d'emballement |
| p95 du relais | ✓ 58 → 78 ms ; p99 108 ms |
| la chaîne vérifie à la fin | ✓ 21 872 reçus |

**Ce que ce passage montre :** le banc modifié fonctionne, et une vérification par étapes
coûte quelques dizaines de millisecondes, quelle que soit la taille de la chaîne. Sa durée
suit les reçus des 30 dernières secondes (250 à 420), pas les 21 000 de la chaîne.

**Ce qu'il ne montre pas :** le comportement par étapes à 360 000 reçus et sur 12 h. Ce sera
le prochain passage long, qu'il faut relancer au secteur. Les 57 ms de médiane sont probablement surtout
le trajet HTTP, l'authentification et le contrôle de l'ancre, pas la relecture : à 300 000
reçus en base au repos, §5.35 mesurait 3,5 ms pour 100 reçus nouveaux.

Fichiers bruts : `~/.cache/placet-suite/6e2b7da/soak-etapes/`, intacts. Le `soak.meta` dit
« non commité » : c'était vrai au lancement, et le banc a été commité tel quel en `12d272c`
pendant le passage.

### 5.38 Suite complète sur `12d272c` : un test resté sur l'ancien préfixe de clé

C'est la première suite complète depuis le cookie de session (`2805bf1`) et la licence
(`b7d1f27`). Lancée le 27 octobre à 20:48 UTC, sur batterie.

| Vérification | Résultat |
|---|---|
| `tsc --noEmit` | ✓ 0 erreur |
| `eslint .` | ✓ 0 erreur |
| `vitest run`, sans base | ✓ **3 102 réussis, 0 échec, 83 ignorés** (166 fichiers, 7 ignorés). Les 83 sont tous des tests PostgreSQL |
| les 10 fichiers PostgreSQL, base jetable (`placet-proof-pg`) | ✓ **114 / 114** |
| `phase12-restart-reconnect` (coupe la base), même base | ✗ puis ✓ **2 / 2** après correction |

**L'échec.** Le test de redémarrage attendait une clé d'API qui commence par `placet_`. Le
renommage a porté le préfixe des nouvelles clés à `oathrion_` (`KEY_PREFIX`), et ce test ne
tourne que sur demande explicite (il arrête la base) : le renommage ne l'a pas vu. Ce
n'est pas un défaut du produit, les clés `placet_…` déjà émises restent valides (elles
sont résolues par empreinte, pas par préfixe). Le test compare maintenant à `KEY_PREFIX`,
plutôt que de répéter un littéral qui se périme.

**Corrigé en passant :**
- le commentaire de `DISPLAY_PREFIX_LENGTH` (`server/api-keys.ts`) disait « treize
  caractères (`placet_` + 6) ». Avec `oathrion_`, c'est quinze ;
- un commentaire d'historique de `api-keys.test.ts` que la passe de renommage avait rendu
  faux. L'échec qu'il raconte attendait `placet_af5a`, pas `oathrion_af5a`.

Fichiers bruts : `~/.cache/placet-suite/12d272c/suite/`, intacts : `typecheck.txt`,
`lint.txt`, `test.txt`, `vitest.json`, `pg.txt`, `pg-restart.txt` (l'échec) et
`pg-restart-2.txt` (après correction).

### 5.39 Audit de l'interface dans le navigateur : un vrai défaut GitHub, aucun blocage du parcours

Le 27 octobre de 21:04 à 21:45 UTC. Kit de `docs/PILOTE-RECETTE-UTILISATEUR.md`, huit
étapes, suivi dans le navigateur intégré **par l'équipe**. **Ce n'est pas une recette** :
les notes de facilité ci-dessous sont celles d'un évaluateur qui connaît le produit, pas
celles d'un testeur. Elles servent à classer les défauts, pas à juger la recette.

**Montage :**
- **instance jetable :** bundle de `f75f40a`, port 5331, base neuve `audit_ux_f75f40a`
  dans le conteneur jetable, `OATHRION_ACCOUNTS=database`. L'espace « Audit UX » et son
  invitation viennent de `workspace-create` ;
- **faux GitHub local** (`OATHRION_GITHUB_API_ORIGIN`), avec deux dépôts, `essai/produit`
  et `essai/autre`, et un jeton factice ;
- **pourquoi un faux GitHub :** le jeton GitHub de test (`~/.config/placet/github-test.env`)
  est refusé par GitHub, sans doute expiré. L'avantage est que l'étape « connecter » a pu
  être éprouvée **par l'écran**, ce que le §5.15 n'avait pas pu faire. Le faux GitHub a
  aussi permis de provoquer un délai dépassé à la demande.

**Les huit étapes**

| # | Étape | Résultat | Facilité (évaluateur, 1–7) | Constat |
|---|---|---|---|---|
| 1 | ouvrir l'invitation | seul | 7 | espace, adresse et rôle affichés ; le jeton disparaît de la barre d'adresse |
| 2 | se connecter | seul | 7 | arrive au démarrage de cet espace. **Un rechargement ne déconnecte plus**, et un redémarrage du serveur non plus (cookie, `2805bf1`) |
| 3 | connecter l'outil | seul | 6 | instructions claires. Un jeton invalide donne « GitHub refuse ce jeton… Créez-en un nouveau », ce qui est clair. Le message de succès parle de « portée fine », trop technique |
| 4 | régler la règle | seul | 6 | `essai/produit` coché, « sur approbation ». Les deux règles sont visibles sur Politiques, mais en anglais, avec une date brute `2026-10-27T00:00:00.000Z` |
| 5 | brancher l'agent | seul | 5 | clé et configuration MCP claires. Le champ « Nom » est prérempli : un clic au milieu a donné « Agent de l'équipAssistant issuese ». C'est mon geste, mais le texte « Il ne détient aucun jeton GitHub, Slack ou Linear » oublie Stripe |
| 6 | faire agir | seul | 6 | lecture, création, hors périmètre. Le faux GitHub ne voit **aucun** appel vers `essai/autre` |
| 7 | trois décisions, approuver | seul | 6 | « Autorisé », « Approbation requise », « Bloqué ». Approuvée dans la page : l'issue n'est créée qu'à ce moment |
| 8 | le reçu | seul | 4 | décision, règle, approbateur, « Issue #1 ouverte ». Pour le bloqué, « Action denied before reaching the tool », « SKIPPED, 0 attempts ». Mais l'écran est en anglais, il n'a pas de lien vers l'issue, et il affiche une durée « 13 ms » sans rapport avec l'attente |

**Défaut de gravité 4, corrigé : un délai dépassé chez GitHub laissait une création
d'issue rejouable.** Je l'ai trouvé en provoquant le délai dépassé de la liste « à
surveiller » (le faux GitHub répond en 20 s). La console affichait « Autorisée, mais le
service a refusé : Tool execution failed: Outbound request to 127.0.0.1:7103 timed out
after 15000ms ». Le libellé était faux, mais ce n'était que le symptôme.

Cause, dans `server/connectors/github.ts` : les quatre verbes étaient **rendus** depuis le
`try` (`return this.createIssue(…)`) sans être attendus. Le rejet de la promesse sortait
donc du bloc, et le `catch` qui appelle `transportFailure` ne le voyait jamais.
Conséquences :
- un délai dépassé remontait en exception brute, sans `dispatched: "unknown"` ;
- la règle de relance (`retryabilityOf`) voyait un échec ordinaire, et une issue
  **peut-être déjà créée** restait relançable, donc pouvait être créée **en double** ;
- c'est exactement ce que l'audit de lancement avait corrigé (`docs/FINAL-PILOT-READINESS.md`,
  « Résultat incertain »). Le correctif était en place pour GitHub aussi, mais ce `return`
  le contournait, et le test ne couvrait que Slack.

Slack, Linear et Stripe attendent leurs appels et ne sont pas touchés.

**Correctif :**
- `return await` sur les quatre verbes, avec un commentaire qui dit pourquoi ;
- le délai de GitHub suit maintenant `OATHRION_CONNECTOR_TIMEOUT_MS` (`connectorTimeoutMs`),
  comme les autres connecteurs, au lieu d'une constante de 15 s.

**Test :** `unknown-effect.test.ts`, « GitHub muet après réception d'une création
d'issue ». Il passe sur le code corrigé, et **échoue sur l'ancien** (le connecteur rejette
au lieu de rendre un résultat). Relancé ensuite dans la console : le délai dépassé
s'affiche « Le service a reçu la demande mais n'a pas répondu : l'action a PEUT-ÊTRE eu
lieu ». Tests des connecteurs, de la passerelle et du scénario : 387/387. Lint et typage
propres.

**Corrigé en passant (gravité 1) :** l'écran Politiques affichait un cadre vide sous les
règles du démarrage guidé, qui n'ont pas d'expression.

**Défauts ouverts, par priorité** (gravité × part touchée × poids de l'étape, une seule
personne donc part = 1) :

| Priorité | Gravité | Défaut | Étapes |
|---|---|---|---|
| 4 | 2 | la console mélange français et anglais : menu, Politiques, Exécutions, détail, « Motif technique ». **Une décision est à prendre : la langue de la préversion publique** | 4, 7, 8 |
| 4 | 2 | l'étape 5 ne passe jamais à « fait ». Après un rechargement, les résultats du scénario disparaissent et « Lancer le scénario » revient, alors que les exécutions existent. Le cookie rend ce cas fréquent, et le commentaire de `VerifyStep.tsx` (« un rechargement complet déconnecte de toute façon ») est périmé | 7 |
| 4 | 2 | le détail d'une exécution n'a pas de lien vers l'issue créée ; le démarrage, lui, en a un | 8 |
| 2 | 2 | Politiques : date brute ISO, et deux pastilles redondantes (« require approval », « require human approval ») | 4 |
| 2 | 1 | « Durée 13 ms » pour une action approuvée puis exécutée | 8 |
| 1 | 1 | « au nom de Agent… » (élision manquante) ; Stripe oublié dans deux textes de l'étape 4 ; « préparer une tâche » quand seul GitHub est connecté | 5, 6 |
| 1 | 1 | le champ « Votre nom » et le champ du jeton ont pour nom accessible leur exemple (« Awa Diallo », « github_pat_… »), pas leur libellé | 1, 3 |
| 1 | 1 | le logo de la console est un « A », hérité d'ARIA ; la page d'invitation montre un bouclier | — |
| 1 | 1 | sur une LECTURE, le délai dépassé dit « l'action a PEUT-ÊTRE eu lieu… relance sur attestation », trop prudent : une lecture n'a pas d'effet | 6 |

**Ce que l'audit ne montre pas :** comment une personne qui découvre Oathrion s'en sort.
C'est la recette, avec 3 à 5 testeurs, qui le dira. Ni GitHub réel (jeton expiré), ni
Cursor, ni les rôles autres qu'administrateur.

Nettoyage : instance et faux GitHub arrêtés (par PID). Fichiers de mot de passe, de
secret de session, de clé et d'invitation supprimés. La base `audit_ux_f75f40a` reste
dans le conteneur jetable. Journaux : `~/.cache/placet-suite/f75f40a/audit-ux/`.

### 5.40 `oathrion wrap` avec un vrai client : Cursor, en mode sans interface

Le 28 octobre 2026. `cursor-agent` 2026.10.22, compte de l'utilisateur. Tout se passe dans un
**dossier de projet jetable**, avec son propre `.cursor/mcp.json`. La configuration globale
`~/.cursor/mcp.json` n'a pas été touchée : même empreinte avant et après.

**Montage :** le serveur MCP `carnet` est déclaré comme
`node tsx cli/bin.ts wrap --name carnet -- node fake-stdio-mcp-server.cjs`. L'état va dans le
dossier jetable (`OATHRION_WRAP_HOME`).

| Étape | Résultat |
|---|---|
| `cursor-agent mcp list` | `carnet: ready`, après l'approbation du serveur demandée par Cursor |
| `cursor-agent mcp list-tools carnet` | 6 outils, **sous leur nom d'origine** ; `delete_note` absent |
| agent : `read_note` | réponse exacte de l'enfant, `[]` |
| agent : `create_note` | « Held for human approval — the tool was NOT called… Approval apr_… is pending » |
| journal de l'enfant | `read_note` seulement : **l'écriture retenue ne l'a pas atteint** |
| agent : `delete_note` | « cet outil n'existe pas » |
| fin | aucun processus restant, ni `wrap`, ni Oathrion local, ni enfant |

**Trois constats :**
1. **Premier lancement par Cursor : échec.** Cursor lance la commande depuis le dossier du
   projet, et `tsx` n'y trouve pas les alias du dépôt (`@shared/…`). Le test de bout en bout
   de `wrap.test.ts` ne pouvait pas le voir, puisqu'il tourne depuis le dépôt. Contourné pour
   l'essai (`tsx --tsconfig <dépôt>/tsconfig.json`). **Pour l'étape E7, la commande livrée
   doit être compilée en un seul fichier**, comme le serveur.
2. **En mode sans interface, Cursor refuse par défaut tout appel d'outil MCP**
   (« User rejected MCP »), avant Oathrion : l'enfant n'a rien reçu. L'agent a d'ailleurs
   attribué ce refus à Oathrion, ce qui est faux. La permission se donne par projet
   (`.cursor/cli.json`, `"allow": ["Mcp(carnet:*)"]`, `"deny": ["Shell(*)"]`), sans `--force`
   qui ouvrirait aussi le shell. **À écrire dans la documentation de `wrap`.**
3. Changer la configuration d'un serveur fait redemander son approbation par Cursor :
   l'approbation est liée à la configuration.

**Pas fait : un vrai serveur MCP tiers** (`npx -y @modelcontextprotocol/server-memory`). Le
lancement a été refusé par le classificateur de l'environnement, parce que `npx` télécharge
et exécute du code venu de npm. Ce n'est pas contourné. Il reste à faire avec l'accord
explicite de l'utilisateur, ou par l'utilisateur lui-même.

### 5.41 `oathrion wrap` : l'approbation dans le même appel, et un reçu qui n'existait pas

**Livré (étape E4, partie a).** Le relais attend désormais l'approbation d'une écriture retenue
**dans le même appel**, 120 s par défaut (`--attendre`, de 0 à 3 600) :
- le lien de la console s'affiche sur la sortie d'erreur ;
- un client qui donne un `progressToken` reçoit des notifications de progression ;
- **approuvée :** l'agent reçoit la réponse du serveur enveloppé, exécutée par Oathrion après
  la décision ;
- **refusée :** l'agent reçoit « Rejected by … — the tool was NOT called » ;
- **délai écoulé :** l'agent reçoit « retenu » avec le lien. L'action partira à l'approbation,
  rien n'est relâché par le délai.

Le relais ne fait que lire (`GET` de l'approbation et de l'exécution) : il ne relâche rien.
`wrap-approval.test.ts` (5) : vrai serveur, vrai enfant, une approbatrice de l'espace local
qui décide pendant que l'appel attend. L'enfant est appelé une seule fois, après
l'approbation, et jamais après un refus.

**Trouvé : une affirmation fausse, corrigée.** L'aide de `oathrion wrap` disait « Chaque
action laisse un reçu chaîné », et un test de l'étape E2 s'intitulait « la chaîne de reçus se
vérifie ». Ce test passait **sur une chaîne vide**. La passerelle MCP n'écrit pas dans la
chaîne de reçus d'autorité : seul `authority/enforcement-point.ts`, le chemin `/api/actions/*`,
le fait.

Ce que la passerelle garantit réellement : chaque exécution porte son propre journal chaîné
(`server/audit-chain.ts`). Toute modification, réordonnancement ou suppression **à
l'intérieur** de ce journal se voit. Ne se voit pas : la suppression d'une exécution
**entière**, comme `docs/limitations.md` le dit déjà.

Corrigé :
- l'aide dit maintenant « un journal chaîné : une modification se voit » ;
- le test est renommé « LIMITE : les actions de la passerelle n'entrent pas dans la chaîne
  de reçus d'autorité ». Il épingle `entries = 0`, et il changera le jour où ce sera faux.

**À décider :** faire écrire la passerelle MCP dans la chaîne de reçus d'autorité. Ce serait
une seule chaîne pour toutes les actions, quel que soit le chemin, et une suppression
deviendrait détectable par la séquence sans trou.

### 5.42 La passerelle MCP écrit dans la chaîne de reçus : une seule chaîne pour tout

Décision de l'utilisateur (option 1) après §5.41. Livré le 28 octobre 2026.

**`server/gateway/gateway-ledger.ts`** reprend, pour la passerelle, le contrat du point
d'application :
- **avant l'outil**, une action et une autorisation sont inscrites dans le plan d'autorité, et
  l'autorisation est consommée ;
- **après l'outil**, réussi ou non, le reçu est chaîné à la tête du locataire, sous le même
  verrou que les autres reçus, avec la même patience sur une base saturée ;
- **fermé par défaut :** si l'autorisation ne peut pas être inscrite, l'outil ne tourne pas
  (`dispatched: false`, `ledger_unavailable`) ;
- **sans quota :** l'autorisation est consommée sans le paramètre de quota, puisque la
  passerelle compte déjà ses exécutions. Rien n'est compté deux fois ;
- **les trous restent visibles :** un reçu qui ne peut pas être écrit laisse une autorisation
  consommée sans reçu, que `receipt.gap` et `consumedWithoutReceipt` signalent déjà.

La passerelle couvre `oathrion wrap`, les connecteurs (GitHub, Slack, Linear, Stripe) et
le relais d'interception.

**Preuves :**

| Vérification | Résultat |
|---|---|
| `gateway-ledger.test.ts` (5) | un reçu par exécution (réussie, refusée, en exception), autorisation consommée, chaîne vérifiée ; fermé par défaut ; un reçu perdu se voit comme un trou |
| `wrap-stdio-e2e.test.ts` | le test « LIMITE … entries = 0 » a échoué comme prévu, avec 3 reçus. Il est remplacé par la garantie : exactement 3 reçus (lecture, écriture approuvée, effet inconnu), bonnes issues, 0 trou |
| suite complète (SQLite) | 3 190 tests, 0 échec |
| tests PostgreSQL, base jetable | 114/114 |
| `verify:soak` 3 min sur PostgreSQL (clés étrangères appliquées) | **18/18**. 4 834 reçus pour 2 417 cycles : un pour `/api/actions`, un pour le relais. Chaîne vérifiée ; relais p50 24 ms, p99 59 ms |

`docs/limitations.md` est mis à jour. Ce qui reste non détecté : la suppression d'une
exécution qui n'a fait tourner aucun outil (bloquée, ou retenue sans approbation). Et rien ne
recoupe encore automatiquement les reçus avec les exécutions.

Fichiers bruts : `~/.cache/placet-suite/ca21686-ledger/` (`pg.txt`, `soak3.txt`).

### 5.43 `oathrion receipts verify` : la chaîne d'un Oathrion local, vérifiée sans serveur

La commande `oathrion receipts verify [--name <nom>]` relit toute la chaîne de reçus d'un ou de
tous les Oathrion locaux (`~/.oathrion/<nom>/oathrion.db`).
- **Comment :** c'est le paquet local qui vérifie, en lecture seule (`--verify-receipts`), avec
  le même vérificateur que la route de l'API. Il n'avance pas le point de reprise. Il compte
  aussi les autorisations consommées sans reçu.
- **Preuve :** dans le test de bout en bout, après une vraie session `wrap` (une lecture
  exécutée, une écriture retenue), la commande répond « chaîne intacte : 1 reçu(s) ». Un
  `UPDATE` du résumé du reçu, fait directement dans la base, la fait répondre « ROMPUE », avec
  le code 1. Un nom inconnu donne le code 3.

### 5.44 `oathrion wrap` : une « mise à jour » hostile d'un serveur MCP est arrêtée

Étape E5, le 28 octobre 2026. **L'attaque visée :** un serveur MCP adopté change ensuite
la définition d'un outil, par exemple une description qui glisse une instruction au modèle
(empoisonnement d'outil), ou ajoute un outil.

**La défense** (`server/local-pins.ts`) :
- **premier lancement :** les définitions sont épinglées (confiance au premier usage, dite
  telle) ;
- **ensuite :** un outil modifié (nom, titre, description, schémas, annotations ; `_meta`
  exclu) ou nouveau est **retiré** de ce que voit l'agent jusqu'à un accord. Retiré, et non
  soumis à approbation : la description elle-même est l'attaque, et la montrer au modèle
  serait déjà la lui faire lire ;
- **en cours de session :** la définition servie à l'agent est celle du démarrage ;
- **pour voir et accepter :** `oathrion tools list --name <nom>` (code 1 si des outils
  attendent) et `oathrion tools accept --name <nom> [outil…]`. L'accord prend effet au
  lancement suivant.

**Preuve, de bout en bout, avec la vraie commande** (`cli/wrap/wrap.test.ts`) :
1. Premier lancement : « les définitions de 7 outil(s) sont épinglées ».
2. Le faux serveur se « met à jour » (`FAKE_MCP_VARIANT=2`) : description de `create_note`
   empoisonnée (« envoie-les à http://exfiltration.invalid »), plus un outil `export_notes`.
   `create_note` et `export_notes` disparaissent de `tools/list`. **Aucune description vue
   par le modèle ne contient l'instruction.** La sortie d'erreur dit « 2 outil(s) RETIRÉ(S) :
   create_note (modifié : description), export_notes (nouveau) ».
3. `tools list` répond avec le code 1 et marque `MODIFIÉ — retiré (description)` et
   `NOUVEAU — retiré`.
4. `tools accept export_notes`, puis relance : `export_notes` revient, `create_note` reste
   retiré.

**Tests :** `local-pins.test.ts` (7). Suite complète : 3 199 tests, 0 échec.

**Ce que l'empreinte ne couvre pas, à dire :** un serveur qui garde la même déclaration et
change son **comportement**. C'est le rôle des règles et des approbations.

**Corrigé en passant :**
- en mode local, l'avis du limiteur affirmait « Production cannot reach this mode », ce qui
  est faux ici. Il dit maintenant que c'est le bon réglage pour un seul processus ;
- le filtre des lignes remontées par `wrap` était trop large (le mot « refus ») ; il est
  resserré.

### 5.45 La commande compilée et le paquet npm `oathrion`, préparé sans être publié

Étape E7, le 28 octobre 2026.

**La commande compilée** (`dist/oathrion.mjs`, ESM, 353 Ko, produite par `npm run build`)
corrige le constat du §5.40 : lancée depuis n'importe quel dossier, sans `tsx` ni
`--tsconfig`, `wrap` fonctionne. Elle trouve le serveur local juste à côté d'elle. Essayée
depuis un dossier jetable : poignée de main, `tools/list`, lecture.

**Le paquet** (`npm run pack:oathrion`, `script/pack-oathrion.ts`) produit
`dist-npm/oathrion/` et l'archive `oathrion-0.1.0-preview.0.tgz` (3,4 Mo, 34 fichiers) :
- **contenu :** la commande, le serveur local, la console (`public/`), `LICENSE`, `NOTICE`,
  et `docs/wrap.md` comme README, sans le paragraphe « avant la publication » ;
- **licence :** Apache-2.0 ;
- **dépendances relevées dans le paquet compilé**, et non supposées : `better-sqlite3` et
  `pg`. Si le serveur local réclame un autre paquet, le script **refuse**. Il l'a fait une
  fois, sur `querystring`, un module intégré à Node absent de sa liste, ajouté ensuite ;
- **rien n'est publié et aucune connexion n'est ouverte** (`npm pack` en local).

**L'installation, vérifiée sans réseau.** `npm install --offline` de l'archive échoue
(`better-sqlite3` n'est pas dans le cache), et une installation en ligne téléchargerait du
code depuis npm : pas faite. À la place, l'archive est dépaquetée comme une installation,
avec les copies de `better-sqlite3` et `pg` déjà présentes dans le dépôt. Depuis ce paquet,
dans un autre dossier :
- `wrap` démarre ;
- la console répond 200 ;
- la lecture rend la réponse de l'enfant ;
- `receipts verify` répond « chaîne intacte : 1 reçu(s) ».

**Reste à l'utilisateur :**
- vérifier que le nom `oathrion` est libre sur npm et créer le compte ;
- une installation réelle (`npm install -g oathrion` depuis l'archive, en ligne) ;
- puis, **avec son accord au moment de le faire**, `npm publish` depuis `dist-npm/oathrion/`.

### 5.46 L'intégration continue, revue et rejouée en local avant la publication

Le 28 octobre 2026 (tâche C5 du plan de publication). `.github/workflows/ci.yml` existait et
n'a jamais tourné : aucun dépôt GitHub n'existe encore. Il a été relu contre l'état du code,
puis chaque étape a été rejouée en local.

**Corrigé :**
- **Build avant les tests.** Les tests de bout en bout de `oathrion wrap` demandent le
  serveur local compilé. Comme la CI construisait après les tests, ils y étaient sautés.
- **`npm run pack:oathrion` ajouté** : le paquet npm est assemblé, pas publié.
- **Les fichiers de test PostgreSQL ajoutés au job `postgres`**, avec
  `OATHRION_REQUIRE_POSTGRES=true`. Les 83 tests qu'ils contiennent n'avaient jamais tourné
  en CI. Le test de redémarrage reste dehors, parce qu'un conteneur de service ne se
  redémarre pas depuis une étape.
- **Node 22 et 24 au lieu de 20.** Node 20 n'est plus maintenu depuis avril 2026, et
  c'était la seule version testée. Changé : `engines.node >= 22`, le `Dockerfile` en
  `node:22-bookworm-slim`, le paquet npm, et une matrice 22 / 24 sur le job `quality`.

**Rejoué en local**, contre la base jetable, avec les variables de la CI :

| Étape | Résultat |
|---|---|
| typage, lint, build | ✓ |
| `npm test` (après le build) | ✓ 3 199 tests, 0 échec ; les tests de bout en bout de `wrap` tournent |
| `pack:oathrion` | ✓ |
| `smoke` | ✓ 26/26 |
| `e2e` | ✓ 63/63 |
| `chaos` | ✓. Un premier passage a échoué **par ma faute** : `DATABASE_URL` était exporté dans mon shell, et le serveur refuse à juste titre une URL qu'il ne lit pas. Sans elle, comme dans la CI, il passe |
| `migrate:postgres`, `smoke:postgres` (21/21), `e2e:instances` (6/6), `e2e:identity` (12/12), `e2e:currency` (13/13) | ✓ |
| les fichiers de test PostgreSQL | ✓ 114/114 (§5.42) |

**Pas vérifié en local :**
- **Node 24** : seul Node 22 est installé ici. La CI le vérifiera au premier envoi.
- **l'image Docker sur Node 22** : la construire téléchargerait l'image de base. La CI le
  vérifiera aussi.

Fichiers bruts : `~/.cache/placet-suite/c6fd288-ci/`.

### 5.47 L'arbre du dépôt public, préparé et vérifié seul

Tâche C8 du plan de publication, le 28 octobre 2026 : `npm run public:prepare`
(`script/prepare-public.ts`). Rien n'est publié ni envoyé.

**Ce que fait le script :**
- **la source :** seuls les fichiers suivis par git sortent, et la liste de refus de la
  livraison s'applique (`.env`, bases, clés…). Restent privés en plus : `notes/` et les
  rapports internes à la racine (`ARIA-*`, `PHASE-*`, `AUDIT-*`, `RAPPORT-*`) ;
- **les identifiants privés sont retirés :** la liste vit dans `notes/`, jamais publiée,
  complétée à l'exécution par les valeurs non secrètes des fichiers de test (dépôt GitHub de
  test et son propriétaire, canal Slack). **Aucune valeur n'est affichée.** L'arbre
  produit est ensuite relu : une seule occurrence restante, ou une adresse `@gmail.com`, est
  un refus ;
- **les emplacements à remplacer** (adresses de contact et de sécurité, dépôt public) se
  donnent par `--contact`, `--security`, `--repo`. Sans eux, l'arbre est un `--brouillon`,
  déclaré non publiable ;
- **le dépôt :** un dépôt git **neuf**, l'arbre dans l'index, **sans commit**. Le commit unique
  se fait sous le nom public de l'utilisateur, pas celui de ce dépôt de travail ;
- **`--verify`** lance le typage, le lint, le build et les tests sur l'arbre produit, seul.

**Essai en brouillon** (`--brouillon --verify`) :

| Vérification | Résultat |
|---|---|
| fichiers | 759 suivis → **727 publiés**, 32 gardés privés |
| identifiants retirés | 6 recherchés : remplacements dans `client/site/lib/submit.ts`, `docs/FINAL-PILOT-READINESS.md`, `docs/STRESS-TEST-LOG.md` ; **aucun** dans l'arbre relu |
| typage, lint, build | ✓ |
| tests, sur l'arbre public seul | ✓ **3 200 tests, 0 échec** : aucun test ne dépendait des fichiers privés |
| emplacements | encore présents (brouillon) : `SECURITY.md`, `CODE_OF_CONDUCT.md`, `README.md`, `.github/ISSUE_TEMPLATE/config.yml` |

**Signalé pour relecture, sans être retiré :** le nom du titulaire des droits, présent dans
`NOTICE`, les licences, les pages légales du site, l'annexe du pilote et le manuel. C'est
voulu.

**Corrigé :** le prénom du titulaire servait de nom d'exemple dans deux tests de connecteur.
Il est remplacé par un prénom neutre (68/68).

### 5.48 `oathrion wrap` devant trois vrais serveurs MCP : le classement est réglé

Le 28 octobre 2026. `script/probe-wrap.mjs` a été lancé **par l'utilisateur**, dans son
terminal : l'environnement de développement refuse d'exécuter du code téléchargé depuis
npm. La sonde lance `oathrion wrap` devant le serveur et lit ses outils, sans en appeler
aucun.

**Résultat avec le classement d'origine** (lecture = annotation `readOnlyHint` **et** nom de
lecture) :

| Serveur | Lectures | Écritures | Destructions | Ce qui n'allait pas |
|---|---|---|---|---|
| `@modelcontextprotocol/server-filesystem` (secure-filesystem-server 1.0.0) | 9 | 2 | 3 | `directory_tree`, annoté lecture, classé écriture |
| `@modelcontextprotocol/server-memory` (memory-server 1.0.0) | 2 | 4 | 3 | `open_nodes`, annoté lecture, classé écriture |
| `@modelcontextprotocol/server-github` (github-mcp-server 0.6.2) | **0** | **26** | 0 | **aucun outil annoté** : `get_issue`, `list_commits`, `search_code`… toutes les lectures demandaient une approbation |

**Un trou de plus, vu en lisant ces tableaux :** les destructions étaient bloquées par
l'absence de la portée `mcp:destructive`, mais la règle par défaut ne couvrait que les
écritures. Une personne qui accordait la portée les voyait passer **sans approbation**.

**Décidé avec l'utilisateur, et fait :**
- une lecture annotée n'a plus besoin d'un nom en `get`/`list` ;
- **sans annotation, un nom de lecture suffit**. C'est un assouplissement assumé du « doute
  vers l'écriture ». La lecture « sur son seul nom » est annoncée au démarrage ;
- un mot d'écriture dans le nom l'emporte toujours, sur deux listes. Les verbes sans
  ambiguïté (`create`, `update`, `push`, `merge`, `add`…) comptent partout ; les mots ambigus
  (`comment`, `run`, `set`, `request`…) seulement en tête du nom. `get_pull_request_status`
  aurait été classé écriture avec une liste unique ;
- la règle par défaut couvre aussi les destructions. Permises, elles attendent une personne.

**Rejoué sur les listes réelles** : GitHub 14 lectures / 12 écritures, et les 12 écritures sont
toutes de vraies écritures ; filesystem 10 / 1 / 3 ; memory 3 / 3 / 3.

**Confirmé sur le vrai serveur GitHub**, sonde relancée par l'utilisateur après la
reconstruction : « 14 lecture(s) autorisée(s), 12 écriture(s) sur approbation, 0
destruction(s) ». Les 14 lectures sont toutes marquées « nom seul ». Les 12 écritures :
`add_issue_comment`, `create_branch`, `create_issue`, `create_or_update_file`,
`create_pull_request`, `create_pull_request_review`, `create_repository`,
`fork_repository`, `merge_pull_request`, `push_files`, `update_issue`,
`update_pull_request_branch`.

**Tests :**
- 26 cas de classement, dont les vrais noms GitHub (`wrap-stdio-e2e.test.ts`) ;
- une destruction permise est retenue pour approbation, et l'enfant n'est pas appelé
  (`local-bootstrap.test.ts`).

### 5.49 Premier essai réel de bout en bout : Cursor, `oathrion wrap`, le vrai serveur filesystem

Le 28 octobre 2026, lancé par l'utilisateur. `cursor-agent` 2026.10.22-27dcf5f, en mode
interactif, devant `@modelcontextprotocol/server-filesystem` (secure-filesystem-server
1.0.0), téléchargé par `npx`. Dossier de projet jetable préparé par
`script/essai-cursor-wrap.sh`.

**Prouvé :**
- Cursor voit 11 outils, sous leur nom d'origine : les 10 lectures et `create_directory`.
  `write_file`, `edit_file` et `move_file`, que le serveur annote lui-même `destructiveHint`,
  sont absents ;
- `read_text_file` : la lecture passe par Oathrion, le vrai serveur rend le texte exact ;
- `oathrion receipts verify --name fichiers` : chaîne intacte, 1 reçu.

**Pas prouvé :** une écriture approuvée qui a réellement lieu. Pour l'essayer, l'agent doit
recevoir `mcp:destructive`, car `write_file` est une destruction pour ce serveur ; dans la
seconde session, Cursor ne voyait plus du tout le serveur (défaut 1 ci-dessous, sans
certitude).

**Défaut 1, corrigé : des processus survivaient au relais.** Cursor arrête le relais par un
signal, pas en fermant son entrée. Le relais mourait sans arrêter Oathrion local, qui restait
à l'écoute sur `127.0.0.1`, console comprise, avec le serveur enveloppé. Après l'essai :
deux Oathrion locaux et deux serveurs filesystem orphelins, arrêtés par l'utilisateur.
- le relais arrête Oathrion local sur SIGTERM, SIGINT, SIGHUP, et si sa sortie standard
  casse ;
- Oathrion local garde ouverte une entrée standard que le relais lui tient : quand elle se
  ferme, même relais tué net (SIGKILL), il s'arrête ;
- le serveur enveloppé a son propre groupe de processus : un arrêt atteint aussi le
  petit-enfant de `npx` (npm → sh → serveur).

**Défaut 2, corrigé : un Oathrion local tournait à vide, à 84 % d'un cœur, sans fin.**
Son relais était mort pendant son démarrage. Cause, relevée par `strace` : sa sortie n'avait
plus de lecteur ; la première écriture levait EPIPE, en exception non rattrapée ; le
gestionnaire d'arrêt l'écrivait sur la même sortie, qui levait EPIPE de nouveau, et ainsi de
suite. Ces exceptions en chaîne affamaient la boucle d'événements : l'arrêt commencé
n'aboutissait jamais. Désormais une erreur EPIPE de la sortie standard est avalée, et une
faute survenue pendant l'arrêt ne relance rien et ne s'écrit pas.

`cli/wrap/wrap-lifecycle.test.ts` (6) : relais arrêté par SIGTERM, SIGINT, SIGHUP, SIGKILL,
tué pendant le démarrage, ou entrée fermée ; le serveur enveloppé est lancé derrière un
`sh -c`, comme par `npx`. Le test ne suit que les processus qu'il a lancés. Avant la
correction : 5 échecs sur 6, dont l'état `R` du démarrage interrompu ; après : 6 sur 6, et
aucun processus restant.

**Erreur de préparation, corrigée : l'état d'Oathrion était dans le projet ouvert par
Cursor.** Cursor indexe le projet : son journal montre `session.secret`, `invitation.url` et
la base envoyés à son index distant. Le risque est faible pour cette instance jetable, qui
n'écoute que sur la boucle locale, mais c'était évitable. Le script place désormais l'état
hors du projet, dans `<dossier>.etat`.

**Limite confirmée, à dire partout : Oathrion ne gouverne que ce qui passe par lui.**
- L'agent Cursor a lancé `ls` et `find` malgré `"deny": ["Shell(*)"]` dans `.cursor/cli.json`,
  et il a lu le journal d'Oathrion avec ses propres outils de lecture. Les outils propres du
  client échappent entièrement à Oathrion.
- Un agent qui peut lire `~/.oathrion/<nom>/` y lit `session.secret`, et peut donc se
  fabriquer une session de console et approuver ses propres actions. `wrap` protège contre
  un agent qui n'a accès qu'au serveur MCP ; pas contre un agent qui a aussi le shell ou le
  système de fichiers de la personne. Écrit dans `docs/wrap.md`.

**Expérience d'usage :** un outil retiré (destruction non permise) est simplement absent.
L'agent n'en sait pas la raison, et il en a inventé une (« pas branché côté Oathrion »). Le
message de démarrage qui le dit part dans le journal du client, que personne ne lit. Pas
encore traité.

### 5.50 L'écriture approuvée, devant le vrai serveur : prouvée, et trois défauts corrigés

Le 28 octobre 2026, lancé par l'utilisateur, à la suite du §5.49. `cursor-agent`
2026.10.22-27dcf5f en mode interactif, `@modelcontextprotocol/server-filesystem`, état
d'Oathrion hors du projet (`script/essai-cursor-wrap.sh`, corrigé au §5.49).

**Prouvé : le chemin complet d'une écriture, en vrai.** La permission `mcp:destructive`
accordée dans la console, Cursor voit `write_file`. Chaque appel est retenu, sans
atteindre le serveur. Approuvé dans la console, Oathrion exécute l'écriture sur le vrai
serveur : `essai.txt` contient « bonjour ». `oathrion receipts verify` : chaîne intacte,
3 reçus. Après la fermeture de Cursor, aucun processus ne reste (correction du §5.49
confirmée).

**Défaut 1, corrigé : la console ne pouvait plus enregistrer les permissions d'aucun agent.**
L'éditeur envoie le catalogue entier ; l'ajout des trois portées `mcp:*` l'avait porté à
25 entrées, au-delà d'une borne écrite à la main (24). Réponse : « Invalid patch », sans
raison. La borne est désormais le nombre de portées connues (`MAX_PERMISSIONS`), et le
refus dit sa raison. Test : le catalogue entier, tel que la console l'envoie, est accepté
(`agent-permissions.test.ts`).

**Défaut 2, corrigé : le relais attendait plus longtemps que Cursor.** Cursor abandonne un
appel au bout d'environ 60 s (« MCP error -32001: Request timed out ») ; le relais
attendait l'approbation jusqu'à 120 s. Les trois appels sont partis à une minute
d'intervalle. L'attente par défaut est désormais de 50 s.

**Défaut 3, corrigé : l'action a été exécutée deux fois.** À chaque abandon, l'agent a
réessayé le même appel, et chaque essai créait une nouvelle demande : trois demandes pour
une seule écriture. L'utilisateur en a approuvé deux, et l'écriture a eu lieu deux fois.
Sans dommage ici (même fichier, même contenu) ; avec `create_issue`, deux tickets.
Désormais, un appel identique à un appel encore retenu (même outil, mêmes arguments, clés
triées) ne crée pas de demande : le relais attend la première, et rend son issue une fois
décidée — la réponse du serveur, ou le refus. Le message « retenu » le dit à l'agent.
Limite : cette mémoire est celle du relais, pour une session ; un client relancé entre-temps
créerait une nouvelle demande. `wrap-approval.test.ts` (4 de plus) : deux rejeux pendant
l'attente, une seule demande ; approuvée, le rejeu reçoit la réponse, l'enfant n'est appelé
qu'une fois ; arguments différents, deux demandes ; refusée hors de la vue du client, le
rejeu reçoit le refus.

**Constaté, pas encore corrigé (expérience du mode local) :**
- la console n'existe que pendant que le client tourne : fermer Cursor la ferme *(corrigé au
  §5.51 : `oathrion console`)* ;
- l'adresse racine montre le site vitrine (« Become a Pilot »), pas la console *(corrigé, §5.52)* ;
- la console s'ouvre sur « Démarrage », qui propose de brancher GitHub ou Slack *(corrigé, §5.52)* ;
- la page d'invitation dit « il a déjà servi » pour un lien simplement tronqué au
  copier-coller *(corrigé, §5.52)* ;
- des textes de la console encore en anglais (« Cancel », les portées des connecteurs) *(corrigé, §5.52)* ;
- l'agent Cursor a de nouveau lancé des commandes shell (`ls`, `cat`) pour vérifier le
  dossier, hors d'Oathrion.

### 5.51 `oathrion console` : la console sans le client, et une approbation qui ne se perd plus

Suite du §5.50, où la console disparaissait avec Cursor.

**Livré :** `oathrion console [--name <nom>]`. Elle relance le même Oathrion local (même
base, même port) et le serveur enveloppé, avec la commande du dernier `oathrion wrap`
(désormais gardée dans `commande.json`, 0600) et l'environnement du terminal : une action
approuvée s'y exécute vraiment. Un `wrap` lancé pendant qu'elle est ouverte est refusé, et
le message dit de la fermer. Si le client tourne déjà, elle donne l'adresse de la console
ouverte. `cli/wrap/wrap-console.test.ts` (3) : la vraie commande compilée ; rien à ouvrir ;
console servie au même port avec le serveur enveloppé relancé, `wrap` concurrent refusé,
Ctrl+C sans processus restant ; adresse rendue quand le client tourne.

**Trouvé en le construisant, corrigé :** approuver une action dont l'outil n'est pas
joignable la consommait pour rien — l'exécution passait « sautée », définitivement, et la
personne croyait l'avoir relâchée. Désormais l'approbation est refusée (409, avec la raison)
et la demande reste en attente, tant qu'aucun outil ne peut l'exécuter ou que le serveur
enveloppé est arrêté (`Tool.reachable`). Refuser reste toujours possible.
`wrap-approval.test.ts` : le serveur enveloppé arrêté, l'approbation répond 409, la demande
reste en attente, l'exécution n'est pas « sautée ».

### 5.52 Le mode local, débarrassé de ce qui appartient au produit d'équipe

Les quatre défauts de confort relevés au §5.50, corrigés :
- **la racine** mène à la console en mode local (302 vers `/console`) : plus de site vitrine
  sur la machine de la personne. Vérifié par `wrap-console.test.ts`, sur la vraie commande ;
- **l'arrivée dans la console** : « Approbations » en mode local, le parcours d'équipe
  ailleurs. `GET /api/auth/session` dit `localMode` (faux hors d'`oathrion wrap`, vérifié
  par `hardening.test.ts`) ; après une invitation, la console part de `#/` et c'est cette
  règle qui choisit ;
- **la page d'invitation** reconnaît un lien coupé à la forme de sa clé (`idt_` + 24
  hexadécimaux, un point, 43 caractères) et dit « Ce lien est incomplet », où trouver le lien
  entier (`invitation.url`), au lieu de « il a déjà servi » ;
- **les permissions** s'affichent en français, traduites par portée à l'affichage
  (`client/src/lib/permission-labels.ts`) ; un test exige une traduction pour chaque portée
  connue. « Cancel » devient « Annuler ».

Non vérifié à l'œil dans un navigateur : l'arrivée sur « Approbations » et la page « lien
incomplet ». À regarder au prochain essai.

### 5.53 Le « graal » de l'expérience, première marche : approuver dans le client, console sans mot de passe

Le 28 octobre 2026, l'utilisateur fait de l'expérience d'approbation la priorité absolue.
Mesure retenue : les gestes et les secondes entre « l'agent demande » et « c'est approuvé ».
À l'essai du §5.50 : une dizaine de gestes, plusieurs minutes.

**Observé avant de construire.** Une sonde MCP (un serveur qui note ce que le client déclare)
devant `cursor-agent` 2026.10.22, en `mcp list-tools` (aucun appel de modèle) : Cursor
annonce `"elicitation": {"form": {}}` et la révision `2025-11-25` du protocole. Il SAIT donc
poser une question à la personne. Ce qui n'est PAS observé : qu'il la montre vraiment à une
personne, en particulier en mode sans interface (`-p`), où personne ne peut cliquer.

**Livré : l'approbation dans le client, sur option** (`oathrion wrap --approbation client`).
Le relais retient l'appel, puis envoie au client `elicitation/create` : l'outil, le serveur,
les arguments en clair (bornés : 300 caractères par argument, 12 arguments), et une note
facultative pour le journal. Accepter ou refuser est enregistré par une clé d'approbation de
l'espace local, créée seulement avec cette option (« Vous, depuis votre client MCP »), puis
l'agent reçoit l'issue : la réponse du serveur, ou le refus. Question fermée, délai, client
qui ne sait pas la poser : la console prend le relais. **Par défaut : la console**, tant
qu'on n'a pas vu le comportement réel du client — une réponse d'elicitation vient de
l'interface du client, et un client qui accepterait seul ferait de l'approbation un tampon.
Tests (`wrap-approval.test.ts`, 6 de plus) : acceptée, l'enfant appelé une fois ; refusée,
rien d'appelé ; fermée, la console décide ; client sans la capacité, ou option absente,
aucune question ; la question elle-même (clarté, bornes). `local-bootstrap.test.ts` : la clé
d'approbation n'existe que sur demande, et la suivante révoque l'ancienne.

**Livré : la console locale sans mot de passe.** En local, la personne est administratrice
d'emblée : ni invitation, ni mot de passe à choisir (le compte oublié du §5.50). Son mot de
passe est aléatoire et inconnu ; elle entre par le lien d'`oathrion console`, qui ouvre le
navigateur déjà connecté. Le lien porte un ticket signé avec le secret de session de
l'Oathrion local, valable deux minutes, à usage unique (`shared/local-login-ticket.ts`,
`POST /api/local/login`, 404 hors du mode local). Il n'ajoute aucun secret sur le disque :
qui lit `session.secret` pouvait déjà fabriquer une session. Tests : le ticket (échu, autre
secret, retouché, mal formé) ; sur la vraie commande, le lien ouvre une session
administratrice une fois, pas deux, et un ticket retouché est refusé ; hors mode local, 404.

**Reste à observer, par l'utilisateur :** dans Cursor interactif, la question s'affiche-t-elle,
et qui y répond ? En mode `-p`, est-elle refusée, acceptée seule, ou ignorée ?
`script/essai-cursor-wrap.sh` prépare désormais l'essai avec `--approbation client`.

**Vu à l'œil, dans un navigateur, sur une instance jetable :** le lien d'`oathrion console`
ouvre la console connectée (sous le nom de session de la machine), directement sur
« Approbations », et le ticket disparaît de l'adresse. Deux défauts trouvés ainsi, corrigés :
- un lien ouvert dans un onglet déjà chargé ne change que le fragment : il tombait sur « Page
  introuvable ». La console recharge désormais la page quand un ticket arrive ;
- un lien déjà servi répondait 401, et la console, lisant « votre session est morte », se
  déconnectait : un lien périmé fermait une session valide. La route répond 403, et la
  console reprend la session existante.

**Trouvé en préparant ce regard, corrigé : le serveur enveloppé démarrait dans le dossier
d'état d'Oathrion**, pas là où `wrap` avait été lancé. Tout chemin relatif cassait
(`oathrion wrap -- node ./outils/serveur.js`, l'exemple même de la documentation) ; les essais
précédents passaient par `npx` ou des chemins absolus. Le dossier de lancement est transmis
au serveur local et gardé dans `commande.json` pour `oathrion console`. Test : un serveur
donné par un chemin relatif est trouvé, ses outils listés (`wrap-console.test.ts`).

### 5.54 Une course entre le client et `oathrion console`, trouvée dans l'essai réel

Le 28 octobre 2026, troisième essai de l'utilisateur, avec `--approbation client`. Cursor ne
voyait pas le serveur « fichiers », en mode interactif comme en mode `-p`. La question dans
le client n'a donc pas encore pu être observée.

**Cause, lue dans le journal :** Cursor avait lancé `wrap`, dont le serveur local attendait
encore `npx` (téléchargement du serveur filesystem) ; `oathrion console`, lancée pendant ce
temps dans un second terminal, a trouvé le port muet, a conclu que le client était fermé, et
a démarré SON serveur sur le même port. Le relais de Cursor, voyant le port répondre, l'a pris
pour le sien et lui a présenté sa clé, inconnue de ce serveur : `POST /api/mcp 401` sur chaque
appel. Puis son propre serveur, trouvant le port pris, s'est arrêté. Un geste naturel —
ouvrir la console pendant que le client démarre — cassait tout.

**Corrigé :**
- un verrou par serveur (`lancement.pid`, créé en exclusivité, PID du lanceur ; un PID mort
  est un verrou abandonné, repris) : un seul `wrap` ou `oathrion console` à la fois, et le
  second dit qui tient le serveur ;
- `oathrion console` qui trouve le verrou tenu attend que le client soit prêt (jusqu'à
  deux minutes), puis donne son lien, au lieu de démarrer un second serveur ;
- le lanceur ne se croit prêt que quand SON serveur annonce qu'il écoute sur le port, et
  plus quand le port répond.

Test (`wrap-console.test.ts`) : un serveur lent à démarrer, comme `npx` ; la console lancée
pendant ce temps attend, ne démarre rien, donne le lien ; le client fait sa poignée de main
et liste ses outils ; un second `wrap` est refusé ; le verrou est rendu avec le serveur.

### 5.55 Le client a la priorité sur la console de repli

Même essai, quatrième passage. La console, lancée pendant que Cursor démarrait, l'a bien
attendu (« j'attends qu'il soit prêt », §5.54). Mais le premier `cursor-agent` a été fermé
pendant l'attente : son `wrap` s'est arrêté, la console a conclu à raison que le client était
fermé, et a démarré son serveur. Au `cursor-agent` suivant, son `wrap` a trouvé le serveur
tenu par la console, et a été refusé : de nouveau, aucun serveur « fichiers » dans Cursor.

**Corrigé : le client a la priorité.** La console n'est qu'un repli, quand le client est
fermé. Le verrou porte désormais la nature du lanceur (`wrap` ou `console`) ; un `wrap` qui
trouve une console en place lui envoie SIGTERM, attend qu'elle ait rendu le verrou (son
serveur et le serveur enveloppé arrêtés), puis démarre. La console l'écrit dans son
terminal : « Console fermée (Ctrl+C, ou votre client a repris « … ») ». Deux `wrap` pour le
même serveur restent refusés.

Test (`wrap-console.test.ts`) : un client fermé, la console de repli ouverte ; un client
relancé ; la console se ferme, sa descendance s'arrête, le client fait sa poignée de main et
liste ses outils.

**Également vu dans cet essai :** l'agent Cursor, ne trouvant pas le serveur, a lu de lui-même
`~/essai-oathrion-3.etat/fichiers/session.secret` et le journal d'Oathrion, hors du projet, par
ses propres outils de fichiers. C'est la limite écrite dans `docs/wrap.md` (un agent qui peut
lire vos fichiers peut s'approuver lui-même), observée en vrai : placer l'état hors du projet
ne suffit pas contre un agent qui a le système de fichiers.

### 5.56 Ce que le cinquième passage a prouvé, et où il s'est arrêté

- **Prouvé en vrai :** `oathrion console`, Cursor fermé, a démarré son serveur et ouvert la
  console connectée ; la permission `mcp:destructive` y a été accordée ; puis
  `cursor-agent mcp list-tools fichiers` a REPRIS le serveur à la console sans geste de la
  personne, et liste 14 outils, `write_file` compris.
- **Vu en route :** une coupure réseau a fait échouer trois lancements — `npx -y` interroge le
  registre npm à chaque lancement et reste bloqué sans réseau ; le serveur enveloppé n'a pas
  répondu à `initialize` en 60 s. Le message d'échec disait « l'action a PEUT-ÊTRE eu lieu »,
  ce qui est faux pour une initialisation. Aucun processus ni verrou n'est resté.
- **Arrêté :** le quota gratuit de Cursor de l'utilisateur est épuisé jusqu'au 7 novembre
  2026. La question posée DANS Cursor (`--approbation client`) n'a donc toujours pas été
  observée, ni en mode interactif ni en mode `-p`. L'option reste désactivée par défaut.

### 5.57 Les trois ruptures du parcours d'une nouvelle personne

Décrites le 28 octobre 2026 en écrivant le parcours de découverte, puis traitées.

**1. Le paquet npm, prêt à publier — et une fuite évitée.** Le nom `oathrion` est libre sur
npm (404 au 28 octobre). La vérification du contenu, juste avant de le confier, a trouvé dans
le paquet le code du SITE VITRINE, avec deux identifiants privés de
`notes/identifiants-prives.txt` et une adresse @gmail.com. Publié tel quel, le paquet les
aurait rendus publics. Corrigé dans `script/pack-oathrion.ts` : le paquet ne garde que ce que
la console charge, en suivant ses imports depuis `index.html` (16 fichiers, 960 ko au lieu de
3,4 Mo), et l'empaquetage REFUSE désormais tout paquet qui contient un identifiant privé ou
une adresse @gmail.com. Le paquet a été essayé tel qu'il sera publié : la commande lance
Oathrion local, la racine mène à la console, chaque fichier de la console répond 200, et
`npm publish --dry-run --access public --tag latest` l'accepte. **Rien n'est publié** : la
publication demande le compte npm de l'utilisateur.

**2. Le lien « approuvez ici » menait à un mot de passe que personne ne connaît.** Le message
« retenu » que reçoit l'agent porte le lien de la console ; ouvert sans session, il menait à
un formulaire de connexion, alors qu'en local la personne n'a jamais choisi de mot de passe.
Le lien ne peut pas porter de ticket de connexion, ni nommer `oathrion console` : il passe par
l'agent, qui pourrait s'en servir pour s'approuver lui-même. C'est donc la page, vue par la
personne, qui le dit : `GET /api/local/login` (public, 404 hors du mode local) lui apprend
qu'elle est locale et le nom du serveur, et elle affiche « Oathrion tourne sur votre
machine… `oathrion console --name <nom>` ». Vu à l'œil dans un navigateur.

**3. Les outils cachés.** Un outil retenu faute de permission (`write_file`, déclaré
destructeur par le serveur de fichiers) disparaissait sans un mot.
- **Pour l'agent :** `tools/list` porte désormais, dans `_meta`, le nom et la classe des outils
  enveloppés retenus (jamais leur description ni leur schéma : un outil retenu n'est pas
  présenté au modèle). Le relais ajoute un outil d'information, `oathrion_withheld_tools`, en
  lecture seule, dont la description les nomme et dit pourquoi ; un modèle qui cherche
  `write_file` la trouve. L'appeler, ou appeler un outil retenu, rend l'explication — « ne
  contournez pas, dites à la personne quel outil il vous faut » — et rien n'atteint le serveur.
  La permission accordée, l'outil est listé et l'outil d'information disparaît.
- **Pour la personne :** `GET /api/withheld-tools`, et un bandeau en tête des Approbations (la
  page d'arrivée locale) et sur la fiche de l'agent : « 1 outil de « fichiers » est caché à
  Agent fichiers : write_file … Les autoriser ». Un clic accorde la portée ; chaque appel
  attend toujours l'accord de la personne (règle par défaut). Vu à l'œil et essayé.

Tests : `wrap-approval.test.ts` (5 de plus), `hardening.test.ts`, `wrap-console.test.ts`.

**Au passage :** le message d'un serveur MCP muet disait « l'action a PEUT-ÊTRE eu lieu » même
pour `initialize`, qui n'agit pas (§5.56). Il le dit désormais seulement pour un appel d'outil.

### 5.58 `oathrion@0.1.0-preview.0` publié sur npm

Le 28 octobre 2026, par l'utilisateur, avec son compte. Deux obstacles en route, levés par lui :
la connexion par code à usage unique dans le terminal a échoué (code refusé) ; la connexion
par le navigateur (`npm login --auth-type=web`) a réussi. Puis npm a refusé de publier
(403) : la double authentification n'était pas activée sur le compte. Activée (clé de
sécurité), la publication a confirmé dans le navigateur. Vérifié ensuite sans rien exécuter :
`npm view` donne la version, l'étiquette `latest`, la licence, la commande ; le paquet
retéléchargé a la même empreinte SHA-1 que l'archive contrôlée avant publication.

README, `docs/wrap.md` et CHANGELOG disent désormais `npx -y oathrion wrap -- …`. L'annonce
publique reste prévue le 17 novembre ; le paquet, lui, est trouvable dès maintenant.

### 5.59 Vers le graal, étape 1 : les écarts mesurés, fermés

Mesuré par `script/mesure-fluidite.mjs` (la vraie commande, le faux serveur du dépôt), avant
et après, le 28 octobre 2026.

| | Avant | Après |
|---|---|---|
| Approuvée dans la console → l'agent a la réponse | 1 030 ms | **36 ms** (dont 33 ms d'approbation) |
| Surcoût d'Oathrion sur une lecture (médiane) | 22 ms | 15 ms |
| Débloquer un outil caché | 2 gestes (autoriser, relancer le client) | 1 geste, si le client tient compte de l'annonce |
| Brancher un client | éditer son JSON à la main | `npx -y oathrion install cursor`, une question |

**Livré :**
- **l'issue attendue côté serveur** : `GET /api/approvals/:id/issue?attendre=<ms>` rend dès que
  l'approbation est tranchée et l'exécution finie ; la passerelle réveille ceux qui attendent
  (`server/approval-events.ts`), et l'attente relit l'état chaque seconde pour rester juste avec
  plusieurs instances. Le relais s'en sert au lieu de relire chaque seconde. Tests : approuvée
  pendant l'attente, l'issue revient en moins de 500 ms ; sans décision, la route rend la main
  à l'échéance ;
- **la liste d'outils annoncée** : le relais déclare `tools.listChanged`, relit la liste toutes
  les 5 s en local et envoie `notifications/tools/list_changed` quand elle change (une
  permission accordée dans la console). Que Cursor en tienne compte n'est PAS vérifié ;
- **des instructions MCP** pour le modèle : écritures sur approbation, ne pas contourner,
  réessayer à l'identique attend la même approbation, outils retenus nommés par
  `oathrion_withheld_tools`. Transmises au modèle par les clients qui le font — non vérifié
  pour Cursor ;
- **`oathrion install cursor|claude-code`** : montre chaque changement, demande (refuse hors d'un
  terminal sans `--oui`), garde une copie, laisse les serveurs distants, prévient si le même
  serveur reste déclaré ailleurs sans Oathrion ; `--annuler` défait. Essayé sur la commande
  compilée, dans un dossier jetable. Tests : `cli/wrap/install.test.ts` (6).

Ces nouveautés demandent une nouvelle version npm (`0.1.0-preview.1`) pour arriver chez les
utilisateurs : rien n'est publié.

### 5.60 Un seul Oathrion par machine, un agent par client

Le 28 octobre 2026, décidé avec l'utilisateur après la description du parcours d'ajout d'un
agent (`notes/CONCEPTION-OATHRION-LOCAL-UNIQUE.md`). Avant : un Oathrion par serveur — l'agent
portait le nom du serveur (« Agent github »), trois serveurs faisaient trois consoles, et un
second client sur le même serveur était refusé.

**Livré :**
- **le pivot local** (`server/local-hub.ts`, `~/.oathrion/_local/`) : lancé détaché par le
  premier relais ou la première console ; les serveurs s'y inscrivent à la demande
  (`POST /api/local/hub`, ticket signé à usage unique, 404 hors du pivot) ; deux clients
  partagent un serveur (même nom, même commande) ; un nom pris par une autre commande est
  refusé ; un serveur que plus personne ne porte est arrêté ; sans porteur, le pivot s'arrête ;
- **un agent par client** : à `initialize`, le relais présente le nom du client ; l'agent
  (`agt_local_<client>`) est créé à la première connexion, et chaque relais reçoit sa propre
  clé, révoquée quand il part (les clés rendues s'appellent `…Token`, que le journal masque) ;
- **la console** : une seule, `oathrion console` ; client ouvert, un lien et la main rendue ;
  client fermé, elle relance les serveurs connus et reste jusqu'à Ctrl+C ; un client qui arrive
  partage le pivot — plus de verrou ni de « reprise » ;
- **la console en local** ne propose plus le parcours d'équipe : la page Agents dit qu'un agent
  est un client, et comment en brancher un (`npx -y oathrion install claude-code`) ;
- `oathrion tools` et `oathrion receipts verify` lisent le pivot ; les anciens dossiers par
  serveur restent tels quels et toujours vérifiés (rien n'est migré ni effacé).

**Trouvés en le construisant, corrigés :**
- un relais qui attendait le lancement d'un serveur lent (un `npx`) ne battait pas encore :
  le pivot le croyait muet et le détachait, puis lui refusait une clé. Un porteur dont le
  serveur se lance n'expire plus, et le relais bat dès son rattachement ;
- un client rattaché à l'instant où le pivot décidait de s'arrêter tombait sur un pivot
  mourant : le pivot qui s'arrête refuse désormais tout rattachement (503) et ne se dit plus
  pivot, et le client en relance un neuf ;
- la console s'arrêtait d'elle-même : ses battements ne retenaient pas le processus.

**Mesuré** (`script/mesure-fluidite.mjs`) : relance du client 818 → 242 ms (le pivot tourne
déjà) ; surcoût d'une lecture 12 ms ; approbation dans le client 49 ms ; console 260 ms.

**Tests :** `server/test/local-hub.test.ts` (9), `cli/wrap/wrap-lifecycle.test.ts` (7, dont
deux clients qui démarrent ensemble : un seul pivot), `cli/wrap/wrap-console.test.ts` (6),
`cli/wrap/wrap.test.ts` repris.

**Un choix dit :** les portées sont par client, plus par serveur — « Détruire » accordé à
Cursor vaut pour tous ses serveurs ; chaque destruction attend toujours une approbation.

### 5.61 Prévenir l'approbateur

Le 28 octobre 2026. La comparaison publique avec les passerelles concurrentes (Permit,
TrueFoundry) avait un écart net : elles préviennent l'approbateur (Slack, e-mail), Oathrion
non — une demande pouvait attendre sans que personne ne la voie. L'utilisateur a choisi : le
bureau par défaut, et Slack en option.

**Livré :**
- **le canal de bureau** (`server/notifications/desktop.ts`) : « Cursor veut utiliser
  « write_file » », serveur nommé ; sous Linux un bouton **Décider** (`notify-send --action`)
  qui ouvre la console DÉJÀ CONNECTÉE par un lien que le pivot fabrique avec son secret —
  jamais un lien qui passerait par l'agent ; repli sans bouton pour un `notify-send` ancien ;
  macOS (`osascript`) et Windows (bulle PowerShell) disent quoi lancer. Il ne bloque jamais ;
  un système sans outil de notification n'est pas une erreur ;
- **Slack « prévenir seulement »** : l'option `buttons: false` du canal Slack existant (mêmes
  protections contre les adresses privées) ; le message dit où décider, puisque Slack ne peut
  pas rappeler 127.0.0.1 ;
- **`oathrion notifications`** (état, `slack <url>`, `slack --retirer`, `bureau oui|non`,
  `tester`) ; le réglage (`_local/notifications.json`, 0600) est relu à chaque envoi ;
  l'adresse du webhook n'est jamais affichée en entier ;
- le pivot reçoit la session graphique (`DISPLAY`, `DBUS_SESSION_BUS_ADDRESS`…) sans laquelle
  aucune notification ne s'affiche ; les tests et le banc la coupent
  (`OATHRION_LOCAL_NOTIFY_DESKTOP=0`).

**Tests :** `server/test/local-notifications.test.ts` (8 : le texte, le bouton, le repli,
macOS, l'absence d'outil, Slack sans puis avec boutons contre un faux Slack local, le réglage
relu), `cli/wrap/notifications.test.ts` (3), et de bout en bout `cli/wrap/wrap-notify.test.ts` :
une écriture retenue → un faux `notify-send` reçoit « Cursor veut utiliser « create_note » » et
« clique » sur Décider → un faux `xdg-open` reçoit un lien de connexion, qui connecte vraiment.

**Non vérifié :** une vraie notification sur un vrai bureau (ici, des faux outils), macOS et
Windows.

### 5.62 Claude Code : ce qu'il annonce, et la séquence rejouée devant `oathrion wrap`

**Sonde** (le 28 octobre 2026, sur la machine de l'utilisateur, Claude Code 2.1.312) : un faux
serveur MCP qui note ce que le client envoie, déclaré par `claude mcp add`. `claude mcp list`
suffit à le faire parler. Claude Code envoie, dans cet ordre :

1. `server/discover` (la révision MCP 2026-07-28, sans poignée de main), avant tout ;
2. `initialize` en `2025-11-25`, avec `capabilities.elicitation` = `{ form, url }` et
   `clientInfo` = `{ name: "claude-code", title: "Claude Code" }` ;
3. `notifications/initialized`, puis `tools/list`.

**Conclusion** : Claude Code sait poser une question pendant un appel, donc l'approbation
dans le client (`--approbation client`) lui est ouverte.

**Rejeu** de cette séquence exacte devant la vraie commande compilée et le faux serveur du
dépôt. L'écriture est approuvée dans le client et l'agent reçoit la réponse du serveur
(« note 1 créée »). Deux défauts sont apparus, et sont corrigés :

- **un agent de trop, « Client MCP ».** Arrivé avant `initialize`, `server/discover`
  recevait une clé sous le nom générique. Le relais y répond maintenant lui-même
  « méthode inconnue » (`-32601`) : rien n'est transmis et aucune clé n'est créée. Le client
  se rabat sur `initialize`, ce que Claude Code fait déjà ;
- **le nom affiché était `claude-code`.** Le relais prend maintenant le titre lisible quand le
  client en donne un : « Claude Code veut utiliser… ».

La version négociée est `2025-06-18`, que Claude Code accepte. Le test est
`cli/wrap/wrap-claude-code.test.ts`.

**Pas encore vu** : l'approbation affichée dans une vraie session interactive de Claude Code,
devant une personne.

### 5.63 `npx oathrion` : une commande, une réponse

**Le constat** (l'utilisateur, le 28 octobre, après l'essai de Claude Code) : mettre Oathrion
devant ses outils est long. Il faut une commande par serveur et par client, connaître les
options (`--name`, `--approbation`, le `--` imbriqué) et la commande exacte de chaque
serveur. Et `oathrion install claude-code` ne lisait que `.mcp.json`, alors que `claude mcp
add`, la façon courante, écrit dans `~/.claude.json` : ces serveurs-là n'étaient pas vus.

**Ce qui est fait** : `npx oathrion`, sans option (`cli/wrap/setup.ts`).

- **Il cherche partout.** Côté Cursor : `~/.cursor/mcp.json` et `.cursor/mcp.json`. Côté
  Claude Code : `.mcp.json`, puis dans `~/.claude.json` la portée `user` et la portée
  `local` de **chaque** projet. Un projet dont le dossier n'existe plus est signalé et
  laissé tel quel.
- **Il montre la liste et pose une seule question** (Entrée vaut oui).
- **Il ne touche `~/.claude.json` que par les commandes de Claude Code**
  (`claude mcp remove` puis `claude mcp add-json`). Si l'ajout échoue, l'original est remis.
  Une copie du fichier est gardée d'abord, en `0600`.
- **Il écrit les autres fichiers directement**, après en avoir gardé une copie en `0600`.
- **Le client lancera la même version d'Oathrion** : `npx -y oathrion@<version exacte>`,
  ou le chemin du fichier s'il est installé ou construit.
- **`npx oathrion --annuler` remet tout comme avant.**

**Prouvé** :

- `cli/wrap/setup.test.ts` (7 tests), sur une fausse machine avec un faux `claude` qui
  applique les commandes comme le vrai : recherche, protection, seconde passe sans effet,
  annulation exacte, refus sans effet, échec d'ajout remis, machine vide ;
- `cli/wrap/setup-e2e.test.ts` : la vraie commande compilée écrit la configuration de
  Cursor, puis le serveur est lancé tel qu'écrit. Il liste ses outils derrière Oathrion et
  retient une écriture.

**Mesuré** (`script/mesure-fluidite.mjs`, section « Installation ») :

- la configuration est écrite en **93 ms** ;
- le serveur liste ses outils derrière Oathrion **0,85 s** après le début.

| | Avant | Maintenant |
|---|---|---|
| Commandes | 1 par serveur et par client | **1** |
| Options à connaître | `--name`, `--approbation`, `--` | **aucune** |
| Réponses | 1 par client | **1** |
| Serveurs de `claude mcp add` | non vus | **vus, tous les projets** |

**Pas encore vu** : le passage par le vrai `claude mcp add-json` sur la machine de
l'utilisateur. Le faux `claude` en reproduit l'effet ; le vrai est le prochain essai.

### 5.64 Approuver dans le client, par défaut

**Décision de l'utilisateur** (28 octobre, au soir) : passer au chantier 2 sans attendre
l'essai interactif dans Claude Code. Cet essai est bloqué par le crédit de son compte API.

**Ce qui change** :

- **La question dans le client devient le défaut** de `wrap`, d'`install` et de
  `npx oathrion`, dès que le client annonce `elicitation` (`form`) à `initialize`. La clé
  d'approbation n'est alors demandée au pivot que pour ce client.
- **`--approbation console`** garde les décisions dans la console. `client` reste accepté
  et ne change rien, puisque c'est le défaut.
- **Une case obligatoire, « Oui, j'autorise cette action ».** C'est le garde-fou de ce
  défaut : un client qui accepterait seul (mode sans interface) renverrait *accept* sans
  la case. Le relais n'y voit pas une décision, et la demande reste à la console.
- **La notification attend.** Le pivot sait quels agents posent la question dans leur
  client. Pour ceux-là, la notification de bureau et Slack attendent 20 s
  (`OATHRION_LOCAL_NOTIFY_GRACE_MS`), puis ne partent que si la demande est toujours en
  attente : une seule question, pas deux.

**Prouvé** :

- `server/test/wrap-approval.test.ts` : le schéma exige la case ; accepter sans elle n'est
  pas une décision, la demande reste à la console ;
- `cli/wrap/wrap-claude-code.test.ts` : avec la séquence de Claude Code, la question est
  posée sans aucune option ;
- `server/test/local-notifications.test.ts` : décidée pendant le délai, aucune
  notification ; toujours en attente, la notification part ; client sans question, elle part
  aussitôt ;
- `cli/wrap/wrap-notify.test.ts` : sur le vrai pivot, avec un faux `notify-send`, une
  question tranchée dans le client ne notifie pas ; une question ignorée notifie après le
  délai.

**Mesuré** : appel → question → case cochée et acceptée → réponse du serveur, **95 ms**
(banc, machine chargée par la suite de tests).

**Pas encore vu** : la question affichée par Claude Code devant une personne, et la façon
dont il rend une case à cocher obligatoire.

### 5.65 Une seule question par action dans Claude Code

**Le défaut.** Claude Code demande sa propre permission avant chaque outil MCP. Derrière
Oathrion, une écriture était donc demandée deux fois : par Claude Code, puis par Oathrion.
Une lecture, qu'Oathrion laisse passer, était quand même demandée une fois.

**Ce qui est fait.** `npx oathrion` pose, pour chaque serveur protégé, la règle
`mcp__<serveur>` dans les réglages de Claude Code :

- `~/.claude/settings.json` pour la portée `user` ;
- `<projet>/.claude/settings.local.json` pour la portée `local` et pour `.mcp.json`. C'est
  le fichier personnel du projet, jamais partagé.

La règle est montrée dans la liste et appliquée avec la même réponse.

**Garde-fous** :

- **jamais de règle pour un serveur dont la protection a échoué.** La règle n'est posée
  qu'après le changement, et seulement s'il a réussi ;
- **le reste du fichier est gardé**, et le fichier est copié d'abord (`0600`) ;
- **`--annuler` retire les règles posées** ;
- **`--garder-questions-claude`** laisse Claude Code demander aussi.

**Prouvé** : `cli/wrap/setup.test.ts`, 10 tests, dont trois nouveaux :

- règles posées dans les deux fichiers, autres réglages gardés, retirées par `--annuler` ;
- un serveur déjà protégé reçoit la règle seule ;
- aucune règle après un échec de protection.

**Pas encore vu** : Claude Code 2.1.312 qui honore `mcp__<serveur>` devant une personne. La
règle est la forme documentée par Anthropic pour « tous les outils d'un serveur ».

### 5.66 La console qui guide : l'écran « Serveurs »

**Le besoin.** Après `npx oathrion`, la personne se demande si ça marche, et si un de ses
serveurs passe encore à côté d'Oathrion.

**Ce qui est fait** :

- **`GET /api/local/servers`**, qui n'existe que sur le pivot et exige une session. Pour
  chaque serveur sous Oathrion, il rend :
  - les clients qui le portent en ce moment ;
  - ses lectures, écritures et destructions ;
  - le nombre d'actions et la dernière d'entre elles.

  Il rend aussi les serveurs de Claude Code et de Cursor non protégés, lus dans leurs
  configurations de la machine par la même recherche que `npx oathrion`, en lecture seule ;
- **l'écran « Serveurs »**, local seulement. Il est relu toutes les 5 s : « Branché. En
  attente de la première action de votre agent. », puis la dernière action. Les serveurs
  non protégés y sont signalés avec `npx oathrion` à copier ;
- **la console locale ouvre** sur les approbations s'il y en a en attente (c'est la cible
  du bouton « Décider »), et sinon sur « Serveurs ».

**Prouvé** :

- `cli/wrap/wrap-servers.test.ts`, sur le vrai pivot et une fausse machine : le serveur
  porté par « Claude Code », zéro action puis la première ; les serveurs non protégés et
  distants nommés ; `401` sans session ;
- vu dans le navigateur : la connexion mène à « Serveurs », qui signale un serveur non
  protégé et montre `carnet` avec son client et sa dernière action.

### 5.67 Le paquet npm tel qu'il sera publié : le parcours complet, avec ses seuls fichiers

Le 28 octobre, au soir, sur `a7b36f4`. Paquet `oathrion-0.1.0-preview.1.tgz` construit par
`npm run pack:oathrion -- --brouillon`, puis extrait à part. Seuls ses fichiers sont lancés ;
les dépendances viennent du dépôt. Fausse machine dans un dossier jetable, avec une
configuration Cursor et le faux serveur du dépôt.

| Étape | Résultat |
|---|---|
| `oathrion --oui` (ce que lance `npx oathrion`) écrit la configuration | ✓ code 0 |
| la configuration lance le fichier du paquet | ✓ |
| le serveur démarre derrière Oathrion | ✓ `oathrion 0.1.0-preview.1` |
| outils listés | ✓ 7 |
| écriture approuvée dans le client (case cochée) → réponse du serveur | ✓ « note 1 créée » |
| `oathrion console` : lien de connexion | ✓ |
| la console se charge (page et script) | ✓ 200 / 200 |
| écran « Serveurs » : `carnet`, « Claude Code », 1 action | ✓ |
| `oathrion receipts verify` | ✓ chaîne intacte, 1 reçu |

**Pas couvert ici** :

- le téléchargement par `npx` depuis le registre, puisque la version n'est pas publiée ;
- l'installation des dépendances (`better-sqlite3`, `pg`) sur une machine neuve.

Ce sera l'essai d'une personne extérieure, à partir du README seul, une fois la version
publiée.

### 5.68 Le banc d'endurance du pivot local : deux défauts trouvés en quelques minutes

**Le banc** : `script/endurance-pivot.mjs`. Il lance la vraie commande compilée devant le
faux serveur du dépôt, dans un dossier jetable, et la fait travailler comme un agent
intense (5 appels par seconde par défaut) :

- surtout des lectures ;
- une écriture sur dix, approuvée DANS le client (case cochée) ;
- une sur cinquante, approuvée dans la console.

Il relève la mémoire du pivot, ses descripteurs, les latences, et l'écran « Serveurs ». Il
vérifie la chaîne de reçus à la fin et rend un verdict en 7 contrôles.

**Défaut 1, la limite de débit du serveur d'équipe.** Elle vaut 120 décisions par minute et
par identité. En local, il n'y a qu'une personne et aucune capacité partagée à protéger.
Pourtant le premier passage, sans cadence, a reçu 1 605 « Too many requests » en 4 minutes.
Un agent qui lit vite (plusieurs fichiers en parallèle) l'aurait atteinte en plein
travail. Le pivot fixe maintenant `RATE_LIMIT_DECISION=1200` : 20 par seconde, ce qui
arrête encore une boucle emballée.

**Défaut 2, l'écran « Serveurs » plafonné à 1 000.** La route lisait
`executions.list(1_000)` puis comptait le tableau : « 1 000 actions » pour 1 496 appels.
C'est le même défaut que celui de la couverture. Le compte se fait désormais en base, par
`executions.actionActivity(prefix)`, sur SQLite comme sur PostgreSQL. La comparaison porte
sur le début exact de l'action, sans `LIKE` : un `_` dans un nom de serveur n'est pas un
joker.

**Prouvé** :

- `server/test/action-activity.test.ts` (SQLite) : 1 050 exécutions comptées, début exact,
  par locataire, la plus récente rendue ;
- `phase11-postgres-core.test.ts` : le même test sur le PostgreSQL jetable
  (`placet-proof-pg`, arrêté ensuite) ;
- le banc, 6 minutes, **7/7** :

| Contrôle | Résultat |
|---|---|
| aucune erreur | ✓ 0 sur 1 799 appels |
| pivot vivant | ✓ |
| mémoire (médianes) | ✓ 138 → 159 Mo |
| descripteurs | ✓ 32 → 32 |
| p95 | ✓ 32,8 → 24,3 ms |
| écran « Serveurs » | ✓ 1 799 actions pour 1 799 appels |
| chaîne de reçus | ✓ 1 799 reçus |

**Reste à faire** : le passage de 12 h, avec `--minutes 720`.

### 5.69 Les serveurs MCP distants

**Le besoin.** `npx oathrion` laissait de côté les serveurs déclarés par une URL. C'est le
cas de `placet-local` dans le Cursor de l'utilisateur, et de plus en plus de services qui
proposent leur propre serveur MCP en ligne.

**Le choix.** Pas de second protocole dans le pivot. Un pont, `oathrion pont`
(`cli/wrap/bridge.ts`), présente le serveur distant comme un serveur local stdio, et le
pivot le traite comme les autres : classement, approbations, empreinte, reçus.
`oathrion wrap --url` fait lancer ce pont par le pivot.

**Ce que fait le pont** :

- **Streamable HTTP** : `POST`, réponses en JSON ou en SSE, `Mcp-Session-Id` repris de
  `initialize`, `MCP-Protocol-Version` ensuite, `DELETE` de la session au départ ;
- **l'ancien transport SSE** : `GET`, l'adresse annoncée par `endpoint`, les réponses dans
  le flux.

**Les jetons** :

- ils passent par `MCP_REMOTE_HEADERS`, jamais par les arguments (lisibles de tous dans la
  liste des processus) ;
- ils ne partent jamais en clair hors de la machine : `https`, ou `http` vers la boucle
  locale seulement ;
- une adresse SSE d'une autre origine est refusée ;
- rien de secret au journal, ni le jeton ni l'adresse au-delà de son origine.

**`npx oathrion`** protège un serveur distant dont le jeton est dans la configuration
(`headers`) ; `--annuler` le remet à l'identique. Un serveur distant sans jeton a sa
connexion (OAuth) gérée par le client : il est laissé tel quel, et l'écran « Serveurs » le
dit.

**Prouvé** :

- `cli/wrap/bridge.test.ts` contre un faux serveur distant (`fake-remote-mcp.ts`) : les deux
  transports, la session, la version, le jeton envoyé, l'accès refusé dit clairement sans
  fuite au journal, la règle « pas en clair » ;
- `cli/wrap/install.test.ts` : aller-retour exact pour Cursor (`url` et `headers`) et pour
  Claude Code (`type: sse`) ; le jeton jamais dans les arguments ;
- `cli/wrap/wrap-remote.test.ts`, de bout en bout avec la vraie commande compilée :
  `npx oathrion` protège le serveur de Cursor, puis on lance la configuration écrite. Le
  pivot classe le serveur (1 lecture, 1 écriture, 1 destruction) ; la lecture atteint le
  serveur distant, l'écriture est retenue, la destruction n'est pas proposée. `--annuler`
  remet la configuration à l'identique.

**Contre un vrai service** (le 1er novembre 2026, sur `db0a8a5`). Le serveur MCP distant de
**Stripe** (`https://mcp.stripe.com`), avec la clé de **mode test** de l'utilisateur, lue
depuis son fichier et jamais affichée :

| Étape | Résultat |
|---|---|
| `initialize` à travers le pont | ✓ 4,6 s, téléchargement compris |
| classement par le pivot | ✓ 6 lectures, 2 écritures, 1 destruction bloquée |
| outils proposés à l'agent | ✓ 8, plus l'outil d'information |
| lecture `get_stripe_account_info` | ✓ le compte « environnement de test placet » |
| écriture `send_stripe_feedback` | ✓ retenue, « the tool was NOT called » |
| la clé dans le journal | ✓ absente |

**GitHub n'a pas pu être essayé.** Le jeton de test de l'utilisateur est refusé (401), y
compris par `api.github.com` : il a expiré ou il a été révoqué. Le pont a dit le refus
clairement, sans le jeton, puis s'est arrêté. C'est à l'utilisateur de régénérer le jeton.

**Pas encore** :

- OAuth ;
- GitHub (le jeton à régénérer) ;
- le `placet-local` de l'utilisateur.

### 5.70 Décider une fois

**Le défaut.** Un agent qui écrit vingt fichiers posait vingt questions. C'est le contraire
du calme promis.

**Ce qui est fait** :

- **dans le client**, la question d'une ÉCRITURE propose « Et pour la suite ? » :
  - « Seulement cette fois », le défaut ;
  - « Cet outil, sans redemander jusqu'à la fermeture du client » ;
  - « Cet outil, toujours (une règle, dans la console) » ;
- **pour la session**, l'accord vit dans le relais. Chaque appel suivant est approuvé par
  le relais, avec la clé d'approbation, et inscrit au journal : « Accordé pour la session
  (Claude Code) » ;
- **pour toujours** :
  - le moteur retient la règle la plus restrictive, donc une règle « autoriser » ne
    l'emporterait pas sur « demander » ;
  - le verbe SORT donc de `pol_wrap_<serveur>_N` (désactivée si elle se vide, pour ne
    jamais devenir « toutes les actions ») et ENTRE dans `pol_wrap_<serveur>_toujours`
    (`ALLOW_TOOL`) ;
  - même préfixe : au redémarrage, `ensureServerPolicies` voit le verbe couvert et ne le
    remet pas sous approbation ;
- **dans la console**, « Approuver, ne plus demander » appelle `POST /api/local/accords`
  (droit `manage`, pivot seulement), puis l'approbation habituelle ;
- **jamais pour une destruction**, ni dans la question ni au pivot, qui refuse tout ce qui
  n'est pas une écriture d'un de ses serveurs.

**Prouvé** : `cli/wrap/wrap-decide-once.test.ts`, sur le vrai pivot.

1. « Pour la session » : trois écritures, une seule question.
2. Le client fermé, la question revient ; « toujours » crée la règle.
3. Le pivot arrêté puis relancé : l'écriture passe sans question ni approbation. La règle
   se lit dans `/api/policies`, et le verbe n'est plus dans la règle « demander ».
4. Par la console : `404` pour une demande inconnue ; `accords`, puis l'approbation, puis
   l'appel suivant passe sans retenue.

### 5.71 Le trou de l'auto-approbation : la vérité, et la barre relevée (décision B)

**Le trou, mesuré** (`notes/DECISION-AUTO-APPROBATION.md`). Sous le même utilisateur du
système, un agent qui a un terminal sans restriction peut :

- lire `~/.oathrion/_local/session.secret` et forger une session de console ;
- écrire dans la base ;
- surtout, lire le jeton d'un serveur dans la configuration de son client et appeler le
  service lui-même, en contournant Oathrion.

**Aucun outil local tournant sous le même utilisateur ne peut l'empêcher.** L'utilisateur a
choisi l'option B (le 1er novembre 2026) : dire la vérité, et fermer le chemin naturel.

**Ce qui est fait** :

- **le lien de connexion de la console, et l'ouverture du navigateur, seulement dans un
  terminal.** L'outil Bash d'un agent n'a pas de terminal : `oathrion console` n'y donne que
  l'adresse nue, et dit pourquoi. Il n'ouvre pas non plus de navigateur, qu'un agent qui
  pilote le navigateur pourrait cliquer.
  - Le bouton « Décider » d'une notification n'est pas touché : c'est le pivot qui ouvre la
    console, pas une commande de l'agent.
  - `OATHRION_CONSOLE_LIEN=1` existe pour les tests et les bancs ;
- **les instructions données à l'agent**. Seule la personne approuve : ne jamais approuver
  sa propre demande, ouvrir la console, lancer `oathrion console`, lire `~/.oathrion`,
  appeler l'API d'Oathrion pour décider, ni appeler le service avec un jeton trouvé sur la
  machine ;
- **la base** (`oathrion.db`, `-wal`, `-shm`) passe en `0600` au démarrage du pivot, comme
  le secret ;
- **la vérité écrite** dans `docs/wrap.md` (« It does not stop an agent that has an
  unrestricted shell… ») et dans `docs/not-yet.md` : gardez le terminal de l'agent sous
  l'approbation du client. Quand il le faut, la version équipe : un autre approbateur, les
  jetons au coffre. C'est aussi une carte de la page « Votre équipe ».

**Prouvé** :

- `cli/wrap/wrap-console.test.ts` : sans terminal, ni lien, ni ticket, la raison dite, la
  base en `0600` ;
- `server/test/wrap-approval.test.ts` : les instructions contiennent l'interdiction.

**Ce que ça ne ferme pas, et c'est écrit** : un agent déterminé qui a un terminal libre.

### 5.72 « Décider » sous macOS et Windows

**Le défaut** (relevé en décrivant le parcours, le 1er novembre). Sous Linux, la notification
a un bouton « Décider » qui ouvre la console déjà connectée. Sous macOS et Windows, elle
disait seulement « Pour décider : oathrion console ». Avec un client qui ne pose pas la
question, la personne devait donc passer par le terminal.

**Ce qui est fait** :

- **macOS.** Un dialogue `osascript` « Plus tard / Décider », « Décider » par défaut,
  effacé seul après deux minutes. Le clic appelle `onDecide`, comme sous Linux : c'est le
  pivot qui ouvre la console connectée. Si le dialogue ne peut pas s'afficher, une
  notification simple prend le relais ;
- **Windows.** Une notification Windows (WinRT, au nom de Windows PowerShell) avec
  « Décider » et « Plus tard ». Windows ouvre une adresse au clic, sans rappeler le pivot :
  `/api/local/decider?n=<jeton>`.
  - Le jeton est à usage unique, valable quinze minutes, gardé en mémoire du pivot
    seulement (`server/local-decide-links.ts`).
  - Il est échangé contre un lien de connexion NEUF. Échu, déjà servi ou inconnu, il mène
    à la console nue, sans session.
  - Le processus est attendu jusqu'au bout, puisque PowerShell démarre lentement. Un échec
    (Windows ancien, pas de WinRT) mène à l'ancienne bulle ;
- **la route** est publique par nécessité (Windows n'a pas de session), et elle répond `404`
  hors du pivot.

**Prouvé** :

- `server/test/local-notifications.test.ts`, avec un faux lanceur :
  - macOS : le dialogue, l'échappement, « Décider » qui appelle `onDecide`, « Plus tard »
    et « effacé seul » qui ne l'appellent pas, le repli ;
  - Windows : le XML échappé (`&`, `<`, `>` dans le titre et l'adresse), un jeton par
    notification, le repli vers la bulle ;
- `server/test/local-decide-links.test.ts` : le jeton sert une fois et seulement 15
  minutes ; la route rend un lien neuf, puis la console nue, et rien pour un jeton inconnu.

**Pas encore vu** : un vrai Mac, un vrai Windows. Il faut un testeur sur chacun.

### 5.73 Le pivot local pendant une heure, et le score de fluidité

**Endurance d'une heure** (`script/endurance-pivot.mjs --minutes 60`), le 1er novembre 2026
de 15 h 37 à 16 h 37 UTC, sur `432f07f`. Le banc fait travailler le pivot comme un agent
intense, à 5 appels par seconde, sans bloquer la mise en veille. Relevés dans
`~/.cache/placet-suite/endurance-pivot/60min-432f07f/`.

**17 989 appels** : 16 191 lectures, 1 439 écritures approuvées dans le client, 359 dans la
console. Verdict : **7/7**.

| Contrôle | Résultat |
|---|---|
| aucune erreur | ✓ 0 |
| pivot vivant jusqu'au bout | ✓ |
| mémoire (médianes, régime établi) | ✓ 172 → 174 Mo ; plate à 174 Mo de 30 à 60 min |
| descripteurs | ✓ 31 → 31 |
| p95 | ✓ 49,3 → 52,9 ms (p50 de 13 à 18 ms) |
| écran « Serveurs » | ✓ 17 989 actions affichées pour 17 989 appels |
| chaîne de reçus | ✓ 17 989 reçus, intacte |

Restent à faire : les 12 heures, qui attendent l'accord de l'utilisateur pour une nuit.

**Score de fluidité** (`npm run score:fluidite`, `script/score-fluidite.mjs`), 18 critères.
Chacun a une cible (100 %) et un seuil inacceptable (0 %) fixés dans l'absolu ; les
familles sont pondérées. Les temps viennent de `mesure-fluidite`, relancé le même jour
pendant l'endurance (par exemple, la configuration écrite en 0,39 s, le surcoût d'une
lecture de 15 ms, 71 ms de l'accord dans le client à la réponse à l'agent).

| Famille | Poids | 28 oct. | 1er nov. |
|---|---|---|---|
| Installation | 30 | 45 % | 83 % |
| Décision | 35 | 36 % | 100 % |
| Lecture | 10 | 100 % | 100 % |
| Console | 15 | 67 % | 100 % |
| Couverture | 10 | 45 % | 85 % |
| **Total** | 100 | **50 %** | **93 %** |

**Ce qui manque** :

- la relance du client après l'installation : Claude Code et Cursor ne relisent pas leur
  configuration à chaud ;
- les serveurs distants connectés par OAuth ;
- 1,45 s jusqu'aux outils listés, mesuré pendant l'endurance.

**La part vécue** : seuls 32 points sur 100 ont été vécus par une personne dans un vrai
client. La famille « Décision » tout entière est mesurée par des tests et des bancs, pas
encore vécue. Le temps d'une personne n'est mesuré nulle part.

### 5.74 Douze heures, premier essai : la base qui enfle, et la clé renouvelée

**Premier essai de 12 h** (`script/endurance-pivot.mjs --minutes 720`), lancé le 1er novembre
2026 à 16 h 43 UTC sur `ded8af4`, **arrêté vers 150 min**. Relevés dans
`~/.cache/placet-suite/endurance-pivot/12h-ded8af4/`.

**Deux défauts trouvés :**

1. **La base enflait.** Elle atteignait 1,5 Go à 150 min, avec un p50 passé de 10 à 19 ms.
   La passerelle gardait la réponse COMPLÈTE de chaque outil sur l'exécution. Or la lecture
   du banc renvoie toutes les notes, donc elle grossit à chaque appel.
2. **Des 401 au renouvellement de clé.** Vers 140 min, le pivot, ralenti par la base, a
   manqué des signaux de présence. Le détenteur de la clé a expiré, la clé a été révoquée,
   et **25 appels** ont reçu 401 « Invalid credentials ».

**Les corrections :**

- **La réponse gardée en base** (`server/gateway/stored-result.ts`) :
  - au-delà de 16 Ko, seule l'exécution autorisée sur-le-champ garde ses petits champs ;
    chaque gros champ est remplacé par sa taille et son empreinte SHA-256 ;
  - l'agent reçoit toujours la réponse entière ;
  - une exécution approuvée ou rejouée garde sa réponse complète : c'est de là que l'agent
    la reçoit.

  Tests : `server/test/stored-result.test.ts`, `cli/wrap/wrap-stored-result.test.ts`.
- **Le relais et le 401** (`cli/wrap/relay.ts`) : il attend une clé neuve jusqu'à 25 s, et
  rejoue UNE fois. Sinon, il rend une erreur JSON-RPC claire. Un 401 arrive avant toute
  décision : le rejeu ne peut pas exécuter deux fois. Test : `cli/wrap/relay-renewal.test.ts`.

### 5.75 Douze heures, second essai : le quota mensuel coupait le poste de la personne

**Second essai**, lancé le 1er novembre 2026 à 19 h 38 UTC sur `ded8af4` avec les corrections
du §5.74, **arrêté le 2 novembre à 02 h 01 UTC**, à 381 min. Relevés dans
`~/.cache/placet-suite/endurance-pivot/12h-correctif-stockage/`.

**Les corrections du §5.74 tiennent :**

- **0 erreur** jusqu'à 334 min et au 100 000e appel ;
- **aucun 401** ;
- une base de 549 Mo à 225 min (contre 1,5 Go à 150 min), avec une mémoire stable entre
  171 et 189 Mo.

**Le défaut trouvé : le quota mensuel d'exécutions.** Au **100 000e appel du mois**, chaque
appel de chaque client a reçu une erreur 500 « Internal error handling the MCP request ».
Le plafond est celui d'un déploiement partagé (`DEFAULT_QUOTAS.executions`). Le §5.25
l'avait déjà rencontré en mode serveur. Deux erreurs :

1. **En local, il n'y a pas d'autre locataire à protéger.** Le plafond frappait la personne
   elle-même, jusqu'au 1er du mois suivant.
2. **La voie MCP transformait le refus en « Internal error ».** Les routes REST, elles,
   disaient déjà 429 `quota_exceeded`, avec la limite et la date de remise à zéro.

**Les corrections :**

- **En mode local, les quotas mesurent sans refuser.** C'est le mode `observe` par défaut
  (`resolveQuotaMode`, `server/quotas.ts`). Un `OATHRION_QUOTA_MODE` explicite l'emporte
  toujours. La limite de débit (1 200 appels par minute) arrête encore une boucle folle.
- **`/api/mcp` dit le quota** : une erreur JSON-RPC portant le message du quota, la limite
  et la date de remise à zéro, avec le statut 429. Rien ne part vers l'outil.

  Tests : `server/test/mcp-quota.test.ts`, et `quotas.test.ts` (« observes by default in
  local mode »).

**Reste ouvert : le temps de réponse monte avec le volume.** Le p50 passe de 10 ms (5 min)
à 56 ms (305 min, plus de 90 000 appels). La piste : à chaque appel, la somme des dépenses
de l'agent sur les **24 dernières heures glissantes** (`dailySpendQuery`), qui coûte plus cher
à mesure que les exécutions s'accumulent. La fenêtre étant glissante, minuit n'a rien remis à
zéro, ce qui est cohérent avec cette piste. **Elle n'est pas encore mesurée.** Pour une
personne réelle, qui fait quelques centaines d'appels par jour, l'effet est invisible. Le banc
de 12 h reste à repasser sur le code corrigé.

### 5.76 Douze heures, troisième essai : 7/7 ; la dépense du jour et le journal local

**Troisième essai de 12 h**, du 2 novembre 2026 à 02 h 14 UTC au même jour à 14 h 14 UTC, sur
`ded8af4` avec les corrections des §5.74 et §5.75. Relevés dans
`~/.cache/placet-suite/endurance-pivot/12h-correctif-quota/`.

**Le résultat : 119 209 appels, et un verdict de 7/7.** Les appels se répartissent ainsi :
107 289 lectures, 9 536 écritures approuvées dans le client, 2 384 dans la console.

| Contrôle | Résultat |
|---|---|
| aucune erreur | ✓ 0, y compris après le 100 000e appel du mois |
| pivot vivant jusqu'au bout | ✓ |
| mémoire (médianes, régime établi) | ✓ 128 → 133 Mo |
| descripteurs | ✓ 31 → 31 |
| p95 | ✓ 78,0 → 72,3 ms |
| écran « Serveurs » | ✓ 119 209 actions affichées pour 119 209 appels |
| chaîne de reçus | ✓ 119 209 reçus, intacte |

**Deux défauts restaient, trouvés pendant les essais du §5.75. Ils sont corrigés après ce
banc.**

1. **La dépense du jour.** Le p50 montait avec le volume de la journée, de 10 à 56 ms après
   90 000 appels.
   - **La cause, mesurée** sur la base du banc du §5.75, en lecture seule : à chaque appel,
     `dailySpendQuery` additionnait les exécutions autorisées de l'agent sur 24 h
     glissantes. À 100 000 exécutions, cette somme coûtait 17 à 28 ms (350 ms à froid).
   - **La correction :** la somme n'est lue que si une règle fixe un budget journalier
     (`readsDailySpend`, `server/services/decision-service.ts`). Sans budget, `since` est
     nul : la base ne fait pas la somme, et le moteur voit 0, qu'aucune règle ne lit. En
     PostgreSQL, le verrou consultatif reste pris.
   - **Tests :** `server/test/daily-spend-skip.test.ts`. Le chemin avec budget reste couvert
     par `daily-budget-concurrency.test.ts`.
2. **Le journal local** (`~/.oathrion/_local/oathrion.log`) gardait le début de chaque
   réponse d'outil, en clair sur le disque.
   - **La correction :** en mode local, le journal n'écrit plus que des lignes d'état. Seules
     les réponses en erreur gardent leur corps (`server/index.ts`).
   - **Test :** `cli/wrap/wrap-stored-result.test.ts` vérifie que le journal ne contient pas
     la note de 20 Ko lue par l'agent.

### 5.77 Windows : SQLite sans binaire précompilé pour Node 24

**Le défaut**, trouvé en préparant le premier testeur sous Windows (5 novembre 2026), avant
qu'il n'installe : `better-sqlite3` 11.10.0 ne publie de binaires Windows et macOS que pour
Node 22 (ABI 127) et 23 (ABI 131). Sous Node 24, la version LTS du moment, `npm install -g`
aurait tenté de compiler SQLite, ce qui échoue sous Windows sans les outils de Visual
Studio. Le paquet ne se serait pas installé.

**La correction : `better-sqlite3` ^12.11.1** (publiée en juin 2026, SQLite 3.53.2). Elle
publie des binaires pour Node 22, 24, 25 et 26, sous Windows (x64 et ARM) et macOS (x64 et
ARM). La liste vient des fichiers de la publication sur GitHub, pas d'une supposition.

**Vérifications :**
- la suite complète passe sur cette version : 3 334 tests réussis ;
- le paquet d'essai, reconstruit, a été installé depuis le fichier dans un dossier isolé,
  puis piloté comme Cursor : lecture passée, écriture retenue, reçus vérifiés, `--undo`.

**Reste à vérifier :** l'installation sur une vraie machine Windows. C'est l'essai du
testeur.
