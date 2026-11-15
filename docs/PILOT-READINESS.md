# État réel pour un pilote fermé

> **DOCUMENT HISTORIQUE.** Les nombres de tests et les résultats ci-dessous ont été mesurés
> sur des versions antérieures du dépôt et ne décrivent PAS la version actuelle. L'état
> vérifié de la version actuelle — commandes, codes de sortie, totaux, limites — est dans
> [`docs/FINAL-PILOT-READINESS.md`](FINAL-PILOT-READINESS.md), et nulle part ailleurs.

Ce document ne décrit pas une intention. Chaque ligne porte la commande qui l'établit, et
celles qui n'ont pas été vérifiées sont marquées comme telles.

**Verdict : `PILOT_READY_WITH_DOCUMENTED_LIMITATIONS`** — pour le périmètre défini en §2.

---

## 1. Matrice des fonctionnalités

`RÉEL` = exécuté et vérifié · `PARTIEL` = fonctionne dans un périmètre réduit ·
`SIMULÉ` = se déclare simulé · `ABSENT` = pas commencé.

| Fonctionnalité | État | Preuve exécutée |
|---|---|---|
| Migrations versionnées, reproductibles | `RÉEL` | 21 migrations · `migrations.test.ts` · `verify:compose` applique la migration avant le serveur |
| Persistance PostgreSQL et SQLite | `RÉEL` | `verify:compose` 20/20 · redémarrage sans perte vérifié |
| Isolation multi-locataire | `RÉEL` | `tenant-isolation*.test.ts` · `multitenant-authority-isolation.test.ts` · `coverage.test.ts` |
| Authentification (sessions, clés d'API) | `RÉEL` | 401 sans jeton, 401 jeton faux, 401 mauvais mot de passe — mesuré sur la pile Docker |
| RBAC par capacités | `RÉEL` | 403 pour une clé `viewer` sur une écriture — mesuré en direct |
| Refus de démarrage si config critique absente | `RÉEL` | `verify:prod-config` **41/41** |
| Audit chaîné | `RÉEL` | `conformance` C32, C33 · `audit-hash-chain.test.ts` |
| ALLOW / BLOCK / APPROVAL_REQUIRED | `RÉEL` | `conformance` **27/27**, 25 mutants attrapés |
| Approbation liée à l'action exacte, usage unique | `RÉEL` | `conformance` C10, C11, C19–C22 |
| Passerelle MCP entrante | `RÉEL` | `conformance` · `mcp-single-path.test.ts` |
| Relais MCP sortant | `RÉEL` | `verify:mcp` **37/37** contre `examples/mcp-server/` |
| Découverte `tools/list` + vérification de schéma | `RÉEL` | `verify:tools` **49/49** · `upstream-schema.test.ts` 14/14 |
| Registre d'outils déclaré (`PLACET_TOOLS`) | `RÉEL` | `verify:tools` |
| **Pare-feu HTTP d'interception** | `RÉEL` | `verify:intercept` **61/61** · `intercept-firewall.test.ts` 39/39 |
| Corps form-encoded relayé brut | `RÉEL` | `verify:intercept` — `metadata[order]` nesté arrive intact, sous le bon `content-type` |
| Allowlist d'en-têtes par règle | `RÉEL` | `verify:intercept` — `Stripe-Account`, `Stripe-Version`, `Idempotency-Key` envoyés par l'agent ne sont pas relayés |
| Approbation humaine sur le pare-feu | `RÉEL` | `verify:intercept` gare une requête, **tue le processus**, le relance et approuve · `intercept-approval-persistence.test.ts` 12/12 |
| Connecteur GitHub | `PARTIEL` | `verify:github` **12/12 sans jeton**. Le parcours écriture exige `PLACET_GITHUB_TEST_TOKEN` et **n'a pas été exécuté ici** |
| Coffre de credentials chiffré | `RÉEL` | `connector-vault.test.ts` 19/19 · AES-256-GCM |
| Effacement d'un locataire | `RÉEL` | `verify:erasure` **18/18**, coffre compris |
| Écran Pare-feu (journal + approbation) | `RÉEL` | lit `/api/executions` et `/api/approvals` |
| Écran Couverture | `RÉEL` | `coverage.test.ts` 9/9 |
| Écran Connecteurs | `RÉEL` | états issus d'appels réels |
| SDK TypeScript et Python | `RÉEL` | 76 + 37 tests |
| Adaptateur `withPlacet` | `PARTIEL` | éprouvé contre des objets de la bonne forme, **pas contre les classes réelles de LangChain** |
| Les cinq outils intégrés | `SIMULÉ` | se déclarent `simulated: true` |
| Écran « Integrations » | `SIMULÉ` | décoratif, hors navigation, porte un avertissement |
| Parcours guidé en 13 étapes | `ABSENT` | remplacé par l'écran Couverture — voir §4 |
| OAuth | `ABSENT` | credentials collés |
| Révocation distante d'un credential | `ABSENT` | impossible par l'API GitHub |
| Facturation, marketplace | `ABSENT` | hors périmètre pilote, volontairement |

---

## 2. Le périmètre que ce pilote couvre

Placet est prêt pour un pilote fermé où :

1. l'entreprise connecte **un ou deux** agents existants ;
2. par **MCP** (recommandé) ou par le **pare-feu HTTP** ;
3. sur **des routes explicitement déclarées**, pas sur tout son trafic ;
4. avec le **credential du service dans le coffre de Placet** ;
5. et un **opérateur humain** qui regarde l'écran Pare-feu pendant la phase d'essai.

Hors de ce périmètre, Placet n'est pas prêt : pas de facturation, pas de libre-service,
pas de catalogue de connecteurs.

*(Le SSO figurait dans cette liste. Il existe depuis §5undecies — OIDC, avec exigence
d'attestation d'authentification forte. SAML, non.)*

---

## 3. Critères de sortie

| | Critère | État |
|---|---|---|
| A | Démarrage reproductible | **SATISFAIT** — `npm run pilot:up` ; `verify:compose` 20/20 |
| B | Persistance survivant à un redémarrage | **SATISFAIT** — `verify:compose` |
| C | Auth et isolation testées | **SATISFAIT** |
| D | Un chemin d'intégration d'agent documenté et testé | **SATISFAIT** — MCP, `verify:mcp` + `verify:tools` |
| E | Un outil externe de bout en bout, ALLOW et BLOCK | **SATISFAIT POUR LE PARE-FEU** (`verify:intercept` 41/41, API cible réelle). **NON VÉRIFIÉ POUR GITHUB** : pas de jeton dans cet environnement |
| F | APPROVAL_REQUIRED | **SATISFAIT** — y compris sur le pare-feu après un redémarrage. Un défaut P0 trouvé et corrigé ici : voir §5bis |
| G | Credentials côté serveur, rien de sensible persisté | **SATISFAIT** — et une fuite a été trouvée et fermée, voir §5 |
| H | De la connexion à une action contrôlée puis à l'audit | **SATISFAIT** pour le pare-feu ; **PARTIEL** dans la console (pas d'assistant) |
| I | Erreurs et états vides honnêtes | **SATISFAIT** |
| J | Build de production | **SATISFAIT** |
| K | Tests rapportés sans embellissement | **SATISFAIT** — §6 |
| L | Limites visibles | **SATISFAIT** — `SECURITY-BOUNDARIES.md` |
| M | Aucun P0 de sécurité dissimulé | **SATISFAIT** — le seul trouvé est publié en §5 |

---

## 4. Ce que je n'ai pas construit, et pourquoi

**L'assistant guidé en treize étapes.** Il n'existe pas. À sa place, l'écran
**Couverture** répond à la question que l'assistant devait servir : où en suis-je, qu'est-ce
qui bloque, et où cliquer. Chaque obstacle porte son motif, et la liste est ordonnée.

Un assistant qui masquerait les choix de sécurité serait pire qu'une liste honnête, et un
assistant à moitié fait serait une suite d'écrans qui promettent une progression sans la
tenir. Les étapes 1 à 5 et 10 du parcours demandé (arrivée, compte, organisation, choix du
mode, mode protégé) **ne sont pas** un parcours guidé aujourd'hui.

**La purge des autres écrans.** On ne peut pas exploiter un pare-feu sans les écrans qui
créent l'agent, écrivent les politiques et délivrent la clé.

---

## 5. Le défaut P0 trouvé pendant cette mission, et sa correction

**La réponse complète du fournisseur était persistée en base.**

`InterceptTool.run()` rend `data` → `AgentGateway` l'écrit dans `toolResult` → la colonne
est sérialisée. Le relais y plaçait `responseBody` et `responseHeaders`. Pour un
remboursement, c'est l'objet client : adresse e-mail, nom, quatre derniers chiffres de la
carte — dans la table que ce produit promet de pouvoir montrer à un auditeur.

Aucun test fonctionnel ne pouvait le voir : la requête partait bien, la réponse revenait
bien, et le contrôle de discrétion voisin regardait la **requête**. Deux directions, un
seul contrôle.

**Corrigé** : la réponse voyage par une table en mémoire, à usage unique, reprise par la
route et écrite nulle part. `data` ne porte plus que des faits de gouvernance — statut,
destination, méthode, chemin, `responseBytes`, `credentialInjected`. Trois assertions
textuelles dans `connector-single-path.test.ts` interdisent le retour, dont une qui
attrape la **demi-correction** : une ligne de la route lisait encore
`toolResult.responseBody` et a survécu au déplacement.

---

## 5bis. Le second P0, trouvé en répondant à « est-ce prêt ? »

**L'approbation humaine du pare-feu avait une fenêtre de soixante secondes.**

La requête interceptée attendait dans une `Map` du processus avec un TTL d'une minute.
Mesuré sur le code livré : *« après 61 s, la requête est : PERDUE »*. Un opérateur qui
approuvait après une minute voyait son approbation réussir et **rien partir**. Un
redémarrage les effaçait toutes. Sur deux instances, approuver sur l'une ne relâchait pas
une requête garée sur l'autre — ce que la mission interdisait explicitement.

Le défaut échouait du bon côté — rien ne partait, le motif était nommé — mais il rendait
la fonctionnalité **inutilisable**. Et le test qui couvrait ce chemin approuvait dans la
milliseconde : il passait, et il ne prouvait rien.

**Corrigé** par la migration 022 : un sas persisté, chiffré, à usage unique, expirant avec
l'approbation (15 minutes par défaut). Écrit **uniquement** sur la voie lente — un ALLOW
ne touche pas cette table. La destination est re-résolue à la reprise. Sans `PLACET_KEK`,
la route répond 503 au lieu de 202.

**Prouvé** : `verify:intercept` gare une requête, **tue le processus**, le relance, et
approuve — la requête part avec son corps exact.

## 5ter. Les deux trous d'une revue hostile, trouvés et fermés

En jouant l'entreprise la plus hostile possible contre Placet, deux trous dans mon propre
code sont apparus. Les deux sont corrigés et prouvés à travers du vrai HTTP.

**1. La politique d'en-têtes était une liste de REFUS.** L'agent contrôlait tous les
en-têtes sauf douze. Sur Stripe Connect, `Stripe-Account: acct_autre` fait agir l'appel
**sur un autre compte** — et la règle n'inspecte que `body.charge` et le plafond. Un agent
compromis remboursait sur le compte d'un tiers, dans les limites autorisées, et l'audit
enregistrait une action conforme. C'est désormais une liste d'**autorisation** par règle,
défaut `content-type` + `accept`, avec un plancher que même une règle ne descend pas.

**2. Le corps était re-sérialisé en JSON.** L'API de Stripe parle
`application/x-www-form-urlencoded` : Placet envoyait un corps JSON sous un en-tête
`form`, que le fournisseur refuse. **L'exemple vedette de `docs/firewall.md` ne pouvait
pas fonctionner.** Le corps part maintenant brut, octet pour octet — ce qui corrige aussi
la perte d'ordre des clés et de précision numérique que toute ré-écriture entraîne.

Et deux durcissements de la même revue : un **plafond** sur la table des réponses en
mémoire (c'était une voie de déni de service qui aurait arrêté tous les agents
gouvernés), et un **avis au démarrage** quand une règle lit un montant sans
`amountScale` — la faute qui rend un plafond faux d'un facteur 100 dans le sens
permissif, et que Placet ne peut pas détecter seul.

## 5quater. Ce que Placet coûte en millisecondes, mesuré

Personne ne l'avait jamais mesuré. Le banc d'endurance éprouvait `authorize`, `execute` et
la lecture des reçus — jamais `POST /api/v1/intercept`, c'est-à-dire la **seule voie qui
soit sur le chemin critique de la production du client**. Et la première question d'une
direction technique n'est pas « ça fuit ? » mais « combien de millisecondes ça me coûte ? ».

`npm run verify:soak` chronométre désormais, à chaque cycle et dans le même cycle, l'amont
**en direct** depuis le script puis le même appel **à travers** le pare-feu. Deux mesures
sous la même charge de machine : mesurer les deux à des moments différents produirait une
différence qui ne serait pas celle de Placet.

| | p50 | p95 | p99 |
|---|---|---|---|
| à travers Placet | 34–40 ms | 61–83 ms | 87–124 ms |
| amont en direct | 2–3 ms | 6–8 ms | 9–14 ms |
| **surcoût du pare-feu** | **32–37 ms** | | |

Trois passages, 1 623 à 1 958 appels appariés chacun, à des débits différents (7,6 à 10,2
cycles/s). Le surcoût est reproductible.

**Ce que ce chiffre n'est pas.** Il est propre à une machine, et l'amont est une boucle
locale : sur un vrai lien réseau, le trajet amont grandit et la part de Placet non, donc
le surcoût **relatif** y est plus faible. Un seul appel circule à la fois — ce banc ne dit
donc **rien** de la latence sous concurrence, ni du comportement quand l'amont lui-même
ralentit. Les deux demandent un banc de charge que personne n'a fait. Aucun SLO ne sort
d'ici.

Le contrôle que le banc PREND, lui, est transposable : un p95 qui double entre la première
et la seconde moitié du régime établi est une panne où que l'on tourne. Mesuré : 56 → 67,
84 → 82, et 92 → 55 ms. Pas de dérive.

### Trois propriétés prouvées par ce banc et par aucun test unitaire

**Un appel AUTORISÉ n'écrit rien dans le sas d'approbation** — maximum 0 ligne sous 2 292
appels tous autorisés. La voie rapide reste en mémoire ; si elle écrivait, le pare-feu
paierait une écriture et une suppression par appel et une table grandirait sous le trafic.

**La table du limiteur ne croît pas avec le trafic** — 1 ligne sous 13 752 requêtes. Une
croissance ici voudrait dire que la clé du limiteur contient quelque chose de variable.

**L'allowlist d'en-têtes tient sous trafic continu, et son coût opérationnel est réel.** Au
premier passage, la règle ne nommait que `content-type` alors que l'amont exige
`MCP-Protocol-Version` : **les 2 100 appels ont été refusés en 400 par l'amont**, avec
`x-placet-decision: ALLOW` sur chacun. L'allowlist faisait exactement son travail. Ce
couple `400 + ALLOW` est le symptôme à connaître — il est documenté dans
`docs/firewall.md` §2bis, parce qu'un exploitant l'attribuera à Placet.

### UN DÉFAUT OUVERT, NON REPRODUIT, ET QUI DOIT ÊTRE DIT

Au second passage : **un appel sur 2 451 a répondu 500**, sans en-tête
`x-placet-decision` — donc la route a levé avant de poser ses en-têtes de gouvernance.
Les 2 450 autres sont passés. Le troisième passage, de cinq minutes et 2 292 appels
relayés, **ne l'a pas reproduit** : 17/17 contrôles, zéro erreur sur 13 752 requêtes.

Ce qui est établi : la panne échoue **du bon côté** — l'appel de l'agent n'est pas parti.
Ce qui ne l'est pas : la cause. Rien n'a été corrigé dans le serveur entre les deux
passages, donc **ce défaut n'est pas réglé, il est seulement non reproduit.** Le banc garde
maintenant les trois premiers échecs en entier — corps, cycle, horodatage, identifiant
d'exécution — plus les quarante dernières lignes du processus filtrées secret par secret,
pour que la prochaine occurrence soit diagnosticable au lieu d'être recomptée.

Conséquence à assumer devant un client : Placet se met **devant** son API, donc il est une
dépendance de niveau 1. Un taux d'erreur inexpliqué, même à une occurrence sur deux mille,
est une question à laquelle il faut une réponse avant un pilote en production — et je n'en
ai pas encore.

## 5quinquies. La latence, réduite de 36 %, et ce qu'elle coûte encore

§5quater disait *combien* : 32 à 37 ms. Un total ne dit pas quoi réparer. `npm run
profile:intercept` répond à *où*, en allumant `PLACET_TIMING_HEADER` — un en-tête
`Server-Timing` standard sur la voie du pare-feu, **éteint par défaut**.

### La vraie cause n'était pas du calcul

```
SELECT 1 (aller-retour pur)             p50 0.91 ms
BEGIN + INSERT + COMMIT                 p50 2.21 ms
```

Un aller-retour vers PostgreSQL coûte **0,91 ms** sur ce montage — la base est dans un
conteneur voisin, atteinte par le réseau ponté. Un appel relayé en faisait une vingtaine,
avec six validations durables. **La latence était un compte d'allers-retours**, pas du
temps processeur. C'est la seule quantité qui s'améliore sur toutes les topologies : sur
un déploiement où la base est sur le même hôte, un aller-retour coûte ~0,1 ms et le même
code paie quelques millisecondes au lieu de vingt.

### Mesure A/B, mêmes conditions, machine au repos

| | total client | plancher amont | **surcoût Placet** |
|---|---|---|---|
| avant | 38,0 ms | 3,1 ms | **34,9 ms** |
| après | 25,2 ms | 2,6 ms | **22,5 ms** |

400 appels de chaque côté. L'état « avant » a été rebâti depuis `git stash` et mesuré sur
la même machine au même moment : un « avant » relevé plus tôt, pendant que la suite de
tests tournait, donnait 45 ms avec un plancher passé de 3,4 à 5,2 ms — ce qui disqualifie
le chiffre au lieu de dire quoi que ce soit sur le code.

### Les trois changements

**La clôture d'un run d'outil est devenue une seule transaction.** La passerelle appelait
`completeToolRun`, `appendAudit`, puis `update` — trois allers-retours et trois
validations pour décrire **un** événement. Le découpage payait un ordre (l'état terminal
d'abord, pour rester rejouable si l'audit n'arrivait pas) ; l'atomicité rend cet ordre
inutile, et un processus qui meurt laisse la réclamation périmée que la reprise par
ancienneté récupère déjà. La chaîne d'audit reste calculée depuis la trace **stockée, sous
verrou**. Au passage, un défaut latent se ferme : l'ancien code ignorait le booléen de
`completeToolRun`, donc un second clôtureur écrasait la trace — c'est désormais refusé.
*9,50 → 3,49 ms.*

**L'agent et les politiques sont lus en parallèle.** Deux lectures indépendantes qui
s'attendaient. L'ordre des refus est préservé.

**Le verrou consultatif est fusionné avec la lecture de dépense.** `pg_advisory_xact_lock`
est un appel dont on ne lit pas le résultat : le replier dans la requête qu'il protège ne
change ni ce qui est verrouillé ni quand.

### Trois optimisations REFUSÉES, et pourquoi

**Pas de cache du coffre** (0,80 ms). Un credential révoqué doit cesser de fonctionner
immédiatement ; un cache d'une seconde, c'est une fenêtre pendant laquelle une clé révoquée
part encore chez le fournisseur.

**Pas de `synchronous_commit = off`.** C'est le levier évident, et il échange la durabilité
contre de la vitesse. Sur une chaîne de reçus qui *est* le produit, c'est le mauvais échange.

**Pas de repli du contrôle de quota** dans la requête fusionnée : il faudrait recopier son
SQL de refus, et une seconde copie d'une règle de refus est une copie qui prend du retard.

### Est-ce « à peine perceptible » ? Deux réponses honnêtes

**Pour l'agent, oui.** Un tour d'agent comporte au moins un appel de modèle, de 500 ms à
plusieurs secondes. 22 ms, c'est **1 à 4 % d'un seul tour**, sous le bruit de n'importe
quel appel réseau réel.

**Pour l'API appelée, non.** Sur un amont à 2,6 ms, Placet multiplie le temps par neuf.
C'est l'artefact du montage décrit plus haut, et il ne faut pas le présenter autrement.

### LE VRAI PLAFOND N'EST PAS LA LATENCE

`auth` coûte 2,61 ms et il est **synchrone** : le plan d'identité — clés d'API, sessions,
organisations — passe par un client PostgreSQL **bloquant**. Ces allers-retours gèlent la
boucle d'événements de Node à chaque requête authentifiée, donc **Placet ne chevauche pas
deux requêtes pendant ce temps**.

C'est invisible sur un banc séquentiel et c'est ce qui cédera d'abord sous concurrence —
ce qui explique aussi pourquoi aucune mesure sous charge n'existe dans ce dépôt. Le
corriger demande de rendre `authenticate()` asynchrone, donc de toucher chaque route. Ce
n'est pas fait, et aucun chiffre de débit ne doit être avancé avant que ce le soit.

## 5sexies. Ce qui manquait « pour plusieurs usages », et ce qui est fait

Un inventaire a été fait de ce qui bloque Placet sur plusieurs appels simultanés,
plusieurs instances, plusieurs clients, et plusieurs cas d'usage. Trois points sont
traités ici ; les autres sont nommés avec ce qui les bloque.

### FAIT — les APIs REST qui mettent la ressource dans l'URL

Une API sur deux écrit la cible dans le chemin : `POST /v1/charges/{charge}/capture`,
`POST /repos/{owner}/{repo}/issues`. L'extracteur ne lisait que `body.`, `query.` et
`header.` — **ces routes n'étaient pas gouvernables du tout**, la cible était introuvable
et Placet refusait en 422 à chaque appel.

Un motif capture désormais un segment nommé (`{charge}`), lu par `path.charge`. Le segment
vaut **un** segment, comme `*`.

**La faille trouvée en l'écrivant :** un segment d'URL est encodable. Un agent qui connaît
une politique de refus sur `ch_interdit` appelle `/v1/charges/ch%5Finterdit/capture` — si
Placet juge la chaîne encodée, il ne reconnaît pas la cible refusée, autorise, et le
fournisseur décode puis agit sur la charge interdite. Donc : **la cible jugée est décodée,
le chemin relayé part inchangé octet pour octet**, et un segment indécodable fait échouer
l'appariement. Vérifié par mutation : décodage retiré → trois tests tombent.

Une source `path.x` dont le motif ne déclare pas `{x}` **refuse le démarrage**, avec la
liste des segments déclarés.

### FAIT — une clé du fournisseur PAR LOCATAIRE

Le coffre n'acceptait qu'un connecteur du catalogue, et le catalogue contient une entrée :
`github`. Pour toute autre destination, le relais retombait sur
`PLACET_INTERCEPT_KEY_<DESTINATION>`, une variable d'environnement **valant pour tout le
déploiement** : deux organisations clientes partageaient la même clé Stripe, et rien ne le
disait.

`PUT /api/destinations/:id/credential` scelle la clé d'un locataire pour une destination
**enregistrée et visible pour lui** — sans cette vérification la route serait un magasin de
secrets à clé libre. L'état est **`stored_unverified`, jamais `connected`** : il n'existe
aucune sonde pour une API quelconque, et une pastille verte sur une clé que personne n'a
essayée serait le faux statut « protégé ».

`GET /api/destinations` divulgue laquelle des trois situations s'applique : clé du
locataire (état + empreinte, jamais la clé), **`shared: true`** — la clé du déploiement,
commune à tous les locataires —, ou `none`. La révocation rend `fallsBackToDeploymentKey` :
révoquer la clé d'un locataire ne coupe pas l'injection quand la variable existe, elle y
retombe.

### CORRIGÉ DANS L'INVENTAIRE — le limiteur n'est pas un trou de production

L'inventaire disait que derrière deux instances le plafond doublait silencieusement.
**C'est faux en production** : `server/database-config.ts` refuse de démarrer si
`NODE_ENV=production` sans `RATE_LIMIT_STORE=postgres` — « per-process rate limiting is not
a production mode ». Le compteur local est inatteignable là où il ferait des dégâts.

Ce qui restait réel est plus petit : une préproduction ou une démonstration montée à
plusieurs instances. Un avis au démarrage le nomme, et dit explicitement que la production
ne peut pas atteindre ce mode — pour que personne ne le recompte comme un risque.

### NON FAIT, et ce qui les bloque

| Manque | Conséquence | Pourquoi pas maintenant |
|---|---|---|
| **le plan d'identité est synchrone et bloquant** | la boucle d'événements gèle à chaque requête authentifiée : Placet ne chevauche pas deux requêtes. **C'est le plafond de débit réel** | demande de rendre `authenticate()` asynchrone, donc de toucher chaque route |
| **aucun banc de charge** | aucun chiffre de débit n'est défendable | à faire APRÈS le point ci-dessus, sinon le chiffre est à refaire |
| ~~le relais ne diffuse pas~~ | **FAIT** — voir §5septies | |
| pas de corps multipart ni binaire | pas de téléversement gouverné | même chantier que le flux |
| ~~pas de SSO/MFA~~ | **FAIT** — OIDC avec exigence d'attestation, voir §5undecies. **SAML reste absent** | |
| pas de séparation des tâches | rien n'empêche l'auteur d'une politique d'approuver l'action de son propre agent. Les quatre yeux sont une exigence écrite en banque | non commencé |
| métriques en mémoire par instance | un compteur lu sur une instance ne dit rien du déploiement | le scrapeur doit agréger ; à documenter dans le guide multi-instance, qui n'existe pas |

## 5septies. Le relais en flux — Placet devant une API de modèle

C'était le manque d'usage le plus visible : le relais TAMPONNAIT, donc une API qui répond
en `text/event-stream` perdait son streaming, et une réponse longue butait sur le plafond
de 1 Mio et faisait échouer l'appel. Pour un produit qui gouverne des agents IA, le cas
d'usage le plus naturel était hors de portée.

### Mesuré, pas affirmé

Un amont émet un événement, **attend 250 ms**, émet le second. Aucun relais ne peut
rattraper cette pause.

| | premier octet | dernier octet |
|---|---|---|
| règle avec `stream` | **32 ms** | 279 ms |
| même amont, sans `stream` | 325 ms | 325 ms |

Le second est un **contrôle négatif** sur le même amont : sans lui, la mesure pourrait
être celle d'un réseau lent. Le contenu final est identique dans les deux modes — c'est la
seule mesure qui les distingue.

`npm run verify:intercept` : **67/67** (61 avant), et `server/test/intercept-streaming.test.ts` : **7/7**.

### La difficulté de conception, et sa résolution

Un `ToolResult` est rendu quand `run()` se termine. Pour un flux, `run()` ne peut pas se
terminer avant la fin du transfert — sinon le reçu porterait un nombre d'octets pris au
milieu. Mais la route doit commencer à relayer bien avant.

Inconciliable par la valeur de retour ; conciliable par un **passage de main** : l'outil
publie dès les en-têtes, la route pipe, l'outil attend la fin, et le reçu porte les octets
réellement passés et la troncature réellement subie. L'ordre de gouvernance est intact —
ce passage n'existe que si `run()` a été atteint, donc après un ALLOW et la consommation
du grant.

L'identifiant d'exécution voyage dans ce passage de main : une fois le flux commencé,
aucun en-tête ne peut plus être posé, et sans lui une réponse en flux aurait été la seule
réponse du pare-feu qu'un auditeur ne peut pas relier à son reçu.

### Les bornes, déplacées et non retirées

64 Mio, 60 s de silence, 10 min au total. Le dépassement **coupe** plutôt que refuse —
l'agent a déjà reçu des octets — et `truncated` est persisté : un auditeur doit savoir que
l'agent a agi sur une réponse partielle alors que l'effet chez le fournisseur a eu lieu en
entier. La contre-pression est codée : un agent plus lent que le fournisseur met l'amont
en pause, sinon le tampon intermédiaire reconstituerait en mémoire ce que le flux évite.

### Deux découvertes, dont une qui change une recommandation

**Le catalogue n'avait aucun verbe utilisable.** `call_api` est délibérément sans portée de
permission, et le registre refuse de câbler un verbe sans portée ; le re-gater retirerait
la portée d'un coup à tous les agents livrés. D'où **`api.request`**, gaté par
`call:external-api` — une portée qui existait dans `PermissionScope` sans qu'aucune action
ne l'exige, donc déclarable et inexigible.

**Un plafond de montant à l'échelle de l'organisation bloque un appel de modèle.** Le banc
l'a donné en clair : *« caps this action at 500,00 €, but the action declares no numeric
amount »*. Un appel de modèle ne porte pas de montant, un plafond en euros ne peut pas le
borner, et le moteur refuse — fail-closed, dans le bon sens.

**Recommandation pour un pilote, corrigée :** restreignez le plafond aux verbes qui
portent un montant avec `condition.actions` — le champ que le jeu de politiques livré
emploie déjà pour `pol_purchase_limit`. La première version de cette section conseillait
`appliesToAgentIds`, ce qui marche mais répond à une autre question : borner un AGENT
plutôt qu'un VERBE. L'erreur venait d'une lecture incomplète de `PolicyCondition`, dont
seuls les trois `kind` avaient été regardés.

### Ce qui n'est pas mesuré

L'amont du banc est local et émet quelques centaines d'octets. Rien ne dit le comportement
sur un flux de plusieurs minutes, sous concurrence, ni quand l'agent est plus lent que le
fournisseur : la contre-pression est **codée et bornée, pas mesurée sous charge**. Aucun
des trois plafonds n'a été atteint par un passage.

## 5octies. Les jetons courts, et l'approbation depuis Slack

Deux manques de l'inventaire « plusieurs usages », traités ensemble parce qu'ils ouvrent
les deux moitiés d'un déploiement d'entreprise : les outils Microsoft/Google d'un côté, le
geste humain de l'autre.

### FAIT CONTRE UN FOURNISSEUR LOCAL — le rafraîchissement OAuth (non éprouvé contre Google)

> **Correction d'audit (9fb5091).** Cette section disait « FAIT » sans réserve, et la
> documentation donnait un exemple `PLACET_OAUTH_GOOGLE` comme une voie praticable. Ce
> n'en est pas une : le renouvellement n'a jamais été éprouvé contre Google, Microsoft ni
> Salesforce, et Placet n'offre pas le parcours de consentement qui délivre le jeton de
> rafraîchissement. Les instructions Google ont été retirées ; Google Workspace est hors du
> périmètre de lancement.

Le pare-feu injectait **un en-tête statique**, donc il ne savait travailler qu'avec une
clé de longue durée. Les fournisseurs à jetons d'une heure en restaient exclus : un jeton
collé y expirait en silence, puis chaque appel recevait un 401.

Le partage est celui du reste du produit : **l'application** (`tokenUrl`, `clientId`,
`clientSecret`) dans `PLACET_OAUTH_<DESTINATION>`, qui vaut pour le déploiement ; **le
jeton de rafraîchissement** dans le coffre, chiffré, par locataire, révocable.

Ce qui a demandé le plus de soin n'est pas l'échange :

| propriété | pourquoi |
|---|---|
| **un seul vol** — trois appels concurrents, un échange | Salesforce et Microsoft font tourner le jeton de rafraîchissement à chaque usage ; deux échanges simultanés s'invalideraient mutuellement |
| la clé de cache porte **l'empreinte du jeton de rafraîchissement** | sinon, remplacer le jeton après une révocation laisserait Placet injecter une heure durant un accès obtenu avec le consentement retiré |
| marge de 60 s avant l'échéance | un jeton « valide » pour Placet mais refusé par le fournisseur le temps du trajet donne un 401 intermittent, l'un des symptômes les plus coûteux à diagnostiquer |
| **le corps d'une erreur n'est jamais repris** | un point d'échange peut renvoyer la requête en écho, donc le `clientSecret` |
| un échec **refuse l'appel** (`oauth_unavailable`) | relayer sans credential obligerait l'agent à porter sa propre clé, donc rendrait le contournement possible |
| le point d'échange passe par **le résolveur anti-SSRF** | c'est une URL configurable vers laquelle Placet envoie un `clientSecret` |

`server/test/oauth-refresh.test.ts` : **24/24**, dont la preuve mesurée côté amont que ce
qui part est le jeton d'accès et jamais le jeton de rafraîchissement.

### FAIT — l'approbation depuis Slack, avec ses boutons

`PLACET_WEBHOOK_URL` pouvait déjà pointer sur un webhook entrant Slack, donc la
notification arrivait — sans bouton. L'approbateur lisait dans Slack et allait cliquer dans
la console : deux outils pour le geste qui bloque une action en production.

**C'est le seul point d'entrée de Placet sans credential Placet.** Si un contrôle cède,
n'importe qui sur Internet approuve n'importe quelle action d'agent. Quatre contrôles, et
chacun est prouvé par un mutant :

| contrôle | mutant retiré |
|---|---|
| signature HMAC de l'application, sur le corps **brut** | — |
| fraîcheur ±5 minutes | **2 tests tombent** |
| correspondance nominative `PLACET_SLACK_APPROVERS` | **1 test tombe** |
| capacité `approve` du rôle de la personne | **1 test tombe** |

Le troisième est celui qu'on oublie : une signature valide prouve que **l'application
Slack est la nôtre**, pas que la personne a le droit d'approuver — un espace de travail
contient toute l'entreprise. Le quatrième existe parce que sans lui, écrire un identifiant
Slack dans une variable d'environnement accorderait un pouvoir que l'écran des rôles dit
ne pas avoir donné.

Deux refus de démarrage : un webhook Slack **sans** secret de signature, et une liste
d'approbateurs vide. La résolution passe par `gateway.resolveApproval`, exactement la
méthode de la route de console — pas un second chemin vers l'effet. Et `resolvedBy` porte
les deux identités (`"Nom (Slack U123ABC)"`), parce que le canal fait partie du fait.

`server/test/slack-approval.test.ts` : **15/15**. Chaque test vérifie **l'état réel de
l'approbation** après coup, pas seulement la réponse rendue : une route peut répondre
« refusé » et avoir résolu l'approbation.

### UNE LIMITE ASSUMÉE

Un utilisateur de console appartenant à **plusieurs organisations** ne peut pas approuver
depuis Slack : un clic ne dit pas pour quel locataire la personne agit, et choisir la
première appartenance ferait résoudre l'approbation d'un client par un geste destiné à un
autre. Pour ces utilisateurs, l'approbation reste dans la console, où le locataire est
porté par la session.

### UNE ERREUR DE L'INVENTAIRE, CORRIGÉE

§5septies recommandait `appliesToAgentIds` pour éviter qu'un plafond de montant bloque un
appel de modèle. `PolicyCondition` a un champ **`actions`**, le moteur l'honore, et le jeu
de politiques livré l'emploie déjà pour `pol_purchase_limit` : c'est lui qu'il faut
employer. L'erreur venait d'une lecture incomplète du type — seuls les trois `kind`
avaient été regardés. Les trois documents concernés sont corrigés.

## 5nonies. Le débit, mesuré — et une hypothèse de la mienne corrigée

Les quatre derniers manques de l'inventaire. Les deux premiers sont faits ; les deux
autres ont surtout produit **une mesure qui corrige ce que j'affirmais**.

### FAIT — AWS SigV4

Signer la requête au lieu d'injecter un en-tête. S3, Bedrock, Lambda, SQS, DynamoDB
deviennent gouvernables. `server/test/sigv4.test.ts` : **32/32**, dont sept scénarios où
**deux implémentations indépendantes** — celle de production et une seconde écrite dans le
test depuis le texte de la spécification — tombent sur la même signature.

Pas de vecteur officiel : les bancs d'essai publiés par AWS n'étaient pas accessibles
depuis cet environnement, et **je n'ai pas écrit de signature attendue de mémoire** — si
elle est fausse, la tentation est d'ajuster l'implémentation pour qu'elle corresponde à un
vecteur inventé, ce qui est pire que pas de test. **Aucun appel réel à AWS n'a eu lieu : un
pilote doit en faire un avant de s'y fier.**

Signer RENFORCE la garantie : un agent ne peut pas faire signer une requête puis en
envoyer une autre, puisque le hachage du corps est dans la signature.

### FAIT — les téléversements multipart

Le corps part octet pour octet. `server/test/intercept-multipart.test.ts` : **10/10**, et
le test a trouvé **deux** défauts :

1. `rawBody` n'était capturé que par les parseurs JSON et form-encoded, donc un multipart
   partait **vide** — sans erreur nulle part.
2. Le corps brut voyageait dans une chaîne écrite en UTF-8 : **288 octets envoyés, 293
   reçus**, et 2 Mio d'aléatoire devenaient 3 Mio. Un fichier systématiquement corrompu.

Le corps voyage maintenant en latin1 (un octet, un point de code), et la convention vit à
un seul endroit — `server/intercept/raw-body.ts` — plutôt qu'en souvenir réparti.

### FAIT — le banc de charge, qui manquait pour tout le reste

`npm run verify:load` : paliers 1, 4, 16, 64 clients en boucle fermée. Et une **sonde** :
pendant la charge, un client solitaire appelle `/api/live`, qui ne s'authentifie pas et ne
touche pas la base — sa latence est l'attente dans la file de la boucle d'événements.

Plus une **jauge de retard de boucle** (`placet_event_loop_delay_p99_ms` dans
`/api/metrics`), parce que la sonde seule ne distingue pas « le serveur est chargé » de
« le serveur est BLOQUÉ ». Les deux ensemble attribuent la cause ; ni l'un ni l'autre ne
le fait seul.

| | 1 client | 64 clients |
|---|---|---|
| débit | 52 req/s | 84 req/s |
| p50 | 18 ms | 698 ms |
| sonde `/api/live` p95 | 14 ms | **84 ms** |
| retard de boucle | | **p99 74 ms · max 213 ms** |

Un retard de boucle de 74 ms au p99 ne vient pas d'une file de tâches : aucune quantité de
travail asynchrone ne tient la boucle pendant des dizaines de millisecondes. **La boucle
est bloquée.**

### UNE HYPOTHÈSE À MOI, D'ABORD RÉFUTÉE PAR UNE MAUVAISE EXPÉRIENCE

J'ai affirmé plusieurs fois que le plan d'identité synchrone était « le vrai plafond ».
Pour le vérifier, j'ai basculé le plan d'identité sur SQLite local — lectures en
microsecondes au lieu d'un aller-retour PostgreSQL bloquant. Le débit a **baissé** (84 →
51 req/s) et le retard de boucle a **augmenté** (74 → 116 ms).

J'ai donc d'abord conclu que j'avais tort. **C'était l'expérience qui était fausse** :
better-sqlite3 est lui aussi synchrone, et `api-keys.ts` appelait `rawDb.prepare()` à
chaque lecture. J'avais échangé une implémentation bloquante contre une autre, pas mesuré
« bloquant contre non bloquant ».

Un **profil processeur** sous 48 clients a nommé la cause sans ambiguïté — les deux plus
gros consommateurs du processus, loin devant le reste :

```
1402 ms  m ← get ← resolve   ← authenticate   (apiKeyStore.resolve)
1163 ms  m ← get ← isActive  ← authenticate   (organizationStore.isActive)
```

**2,6 s de temps bloquant sur 11 s de profil**, pour les deux lectures d'identité de
l'authentification. L'hypothèse était juste ; la façon de la tester ne l'était pas.

### FAIT, PARTIELLEMENT — une lecture d'identité au lieu de deux

Les deux lectures sont devenues **une jointure**. Ce n'est pas un cache : révocation d'une
clé et suspension d'une organisation prennent effet au prochain appel, exactement comme
avant. Et les déclarations préparées de ce chemin sont hissées hors des appels — elles
étaient recompilées à chaque lecture.

| à 64 clients | avant | après |
|---|---|---|
| débit | 84 req/s | **101 req/s** (+20 %) |
| p50 | 698 ms | **592 ms** |
| p95 | 1131 ms | **861 ms** (−24 %) |
| retard de boucle p99 | 74 ms | **59 ms** |

### CE QUI RESTE, ET POURQUOI C'EST VOTRE DÉCISION ET PAS LA MIENNE

La boucle est **encore bloquée** (p99 59 ms) : il reste une lecture d'identité bloquante
par requête authentifiée, et le plan d'identité en fait d'autres ailleurs.

La supprimer demande de choisir entre deux choses, et le choix a un prix de sécurité dans
les deux sens :

| option | ce qu'elle coûte |
|---|---|
| **un cache d'identité** (TTL d'une seconde) | la révocation d'une clé prend jusqu'à une seconde. Aujourd'hui elle est immédiate, et c'est une propriété qu'un auditeur vérifie |
| **un plan d'identité asynchrone** | deux implémentations des opérations de sécurité (SQLite et PostgreSQL), là où la phase 12 en a délibérément gardé UNE — « une différence de sécurité entre les deux moteurs serait interdite, et la meilleure façon de l'interdire est de n'avoir qu'un seul code » |

Le blocage n'est donc pas un oubli : c'est le prix écrit de la phase 12. Le lever est une
décision de produit, pas une optimisation, et je ne la prends pas seul.

## 5decies. UNE ANOMALIE OUVERTE, TROUVÉE PAR LA SUITE, ET SA SÉVÉRITÉ BORNÉE

Deux passages de la suite complète ont chacun produit **un** fichier en échec, et jamais le
même. Les deux sont rapportés ici parce qu'un échec intermittent qu'on ne raconte pas est
un échec qu'on finira par ignorer.

### Le premier était le mien, et il est corrigé

`intercept-streaming.test.ts` : **« Hook timed out in 10000ms »**, donc zéro test exécuté —
pas un test faux, une mise en place interrompue. Cette mise en place démarre un amont,
importe le harnais, ouvre une session et crée un agent, une politique et une clé. Sur une
machine chargée, dix secondes ne suffisent pas.

Les trois fichiers que j'ai ajoutés avec ce genre de mise en place sont passés à soixante
secondes. Un délai trop court ne protège de rien ici — il n'y a pas de boucle infinie
possible dans ces appels — et il transforme une machine occupée en échec de suite,
c'est-à-dire en bruit qui apprend à ignorer les échecs.

### Le second ne l'est pas, et il faut le lire en entier

`multitenant-authority-isolation.test.ts` : deux cas attendaient `null` et ont reçu un
grant. Le titre des cas dit « isolation entre locataires », donc la première lecture est
alarmante. **Le contenu du grant dit autre chose :**

```json
{
  "id": "grant_7782b55b…",  "agentId": "agt_b",
  "destinationId": "alpha-payments",
  "decision": "BLOCK",      "state": "issued",
  "idempotencyKey": null
}
```

**La décision EST `BLOCK`.** L'isolation a tenu : le locataire B a bien été refusé sur la
destination du locataire A, avec le motif « not registered for this tenant ». L'anomalie
est qu'un **enregistrement de grant existe** alors que `authorize()` rend `grant: null`
pour un BLOCK.

### LA SÉVÉRITÉ, BORNÉE PAR UNE VÉRIFICATION ET PAS PAR UN RAISONNEMENT

Un grant qui ne devrait pas exister est inquiétant si on peut le consommer. On ne peut
pas :

```sql
UPDATE action_grants SET state = 'consumed' …
  WHERE … AND state = 'issued' AND decision <> 'BLOCK' AND expires_at > ?
```

`consumeGrant` refuse explicitement un grant dont la décision est BLOCK. Donc **rien ne
s'exécute** : l'anomalie est un enregistrement en trop, pas une autorisation en trop.

Et cette clause est instructive en elle-même — elle n'aurait aucune raison d'exister si le
cas était impossible. Quelqu'un l'avait déjà rencontré et avait fermé la porte au seul
endroit qui compte.

### CE QUE JE NE SAIS PAS, ET QUE JE NE PRÉTENDS PAS SAVOIR

Le mécanisme. `authorize()` rend `grant: null` avant tout appel à `createGrant` quand la
décision est BLOCK, et la seule autre voie — un rejeu idempotent — exige une
`idempotencyKey`, qui est `null` ici. Cinq passages isolés du fichier donnent **29/29**.

Ce n'est **pas** causé par le travail de cette session : rien n'y touche au plan
d'autorité, ni à `createAction`, ni à `createGrant`, ni à `evaluate`.

Ce qui est établi : l'isolation entre locataires a tenu, et le grant ne peut pas être
consommé. Ce qui reste ouvert : pourquoi la ligne existe, et pourquoi seulement sous
suite complète.

### CE QUE LA REVUE DE PRÉ-LANCEMENT A AJOUTÉ

**Les deux voies connues sont fermées, vérifiées ligne par ligne et non supposées.**

1. `authorize()` retourne avant tout appel à `createGrant` sur un verdict BLOCK.
2. Le rejeu idempotent est **inatteignable** pour le test en cause :
   `buildActionEnvelope` écrit `idempotencyKey: request.idempotencyKey ?? null`
   (`server/action/canonical.ts:168`), l'assistant `refund()` du test n'en passe aucune,
   et `createAction` ne consulte la déduplication que `if (record.idempotencyKey)`. La
   branche de rejeu ne peut donc pas s'exécuter.
3. `evaluate()` refuse par `isRegisteredDestination`, qui est une **comparaison exacte**
   de chaînes (`destinationVisibleTo` : `entry.organizations === "*" ||
   entry.organizations.includes(organizationId)`). Il n'y a ni joker ni correspondance
   par préfixe, et aucun cache de module : la fonction est pure vis-à-vis de l'`env`
   qu'on lui passe.

Autrement dit, **d'après le code, l'anomalie est impossible par ces trois voies.** Elle
n'a pas été reproduite : huit passages isolés supplémentaires donnent 31/31.

**CE QUI A ÉTÉ CORRIGÉ N'EST PAS LE MÉCANISME — C'EST L'ABSENCE D'INVARIANTE.**

La contrainte « un grant BLOCK n'existe pas » n'était posée **nulle part à l'écriture**.
`consumeGrant` portait `AND decision <> 'BLOCK'`, donc rien ne pouvait s'exécuter — mais
une consommation bloquée laisse la BASE dans un état incohérent : un auditeur qui lit la
table y voit une autorisation là où il n'y en a jamais eu. La contrainte n'existait qu'à
la lecture.

`createGrant` refuse désormais, au seul point d'écriture :

```ts
if (grant.decision === "BLOCK") {
  throw new Error(`Refus d'écrire un grant dont la décision est BLOCK (…)`);
}
```

Deux effets, et le second est le plus utile :

* l'état incohérent devient **impossible à écrire**, quelle que soit la voie ;
* si le mécanisme inconnu se déclenche à nouveau, il **lève avec son propre nom** au lieu
  d'écrire une ligne en silence. Une anomalie qui se signale finit par être trouvée ;
  celle-ci avait coûté deux passages de suite à simplement être *remarquée*.

Le garde est redondant avec `authorize()` par construction, et c'est voulu : une
invariante de données appartient à la couche qui écrit les données, pas à l'appelant qui a
eu raison aujourd'hui. Deux tests l'affirment, dans
`server/test/helpers/authority-tenant-attacks.ts`, et un mutant qui retire le garde en
tue un.

**Statut honnête : anomalie NON REPRODUITE, mécanisme INCONNU, état incohérent rendu
impossible à écrire et bruyant s'il est tenté.** À surveiller sous suite complète ; le
runner conserve le journal dans `/tmp/fail-<fichier>.log`.

## 5undecies. LE SSO — le verrou d'achat, levé

C'était le premier filtre du processus fournisseur d'une banque, d'un assureur ou d'un
hôpital : pas de SSO fédéré, pas de MFA, et l'équipe IAM arrête le dossier avant qu'un
architecte ait ouvert la documentation. Zéro ligne existait.

### La décision qui structure tout

**Le SSO est une nouvelle façon d'OBTENIR une session, pas un nouveau système de
sessions.** Le jeton d'identité du fournisseur établit qui se connecte ; ensuite,
`auth.openSession()` fait exactement ce qu'elle fait pour un mot de passe.

Donc révocation, liste des sessions, expiration et trace d'audit marchent sans une ligne
de plus — et il n'existe pas **deux implémentations de « qui a le droit d'ouvrir une
session et dans quel locataire »**, la classe de divergence qui produit un trou qu'on
corrige d'un côté et pas de l'autre. `oidc-flow.test.ts` le vérifie en révoquant une
session SSO par la route ordinaire.

### Les quatre portes, chacune prouvée par mutation

| contrôle | ce qu'il empêche | mutant retiré |
|---|---|---|
| **liste d'algorithmes** (asymétriques seuls) | `alg: none` et la **confusion d'algorithme** — un jeton `HS256` signé avec la clé PUBLIQUE du JWKS, qui est publique | **2 tests** |
| **`state` + cookie `HttpOnly`** | le **CSRF de connexion** : la victime connectée au compte de l'attaquant | **2 tests** |
| **`nonce` dans le jeton** | le rejeu d'un jeton capturé | **2 tests** |
| **`state` à usage unique** | le rejeu d'un retour capturé | 1 test |
| **`kid` exact** | l'attaquant choisirait la clé de validation | 1 test |
| **audience exacte** | l'escalade depuis une autre application du même IdP | 1 test |
| **refus par défaut d'une adresse inconnue** | tout l'annuaire du client dans la console | 1 test |

`oidc-token.test.ts` **33/33** et `oidc-flow.test.ts` **20/20**, avec de vraies clés RSA
et EC générées à l'exécution et un signataire écrit à la main dans le test — c'est ce qui
permet de fabriquer des jetons que le code de production refuserait d'écrire.

### LE MFA EST EXIGÉ, PAS IMPLÉMENTÉ

`"requiredAmr": ["mfa"]` ou `"requiredAcr": [...]`. C'est le fournisseur qui fait
l'authentification forte ; Placet en exige la **preuve** et refuse sans elle, avec un
motif qui dit « Placet ne la simule pas ». Un fournisseur muet fait refuser l'accès.

C'est défendable devant une équipe IAM parce que c'est vérifiable. « Nous acceptons ce que
votre IdP envoie » ne l'est pas.

### Le défaut trouvé par le test, visible seulement sur un processus froid

Les comptes de `PLACET_CONSOLE_USERS` n'existent **en base** qu'après la résolution de la
configuration. La route cherchait l'utilisateur par son adresse sans déclencher cette
adoption : **la première connexion SSO après un démarrage était refusée**. Et avec le
provisionnement automatique, elle aurait créé un **doublon au rôle le plus faible** pour
une adresse désignant un administrateur configuré.

### Trois refus par défaut

- **le provisionnement automatique est désactivé** — sinon tout l'annuaire du client entre
- **`jitRole` ne peut pas être `admin`** — la configuration le refuse, parce que ce serait
  faire de l'annuaire du client la liste des administrateurs de Placet
- **un compte créé par SSO n'a aucun mot de passe utilisable**, par construction : sa
  valeur stockée n'a pas la forme d'une enveloppe scrypt

### Ce que Placet ne garde pas, et ce qu'il ne sait pas faire

Ni le jeton d'accès ni le jeton de rafraîchissement du fournisseur : Placet n'appelle
aucune API au nom de l'utilisateur, il lui faut une preuve d'identité, une fois.

**Deux limites écrites** : un utilisateur appartenant à plusieurs organisations ne peut pas
se connecter par SSO (un jeton ne porte pas le locataire, et deviner placerait quelqu'un
dans le mauvais) ; et l'état d'une tentative vit en mémoire, donc derrière deux instances
sans affinité de session le retour peut atterrir sur la mauvaise et la connexion est
refusée — le sens sûr, mais une contrainte de déploiement.

**Et ce qui n'est pas fait : SAML.** Certains grands comptes l'exigent encore. OIDC couvre
Okta, Entra ID, Google Workspace, Auth0 et Keycloak ; un client qui n'a que du SAML a
besoin d'autre chose, et aucun passerelle n'est écrite ici.

## 5duodecies. LA REVUE DE PRÉ-LANCEMENT — huit défauts réels, et ce qu'ils avaient en commun

Cette section rend compte d'une passe de stabilisation menée avant le premier pilote. Les
défauts trouvés ne se ressemblent pas, mais **sept sur huit ont la même forme** : une
promesse plus large que ce qui était éprouvé.

### 1. Trois algorithmes de signature annoncés, aucun utilisable

`ALLOWED_ALGORITHMS` annonçait neuf algorithmes de signature pour les jetons d'identité.
Les tests en exerçaient **deux**. Trois des sept non exercés — PS256, PS384, PS512 —
**refusaient toute signature valide** :

```ts
{ key, padding: 6 /* RSA_PKCS1_PSS_PADDING */, saltLength: 0 /* RSA_PSS_SALTLEN_DIGEST */ }
```

Le commentaire disait l'inverse du code : `RSA_PSS_SALTLEN_DIGEST` vaut **-1**, et `0`
demande un sel de longueur nulle. La RFC 7518 §3.5 fixe la longueur de sel à celle du
condensat.

Un client dont le fournisseur signe en PS256 aurait vu **chaque** connexion refusée pour
`bad_signature` — un message qui désigne la mauvaise cause et envoie l'exploitant chercher
une clé fausse ou un JWKS périmé.

**Corrigé** avec les constantes nommées de Node. Et la cause derrière le défaut est
corrigée aussi : la liste est exportée et le test **itère sur elle**, quatre cas par
algorithme avec de vraies clés. Ajouter un algorithme sans pouvoir le signer fait tomber
la suite. Les neuf sont éprouvés : signature valide acceptée, signature d'une autre clé
refusée, bit retourné refusé, en-tête mensonger refusé.

### 2. Un drapeau qui ouvrait le réseau interne, et y envoyait le secret du client

`PLACET_OIDC_ALLOW_HTTP=1` levait bien plus que son nom n'annonce :

* il sautait `resolveDownstreamDestination` **en bloc**, pour n'importe quelle adresse ;
* il posait `allowPrivate: true` sur l'échange de code — l'appel qui transporte le
  `clientSecret`.

Un `issuer` en `http://169.254.169.254` — le service de métadonnées des hébergeurs —
suffisait à faire de Placet un client HTTP pointé sur le réseau interne, porteur d'un
secret.

**Corrigé.** L'exception est bornée à la boucle locale (`127.0.0.0/8` en entier, pas la
seule `127.0.0.1`), jugée sur la **cible réelle de chaque appel** et non sur la présence
du drapeau, et **refusée au démarrage** avec `NODE_ENV=production`. Le refus est posé
avant l'analyse de la configuration, pour qu'une autre faute ne le masque pas.

### 3. Quatre URL de configuration jamais analysées

`redirectUri`, `authorizationEndpoint`, `tokenEndpoint` et `jwksUri` étaient lues comme de
simples chaînes. Une faute de frappe ne se voyait qu'à la première connexion d'un
utilisateur réel, et un schéma inattendu (`file:`, `data:`) traversait sans un mot.

**Corrigé** : schéma, identifiant dans l'URL, fragment, et pour l'URL de retour le chemin
exact de la route réellement servie — dont la constante n'a plus qu'une définition.

### 4. `azp` non vérifié, `nbf` non vérifié

OpenID Connect Core §3.1.3.7 règle 3 exige `azp` dès que `aud` porte plusieurs valeurs, et
le contrôle d'appartenance ne le couvre pas : un jeton dont `aud` vaut
`["autre-app", "placet-console"]` satisfait l'appartenance tout en ayant été émis **à la
demande** d'une autre application. Si cette application est compromise, ou simplement
moins regardante, son jeton ouvrait une session de console ici.

Un test existant affirmait précisément ce cas comme **accepté**. Il a été réénoncé, et le
test dit pourquoi : le code est devenu plus strict, ce n'est pas une protection relâchée
pour verdir une suite.

### 5. L'identité liée par adresse électronique

La route faisait `findByEmail(verdict.email)`, et rien d'autre. **Une adresse est
réattribuable** dans un annuaire d'entreprise : un départ, une homonymie, un alias repris
par le service informatique. Le jour où cela arrive, la nouvelle personne héritait
silencieusement du compte de console de l'ancienne — rôle, organisation et approbations en
attente comprises — et rien ne le signalait, puisque du point de vue de Placet c'est la
même adresse qui revient.

**Corrigé** par la migration 23 : la paire `(issuer, sub)` est la clé d'identité,
l'adresse redevient un attribut utile à la première liaison. Les deux unicités sont posées
par la **base**, parce que deux connexions simultanées lisent toutes les deux « aucune
liaison » avant que l'une ait écrit.

Trois situations deviennent distinguables : un `sub` connu dont l'adresse a changé est
suivi et journalisé ; une adresse réattribuée à une autre identité est **refusée** ; une
liaison vers un compte supprimé est refusée **sans repli sur l'adresse** — ce repli
rouvrirait la porte exactement le jour où l'on y tient le moins.

**Le coût d'exploitation est réel et nommé** : un fournisseur qui réémet un `sub` pour la
même personne verrouille le compte. `unbind`/`unbindUser` existe pour que la procédure
d'incident ne soit pas un `DELETE` à la main en production.

### 6. Un GET qui rendait un jeton de session, sans en-tête de cache

Le rappel SSO est un **GET** — le fournisseur ramène le navigateur par une navigation — et
il rendait un jeton de session dans son corps. Une réponse à un GET est cacheable **par
défaut** : le navigateur peut la garder sur disque, et un mandataire d'entreprise placé
devant Placet peut la garder pour tout le monde.

Vérification faite, les deux autres routes qui rendent un jeton (`/api/auth/login`,
`/api/invitations`) sont des **POST**, donc non cacheables par défaut : le rappel SSO était
le seul GET concerné.

**Corrigé**, et la conception a changé avec : ce qui voyage dans l'URL est désormais un
**ticket** — opaque, 32 octets, 60 secondes, consommable une fois — et non un jeton. C'est
exactement ce qu'est un code d'autorisation OAuth, et pour la même raison. La session naît
à l'**échange**, donc un onglet fermé entre les deux étapes ne laisse aucune session
ouverte derrière lui.

### 7. Un 500 qui ne disait pas si la requête était partie

`const result = await pending;` était hors de tout `try`. `gateway.execute()` n'attrape
rien en interne — ni `decide()`, qui écrit en base et applique les quotas, ni `dispatch()`
— donc un échec transitoire remontait au gestionnaire générique.

**Le défaut n'est pas la cause racine, c'est la réponse.** Un 500 nu ne dit ni la décision,
ni si la requête a été transmise. Pour un pare-feu de gouvernance, « je ne sais pas si
votre remboursement est parti » est la plus mauvaise réponse possible : l'agent ne peut ni
réessayer sans risquer un doublon, ni renoncer sans risquer une perte.

**Corrigé** : `forwarded` est un booléen établi par **observation** de la table du relais,
et le message dit « le réessai est sûr » ou « ne réessayez pas à l'identique ». La
référence de relais est journalisée — c'est ce qui manquait pour rattacher l'occurrence
d'origine à son exécution.

### 8. Deux chiffres faux sur l'écran qui décide du pilote

`GET /api/coverage` lisait `executions.list(500)` puis comptait le tableau rendu. **Tous**
les nombres étaient plafonnés à 500, et les **proportions restaient vraisemblables** —
donc rien n'attirait l'œil. Remplacé par un `GROUP BY` cadré au locataire, implémenté des
deux côtés (SQLite et PostgreSQL).

Et les règles du pare-feu étaient annoncées sans vérifier qu'elles sont **utilisables par
ce locataire**. La conséquence grave n'est pas le nombre affiché :
`counts.interceptRules === 0` décide d'une entrée **bloquante**. Un locataire sans aucune
règle utilisable ne recevait donc pas l'avertissement — l'écran lui disait que rien ne le
bloquait, alors que son premier appel intercepté aurait été refusé.

### Deux défauts de l'outillage, trouvés en l'exécutant

**`npm run pilot:down` détruisait la base.** Le script exécutait `docker compose down -v`.
C'était documenté, mais le nom dit « arrêter » : quelqu'un l'aurait lancé pour arrêter le
pilote. `pilot:down` conserve les données, `pilot:destroy` est nommé pour ce qu'il fait.

**L'exercice de reprise après sinistre ne restaurait pas.** `verify:dr` démarrait sa
machine de remplacement en `postgres:16-alpine`, alors que le compose livré épingle
`postgres:17` :

```
pg_restore: error: unsupported version (1.16) in file header
```

`pg_dump` et `pg_restore` sont compatibles **vers l'avant seulement**. L'échec n'était pas
un artefact de banc : un exploitant qui restaure sur une version majeure plus ancienne que
celle qui a produit la sauvegarde se heurte au même mur, le jour où il n'a plus que la
sauvegarde. `docs/QUICKSTART-PILOT.md` recommandait aussi la 16.

La version est maintenant **lue dans le compose** — un seul endroit où elle est déclarée,
et l'exercice suit le déploiement. Résultat : **28/28** là où il donnait 12/14.

> **Reste divergent, et signalé plutôt que corrigé :** `.github/workflows/ci.yml` emploie
> `postgres:16` tandis que le déploiement est en 17. La suite est donc validée sur une
> version majeure différente de celle qui tournera. Ce n'est pas un défaut de Placet, mais
> c'est un écart à fermer avant d'appeler la CI une preuve de production.

### Un test qui mesurait la machine en croyant mesurer une propriété

Le seul échec de la suite de référence était `notifications.test.ts` :
`expect(elapsed).toBeLessThan(500)`, sous le commentaire « la requête ne doit pas attendre
le receveur mort ». Deux défauts opposés :

* **fragile** — 704 ms sur cette machine à deux cœurs chargée par le lanceur de suite
  (charge moyenne mesurée à 6,6), alors que le fichier passe 3/3 en isolé ;
* **faible**, ce qui est plus grave — un port **fermé** refuse la connexion en une
  milliseconde, donc même un `emit` bloquant passait. Elle ne pouvait pas attraper la
  régression qu'elle prétendait garder.

La propriété est maintenant éprouvée avec un receveur qui **accepte et ne répond jamais**,
délai à 10 s, borne à 5 s : la séparation ne dépend plus de la vitesse de la machine. Le
mutant qui ajoute une attente dans la voie de décision meurt à 10 088 ms.

### Trois fois où un mutant m'a donné tort

Les mutants n'ont pas seulement confirmé les correctifs ; ils ont corrigé **mon propre
travail** :

1. J'avais ajouté `Referrer-Policy: no-referrer` dans la route SSO. Le retirer ne faisait
   tomber aucun test : `security.ts` le pose déjà pour toutes les réponses. Ligne retirée
   — une seconde écriture au même en-tête met deux endroits en désaccord le jour où la
   valeur change.
2. Mon premier mutant « `emit` devient bloquant » a **survécu**, parce que je l'avais posé
   au mauvais endroit : rendre `emit` asynchrone ne bloque rien, l'appelant ne l'attend
   pas. La vraie régression est un `await` ajouté à l'appel.
3. Le second a survécu aussi, parce que mon test tolérait deux verdicts et n'éprouvait donc
   de façon fiable **aucune** des deux branches. Le verdict est devenu déterministe.

### Une méthode qui a produit un relevé sans valeur

Le premier passage de suite complète a été lancé **pendant que je modifiais l'arbre**.
Vingt-trois fichiers ont chargé un état intermédiaire (`SSO_CLAIM_PATH is not defined`) et
ont été rapportés en échec. Ce relevé a été **jeté, pas interprété** : un test exécuté sur
un arbre qui change ne mesure rien. Les suites rapportées en §6 ont toutes été lancées sur
un arbre figé.

## 5terdecies. L'AUDIT DE CHAÎNE, ENFIN ÉPROUVÉ — et pourquoi il ne l'était pas

`audit:chains` est l'outil qu'un exploitant lance quand il veut savoir si ses reçus ont
été touchés : la dernière ligne de défense de l'auditabilité. **Rien dans ce dépôt ne
l'exerçait.**

Ce n'était pas un oubli, c'était **structurel**. Tous les bancs qui produisent des reçus —
`verify:soak`, `verify:mcp`, `e2e` — montent une base JETABLE et la détruisent en partant.
Lancé sur n'importe quelle base disponible, `audit:chains` répondait donc :

> Aucun reçu dans ce déploiement : rien à vérifier. Une chaîne vide est valide.

Honnêtement, et sans rien prouver. L'architecture des bancs *garantissait* que l'outil ne
rencontrerait jamais de données.

### Et le voir dire « valide » n'aurait pas suffi

Un vérificateur qui rend toujours « valide » passe ce contrôle-là. C'est la logique des
mutants, appliquée à un outil plutôt qu'à une fonction : une propriété n'est tenue que si
sa rupture délibérée est **détectée**.

`npm run verify:chain-audit` monte donc une chaîne de dix reçus **par la voie réelle**
(autoriser puis exécuter, jamais un `INSERT`), puis la casse de deux façons qui empruntent
deux branches différentes du vérificateur :

| falsification | ce que l'outil répond |
|---|---|
| le **contenu** d'un reçu change | `ROMPUE au n°4 : content: le contenu du reçu "rcpt_…" a changé depuis son écriture` |
| un reçu **disparaît** | `ROMPUE au n°6 : sequence: le reçu "rcpt_…" porte la position 8 là où 7 était attendue — un reçu a été retiré, inséré ou déplacé` |

Dans les deux cas : sortie **1**, le reçu fautif **nommé**, et la nature de l'atteinte
distinguée.

**Et entre les deux, le contenu est restauré et la chaîne doit revérifier.** Sans ce
contrôle, un détecteur bloqué en position « rompue » passerait les deux précédents.

**10/10.** Ce que ce banc n'établit pas : qu'une chaîne résiste à un attaquant capable de
la réécrire ENTIÈREMENT et de façon cohérente. Une chaîne d'empreintes stockée dans la
base qu'elle protège détecte une altération **partielle** ; elle ne remplace pas un
stockage externe en écriture seule, et `docs/limitations.md` le disait déjà.

## 6. Tests exécutés, et leurs résultats exacts

Sous Node 22 (le `.nvmrc` ; `better-sqlite3` est compilé pour cette ABI), contre un
PostgreSQL 17 réel pour tout ce qui en a besoin.

### Les bancs de vérification

| Commande | Résultat |
|---|---|
| `npm run conformance` | **27/27 CONFORME** (21 core + 6 extended) |
| `npm run verify:intercept` | **67/67** |
| `npm run verify:tools` | **49/49** |
| `npm run verify:mcp` | **37/37** |
| `npm run verify:prod-config` | **41/41** |
| `npm run verify:erasure` | **20/20** — et il attrape désormais le défaut d'ordre, voir §5duodecies |
| `npm run verify:obs` | **61/61** |
| `npm run verify:compose` | **20/20** (sur un passage propre ; 19/20 si un `deploy/placet.env` traîne, ce que le script refuse correctement d'écraser) |
| `npm run verify:backup` | **24/24** |
| `npm run verify:dr` | **28/28** — contre 12/14 avant la correction de version |
| `npm run verify:upgrade` | **17/17** |
| `npm run verify:load` | **6/6** |
| `npm run smoke` | **26/26** — « le bundle livré démarre, sert, authentifie et s'arrête » |
| `npm run pilot` | **0 bloqueur**, 2 avertissements, 1 note |
| `npm run audit:chains` | exécuté sur une chaîne **peuplée** : 12 reçus, chaîne vérifiée |
| `npm run verify:chain-audit` | **10/10** — la falsification est détectée, et nommée. Voir §5terdecies |

### Les campagnes de bout en bout

| Commande | Résultat |
|---|---|
| `npm run e2e` | **63/63** |
| `npm run e2e:multitenant` | **98/98** — **exécuté pour la première fois sur cette machine, et c'est lui qui a trouvé le défaut d'effacement** |
| `npm run e2e:currency` | **13/13** |
| `npm run e2e:identity` | **12/12** |
| `npm run e2e:instances` | **6/6** |

### PostgreSQL réel, sans aucun saut

| Commande | Résultat |
|---|---|
| `npm run test:postgres` | **25/25** |
| les six fichiers PostgreSQL de la suite, `PLACET_REQUIRE_POSTGRES=true` | **79/79, 0 sauté** |
| `npm run migrate:postgres` | **23 migrations appliquées**, dont `sso-identities` |

> **Trois noms de variable pour une seule URL** — `PLACET_TEST_PG_URL`,
> `PLACET_TEST_POSTGRES_URL`, `DATABASE_URL`. Sans les trois, des fichiers **sautent
> silencieusement** : 45 tests étaient rapportés « skipped » avant que les trois soient
> posées. C'est précisément la façon de croire qu'on a testé ce qu'on a sauté, et c'est
> noté ici parce que la prochaine personne y perdra le même temps.
>
> Et `DATABASE_URL` doit être **absente** pour la suite vitest : plusieurs fichiers
> refusent une configuration ambiguë plutôt que de deviner le pilote. C'est une protection
> qui fonctionne, et elle m'a fait échouer trois fichiers avant que je comprenne pourquoi.

### Les outils de qualité

| Commande | Résultat |
|---|---|
| `npx tsc --noEmit` | propre |
| `npx eslint .` | propre — **`eslint .` et non `eslint <fichier>`** : la version par fichier avait laissé passer une analyse d'URL devenue inutile |
| `npm run build` | réussi (`dist/index.cjs` 1,6 Mo, `dist/migrate.cjs` 49,9 ko) |
| `npm run scan:secrets` | **606 fichiers balayés, aucun secret réel** |

### Ce qui N'A PAS été exécuté, et pourquoi

* **Le parcours GitHub en écriture** (`verify:github`) : aucun credential n'est disponible
  dans cet environnement, et la consigne est de ne pas en fabriquer ni en récupérer un.
  Le chemin externe reste **NON VÉRIFIÉ**.
* **Un vrai fournisseur d'identité** (Entra ID, Okta, Google) : les tests emploient un
  faux fournisseur local qui signe de vrais jetons avec de vraies clés. Le protocole est
  éprouvé, **un tenant particulier ne l'est pas**.
* ~~**`audit:chains` sur une chaîne peuplée**~~ — **comblé.** Voir ci-dessous.
