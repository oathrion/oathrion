# Exploitation entreprise — sauvegarde, restauration, export, mise à jour, incident

Ce document complète `DEPLOYMENT.md` (installation) avec ce qu'une équipe d'exploitation
fait **après** la mise en service. Chaque procédure indique ce qui a été **réellement
exécuté** lors de la Phase 13 et ce qui ne l'a pas été.

Légende : **PASS** = exécuté et vérifié · **NON TESTÉ** = documenté mais pas exécuté
dans cet environnement · **NON IMPLÉMENTÉ** = n'existe pas dans ce build.

---

## 1. Sauvegarde

| Élément | Commande | Statut |
|---|---|---|
| Sauvegarde à chaud cohérente | `deploy/scripts/backup.sh` | **PASS** — `npm run verify:backup`, 21/21 : le script tourne tel quel, écrit le dump en mode 600 et son empreinte, et ne laisse aucun `.partial` |
| Rétention | `RETENTION_DAYS` (défaut 14) | **PASS** — un dump daté de 30 jours est supprimé avec son empreinte, les récents survivent |
| Restauration et reprise | `deploy/scripts/restore.sh` | **PASS** — restauration dans une base neuve, refus d'une base non vide, Oathrion démarre dessus, la chaîne de reçus se vérifie **avec la même tête qu'avant**, et un grant consommé avant la sauvegarde reste consommé |

> **Ces scripts ne fonctionnaient pas** avant cette vérification. Ils appellent
> `pg_dump`, `pg_restore` et `psql`, qu'aucune image du kit n'installe : sur l'hôte d'un
> `docker compose up`, les deux échouaient sur « commande introuvable ». Le mode
> `COMPOSE=1` de `backup.sh` n'était qu'à moitié fait — il dumpait dans le conteneur,
> puis vérifiait le dump sur l'hôte. Toutes les commandes client passent désormais par
> une indirection unique (`deploy/scripts/pg-run.sh`) :
>
> ```bash
> OATHRION_PG_CONTAINER=placet-postgres ./backup.sh   # via un conteneur nommé
> COMPOSE=1 ./backup.sh                         # via le service compose
> ./backup.sh                                   # binaires de l'hôte
> ```
>
> Avec un conteneur, l'URL doit être joignable **depuis lui** : `127.0.0.1:5432`, pas le
> port publié sur l'hôte. Sans outils ni conteneur, le script s'arrête avec le code 2 et
> dit lequel des trois chemins choisir — au lieu de laisser un `.partial` tronqué.
| Archivage continu WAL (RPO < 1 h) | pgBackRest / WAL-G côté PostgreSQL | NON IMPLÉMENTÉ par Oathrion (responsabilité de l'exploitant / du PostgreSQL managé) |

Planification recommandée (cron, toutes les heures) :

```cron
15 * * * * DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/placet OATHRION_PG_CONTAINER=placet-postgres /opt/placet/deploy/scripts/backup.sh >> /var/log/placet-backup.log 2>&1
```

**Ce qui est prouvé et ce qui ne l'est pas.** `npm run verify:backup` garantit que la
commande ci-dessus fait ce qu'elle annonce : elle produit un dump restaurable, applique
la rétention, et la restauration redonne un Oathrion qui démarre avec la même chaîne
d'audit. Elle ne garantit pas que **votre** cron se déclenche — la planification
appartient à l'exploitant, et la seule façon de le savoir est de regarder le journal
le lendemain.

Deux gardes à poser le jour de la mise en service, parce qu'un cron silencieux est
indiscernable d'un cron qui marche :

- une **alerte sur l'absence** de dump récent (`find "$BACKUP_DIR" -name 'placet-*.dump' -mmin -90`
  qui ne renvoie rien = incident), et non sur l'échec du script ;
- une **restauration d'essai mensuelle** dans une base jetable. `verify:backup` en est
  la forme automatisée ; sur votre volume réel, c'est aussi la seule mesure de RTO qui
  vaille.

Les dumps contiennent des données clients et des hachages de credentials : répertoire
`chmod 700`, fichiers `chmod 600`, copie hors machine chiffrée. Ils sont exclus du
dépôt (`.gitignore`) et refusés par l'empaquetage.

## 2. RPO / RTO

| Mesure | Valeur | Origine |
|---|---|---|
| RPO avec dump horaire | ≤ 1 h | conséquence de la fréquence ; pas une mesure |
| RPO avec WAL archiving | quelques secondes | dépend de l'infrastructure PostgreSQL ; NON TESTÉ |
| Durée dump / restauration / redémarrage | ~0,6 s / ~0,7 s / ~0,8 s | **mesuré** par `npm run verify:backup`, scripts réels compris, sur une base de test de quelques dizaines de lignes. **Ce n'est pas un RTO de production** : il croît avec le volume. Mesurez sur une copie de votre base. |

## 3. Restauration — **PASS** (exercice automatisé)

`npm run e2e:multitenant` (section BACKUP / RESTORE) exécute réellement :

1. `pg_dump -Fc` de la base vivante de deux organisations ;
2. `pg_restore` dans une **nouvelle base vide** ;
3. comparaison du nombre de lignes de **chaque** table (18/18 identiques) ;
4. démarrage du bundle de production sur la base restaurée → `/api/ready` 200 ;
5. la session console de l'organisation A fonctionne encore ;
6. un grant **consommé avant** la sauvegarde reste consommé (`grant_already_consumed`) — la restauration ne rouvre pas de rejeu ;
7. la clé de l'agent A et ses policies fonctionnent (ALLOW → outil appelé une fois) ;
8. la chaîne d'audit de A se vérifie ;
9. B ne lit toujours pas le reçu de A.

Procédure manuelle équivalente :

```bash
createdb oathrion_restored
TARGET_URL=postgres://.../oathrion_restored deploy/scripts/restore.sh /var/backups/placet/placet-XXXX.dump
# puis : DATABASE_URL -> oathrion_restored, redémarrer Oathrion, vérifier
deploy/scripts/check-health.sh
```

`restore.sh` refuse une base cible non vide (pas d'écrasement accidentel).

## 4. Export d'un tenant — **PASS**

```bash
DATABASE_URL=postgres://... npm run tenant:export -- org_acme_corp > org_acme_corp.json
```

- Lecture seule, un seul instantané cohérent (`REPEATABLE READ READ ONLY`).
- Tables exportées : **toutes** celles qui ont une colonne `organization_id` (découvertes dans `information_schema`, pas une liste figée), plus la ligne de l'organisation.
- Credentials **expurgés** : `api_keys.secret_hash`, `sessions.id` (moitié d'un jeton console), et toute colonne `*password*`, `*secret*`, `*_hash` de credential. Les hachages de la chaîne d'audit sont conservés (ils permettent au client de vérifier l'intégrité).
- Vérifié par `e2e:multitenant` : l'export de A contient les données de A (53 lignes, 15 tables), **aucune** trace de B (identifiant d'organisation, e-mail), aucun mot de passe, clé d'API, jeton de session ni secret de session ; chaque ligne porte `organization_id = A`.

## 5. Suppression d'un tenant — **NON IMPLÉMENTÉ**

Aucune commande ne supprime une organisation. C'est volontaire dans ce build : le
journal d'audit est chaîné et sa suppression doit suivre une politique de rétention
contractuelle (durée, preuve de suppression) qui n'est pas définie. En attendant :

- **geler** un client sans rien supprimer : `DEPLOYMENT.md` §15.3 (quotas à zéro, comptes désactivés) ;
- révoquer ses clés et sessions (`DEPLOYMENT.md` §11) ;
- exporter ses données (§4) avant toute suppression manuelle faite par un DBA.

## 6. Rétention des données — **NON IMPLÉMENTÉ**

Aucune purge automatique des exécutions, reçus ou audits. Les lignes s'accumulent.

## 7. Surveillance

| Signal | Où | Statut |
|---|---|---|
| Vivacité | `GET /api/live` (processus vivant) | PASS (e2e, chaos) |
| Disponibilité | `GET /api/ready` → 503 si PostgreSQL est absent | **PASS** : `npm run chaos:postgres` arrête réellement PostgreSQL sous une instance vivante (15/15) |
| Journaux | sortie standard, une ligne par requête, `requestId` | PASS (aucun secret dans la sortie : vérifié par `e2e:multitenant`) |
| Métriques Prometheus | `GET /api/metrics`, derrière `OATHRION_METRICS_TOKEN` | **PASS** : `npm run verify:obs` **58/58** — chaque signal provoqué pour de vrai (jeton absent, jeton faux de même longueur, magasin de quotas renommé sous une instance vivante, chaîne falsifiée en base). 81 séries, cardinalité **bornée par construction**, aucun identifiant de locataire |
| Alertes | règles PromQL prêtes à coller | **PASS** : [`ON-CALL.md`](ON-CALL.md) §1 — sept règles, dont une qui surveille le surveillant (`OathrionAuditDeChaineMuet`) |
| Fraîcheur des sauvegardes | `deploy/scripts/check-backup-freshness.sh` | **PASS** : alarme sur l'**absence** d'un dump récent, codes de sortie 0/1/2, sortie `--prometheus` pour le collecteur de fichiers |
| Intégrité des chaînes de reçus, tous locataires | `npm run audit:chains` | **PASS** : lit la base (aucune route ne parcourt les locataires, et il ne doit pas en exister), réutilise `verifyReceiptChain` et `receiptFromRow` — jamais une seconde implémentation |
| Latence / quantiles | — | **NON IMPLÉMENTÉ, et délibérément** : un histogramme utile exige des tranches choisies sur une distribution mesurée en charge réelle, qui n'existe pas. Des tranches inventées rendraient des quantiles crédibles et sans fondement. Le plafond connu est 90–190 req/s par instance |
| Trace distribuée | — | NON IMPLÉMENTÉ. La corrélation disponible est le `requestId` des journaux |

**Les deux contrôles périodiques ne sont pas dans Oathrion, et c'est structurel.** La
fraîcheur des sauvegardes porte sur des fichiers qu'Oathrion ne voit pas ; l'intégrité des
chaînes serait un auto-contrôle. Les deux lignes de cron à poser sont dans
[`ON-CALL.md`](ON-CALL.md) §1.

## 7bis. Endurance et reprise — les trois exercices que personne n'avait joués

| Exercice | Commande | Statut |
|---|---|---|
| **Restauration sur une AUTRE machine** | `npm run verify:dr` | **PASS 28/28** — un second serveur PostgreSQL (conteneur, volume, mot de passe et port à lui, rien de partagé) ; seul le dump traverse. L'identifiant du locataire, l'agent, la règle, le credential et la chaîne de reçus survivent **avec la même tête**, et un grant consommé avant la sauvegarde reste consommé |
| **Trafic continu** | `npm run verify:soak` | **PASS 13/13** sur 12 min — **46 524 requêtes, 0 erreur** ; mémoire résidente 233 → 236 Mo (+1,4 %), descripteurs constants à 35, 5 connexions PostgreSQL, 1 ligne de limiteur. Durée paramétrable par `SOAK_MINUTES` |
| **Mise à jour N−1 → N sur données vivantes** | `npm run verify:upgrade` | **PASS 17/17** — voir §8 et §8bis |

### Ce que `verify:dr` a trouvé, et qu'aucun runbook ne disait

**Le dump ne contient pas le registre des destinations.** Il vit dans l'environnement
(`OATHRION_DESTINATIONS`, `OATHRION_LOCAL_MCP_URL`) et nulle part en base. Une restauration
rend donc les locataires, les agents, les règles, les grants et les reçus — mais **pas où
les actions partent**. Un exploitant qui ne sauvegarde que PostgreSQL obtient un système
qui décide correctement et n'exécute plus rien ; les actions sont alors BLOQUÉES à
l'autorisation, avec un motif qui nomme la destination non enregistrée.

**Sauvegardez donc aussi votre fichier d'environnement**, dans un coffre et non à côté des
dumps : il porte `OATHRION_SESSION_SECRET`, le mot de passe PostgreSQL et les mots de passe
d'administration. Sans lui, une reprise est incomplète ; avec lui au même endroit que les
dumps, un vol de sauvegardes devient un vol de credentials.

Ce qu'il est en revanche **inutile** de conserver à l'identique : le secret de session.
Un nouveau secret invalide les sessions en cours — les utilisateurs se reconnectent avec
leur mot de passe, dont le hachage est en base — et c'est le cas éprouvé par `verify:dr`.

### Ce que ces exercices ne prouvent pas

- La machine de remplacement de `verify:dr` est un autre **serveur PostgreSQL**, mais le
  processus applicatif tourne sur le même hôte : même noyau, même architecture. Une
  reprise sur un autre système d'exploitation ou une autre architecture reste **non
  éprouvée**.
- `verify:soak` mesure par défaut 10 minutes. **Dix minutes ne prouvent pas 24 heures** :
  il attrape une fuite rapide et établit une courbe. Avant un pilote, lancez la version
  longue — `SOAK_MINUTES=720 npm run verify:soak`.
- `verify:upgrade` simule « N−1 » par la liste de migrations **tronquée**, c'est-à-dire ce
  qu'un build antérieur connaît du registre. Qu'un binaire réellement ancien se comporte
  comme sa liste tronquée reste à vérifier le jour où deux versions existent.

## 8. Mise à jour et retour arrière

1. Sauvegarde (§1) **avant** toute mise à jour.
2. **Appliquer les migrations, explicitement** : `node dist/migrate.cjs` (c'est ce que fait
   le service `migrate` du compose). Oathrion **n'applique PAS** les migrations à son
   démarrage : il refuse de démarrer sur un schéma en attente, en nommant les deux
   versions et la commande à lancer. Cette ligne affirmait le contraire — « Oathrion
   applique les migrations en attente au démarrage » — et un exploitant qui la suivait
   déployait, voyait le processus refuser de démarrer, et ne trouvait nulle part l'étape
   manquante. Corrigé après l'avoir constaté par `npm run verify:upgrade`.
3. Déployer la nouvelle version. Elle **refuse** aussi de démarrer sur un schéma plus
   récent que le sien : c'est ce qui rend un retour arrière sûr — voir §8bis.
4. Vérifier `/api/ready` et `npm run verify:prod-config` sur l'environnement de préproduction.

### 8bis. Le retour arrière, et ce qu'il coûte vraiment

**Il n'existe aucune migration descendante**, par conception : l'histoire des migrations
est append-only, et `assertHistoryMatches` refuse une histoire réécrite.

Revenir en arrière signifie donc redéployer l'image précédente — et elle **refusera de
démarrer** si la nouvelle version a appliqué une migration, en nommant la version qu'elle
ne connaît pas. C'est voulu : faire tourner du code ancien sur un schéma récent lui
ferait écrire des lignes que les contraintes du nouveau schéma interdisent, et la
corruption ne se verrait qu'à la mise à jour suivante.

La seule issue est alors la **restauration du dump pris à l'étape 1**, avec la perte des
écritures survenues depuis. C'est la raison pour laquelle l'étape 1 n'est pas une
politesse.

| | Statut |
|---|---|
| Montée N−1 → N sur des données vivantes, sans perte | **PASS** — `npm run verify:upgrade` 17/17 : refus sur schéma en attente, migration ponctuelle, démarrage, chaîne de reçus avec la **même tête**, grant consommé toujours consommé |
| Redémarrage à la même version, sans rejouer de migration | **PASS** |
| Un serveur N−1 refuse une base en N | **PASS** — en nommant la version inconnue et l'action à prendre |
| Une histoire de migrations réécrite est refusée | **PASS** |
| Un binaire RÉELLEMENT antérieur | **NON TESTÉ** — « N−1 » est la liste de migrations tronquée, c'est-à-dire ce qu'un build antérieur connaît du registre. À rejouer le jour où deux versions existent réellement |

## 9. Reprise après incident

| Incident | Comportement vérifié | Statut |
|---|---|---|
| PostgreSQL s'arrête | `/api/ready` 503, aucune écriture autorisée, sessions non validées, aucun fichier SQLite, le processus reste vivant | **PASS** (`chaos:postgres`, cluster réel arrêté) |
| PostgreSQL revient | la même instance redevient prête **sans redémarrage**, l'écriture refusée n'a laissé aucune ligne | **PASS** |
| Redémarrage réel de PostgreSQL pendant le trafic d'identité | reconnexion, et fail-closed pendant l'absence | **PASS** (`phase12-restart-reconnect.test.ts`, `OATHRION_TEST_PG_RESTART=1`) |
| Oathrion tué (SIGKILL) | redémarrage par le superviseur (`restart: unless-stopped` / systemd `Restart=on-failure`) ; l'état est dans PostgreSQL | redémarrage + état : PASS sur le banc `npm run chaos` (26 scénarios traités, 2 non simulables) — ce banc tourne en mode développement SQLite ; sur PostgreSQL, la persistance après arrêt/redémarrage du processus est PASS dans `e2e:multitenant` (redémarrage sur la base restaurée) |
| Perte de la machine | restauration du dernier dump sur une **autre** machine, puis migration, puis démarrage | **PASS 28/28** — `npm run verify:dr`, §7bis. Un second serveur PostgreSQL : conteneur, volume, mot de passe et port à lui, rien de partagé, seul le dump traverse. Reste non éprouvé : un autre système d'exploitation ou une autre architecture de processeur |
| Trafic continu pendant des minutes | mémoire, descripteurs, connexions et table du limiteur stables en régime établi ; zéro erreur | **PASS** — `npm run verify:soak`, §7bis. **10 minutes ne prouvent pas 24 h** : lancer `SOAK_MINUTES=720` avant un pilote |
