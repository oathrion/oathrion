# Intégrer un agent qui existe déjà

Une entreprise qui possède déjà des agents IA veut les placer derrière Oathrion **sans les
reconstruire**. Ce document dit comment, ce que chaque voie garantit, et ce qu'elle ne
garantit pas.

Il commence par un audit, parce que la question « est-ce réel ? » se pose pour chaque
chemin et qu'aucune réponse ici n'est à croire sur parole : chaque ligne porte la commande
qui la vérifie.

---

## 1. Audit des chemins d'intégration

| Chemin | État | Preuve exécutée | Non vérifié / limite |
|---|---|---|---|
| **Passerelle MCP entrante** (`POST /api/mcp`) | `REAL_AND_TESTED` | `conformance` 27/27 CONFORME · `mcp-gateway.test.ts` · `mcp-single-path.test.ts` : `tools/call` n'atteint un outil que par `AgentGateway.execute()` | — |
| **Relais MCP sortant** (`tools/call`) | `REAL_AND_TESTED` | `verify:mcp` 37/37 contre `examples/mcp-server/`, qui n'importe rien d'Oathrion | Un seul serveur indépendant : écarte la mélecture partagée, pas un désaccord avec une implémentation tierce |
| **Découverte des outils d'un serveur MCP** (`tools/list` sortant) | `REAL_AND_TESTED` *(ajouté par ce chantier)* | `verify:tools` — découverte réelle, puis refus nommés sur nom d'outil inconnu et argument requis non projeté | Un serveur qui n'implémente pas `tools/list` n'est pas vérifiable : le résultat le dit (`schemaChecked: false`) au lieu de le taire |
| **`POST /api/execute`** | `REAL_AND_TESTED` | `gateway.test.ts` · `reference-scenarios.test.ts` · `connector-control-point.test.ts` 13/13 | — |
| **`POST /api/evaluate`** | `REAL_AND_TESTED` **comme avis** | `conformance` C1–C8 · `evaluate-contract` | **Consultatif.** Un client qui ignore la réponse n'est pas empêché. Voir §2.C |
| **Connecteur GitHub** | `REAL` (12/12 sans jeton, parcours complet avec jeton) | `verify:github` | Trois verbes non destructifs · pas d'OAuth · pas de révocation distante |
| **`OATHRION_TOOLS` + registre d'outils** | `REAL_AND_TESTED` | `verify:tools` | Pas de transformation de valeur · pas d'argument optionnel |
| **SDK TypeScript** | `REAL_AND_TESTED` | `vitest run sdk/` — 76 tests (SDK TS + adaptateur) | Fail-closed vérifié : injoignable lève, APPROVAL_REQUIRED ne passe pas |
| **SDK Python** | `REAL_AND_TESTED` | `python3 -m unittest discover -s sdk/python` — 37 tests, OK | Même limite de motif que le TS |
| **Adaptateur `withOathrion`** | `REAL_AND_TESTED`, mais **un exemple** | `examples/framework-adapter/with-placet.test.ts` dans les 76 ci-dessus | Vit dans `examples/`, donc hors du paquet publié : un client doit le recopier. Voir §4.B |
| **Contrat d'action canonique** | `REAL_AND_TESTED` | `shared/action/envelope.ts` · `conformance` C5, C7, C10, C11, C16 | — |
| **Écran Connecteurs** | `REAL` | `connector-vault.test.ts` 19/19 | Un seul connecteur au catalogue |
| **Écran Integrations** | `SIMULATED` — décoratif | — | Retiré de la navigation, porte un avertissement |
| **Création d'agents** (`POST /api/agents`) | `REAL_AND_TESTED` | `permission-scope-parity.test.ts` · `agent-permissions.test.ts` | Pas d'import depuis un framework : un agent existant est redéclaré à la main |
| **Proxy universel d'appels API directs** | `MISSING` | — | Volontairement non commencé. Voir §4.C |

### Les écarts prioritaires trouvés

1. **Oathrion ne pouvait pas découvrir les outils d'un serveur MCP existant.** Le client
   sortant n'émettait que `tools/call`. Un opérateur devait donc écrire à la main le nom
   de l'outil distant et la projection de chaque argument, **sans que rien ne les compare
   à ce que le serveur déclare**. Une faute de frappe (`refunds.creat`) ou un argument
   requis oublié ne se révélait qu'au premier appel réel d'un client — exactement la
   classe de défaut que ce dépôt refuse. *Corrigé par ce chantier.*

2. **L'adaptateur `withOathrion` est un exemple, pas un composant du SDK.** Il est éprouvé
   et honnête sur ses limites, mais il vit dans `examples/`, donc hors du paquet publié :
   un client doit le recopier dans son code, où il cessera d'être tenu par nos tests.
   *Évalué en §4.B, non déplacé par ce chantier — et la raison est écrite.*

3. **Aucun écart de documentation sur « outils simulés » / « connecteurs réels ».**
   Vérifié : `docs/mcp.md`, `docs/limitations.md`, `docs/connectors.md` et
   `docs/COMMERCIAL_READINESS.md` disent la même chose, et
   `server/test/tools-inventory-honesty.test.ts` fait échouer la suite si
   `GET /api/tools` cesse de dériver son drapeau de l'outil.

---

## 2. Les trois garanties, et elles ne sont pas interchangeables

### A — Gouvernance effective : Oathrion est sur le chemin

L'agent ne détient aucun credential du système cible. Sa seule route vers l'outil passe
par Oathrion : passerelle MCP entrante, ou `POST /api/execute`.

**Garantie :** une action refusée n'atteint pas l'outil. Ce n'est pas une politique, c'est
une propriété du chemin — il n'y a pas d'autre route.

**Condition, et elle est entière :** le credential du système cible vit dans le coffre de
Oathrion **et nulle part ailleurs**. Un agent qui garde son propre jeton a une seconde route
et Oathrion ne voit rien.

### B — Intégration logicielle : le développeur enveloppe ses outils

`withOathrion(outil)` ou un appel à `placet.requireAllow()` dans le code de l'agent.

**Garantie :** l'outil **enrobé** ne tourne pas sans ALLOW. Oathrion injoignable lève ;
APPROVAL_REQUIRED ne tourne pas — traiter une attente pour un oui est la pire chose
qu'une intégration puisse faire.

**Ce que ce n'est pas :** une interception transparente. `withOathrion` protège l'outil
qu'il a enrobé, et rien n'empêche d'appeler l'original. C'est la limite de tout motif
en-processus, et elle ne se contourne pas par un meilleur adaptateur.

### C — Évaluation consultative : le client demande un avis

`POST /api/evaluate`. Le client peut ignorer la réponse.

**Garantie :** la décision est autoritative, enregistrée et infalsifiable. **Pas qu'elle
est inévitable.**

> **La règle de ce document :** B et C ne doivent jamais être présentés comme une
> interception impossible à contourner. Le seul mode qui l'est est A, et il l'est parce
> que l'agent n'a pas d'autre chemin — pas parce que le logiciel l'empêche.

---

## 3. Le contrat d'action canonique

Il existe et il est éprouvé : `shared/action/envelope.ts`.

| Ce qu'il préserve | Comment |
|---|---|
| Identité vérifiée | `tenantId` vient du credential, **jamais** du corps. `AUTHORITATIVE_FIELDS` refuse qu'on le dise |
| Organisation | idem, et la portée du locataire est construite depuis elle |
| Action, destination, arguments | canonicalisés puis **hachés** : `actionHash` |
| Mandat et permissions | lus côté serveur depuis l'agent, pas annoncés par l'appelant |
| Décision, identifiant d'exécution | sorties du système, refusées en entrée |
| Approbation liée à l'action exacte | l'approbateur cite l'`actionHash` ; approuver « rembourser 75 » n'exécute pas « rembourser 750 » |
| Rejeu impossible | grant à usage unique, consommé par un `UPDATE … AND state = 'issued'` |
| Fail-closed | BLOCK, APPROVAL_REQUIRED, erreur et expiration ne livrent rien. `conformance` le mesure |

**Les arguments exécutés correspondent exactement au contexte autorisé.** Un outil déclaré
ne peut que **projeter** un champ qu'Oathrion détient déjà — jamais formater, convertir ni
poser un défaut. Une source qui ne projette rien arrête la dépêche
(`unprojectable_arguments`) plutôt que d'envoyer une instruction à moitié remplie.

---

## 4. Intégrer, par ordre de préférence

### Priorité 1 — MCP : découvrir, puis relayer sous politique

C'est la voie recommandée, et depuis ce chantier elle est **vérifiable avant de servir**.

```bash
# 1. Découvrir ce que le serveur de vos agents déclare réellement
npm run mcp:discover -- --destination=acme-erp

# 2. Déclarer la correspondance, puis la faire valider contre ce schéma
npm run verify:tools
```

La découverte émet un `tools/list` sur la destination déjà validée (même allowlist,
mêmes règles d'adresse) et rend les noms, les descriptions et les **schémas d'arguments**
tels que le serveur les donne.

Ce qu'Oathrion refuse ensuite, **à l'exécution**, avec le motif et la correction :

| Situation | Refus |
|---|---|
| Le nom d'outil déclaré n'existe pas chez le serveur | `tool_not_found_upstream` + la liste de ceux qui existent |
| Un argument **requis** par le schéma n'est pas projeté | `missing_required_argument` + le nom du champ |
| Un argument projeté n'est pas dans le schéma | `unknown_argument_upstream` — il serait ignoré en silence, donc l'opérateur croirait avoir transmis quelque chose |
| Le serveur n'implémente pas `tools/list` | la dépêche a lieu et le reçu porte `schemaChecked: false` avec la raison. Un opérateur qui veut un refus strict met `"requireSchema": true` dans sa déclaration |

### Priorité 2 — SDK et adaptateur générique

`withOathrion` accepte `execute`, `invoke`, `func`, `call`, `_run` ou une fonction nue, et
**conserve tout le reste de l'objet** (description, schéma, `parameters`) pour que l'outil
enrobé se glisse là où l'autre était. Les cinq formes correspondent au SDK ai de Vercel,
LangChain/LangGraph, LlamaIndex, CrewAI et au function calling brut.

**Pourquoi il reste dans `examples/` pour l'instant.** Le déplacer dans
`sdk/typescript/src` ferait de lui une API publique du paquet, donc une surface à
versionner et à ne plus casser. Avant cela il faut l'avoir passé sur les signatures
réelles d'au moins deux frameworks installés — ce que ce dépôt ne fait pas encore : ses
tests emploient des objets de la bonne forme, pas les classes véritables de LangChain.
Promouvoir d'abord et vérifier ensuite serait publier une compatibilité supposée.

**Un adaptateur Python ?** Le SDK Python existe et est éprouvé (37 tests). CrewAI et
LangChain-Python appellent `_run` / `invoke`, donc un `with_placet` y serait une
vingtaine de lignes. Il n'est pas écrit : un adaptateur qu'aucun agent réel n'a encore
exercé est une dépendance de plus à maintenir pour une compatibilité supposée.

### Priorité 3 — appels directs aux API

**Aucun proxy universel n'est développé, et c'est délibéré.** Les options, avec ce
qu'elles garantissent :

| Option | Garantie | Coût réel |
|---|---|---|
| Retirer le credential de l'agent et le mettre dans le coffre d'Oathrion | **A** — gouvernance effective | L'agent doit passer par un verbe Oathrion. C'est la seule option qui tient la promesse |
| Proxy HTTP sortant (Oathrion en MITM) | A, pour le trafic qui y passe | TLS à terminer, un schéma d'API à comprendre par fournisseur, et un agent qui peut changer de résolveur DNS |
| Politique réseau (egress refusé sauf vers Oathrion) | A, au niveau infrastructure | N'appartient pas au logiciel : c'est votre VPC |
| Laisser l'agent appeler directement et auditer après | **Aucune** | À ne pas vendre comme une gouvernance |

> **Si l'objectif annoncé est une gouvernance obligatoire, aucun agent ne doit conserver
> un accès direct non maîtrisé.** Le reste est une question d'infrastructure, pas de
> fonctionnalité produit.

---

## 5. Ce que ce chantier a changé, et ce qu'il a laissé

**Ajouté :** la découverte `tools/list` sortante (`npm run mcp:discover`), la comparaison
d'une déclaration au schéma réel du serveur, et les quatre refus nommés du §4. Le reçu
d'une dépêche porte désormais `schemaChecked`, donc « vérifié » et « non vérifiable » ne
se lisent plus de la même façon.

**Laissé en l'état, et la raison est écrite :** `withOathrion` reste dans `examples/`
(§4.B), aucun adaptateur Python n'est écrit (§4.B), aucun proxy universel n'est commencé
(§4.C). Les trois sont des décisions, pas des oublis.

## 6. Critères d'acceptation

Un parcours « brancher un agent existant » est considéré livré quand ces commandes
passent, et elles sont toutes exécutables par vous :

| Critère | Commande | Attendu |
|---|---|---|
| La découverte lit le schéma réel d'un serveur indépendant | `npm run mcp:discover -- --destination=…` | noms, descriptions, champs requis |
| Une déclaration fausse ne dépêche pas | `npm run verify:tools` | 49/49, dont un troisième démarrage avec un nom d'outil erroné : ALLOW, et **zéro** requête chez le fournisseur |
| Les trois refus nomment leur correction | `vitest run server/test/upstream-schema.test.ts` | 14/14 contre `examples/mcp-server/` |
| Le chemin aval reste inchangé | `npm run verify:mcp` | 37/37 |
| ALLOW / BLOCK / APPROVAL sur un outil réel | `vitest run server/test/connector-control-point.test.ts` | 13/13 |
| Le SDK et l'adaptateur sont fail-closed | `vitest run sdk/ examples/` | 76 tests |
| Le SDK Python l'est aussi | `python3 -m unittest discover -s sdk/python` | 37 tests, OK |
| Aucune règle de sécurité affaiblie | `npm run conformance -- --mutants` | 27/27 CONFORME, 25 mutants attrapés |
