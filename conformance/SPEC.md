# Kit de conformité — autorisation d'agent

**Version de la spécification : 0.3**

Ce document définit une autorisation d'agent correcte, vérifiée en **boîte noire**, sur
HTTP uniquement. Il fait autorité sur le code du kit : une vérification que ce document
ne décrit pas n'a pas à exister, et une propriété décrite ici sans vérification est un
défaut du kit.

> **Provenance.** La v0.2 a été rédigée par un agent distinct à partir des tests de ce
> dépôt. La v0.3 applique quatre corrections : C34 reste **core** et c'est le produit qui
> a été corrigé ; C32 et C33 passent en **core** ; C35 devient déterministe ; les
> propriétés non implémentées sont nommées. Le § 7 dit ce qui a changé et pourquoi.

---

## 1. Conventions

### 1.1 Profil filaire

Le kit juge les réponses brutes des routes ci-dessous, **qu'il appelle lui-même**. Ces
routes forment le profil de l'implémentation de référence. Une implémentation dont l'API
diffère expose ce profil par une passerelle, et cette passerelle fait partie de ce qui
est jugé.

Alternative écartée : un driver qui traduirait chaque opération jugée. Un code qui lit
les réponses à la place du kit peut blanchir une violation ; le kit jugerait alors le
driver et non le produit.

| Route | Usage |
|---|---|
| `POST /api/actions/authorize` | demander une décision |
| `POST /api/actions/execute` | présenter un grant |
| `POST /api/actions/grants/:id/approve` | approuver, corps `{"actionHash": h}` |
| `POST /api/actions/grants/:id/reject` | rejeter, corps `{}` |
| `GET /api/actions/grants/:id` | lire un grant |
| `GET /api/actions/receipts/:id` · `GET /api/actions/receipts` | lire ou lister les reçus |
| `GET /api/executions/:id/audit/verify` | vérifier une trace |
| `GET /api/tools` | inventaire des outils |

### 1.2 Notation

- `A.agent`, `A.agent2`, `A.admin`, `B.agent`, `B.admin` : les credentials de l'état
  préparé (§ 4). Entre crochets, le credential qui porte la requête.
- `pay(n)` : une action du verbe autorisé de l'état préparé, de montant `n`.
  `pay(n)@X` remplace la destination par `X`.
- `erase` : l'action du verbe bloqué de l'état préparé.
- `exec(g, corps)` : `POST /api/actions/execute` avec `{"grantId": g, …corps}`.
- `Δ(X)` : la variation du compteur de livraisons de la destination `X` (§ 4, O1),
  mesurée entre le début et la fin de l'étape indiquée.
- `<aléa>` : une valeur aléatoire tirée par le kit à chaque passage, qui ne peut donc
  avoir été préparée par personne.
- « refus » : tout statut 4xx. Quand une propriété impose un code précis, elle le nomme.

### 1.3 Égalité différentielle

`R ≡ inexistant` signifie : la réponse `R` a **le même statut et le même champ `code`**
que la réponse à la même requête portant un identifiant `<aléa>`.

Le kit n'impose ni 404 ni 403. Il impose qu'**aucune différence ne soit observable** —
c'est la seule formulation qui ferme l'oracle d'existence, et elle est plus stricte que
les tests du dépôt, qui acceptent `[403, 404, 409]` sans les comparer entre eux.

### 1.4 Contrôles positifs

Une propriété négative passe trivialement sur un système qui refuse tout. Chaque preuve
inclut donc un contrôle positif, marqué `[+]`. **Un contrôle positif qui échoue rend la
propriété FAIL**, avec la mention « contrôle positif ». Jamais PASS, jamais SKIP.

### 1.5 Préconditions

Une violation doit être imputée à **une seule** propriété. Quand une propriété ne peut
être jugée que si une autre a passé, le kit la rend **SKIP**, motif « précondition Cn en
échec », au lieu de la faire tomber en même temps.

| Si elle échoue… | …ces propriétés sont SKIP |
|---|---|
| C1 | toutes, sauf C8, C34, C35, C36 |
| C6 | C7 |
| C10 | C21 |
| C15 | C26 |

Un SKIP de précondition n'arrive que si une propriété core est déjà FAIL : le verdict est
alors NON CONFORME de toute façon (§ 6).

---

## 2. Propriétés

Chaque entrée porte cinq champs, et aucun autre. Le champ **Mutant** est obligatoire pour
toute propriété core : si l'on ne sait pas décrire une violation, la propriété n'est pas
testable et n'a rien à faire ici. C'est la règle qui empêche une suite creuse.

### A. Décision

#### C1 — La décision suit la règle · core
- **Énoncé** : la décision rendue est celle qu'impose la règle préparée.
- **Origine** : `phase10-golden.test.ts` A, B, C ; `e2e-multitenant.ts` scénarios A, B, C
- **Preuve** : `authorize` [A.agent] `pay(sous le plafond)` → `ALLOW` ; `pay(au-dessus)` → `APPROVAL_REQUIRED` ; `erase` → `BLOCK`
- **Mutant** : `plafond-ignore` — le seuil n'est jamais comparé, `pay(au-dessus)` rend `ALLOW`.

#### C2 — Toute décision est une réponse réussie · extended
- **Énoncé** : chaque décision, BLOCK compris, est rendue avec le statut 200.
- **Origine** : `evaluate-contract.test.ts` ; `shared/api/evaluate-contract.ts`
- **Preuve** : les trois décisions de C1 → `200` pour les trois
- **Mutant** : `bloc-en-403`.

#### C3 — Une action BLOCK n'atteint jamais la destination · core
- **Origine** : `phase10-golden.test.ts` C ; `e2e-multitenant.ts` scénario C
- **Preuve** : `erase` → `BLOCK`, `Δ=0` ; si un `grantId` est tout de même rendu, `exec` → refus, `Δ=0`. [+] `pay` autorisé puis exécuté → `Δ=+1`
- **Mutant** : `bloc-avec-grant`.

#### C4 — Une action qu'aucune règle ne nomme est refusée · core
- **Origine** : `phase10-golden.test.ts` D ; `evaluate-contract.test.ts`
- **Preuve** : `authorize` [A.agent] verbe `conformance.undeclared.<aléa>` → `BLOCK`, `grantId` nul
- **Mutant** : `defaut-permissif`.

#### C5 — Décider ne livre rien · extended
- **Origine** : `phase10-golden.test.ts` ; `e2e-multitenant.ts`
- **Preuve** : `pay` → `ALLOW`, `Δ=0` mesuré après la réponse. [+] `exec` → `Δ=+1`
- **Mutant** : `livraison-anticipee`.

#### C6 — Le client ne dicte pas l'autorité · core
- **Origine** : `phase10-golden.test.ts`. La source exige le refus ; en isoler la non-prise en compte est une interprétation, assumée.
- **Preuve** : `authorize` [A.agent] `{…erase, "decision":"ALLOW"}` → pas `ALLOW`. [+] la même action sans le champ se comporte normalement
- **Mutant** : `champ-honore`.

#### C7 — Un champ d'autorité est refusé · extended
- **Origine** : `phase10-golden.test.ts`
- **Preuve** : `authorize` avec `"decision"`, puis `"actionHash"` → `400`
- **Mutant** : `champ-ignore`.

#### C8 — Sans credential valide, pas de décision · core
- **Origine** : `evaluate-contract.test.ts`
- **Preuve** : sans en-tête, puis avec `Bearer <aléa>` → refus, **corps sans clé `decision`**. [+] avec `A.agent` → `200`
- **Mutant** : `anonyme-decide`.

### B. Grant

#### C10 — Un grant s'exécute au plus une fois · core
- **Origine** : `phase10-golden.test.ts` F et K ; `e2e-multitenant.ts`
- **Preuve** : `exec(g)` → `200`, `Δ=+1` [+] ; seconde présentation identique → refus, `Δ=0`. Puis dix grants, deux `exec` concurrents chacun → `Δ=+10` au total. Un PASS signifie qu'aucune course n'a été observée, pas qu'il n'en existe aucune.
- **Mutant** : `rejeu-livre`.

#### C11 — Un grant est lié à l'action exacte · core
- **Origine** : `phase10-golden.test.ts` E ; `e2e-multitenant.ts`
- **Preuve** : grant pour `pay(n)` présenté avec `pay(n+1)` → refus, `Δ=0`. [+] présenté avec `pay(n)` → `200`
- **Mutant** : `hash-ignore`.

#### C12 — Un grant est lié à son agent · core
- **Origine** : `phase10-golden.test.ts` G ; `e2e-multitenant.ts`
- **Preuve** : grant émis à `A.agent`, présenté par `A.agent2` → refus, `Δ=0`. [+] présenté par `A.agent` → `200`
- **Mutant** : `agent-ignore`.

#### C14 — Un refus ne consomme pas le grant · core
- **Énoncé** : une présentation refusée laisse le grant exécutable par son titulaire.
- **Pourquoi core** : sinon, quiconque connaît un identifiant de grant peut annuler l'action d'autrui.
- **Origine** : `phase10-golden.test.ts` E ; `e2e-multitenant.ts`. L'extension à toutes les causes de refus est assumée.
- **Preuve** : pour chaque cause (action modifiée, autre agent), présentation fautive refusée, puis `exec` légitime → `200`, `Δ=+1`
- **Mutant** : `consomme-avant-controle`.

#### C15 — Un grant jamais émis n'autorise rien · core
- **Origine** : `e2e-multitenant.ts`
- **Preuve** : `exec("<aléa>", pay)` → refus, `Δ=0`
- **Mutant** : `grant-a-la-volee`.

#### C16 — Le credential fixe l'agent · core
- **Origine** : `evaluate-contract.test.ts` ; `agent-binding-adversarial.test.ts`
- **Preuve** : `authorize` [A.agent] en nommant l'agent de `A.agent2` → refus, corps sans `decision`. [+] `authorize` [A.agent2] pour son propre agent → `200`
- **Mutant** : `agent-du-corps`.

### C. Approbation

#### C18 — Un grant en attente ne s'exécute pas · core
- **Origine** : `phase10-golden.test.ts` B ; `e2e-multitenant.ts` scénario B
- **Preuve** : `pay(au-dessus)` → `APPROVAL_REQUIRED`, g, h ; `exec(g)` → refus, `Δ=0`. [+] approbation [A.admin] puis `exec(g)` → `200`, `Δ=+1`
- **Mutant** : `attente-executable`.

#### C19 — Approuver ne livre rien · extended
- **Origine** : `phase10-golden.test.ts` B
- **Preuve** : approbation → `200`, `Δ=0`. [+] `exec` → `Δ=+1`
- **Mutant** : `approbation-livre`.

#### C20 — L'agent ne s'approuve pas lui-même · core
- **Origine** : `rbac.test.ts`. Source matricielle ; la forme HTTP est assumée.
- **Preuve** : approbation par `A.agent` de son propre grant → refus ; `exec` → refus, `Δ=0`. [+] approbation [A.admin] → `200`
- **Mutant** : `auto-approbation`.

#### C21 — Une nouvelle approbation ne réarme pas un grant consommé · core
- **Origine** : `phase10-golden.test.ts` ; `e2e-multitenant.ts`. Les sources rejouent l'approbation **avant** l'exécution ; la rejouer **après** la consommation est assumé.
- **Preuve** : approuvé, exécuté (`Δ=+1`) [+] ; nouvelle approbation → refus ; `exec` → refus, `Δ=0`
- **Mutant** : `reapprobation-rearme`.

#### C22 — Un rejet est définitif · extended
- **Origine** : **inventée.** Aucun test ne la vérifie pour les grants. Retenue parce qu'un rejet sans effet ferait mentir le bouton « rejeter ».
- **Preuve** : rejet [A.admin] → `200` [+] ; approbation → refus ; `exec` → refus, `Δ=0`
- **Mutant** : `rejet-sans-effet`.

### D. Isolation

`B` tient les credentials **complets** de sa propre organisation. C'est ce qui rend ce
groupe sérieux : on n'y teste pas un anonyme, on y teste un administrateur légitime.

#### C24 — B ne peut pas approuver un grant de A · core
- **Origine** : `e2e-multitenant.ts` ; `multitenant-authority-isolation.test.ts`
- **Preuve** : approbation par `B.admin` d'un grant de A **≡ inexistant** ; le grant reste non approuvé. [+] A approuve le sien → `200`
- **Mutant** : `approbation-globale`.

#### C26 — B ne peut pas exécuter un grant de A · core
- **Origine** : `phase10-golden.test.ts` H ; `e2e-multitenant.ts` ; `tenant-isolation.test.ts`
- **Preuve** : grant de A présenté par un agent de B portant **le même identifiant d'agent** ≡ inexistant, `Δ=0` des deux côtés. [+] B exécute le sien → `200`
- **Mutant** : `execution-globale`.

#### C27 — Lire un objet de A ne révèle pas son existence · core
- **Origine** : `tenant-isolation.test.ts` ; `e2e-multitenant.ts`
- **Preuve** : `GET grants/:id` et `GET receipts/:id` de A par `B.admin` ≡ inexistant. [+] les mêmes lectures par `A.admin` → `200`
- **Mutant** : `oracle-403` — un objet étranger existant répond `403`, un inexistant `404`.

#### C28 — Les listes de B ne contiennent rien de A · core
- **Origine** : `e2e-multitenant.ts` ; `tenant-isolation.test.ts`
- **Preuve** : le reçu `r` produit par A est absent de `GET receipts` [B.admin]. [+] présent pour `A.admin`
- **Mutant** : `liste-globale`.

### E. Audit

#### C32 — Une trace intacte se vérifie · **core** (était extended en v0.2)
- **Origine** : `audit-verify-endpoint.test.ts` ; `receipt-chain-verify.test.ts`
- **Preuve** : après une exécution, `GET /api/actions/receipts/verify` [A.admin] → `200 {"ok":true,"entries":≥1,"headHash":<64 hex>}`
- **Note v0.3** : la preuve visait d'abord `GET /api/executions/:id/audit/verify`. Le kit a alors découvert que **le chemin d'autorité ne nomme aucun enregistrement de cette table** — son `executionId` est un `axn_…` qui désigne l'appel aval. C32 et C33 restaient donc en SKIP, et un client n'avait aucun moyen de vérifier la trace de ses propres actions. La route `GET /api/actions/receipts/verify` a été ajoutée au produit pour cela.
- **Mutant** : `sans-trace` — aucune entrée écrite, réponse `{"ok":true,"entries":0,"headHash":null}`.
- **Limite assumée** : le kit vérifie qu'une trace **existe** et se vérifie. Il ne peut pas prouver qu'un vérificateur dit vrai — en boîte noire, un vérificateur complaisant passerait. La barre est basse, mais elle est réelle : `entries: 0` ne passe pas.

#### C33 — La vérification est cadrée au locataire · **core** (était extended en v0.2)
- **Origine** : `audit-verify-endpoint.test.ts` ; `e2e-multitenant.ts` ; `receipt-chain-verify.test.ts`
- **Preuve** : A et B obtiennent chacun `200`, avec des têtes de chaîne **différentes**, et **chacun vérifie la sienne** (`ok: true` des deux côtés). [+] A compte au moins une entrée après avoir exécuté
- **Mutant** : `verification-globale`.
- **Renforcement v0.4** : la preuve n'exigeait pas `ok: true`. Le mutant `verification-globale` a montré que la propriété se satisfaisait alors pour la mauvaise raison — en retirant le cadrage par locataire, les deux voient les mêmes lignes, mais leurs têtes restent différentes parce que la chaîne de A ne part pas de la genèse de B : la vérification de B **échoue**, sa tête devient nulle, et « têtes distinctes » était vrai. La propriété décrivait une fuite comme un cloisonnement. Un locataire qui ne peut plus vérifier sa propre chaîne n'est pas cloisonné, il est cassé.
- **Note v0.3** : l'égalité différentielle ne s'applique pas ici — la route ne nomme aucun objet, donc il n'y a pas d'existence à révéler. Ce qui doit être vrai est plus simple : chaque locataire ne voit que sa propre chaîne.

### F. Honnêteté et contrat

#### C34 — Chaque outil déclare s'il est simulé · core
- **Origine** : `claims-honesty.test.ts` (principe) ; `server/mcp/tool-catalog.ts`. **Aucun test HTTP ne le vérifiait** — c'est la conclusion qui a produit le correctif produit, voir § 7.
- **Preuve** : `GET /api/tools` → `200`, au moins une entrée, `typeof simulated === "boolean"` pour chacune
- **Mutant** : `sans-drapeau`.
- **Pourquoi core** : un inventaire qui tait ce qui est simulé rend invérifiable, pour un opérateur sans compteur côté outil, toute affirmation d'exécution du plan de contrôle.

#### C35 — Une erreur porte un code machine · extended
- **Énoncé** : chaque réponse non-2xx **d'un jeu fixe de requêtes fautives émises par cette propriété** porte un champ `code` en snake_case.
- **Origine** : `api-error.test.ts`
- **Preuve** : trois requêtes émises par la propriété elle-même — identifiant de grant inexistant, corps invalide, credential absent — chacune non-2xx, chacune avec `code` conforme à `^[a-z][a-z0-9_]*$`
- **Mutant** : `erreur-en-prose`.
- **Correction v0.3** : la v0.2 jugeait « toutes les réponses non-2xx collectées pendant le passage ». Son verdict dépendait donc de quelles **autres** propriétés avaient tourné — et le § 1.5 peut en mettre beaucoup en SKIP. Une propriété dont le résultat change avec l'ordre d'exécution est une observation, pas une propriété. Le contrôle transversal subsiste en complément, jamais comme fondement du verdict.

---

## 3. Hors périmètre, et pourquoi

Les tests du dépôt garantissent ce qui suit, mais rien n'en est vérifiable par HTTP seul.

| Garantie | Source | Raison de l'exclusion |
|---|---|---|
| Une trace éditée dans le stockage est détectée | `audit-verify-endpoint.test.ts`, `receipt-chain-verify.test.ts` | Il faut écrire dans le stockage. Hors d'un kit boîte noire — mais la détection elle-même est bien prouvée, par `receipt-chain-verify.test.ts`, qui édite, supprime et déplace des reçus en base. |
| Magasin indisponible, rien n'est autorisé | `readiness.test.ts`, `chaos-postgres.ts` | Il faut arrêter le magasin. |
| Écritures conditionnelles portant l'organisation | `tenant-isolation.test.ts` | Appels internes ; leur effet observable est couvert par C24 à C28. |
| Aucun source livré ne revendique de garantie absolue sur le journal | `claims-honesty.test.ts` | Analyse statique du texte source. C34 en reprend le principe sur la surface HTTP. Et le garde a repris CE fichier : la ligne employait le mot qu'elle interdit. |
| Scopes, mandat, plafonds, catalogue de verbes | `permission-enforcement.test.ts`, `mandate.test.ts` | Modèle de politique propre à Oathrion. L'exiger ferait du kit un test de clonage. |
| Atomicité prouvée sur plusieurs processus | `phase11-multiprocess.test.ts` | Il faut plusieurs instances. C10 n'en vérifie que l'effet observable. |
| Export de locataire, rédaction des journaux | `e2e-multitenant.ts` | Il faut lire la base et la sortie du processus. |

---

## 4. Interface du driver

Le kit ne demande pas d'**opérations** de mise en place. Il demande un **état préparé**,
plus **une seule** opération d'observation. La façon de fabriquer cet état ne regarde pas
le kit : API, SQL, configuration ou script.

### 4.1 L'état préparé

| Élément | Exigé |
|---|---|
| `a.agent`, `a.agent2` | deux credentials de A, liés à deux agents distincts |
| `a.admin` | un credential de A qui peut lire, approuver, rejeter |
| `b.agent`, `b.admin` | les mêmes pour B, **une autre organisation** |
| `allowVerb`, `blockVerb` | un verbe autorisé sous plafond, un verbe toujours refusé |
| `belowCeiling`, `aboveCeiling` | deux montants, de part et d'autre du plafond |
| `a.destination`, `b.destination` | la destination utilisable par chaque organisation |

Le verbe non catalogué **n'est pas fourni** : le kit le tire au hasard, sans quoi une
implémentation pourrait traiter à part le verbe qu'elle a elle-même déclaré.

### 4.2 L'opération du driver

| # | Opération | Justification |
|---|---|---|
| O1 | `deliveries(destination) → nombre` | Aucune réponse HTTP ne prouve qu'une action n'a **pas** atteint l'outil. Seul un compteur placé du côté de l'outil le prouve. |

C'est la seule. La v0.1 en demandait six obligatoires et trois facultatives.

---

## 5. Verdict

| Verdict | Condition |
|---|---|
| **CONFORME** | toutes les propriétés core sont PASS |
| **NON CONFORME** | au moins une core est FAIL |
| **INCOMPLET** | aucune core en FAIL, au moins une en SKIP. Ce n'est pas une conformité. |
| **INVALIDE** | l'état préparé est incomplet, ou O1 est injoignable. Rien n'a été jugé. |

Un SKIP porte toujours sa raison et n'est jamais compté comme un PASS. Les propriétés
extended sont rapportées à part et ne changent pas le verdict.

---

## 6. État d'implémentation

Ce tableau est la seule source du décompte, et le kit refuse de démarrer s'il diverge de
ce que le code enregistre.

| | core | extended | total |
|---|---|---|---|
| **Spécifiées** | 21 | 6 | 27 |
| **Implémentées** | voir `conformance/REPORT.md` | | |

Les propriétés C9, C13, C17, C23, C25, C29, C30, C31, C36 de la v0.2 sont **retirées de la
v0.3**, non parce qu'elles sont fausses, mais parce qu'elles exigent un état préparé plus
riche (seconde destination par organisation, credential sacrifiable, TTL déclaré) que la
v0.3 ne demande pas. Les réintroduire est un travail d'extension de l'état préparé, pas de
conception. **Une propriété spécifiée et non implémentée n'est jamais comptée comme
passée** : le kit la rapporte `NOT_IMPLEMENTED`.

---

## 7. Ce que la v0.3 change, et pourquoi

**C34 reste core, et c'est le produit qui a été corrigé.** La v0.2 constatait que
l'implémentation de référence échouait à sa propre propriété core et proposait de la
rétrograder en extended. Abaisser une exigence pour qu'une implémentation passe est le
réflexe que ce dépôt interdit. Vérification faite : `GET /api/tools` ne renvoyait que
`id`, `name`, `description`, `toolExecutionCount`, le catalogue MCP portait un
`simulated: true as const`, et le **type** `OathrionToolGovernance.simulated` était le littéral
`true` — le système de types encodait la fausse affirmation. `docs/COMMERCIAL_READINESS.md`
affirmait pourtant que la route « expose le drapeau ». Corrigé dans le commit
« produit: l'inventaire des outils dit enfin la vérité sur la simulation (C34) ».

**C32 et C33 passent en core.** Décision stratégique autant que technique : une
implémentation qui ne produit aucune trace vérifiable n'est pas un plan de contrôle, c'est
un filtre. Déclarer CONFORME une telle implémentation viderait le kit de ce qu'il doit
définir. La limite est écrite dans C32.

**C35 devient déterministe** — voir sa correction.

**Le décompte est explicite et vérifié par le code** (§ 6). La v0.1 avait un décompte faux ;
la v0.2 l'avait corrigé mais sans garde. Le kit refuse désormais de démarrer si le code et
ce document ne sont pas d'accord.
