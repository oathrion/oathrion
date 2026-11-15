# Placet — état de préparation commerciale

> **DOCUMENT HISTORIQUE.** Les nombres de tests et les résultats ci-dessous ont été mesurés
> sur des versions antérieures du dépôt et ne décrivent PAS la version actuelle. L'état
> vérifié de la version actuelle — commandes, codes de sortie, totaux, limites — est dans
> [`docs/FINAL-PILOT-READINESS.md`](FINAL-PILOT-READINESS.md), et nulle part ailleurs.

**Date** : 2026-10-05 · **Base** : branche `import/chantier-1-etape-1` · **Verdict** : **prêt pour pilote payant limité**

> **Mise à jour du 2026-10-05.** Les lignes « Métriques, logs, alertes », « Procédure
> d'astreinte », « Sauvegardes automatiques » et « Déploiement conteneur » affirmaient
> encore **NON FAIT** ou **Partiel** alors que les quatre existaient et étaient mesurées.
> Ce document suit lui-même la classe de défaut « documents contredisant le code » : il en
> portait quatre. Corrigées, chacune avec la commande qui la prouve.

Ce document dit ce qui est prouvé, par quoi, et ce qui ne l'est pas. Une ligne « vérifié »
renvoie à un test ou à une commande qui a réellement tourné sur ce dépôt. Une ligne
« non vérifié » n'est pas une opinion prudente : c'est l'absence de preuve.

**Aucune conformité réglementaire n'est affirmée ici.** Les lignes légales indiquent ce que
le code fournit comme matière ; la qualification juridique demande un avis externe.

---

## Résumé du verdict

| | |
|---|---|
| **Prêt pour un pilote payant limité** | Oui, sous les conditions ci-dessous |
| Prêt pour un lancement commercial | **Non** — voir B, E, F |
| Prêt « entreprise » | **Non** — l'exécution réelle, la facturation et la capacité ne sont pas démontrées |

Les trois raisons qui empêchent d'aller plus loin, sans détour :

1. **Placet n'exécute presque rien lui-même.** Le registre d'outils est composé d'outils
   simulés ; seul le chemin passerelle MCP appelle un système réel, et seulement vers une
   destination explicitement autorisée. Un pilote est donc viable **si** le client branche
   ses propres outils derrière la passerelle MCP. Vendre « Placet exécute vos actions » ne
   serait pas vrai aujourd'hui.
2. **Aucune mesure de capacité hors d'une seule machine.** Le plan d'identité sérialise par
   conception (une connexion, `Atomics.wait`) et plafonne autour de **90–190 req/s par
   instance** sur la machine de test. Aucun SLO n'est promis.
3. **Aucune facturation produit.** Les compteurs existants sont techniques et explicitement
   « advisory ». Il n'y a ni plan, ni entitlement, ni compteur facturable.

---

## A. Fiabilité et livraison

| Exigence | État | Preuve / test | Limite connue | Action restante |
|---|---|---|---|---|
| Toute la CI passe, chaos inclus | **Vérifié** | `npm run chaos` → `26 handled, 0 cryptic, 0 SILENT FAILURES, 0 BENCH BROKEN`, exit 0 | 2 scénarios restent « NOT SIMULATED » (ENOSPC et chmod exigent des privilèges) et le disent | Rien de bloquant |
| Aucun scénario de sécurité supprimé pour y parvenir | **Vérifié** | La liaison clé→agent reste exigée ; le banc émet des credentials *liés* (`mintBoundKey`) | — | — |
| Suite de tests | **Vérifié** | `npx vitest run` → **2000 passed, 2 skipped, 0 failed** | Les 2 skips sont `phase12-restart-reconnect` (exige un cluster système + sudo) | Couvert autrement par `chaos:postgres` |
| Typecheck, lint, build, scan de secrets | **Vérifié** | exit 0 chacun ; scan : 414 fichiers, aucun secret | — | — |
| Intégration PostgreSQL réelle | **Vérifié** | `smoke:postgres` 21/21 · `postgres.test.ts` 25/25 avec `PLACET_REQUIRE_POSTGRES=true` (échoue si la base manque) | — | — |
| Multi-instance, identité partagée, révocation | **Vérifié** | `e2e:identity` 12/12 (deux processus, une base) · `e2e:instances` 6/6 · `phase12-multiprocess-identity` 8 tests | — | — |
| Grants à usage unique, exactement-une-fois | **Vérifié** | `phase11-multiprocess` : 4 processus OS en course → une seule consommation, aval = 1 · `phase10-postgres` : 8 consommateurs concurrents | « Grant consommé une fois » ≠ « effet fournisseur une fois » — voir B | — |
| Fail-closed de bout en bout | **Vérifié** | `chaos:postgres` 15/15 : base arrêtée → readiness 503, aucune autorisation, aucun fichier SQLite, zéro ligne en aval ; récupération sans redémarrage | — | — |
| Isolation tenant | **Vérifié** | `e2e` 61/61 inclut un tenant rival à chaque étape · `tenant-isolation*`, `phase11-postgres-core` | — | — |
| Documents contredisant le code | **Corrigé** | `docs/limitations.md` affirmait « repositories are not [on PostgreSQL] » et « booting against PostgreSQL refuses » — faux depuis la Phase 12 | `DEPLOYMENT.md` décrit encore un **pilote sur serveur unique** | Écrire un guide de déploiement SaaS multi-instance |
| Build de production reproductible | **Vérifié** | `npm run build` ; `npm run package` revérifie le contenu de l'archive après écriture | L'archive est une release **source** (pas de `dist/`), conforme à `DEPLOYMENT.md:895` (`npm ci && npm run build`) | — |
| Checksums | **Vérifié** | `package-release.ts` émet un SHA256 de l'archive et refuse tout fichier hors manifeste | — | — |
| Inventaire des dépendances / SBOM | **Ajouté** | `npm run sbom` → CycloneDX 1.5, 720 paquets (348 production) ; `npm run sbom -- --check` échoue en cas de dérive | **Les licences ne sont pas inventoriées** : le lockfile n'en porte pas | Revue de licences dédiée avant diffusion commerciale |
| Procédure de rollback | **Partielle** | Les migrations sont **append-only** par conception ; `assertHistoryMatches` refuse une histoire réécrite | Il n'existe **aucune migration descendante**. Revenir en arrière = redéployer l'image précédente, et seulement si elle accepte le schéma courant | Documenter la fenêtre de compatibilité N−1 et la tester |
| Traçabilité de la release | **Partielle** | L'archive porte le hash du commit, et le suffixe `-dirty` quand l'arbre est modifié | L'état actuel **est** `-dirty` : l'archive ne correspond à aucun commit | Commiter avant de livrer |

---

## B. Exécution réelle des actions

| Exigence | État | Preuve / test | Limite connue | Action restante |
|---|---|---|---|---|
| Inventaire précis des outils simulés | **Vérifié (corrigé)** | `simulated-tools.ts` déclare `simulated: true/false` par chemin dans le COMPTE RENDU d'exécution. Cette ligne affirmait aussi que `GET /api/tools` exposait le drapeau : **c'était faux**, la route ne renvoyait que `id`, `name`, `description`, `toolExecutionCount`, et le catalogue MCP portait un `simulated: true` codé en dur — avec un TYPE littéral qui rendait la valeur honnête impossible à écrire. Les deux surfaces d'inventaire dérivent désormais de `Tool.simulated`, source unique ; `server/test/tools-inventory-honesty.test.ts` le tient | Un drapeau est une déclaration du **déploiement** : le même build est simulé ou non selon qu'une destination aval est configurée | — |
| Chemin aval prouvé contre un serveur qui n'est pas le nôtre | **Vérifié (chantier 1, point 6)** | `npm run verify:mcp` **37/37** : bundle livré, `NODE_ENV=production`, PostgreSQL, `PLACET_LOCAL_MCP_URL` pointé sur `examples/mcp-server/` — un serveur écrit depuis la spécification MCP qui n'importe **rien** de Placet. ALLOW → outil atteint une fois · BLOCK → jamais, aucun grant · APPROVAL_REQUIRED → rien avant l'humain, puis une fois · rejeu → refusé avec le bon code · refus métier → reçu `failed`, grant consommé, aucun nouvel essai · en-têtes protocolaires tels que le serveur tiers les a vus | Un serveur indépendant écarte la **mélecture partagée** avec la fixture du dépôt ; il n'écarte pas un désaccord avec une implémentation tierce particulière du marché | Brancher le premier fournisseur réel du pilote |
| **Pare-feu d'interception devant une API du client** | **Vérifié** | `npm run verify:intercept` **39/39** — bundle livré, devant une API cible qui enregistre ce qu'elle reçoit. Route non déclarée → 403 et ZÉRO requête · ALLOW → exactement une, corps intact, clé du fournisseur injectée par Placet, clé Placet de l'agent absente · BLOCK → zéro · APPROVAL_REQUIRED → zéro puis une, approuver deux fois n'en fait pas deux · montant évalué 600 et non 60 000 (`amountScale`) · 422 du fournisseur rendu tel quel · corps de requête et credential ABSENTS de la trace et de l'audit. Hors ligne : `intercept-firewall.test.ts` 26/26 | **Ne gouverne que le trafic qui passe par lui** : un agent qui détient la clé de l'API peut l'appeler directement. Le contournement devient impossible parce que le credential ne vit que dans Placet — propriété du déploiement, pas du logiciel. Le trafic refusé à la porte est COMPTÉ, pas tracé ligne à ligne. `PLACET_INTERCEPT_KEY_*` est un repli en clair, plus faible que le coffre | Brancher le premier agent d'un pilote derrière le proxy |
| Découverte et vérification de schéma d'un serveur MCP existant | **Vérifié** | `npm run mcp:discover` émet un `tools/list` réel et rend les noms, descriptions et champs requis du serveur. Placet compare ensuite une déclaration `PLACET_TOOLS` à ce schéma et REFUSE la dépêche : nom d'outil inexistant, argument requis non projeté, argument absent du schéma (que le serveur ignorerait en silence). `upstream-schema.test.ts` 14/14 contre `examples/mcp-server/` ; `verify:tools` 49/49 le prouve dans le BUNDLE LIVRÉ, avec un troisième démarrage portant une faute d'une lettre : ALLOW, et zéro requête chez le fournisseur | Compare des NOMS d'arguments, pas des types — implémenter JSON Schema à la main refuserait des schémas valides. Un serveur sans `tools/list` n'est pas vérifiable : le reçu porte `schemaChecked: false` au lieu de le taire, et `"requireSchema": true` fait refuser | Brancher le premier serveur MCP d'un pilote |
| Connecteurs réels sur le parcours commercial | **UN connecteur réel : GitHub** | `npm run verify:github` — 12/12 sans credential contre l'API vivante (401 réel, message de GitHub et non le nôtre, cibles mal formées refusées sans appel) ; avec `PLACET_GITHUB_TEST_TOKEN` s'y ajoutent le compte réel, les capacités dérivées de `x-oauth-scopes`, une lecture, une issue, un commentaire, un 404 et la révocation. Credentials scellés en AES-256-GCM (`server/connectors/vault.ts`, **premier consommateur réel** de `secrets/envelope.ts`) : `connector-vault.test.ts` 19/19. Le point de contrôle s'applique : `connector-control-point.test.ts` 13/13 — ALLOW atteint le connecteur une fois, BLOCK zéro, APPROVAL_REQUIRED zéro avant l'humain puis un, un rejet jamais. Un seul chemin d'exécution, assis structurellement par `connector-single-path.test.ts` 13/13 | Trois verbes NON destructifs seulement · pas d'OAuth · **pas de révocation distante** (GitHub n'en offre aucune API : `remoteStillValid: true`, dit par l'API et affiché en rouge) · pas de déduplication chez le fournisseur · **et le contrôle suppose que le credential ne vit que dans le coffre de Placet** : un agent qui détient son propre jeton n'est pas gouverné | Choisir le deuxième connecteur avec le premier pilote — Slack (canal d'approbation) puis un ERP, voir `docs/connectors.md` §6 |
| Politique « deny by default » par action | **Vérifié** | `shared/policy/actions.ts` : une action non cataloguée est BLOCK ou APPROVAL_REQUIRED selon la posture ; `undeclared-action-posture.test.ts` | — | — |
| Schéma + permission + règle de risque par action | **Vérifié** | Catalogue unique dans `actions.ts` ; `permission-enforcement.test.ts`, `action-evasion.test.ts` | — | — |
| Mode d'enforcement honnête | **Vérifié** | `docs/limitations.md` : « MOTIF B cannot physically stop a hostile client » ; seul le chemin passerelle MCP est inévitable | **Un client qui appelle `/api/evaluate` et ignore la réponse n'est pas empêché** | Ne jamais vendre l'inverse |
| Déduplication côté fournisseur | **NON FAIT dans ARIA — faisable par le client, et démontré** | L'idempotence est assurée *dans ARIA* (grant à usage unique, `executionId` comme clé). Ce qui est nouveau : la clé arrive bien chez le fournisseur, et `npm run verify:mcp` le **mesure** sur un serveur indépendant — en-tête `X-ARIA-Execution-Id` de forme `axn_<32 hex>`, et `id` JSON-RPC `aria-<executionId>`. `examples/mcp-server/` montre le stockage à écrire en face | « Grant consommé une fois » **n'est pas** « effet fournisseur exactement une fois ». Un succès fournisseur dont la réponse réseau est perdue n'est **toujours** pas réconcilié : ARIA ne peut pas le faire à la place du fournisseur. La `Map` de l'exemple est un exemple — en production, une table avec contrainte d'unicité, écrite dans la même transaction que l'effet | Réconciliation ; exige un fournisseur réel |
| Timeouts, retries, résultats ambigus | **Partiel** | `chaos` couvre 5 scénarios réseau réels (receveur muet, lent, flood, 500, redirection métadonnées) sur le canal webhook | Ces scénarios portent sur la **notification**, pas sur un appel fournisseur transactionnel | À refaire contre un vrai fournisseur en sandbox |
| Aucun faux connecteur renvoyant `success` | **Vérifié** | Les outils simulés se déclarent simulés ; `claims-honesty.test.ts` | — | — |

---

## C. Devises et Afrique francophone

| Exigence | État | Preuve / test | Limite connue | Action restante |
|---|---|---|---|---|
| Fin de la devise unique codée en dur | **Fait** | `ORG_CURRENCY = "EUR"` supprimé ; devise **par organisation** (migration 15) ; `currency-single-path.test.ts` interdit sa réintroduction | Changer la devise d'un tenant vivant ne reconvertit **rien** et prend effet au redémarrage du processus | API d'administration de la devise |
| XOF et XAF pris en charge | **Fait** | `shared/money.ts` : registre avec exposant par devise ; XOF et XAF **distincts** (BCEAO / BEAC) malgré la parité | — | Ajouter d'autres devises = une entrée dans le registre |
| Aucun calcul financier en flottant | **Fait** | Montants en **unités mineures entières** ; `compareMoney` / `addMoney` ; `money.test.ts` 21/21, dont `0.1 + 0.2 > 0.3` | Les montants transitent en décimal sur l'API et sont convertis à la frontière | Migrer les colonnes de montants en entiers |
| Aucune conversion implicite | **Fait** | `compareMoney` **lève** sur devises différentes ; un montant en EUR chez un tenant XOF est BLOCK | — | — |
| Plafonds, politiques, journaux, connecteurs transmettent la même devise | **Fait** | `ToolContext.currency` ; `simulated-tools.ts` envoyait `currency: "EUR"` **en dur** au connecteur aval — corrigé | — | — |
| Tests limites, arrondi, devise absente/inconnue, discordance | **Fait** | `shared/policy/currency.test.ts` 15/15 : montant exactement au plafond, +1 unité mineure, franc fractionnaire refusé, « CFA » refusé, politique en devise étrangère refusée | — | — |
| Preuve HTTP de bout en bout | **Fait** | `npm run e2e:currency` **13/13** : tenant XOF réel, mandat en XOF accepté, 400 000 XOF ALLOW, 900 000 XOF retenu, 400 000 EUR refusé, « CFA » refusé, 1000,5 XOF refusé, journal sans euro | Ce harnais a trouvé un trou que les tests du moteur ne voyaient pas : le mandat ne validait pas la précision | — |
| Interface et documentation en français | **Partiel** | Les messages monétaires et les refus de configuration sont en français ; `money.ts` formate en `fr-FR` / `fr-SN` / `fr-CM` | **`docs/` est en anglais** ; les motifs de décision mélangent français et anglais | Traduction, et une structure i18n au lieu de chaînes littérales |
| Aucun contrôle financier n'affiche EUR si la devise diffère | **Fait** | `formatAmount` n'a **plus de devise par défaut** — le compilateur a révélé 8 sites qui supposaient l'euro ; `e2e:currency` vérifie l'absence de « € » dans le journal d'un tenant XOF | — | — |

---

## D. Audit et sécurité

| Exigence | État | Preuve / test | Limite connue | Action restante |
|---|---|---|---|---|
| Chaîne d'audit inviolable | **Partiel, limite documentée** | `audit-hash-chain.test.ts`, `audit-verify-endpoint.test.ts` : édition, réordonnancement, insertion et suppression *dans* une trace sont détectés | **La suppression d'une exécution entière n'est pas détectée** · la vérification est une cohérence interne, **pas** une authenticité vis-à-vis d'un tiers : aucune signature, aucun ancrage externe | Registre par tenant avec tête persistée ; ancrage signé append-only |
| Modification par un administrateur de base | **Non empêché, documenté** | — | Quelqu'un ayant accès en écriture à la base **et** au code peut produire une chaîne cohérente | Ancrage externe |
| Export et vérification indépendante | **Partiel** | Endpoint de vérification présent | Vérification interne uniquement | Export signé |
| Auth, RBAC, rotation, révocation | **Vérifié** | `rbac.test.ts`, `api-keys.test.ts`, `session-credential-binding.test.ts` ; révocation prouvée **entre instances** (`e2e:identity`) | — | — |
| Liaison credential → agent | **Vérifié, et renforcé** | `agent-binding-adversarial.test.ts` 28 tests ; un seul lecteur de la variable (`agent-binding-single-path.test.ts`) | Dans le bundle la liaison est **toujours** exigée (`NODE_ENV` est figé à la compilation) — la bannière le dit désormais | — |
| Gestion des secrets | **Vérifié** | Chiffrement d'enveloppe ; un secret sans source déclarée empêche le démarrage ; `secrets.test.ts` | — | — |
| SSRF | **Vérifié** | `mcp-destination-security.test.ts`, `mcp-origin-hardening.test.ts` ; re-vérification de l'adresse au moment de la connexion | Un hôte public explicitement autorisé par l'opérateur reste sa décision | — |
| Rate limiting partagé | **Vérifié** | `e2e:instances` : plafond de 30 respecté **à travers deux instances** (50 envoyées, 30 permises) ; contraste mesuré avec le limiteur mémoire | — | — |
| Isolation, logs sans données sensibles | **Vérifié** | `log-redaction.test.ts` ; `smoke` inspecte la sortie du bundle et n'y trouve aucun credential | — | — |
| Sauvegardes et restauration | **Vérifié (Phase 12.2)** | `pg_dump` / `pg_restore` dans une base isolée : 224 colonnes et 43 index identiques ; **Placet démarre sur la base restaurée** | Procédure manuelle, non planifiée, non testée en continu | Automatiser et mesurer RPO/RTO |
| Modèle de menace et checklist | **NON FAIT** | — | `docs/security-model.md` décrit le modèle de sécurité, mais il n'existe pas de modèle de menace structuré ni de checklist de revue | Rédiger les deux |
| Conformité réglementaire | **Non affirmée** | — | Aucune analyse juridique n'a été faite ; rien ici ne vaut attestation | Avis juridique local (Sénégal, Côte d'Ivoire, Cameroun selon la cible) |

---

## E. Scalabilité et exploitation

| Exigence | État | Preuve / test | Limite connue | Action restante |
|---|---|---|---|---|
| Performance sur infrastructure représentative | **NON FAIT — bloqué** | — | Aucune infrastructure distante disponible dans cet environnement. Aucun chiffre distant n'a été fabriqué | Mesurer avec PostgreSQL distant, plusieurs instances, charge concurrente |
| Mesure locale | **Vérifié, périmètre étroit** | HTTP réel, PostgreSQL réel, 0 erreur sur 5 000 requêtes : session p50 11,66 ms / p99 26 ms à c=1 ; **débit plafonné à ~94 req/s** à c=16 ; clé d'API ~193 req/s | Loopback, base sur la même machine, une instance, cache chaud. **Ce n'est pas un SLO** | — |
| Goulot d'étranglement identifié | **Vérifié** | Le débit ne progresse quasiment pas de c=1 à c=16 : le plan d'identité est un pont **synchrone** sur **une** connexion (`sync-postgres.ts`, `Atomics.wait`) — chaque requête d'identité bloque la boucle d'événements | C'est un compromis assumé : il achète une parité SQLite/PostgreSQL structurelle | Pool de connexions ou identité asynchrone (réécriture `async` de `auth.ts` et appelants) |
| SLO justifiés | **NON FAIT** | — | Aucun SLO ne peut être justifié sans la mesure distante | — |
| Métriques, logs, alertes | **Vérifié** | `GET /api/metrics` derrière un jeton, 80 séries **bornées par construction** (valeurs d'étiquette déclarées, aucune étiquette de locataire) ; `npm run verify:obs` **61/61** provoque les quatre signaux pour de vrai ; logs structurés avec `X-Request-Id` ; rédaction des secrets vérifiée | Aucun histogramme, donc **aucun quantile de latence** : des tranches inventées produiraient des quantiles crédibles et sans fondement. Pas de tableau de bord livré — les règles d'alerte prêtes à coller sont dans `docs/ON-CALL.md` | — |
| Drainage, reprise | **Vérifié** | SIGTERM drainé proprement (readiness passe « degraded » puis fermeture) ; `lifecycle.test.ts` ; `chaos` : SIGKILL puis redémarrage | — | — |
| Sauvegardes automatiques, RPO/RTO | **Partiel** | `npm run verify:backup` **24/24** : les scripts livrés tournent tels quels, rétention éprouvée, et `npm run verify:dr` **28/28** restaure sur une **autre machine** avec la même tête de chaîne. **RPO = 1 h** avec le cron horaire livré | **Planifier le cron reste à l'exploitant** : les scripts existent, rien ne les lance. RTO mesuré ~0,6 s / 0,7 s / 0,8 s sur une base de test de quelques dizaines de lignes — **ce n'est pas un RTO de production** | Archivage WAL pour descendre sous l'heure ; relancer `verify:soak` en version longue |
| Déploiement conteneur reproductible | **Vérifié** | `npm run verify:compose` **20/20** : la pile des quatre services démarre, la migration **garde** le démarrage, TLS avec HSTS et redirection du port 80, durcissement réel (rootfs en lecture seule, utilisateur `node`, PostgreSQL non publié), parcours client à travers le proxy, et panne/reprise de base sans redémarrage | **Le certificat PUBLIC n'est pas obtenu** : le défi ACME exige un nom DNS public et un port 80 joignable, donc le banc tourne sur la CA interne de Caddy. `DEPLOYMENT.md` suppose **un serveur unique** | Obtenir un certificat réel une fois ; guide multi-instance |
| Procédure d'astreinte | **Vérifié** | `docs/ON-CALL.md` : quatre signaux qui justifient de réveiller quelqu'un, chacun avec symptôme → commande → geste, et les règles PromQL. Les quatre sont **provoqués** par `verify:obs` | Le signal « aucune sauvegarde récente » porte sur une **absence** : il ne se déclenche jamais seul, d'où `deploy/scripts/check-backup-freshness.sh` | — |

---

## F. Commercialisation produit

| Exigence | État | Preuve / test | Limite connue | Action restante |
|---|---|---|---|---|
| Organisations, utilisateurs, rôles, invitations | **Vérifié** | `e2e` 61/61 : invitation émise, jeton à usage unique, rejeu refusé, suspension tuant la session vive, réintégration, réinitialisation de mot de passe, dernier administrateur protégé | — | — |
| Quotas techniques | **Vérifié** | `quotas.test.ts` ; 409 `quota_exceeded` dans le bundle ; compteurs lus sur PostgreSQL (défaut `/api/usage` corrigé en Phase 12.2) | Les compteurs `usage_counters` sont **advisory** par conception ; l'enforcement recalcule un `count(*)` exact | — |
| Distinction comptage technique / abonnement | **NON FAIT** | — | Il n'existe aucune notion de plan, d'entitlement ni de compteur facturable | Modèle plans/entitlements |
| Facturation | **NON FAIT** | — | Aucune facture n'est produite, et aucune n'est **simulée** — ce qui est volontaire | Choisir un prestataire : **décision métier**. Rendre le compteur facturable auditable d'abord |
| Export / suppression des données | **Partiel** | Export d'audit via l'API ; `pg_dump` prouvé | Pas de parcours « export tenant » ni « suppression tenant » outillé | À construire pour les contrats |
| Rétention | **NON FAIT** | — | Aucune politique de rétention appliquée par le code | À définir (produit + légal) |
| Disponibilité, support, incidents | **NON FAIT** | — | Aucun engagement mesurable sans E | — |
| Limites du produit écrites | **Vérifié** | `docs/limitations.md`, corrigé en Phase 12.3, et ce document | — | — |
| Interface client terminée | **Non — console interne** | — | La console sert l'exploitation ; elle n'est pas une interface client finie, et ne doit pas être présentée comme telle | — |

---

## Décisions qui n'appartiennent pas au code

1. **Quel premier connecteur réel**, et dans quel environnement sandbox. Tant qu'il n'est
   pas choisi, la promesse d'exécution se limite à la passerelle MCP vers les outils du
   client.
2. **Quel prestataire de facturation.** L'architecture doit rester extensible ; aucune
   facture ne sera simulée en attendant.
3. **Quelles devises au-delà de XOF, XAF, EUR, USD** (GHS, NGN, MAD…).
4. **Politique de rétention et de suppression**, par marché.
5. **Validations juridiques locales** : protection des données, exigences du secteur
   financier, localisation éventuelle des données. Aucune ne peut être faite par le code.

---

## Comment reproduire les preuves de ce document

```bash
# Toolchain : le projet exige Node >= 20. Le node par défaut de la machine de test est v18.
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"

PG=postgres://<user>:<password>@127.0.0.1:55432
npm ci
npm run typecheck && npm run lint && npm run build && npm run scan:secrets && npm run sbom -- --check

PLACET_TEST_PG_URL=$PG/postgres \
PLACET_TEST_POSTGRES_URL=$PG/<db> \
PLACET_TEST_IDENTITY_PG_URL=$PG/<db> \
PLACET_REQUIRE_POSTGRES=true npx vitest run

npm run chaos
DATABASE_URL=$PG/postgres npm run smoke
DATABASE_URL=$PG/postgres npm run e2e
DATABASE_URL=$PG/postgres npm run smoke:postgres
DATABASE_URL=$PG/postgres npm run e2e:currency
DATABASE_URL=$PG/<db> npm run e2e:instances
DATABASE_URL=$PG/<db> npm run e2e:identity
PLACET_TEST_PG_DOCKER=<container> DATABASE_URL=$PG/<db> npm run chaos:postgres
# Phase 13 — sans Docker, sur un cluster système : PLACET_TEST_PG_CTLCLUSTER="18 main"
DATABASE_URL=$PG/postgres npm run e2e:multitenant      # deux entreprises, sauvegarde/restauration, export
DATABASE_URL=$PG/postgres npm run verify:prod-config   # démarrages dangereux refusés
```

> Phase 13 : voir `PHASE-13-MULTI-TENANT-PRODUCTION-REPORT.md` (défauts multi-tenant
> corrigés, kit `deploy/`, `docs/OPERATIONS.md`).

`chaos:postgres` arrête et redémarre le conteneur PostgreSQL qu'on lui nomme. Sans
`PLACET_TEST_PG_DOCKER` il **SKIPPE bruyamment** et sort 0 : il ne doit jamais arrêter une
base que personne n'a désignée.
