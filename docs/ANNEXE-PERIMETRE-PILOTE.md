# Annexe de périmètre — pilote Oathrion

**Annexe technique au contrat de pilote.** Elle dit ce qu'Oathrion garantit, ce qui est
mesuré et par quelle commande, et ce qui n'est **pas** fourni. Elle est écrite pour être
lue par la direction technique du client et par son service juridique.

| | |
|---|---|
| Produit | **Oathrion** — plan de contrôle d'autorisation pour agents d'intelligence artificielle |
| Version | commit livré avec l'archive ; son empreinte SHA-256 accompagne la livraison |
| Titulaire | Abdoulaye Diallo · adresse de contact dédiée à venir (voir `SECURITY.md`) |
| Périmètre | **pilote**, un locataire, une région, mono-instance |

**La règle de lecture de cette annexe.** Une ligne « garanti » renvoie à une commande de
ce dépôt qui a réellement tourné, et le client peut la relancer lui-même. Une ligne
« non fourni » n'est pas une réserve de prudence : c'est l'absence de la chose. Aucune
ligne ne dit « bientôt ».

---

## 1. Ce qu'Oathrion garantit

### 1.1 Les garanties fortes — démontrables par une commande

| Garantie | Ce qu'elle signifie exactement | Preuve |
|---|---|---|
| **Aucune action sans autorisation** | aucun outil aval n'est atteint sans qu'une autorisation ait été accordée et un grant consommé | `npm run verify:mcp` 37/37, contre un serveur d'outils qui ne partage aucune ligne avec Oathrion |
| **Exactement une fois** | un grant autorise **une** exécution. Un rejeu est refusé, y compris sous concurrence, et y compris entre processus distincts | `phase11-multiprocess` : 4 processus système en course → une seule consommation, un seul appel aval |
| **Rien ne part avant l'humain** | une action `APPROVAL_REQUIRED` n'atteint aucun outil avant qu'une personne l'ait approuvée en nommant ce qu'elle a vu (empreinte de l'action) | `verify:mcp`, et `conformance` C18–C22 |
| **Refus par défaut** | une action qu'aucune règle ne déclare est bloquée, pas tolérée | `undeclared-action-posture.test.ts` |
| **Trace infalsifiable à la lecture** | les reçus d'un locataire forment une chaîne de hachage ; une modification, une suppression ou une réorganisation est **détectable** | `npm run audit:chains`, et le client vérifie la sienne par `GET /api/actions/receipts/verify` |
| **Cloisonnement des locataires** | un administrateur pleinement privilégié d'un locataire ne peut ni lire, ni modifier, ni utiliser les objets d'un autre | `npm run e2e:multitenant` 73 contrôles, dont une campagne adverse complète |
| **Fermeture en cas de panne** | base injoignable → aucune autorisation n'est accordée, aucune écriture n'a lieu, et le processus reste vivant pour reprendre sans redémarrage | `npm run chaos:postgres` 15/15, cluster réellement arrêté |
| **Refus de démarrer sur une configuration dangereuse** | 38 configurations réputées risquées refusent le démarrage **en nommant la variable responsable** | `npm run verify:prod-config` 38/38 |
| **Reprise après perte de la machine** | un dump restauré sur une **autre** machine rend l'identifiant du locataire, ses agents, ses règles, ses credentials et sa chaîne de reçus **avec la même tête** ; un grant consommé avant la sauvegarde reste consommé | `npm run verify:dr` 28/28 |
| **Mise à jour sans perte, retour arrière sûr** | une base en N−1 monte en N sans perte ; un serveur N−1 **refuse** une base en N au lieu de la corrompre | `npm run verify:upgrade` 17/17 |
| **Stabilité sous trafic continu** | mémoire, descripteurs, connexions PostgreSQL et table du limiteur stables en régime établi, zéro erreur | `npm run verify:soak` |

### 1.2 Ce que « trace infalsifiable » veut dire, et ne veut pas dire

La chaîne couvre **seize champs** de chaque reçu, résumé lisible du résultat compris, et
rend détectables l'édition, la suppression et la réorganisation.

Elle **ne prouve rien à un tiers** : il n'y a ni signature, ni ancre extérieure.
Quelqu'un qui détient un accès en écriture à la base **et** le code peut recalculer une
chaîne entièrement cohérente. Fermer cela demande une clé hors base ou une publication
périodique des têtes de chaîne — **non fourni**.

Elle **ne détecte pas une troncature en fin de chaîne** : supprimer le dernier reçu laisse
le reste cohérent, et rien n'enregistre la longueur attendue. Fermer cela demande une tête
persistée par locataire — **non fourni**.

Ces deux limites sont écrites ici parce qu'elles sont la différence entre « inviolable »
et « infalsifiable à la lecture ». Nous vendons la seconde.

### 1.3 Le mode d'application : deux formes, deux promesses différentes

| | Ce que le client fait | Ce qu'Oathrion garantit |
|---|---|---|
| **Passerelle MCP** | l'agent n'a d'accès à ses outils **qu'à travers** Oathrion | Oathrion est **physiquement** sur le chemin : une action qu'il refuse ne peut pas avoir lieu |
| **Demander avant d'agir** | le code du client appelle `/api/evaluate` et agit sur la réponse | la décision est **autoritaire, enregistrée et infalsifiable** — mais Oathrion ne peut pas empêcher un programme d'ignorer la réponse qu'il a reçue |

**Cette distinction ne doit jamais être effacée dans une discussion commerciale.** Si le
client a besoin que le contrôle soit *inévitable* et non seulement *autoritaire*, il doit
utiliser la passerelle MCP. C'est écrit dans `docs/security-model.md` et dans
`examples/README.md`.

---

## 2. Ce qui n'est PAS fourni

### 2.1 Oathrion n'exécute presque rien lui-même

Les outils **intégrés** au binaire sont tous simulés, et tout verbe que rien ne sert
revient `runState: "skipped"` : une décision réelle, enregistrée, et **aucun appel
aval**.

Un pilote n'est donc viable que si **le client branche ses propres outils** derrière la
passerelle MCP. C'est faisable, c'est de la configuration et non du code, et c'est
prouvé : `OATHRION_TOOLS` déclare l'outil du client — sa destination, le nom de son outil
chez lui, les verbes servis, et la projection de chaque argument — et
`npm run verify:tools` mesure le parcours entier contre `examples/mcp-server/`, un
serveur d'outils complet qui n'importe rien d'Oathrion. Reste un travail d'intégration
côté client, à son calendrier : écrire le serveur d'outils lui-même.

Ce qu'une déclaration ne sait **pas** faire : transformer une valeur. Ni formater, ni
convertir une unité, ni poser un défaut. Un fournisseur qui attend des centimes là où
Oathrion détient des unités demande un adaptateur devant lui.

`GET /api/tools` déclare, par outil, s'il est simulé **et quels verbes il sert** — de
quoi confirmer qu'une déclaration a pris effet sans passer d'appel. Le drapeau est une
propriété du **déploiement** et non du build : le même binaire est simulé ou non selon
qu'une destination aval est configurée.

### 2.2 L'idempotence chez le fournisseur du client

Oathrion garantit qu'un grant est consommé une fois. Il **ne peut pas** garantir qu'un effet
chez un tiers n'a lieu qu'une fois : si le serveur du client exécute un débit et que la
réponse se perd sur le réseau, Oathrion enregistre un échec là où le débit a eu lieu.

La clé de déduplication est transmise — en-tête `X-Oathrion-Execution-Id`, et `X-Placet-…`
pour les intégrations existantes — et `examples/mcp-server/` montre le stockage à écrire
en face : une table avec contrainte d'unicité, écrite **dans la même transaction que
l'effet**. **C'est un travail du client, et cette annexe ne le promet pas.**

### 2.3 Capacité, et l'absence de SLO

| | |
|---|---|
| Mesuré | **~90 à 190 requêtes authentifiées par seconde et par instance**, sur une machine de test en boucle locale |
| Pourquoi ce plafond | le plan d'identité atteint PostgreSQL par un pont synchrone sur une seule connexion : chaque requête d'identité bloque la boucle d'événements le temps d'un aller-retour |
| **Aucun SLO n'est promis** | ni disponibilité, ni latence, ni débit. Aucune mesure n'existe hors d'une seule machine, et aucune latence de queue n'est publiée — des tranches d'histogramme inventées produiraient des quantiles crédibles et sans fondement |

### 2.4 Trois choses que l'exercice de reprise a révélées, et que vous devez faire

**Le dump ne suffit pas.** Le registre des destinations — où les actions partent — vit
dans l'environnement et **nulle part en base**. Une restauration qui ne rend que
PostgreSQL donne un système qui décide correctement et n'exécute plus rien. Sauvegardez
donc aussi votre fichier d'environnement, **dans un coffre et non à côté des dumps** : il
porte le secret de session, le mot de passe PostgreSQL et les mots de passe
d'administration, et un vol de sauvegardes deviendrait un vol de credentials.

**Oathrion n'applique PAS les migrations à son démarrage.** Il refuse de démarrer sur un
schéma en attente, en nommant les deux versions et la commande à lancer. L'ordre est donc :
restaurer ou déployer, **puis** `node dist/migrate.cjs`, **puis** démarrer. C'est la
bonne conception — une migration s'ordonnance, elle n'est pas un effet de bord du
démarrage d'un conteneur — mais deux de nos propres documents affirmaient l'inverse
jusqu'à ce que `verify:upgrade` le démente.

**Un retour arrière coûte une restauration.** Il n'existe aucune migration descendante,
par conception. Redéployer la version précédente échoue si la nouvelle a appliqué une
migration — volontairement, car du code ancien sur un schéma récent écrirait des lignes
que les contraintes interdisent. La seule issue est le dump pris avant la mise à jour,
avec la perte des écritures survenues depuis.

### 2.5 Le coût de la vérification de chaîne croît sans limite

`verifyReceiptChain` est en **O(n)** sur les reçus du locataire, et rien ne purge les
reçus. **Mesuré** sur un passage de 12 minutes : 16 ms à 1 reçu, **251 ms à 11 220**, soit
une pente de ~22 µs par reçu, linéaire sur toute la plage observée. **Extrapolé** depuis
cette pente : ~2,2 s à 100 000 reçus, **~22 s à un million**. Le même coût est payé par
`GET /api/actions/receipts/verify`, que **vous** appelez sur une requête HTTP, et par le
passage horaire de `audit:chains`.

Ce n'est pas une panne, c'est une trajectoire : au-delà de quelques centaines de milliers
de reçus par locataire, espacez l'audit. Mesurez sur une copie de votre volume réel plutôt
que de croire ces chiffres, qui viennent d'une machine de test.

### 2.6 La liste complète

| | État |
|---|---|
| Facturation, plans, compteurs facturables | **n'existe pas.** Les compteurs sont techniques et explicitement indicatifs |
| Bascule automatique vers une autre région | **n'existe pas.** Un pilote est mono-région, mono-instance |
| Archivage WAL (RPO de quelques secondes) | **non fourni par Oathrion** — c'est au PostgreSQL du client (pgBackRest, WAL-G, ou un service managé). Avec la sauvegarde horaire livrée, **le RPO est d'une heure** |
| Restauration sur une **autre** machine | procédure éprouvée sur la même machine ; **non testée** ailleurs |
| Purge et rétention des données applicatives | **n'existe pas.** Exécutions, reçus et audit s'accumulent |
| API d'administration des locataires | **n'existe pas.** La création d'un client, sa devise et son premier administrateur se font par la procédure de `DEPLOYMENT.md` §6bis ; la suspension se pose en SQL |
| Invitation par courriel | **n'existe pas.** Le jeton est rendu par l'API ; vous le transmettez vous-même |
| Trace distribuée | **n'existe pas.** La corrélation disponible est le `requestId` des journaux |
| Latence / quantiles dans les métriques | **non fourni, délibérément** — voir 2.3 |
| Certificat TLS public, obtenu automatiquement | le chemin TLS entier est vérifié, **sauf l'obtention du certificat** : elle exige un nom DNS public et un port 80 joignable, que seul le client possède |
| Conformité réglementaire | **aucune n'est affirmée.** Le code fournit de la matière d'audit ; la qualification juridique demande un avis externe |
| Cadres d'agents | **l'adaptateur est agnostique, et c'est éprouvé** : son absence de dépendance est vérifiée en lisant son source, et les six formes de méthode que les frameworks emploient (`execute`, `invoke`, `call`, `func`, `run`, `_run`) plus la fonction nue sont chacune éprouvées — exécutée sur ALLOW, **non** exécutée sur APPROVAL_REQUIRED. **Reste non vérifié** : un seul framework est chargé comme vrai code tiers (`@langchain/core` 1.2.9). Les autres formes sont écrites à la main depuis leur API publiée, et une forme n'est pas le framework |

---

## 3. Ce que le client doit fournir

| | |
|---|---|
| **PostgreSQL** | en production, Oathrion n'accepte **que** PostgreSQL, sur tous ses plans. Aucune variable n'y déroge |
| **Un serveur d'outils MCP** | pour que les actions atteignent quelque chose de réel — voir 2.1 et `DEPLOYMENT.md` §6ter |
| **Les sauvegardes, exécutées** | les scripts sont livrés et éprouvés (`npm run verify:backup` 24/24) ; les poser en cron, les surveiller et **essayer une restauration** appartient à l'exploitant |
| **Un collecteur de métriques** | `GET /api/metrics` est servi derrière un jeton ; les règles d'alerte prêtes à coller sont dans `docs/ON-CALL.md` |
| **Un nom DNS et un port 80 joignable** | pour le certificat TLS public |

---

## 4. Les signaux d'astreinte

Quatre conditions justifient de réveiller quelqu'un. `docs/ON-CALL.md` donne pour chacune
le symptôme, la commande et le geste.

| | Signal | Pourquoi c'est grave |
|---|---|---|
| 1 | toutes les instances indisponibles | plus personne n'est servi |
| 2 | une chaîne de reçus rompue | corruption, ou écriture hors d'Oathrion. **Ni l'un ni l'autre ne se répare en redémarrant** |
| 3 | aucune sauvegarde récente | une panne matérielle ordinaire devient une perte définitive |
| 4 | magasin de quotas injoignable | en posture fermée, du trafic légitime est refusé ; en posture ouverte, la protection anti-force-brute a disparu |

Le signal 3 porte sur une **absence**, et c'est le seul qui ne se déclenche jamais tout
seul : une sauvegarde qui échoue bruyamment se remarque, celle qui n'a jamais été lancée ne
produit aucun événement. `deploy/scripts/check-backup-freshness.sh` existe pour cela.

---

## 5. Licence

| Périmètre | Licence |
|---|---|
| `server/` `shared/` `client/` `script/` `deploy/` | **Apache-2.0** (depuis le 27 octobre 2026) : utiliser, modifier, héberger et redistribuer sont permis, aux conditions de la licence (`LICENSE`, `NOTICE`) |
| `sdk/` `cli/` `examples/` | **MIT.** Ces fichiers entrent dans le code du client |
| `conformance/` | **MIT**, et c'est délibéré — voir ci-dessous |

**Publier une vulnérabilité est bienvenu**, selon la procédure de `SECURITY.md`. Oathrion
se vend sur une affirmation vérifiable, et en publier la réfutation doit rester possible.

**Le kit de conformité est sous MIT**, ce qui permet au client de l'exécuter contre
Oathrion, contre une version modifiée, **et contre un produit concurrent**. Un kit de
vérification que seul son éditeur peut exécuter ne vérifie rien.

---

## 6. Reproduire les preuves

Le client n'a pas à nous croire. Toutes ces commandes tournent chez lui, sur l'archive
livrée.

```bash
npm ci
npm run typecheck && npm run lint && npm run test && npm run build
npm run scan:secrets

export PG="postgres://user:motdepasse@hote:5432/postgres"
npm run build
DATABASE_URL=$PG npm run verify:prod-config    # 38 configurations dangereuses refusées
DATABASE_URL=$PG npm run verify:mcp            # le parcours complet, serveur indépendant
DATABASE_URL=$PG npm run verify:obs            # les quatre signaux d'astreinte, provoqués
DATABASE_URL=$PG npm run verify:backup         # sauvegarde et restauration réelles
DATABASE_URL=$PG npm run e2e:multitenant       # deux entreprises, campagne adverse
DATABASE_URL=$PG npm run chaos:postgres        # PostgreSQL réellement arrêté
DATABASE_URL=$PG npm run verify:dr             # restauration sur une AUTRE machine
DATABASE_URL=$PG npm run verify:upgrade        # mise à jour sur données vivantes
DATABASE_URL=$PG SOAK_MINUTES=720 npm run verify:soak   # endurance, version longue
npm run verify:compose                         # la pile Docker entière
npm run conformance                            # le kit, contre ce déploiement
```

Chiffres de la livraison, mesurés sur la machine de release :

| | |
|---|---|
| Suite de tests | **2 090** passés, 0 échec, 78 ignorés |
| `verify:dr` | 28/28 — restauration sur une autre machine |
| `verify:upgrade` | 17/17 — mise à jour N−1 → N, et retour arrière refusé |
| `verify:soak` | 13/13 sur 12 min — **46 524 requêtes, 0 erreur** ; mémoire 233 → 236 Mo, descripteurs et connexions constants |
| `verify:prod-config` | 38/38 |
| `verify:mcp` | 37/37 |
| `verify:obs` | 61/61 |
| `verify:backup` | 24/24 |
| `verify:compose` | 20/20 |
| `conformance` | **CONFORME** — 21 propriétés cœur, 6 étendues |
| `e2e:multitenant` | 73 réussis · **12 bloqués** sur la machine de release, `pg_dump` n'y étant pas installé. Rien n'indique un défaut ; rien ne permet non plus de l'affirmer |
| typecheck · lint · build · `scan:secrets` | 0 |

Chaque banc **imprime ses propres limites** à la fin de son exécution. Ce n'est pas une
politesse : c'est pour qu'un résultat ne puisse pas être cité sans ce qu'il ne couvre pas.

---

## 7. Documents de référence

| | |
|---|---|
| [`limitations.md`](limitations.md) | les limites connues, par domaine. **Le document le plus important de cette liste** |
| [`COMMERCIAL_READINESS.md`](COMMERCIAL_READINESS.md) | l'état de préparation ligne par ligne, avec la preuve de chacune |
| [`ON-CALL.md`](ON-CALL.md) | l'astreinte : symptôme → commande → geste |
| [`security-model.md`](security-model.md) | les deux formes d'application, et ce que chacune peut promettre |
| [`../DEPLOYMENT.md`](../DEPLOYMENT.md) | l'installation, l'onboarding d'un client (§6bis), le branchement de ses outils (§6ter) |
| [`OPERATIONS.md`](OPERATIONS.md) | sauvegarde, restauration, supervision, mise à jour |
| [`../LICENSE`](../LICENSE) | les deux régimes, et la clause de publication des vulnérabilités |
