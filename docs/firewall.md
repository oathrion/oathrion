# Le pare-feu — Oathrion en amont des APIs de vos agents

Un agent appelle une API. Oathrion se met entre les deux, lit la requête, applique vos
règles, et transmet **si et seulement si** la décision est ALLOW.

```
  agent  ──►  POST /api/v1/intercept/stripe-api/v1/refunds  ──►  Oathrion  ──►  api.stripe.com
                                                                   │
                                          BLOCK ◄──────────────────┤
                                          202 + approbation ◄──────┘
```

---

## 1. Brancher un agent — deux modes

### Transparent : changez l'URL de base, rien d'autre

```diff
- const stripe = new Stripe(key, { host: "api.stripe.com" });
+ const stripe = new Stripe(placetKey, { host: "placet.acme.com", basePath: "/api/v1/intercept/stripe-api" });
```

Même méthode, même chemin, même corps. L'agent ne sait pas qu'il parle à un pare-feu.
C'est le mode à préférer.

### Enveloppe : quand l'URL de base est codée en dur

```bash
curl -X POST https://placet.acme.com/api/v1/intercept \
  -H "Authorization: Bearer <clé Oathrion de l'agent>" \
  -d '{"destination":"stripe-api","method":"POST","path":"/v1/refunds",
       "body":{"charge":"ch_1","amount":7500,"currency":"usd"}}'
```

Les deux traversent le même code à partir de la normalisation de la requête.

---

## 2. Déclarer ce qui est gouvernable

```bash
OATHRION_DESTINATIONS='[{"id":"stripe-api","url":"https://api.stripe.com","organizations":["org_acme"]}]'
OATHRION_INTERCEPTS='[{
  "id": "stripe_refunds",
  "destination": "stripe-api",
  "method": "POST",
  "path": "/v1/refunds",
  "action": "refund",
  "target": "body.payment_intent|body.charge",
  "amount": "body.amount",
  "amountUnit": "minor",
  "forwardHeaders": ["content-type"]
}]'
```

> **Pour Stripe, préférez le paquet** : `OATHRION_INTERCEPT_PACKS=stripe` porte ces règles
> relues et vérifiées contre le vrai service (`npm run verify:stripe`, 30/30 en mode test).
> L'exemple ci-dessus en est extrait, et il a été **corrigé par Stripe** : il lisait
> `"currency": "body.currency"` avec `"amountScale": 100`. Stripe refuse `currency` sur
> `/v1/refunds` (`Received unknown parameter: currency`), et le franc CFA n'a pas de
> centimes — `amountUnit: "minor"` prend l'échelle dans la devise.
>
> `target` accepte plusieurs sources séparées par `|`, lues dans l'ordre : un
> remboursement Stripe désigne son paiement par `payment_intent` **ou** par `charge`.

> **L'API de Stripe parle `application/x-www-form-urlencoded`**, pas JSON. Le relais
> transmet le corps **brut**, octet pour octet, sous le `content-type` de l'agent : les
> deux fonctionnent. Vérifié par `verify:intercept`, avec un `metadata[order]` nesté qui
> arrive intact.

| Champ | Ce qu'il fait |
|---|---|
| `destination` | une entrée du registre existant : **même allowlist, mêmes règles d'adresse anti-SSRF**. Une règle ne peut pas inventer une destination |
| `method` + `path` | ce que la règle reconnaît. `*` est un joker **d'un seul segment** ; `{nom}` capture un segment et se lit avec `path.nom` |
| `action` | le verbe Oathrion. Doit être au catalogue de `shared/policy/actions.ts`, sinon le serveur refuse de démarrer |
| `target`, `amount`, `currency` | **d'où lire** dans la requête : `body.<champ>` (descente par points), `query.<champ>`, `header.<nom>`, `path.<segment>` |
| `amountScale` | diviseur. `100` pour une API en centimes. **Oublié, vos plafonds sont faux d'un facteur 100 dans le sens permissif** — Oathrion affiche un avis au démarrage, il ne peut pas le détecter |
| `forwardHeaders` | **liste d'AUTORISATION** des en-têtes que l'agent peut faire relayer. Défaut : `content-type`, `accept`. Voir §2bis |
| `stream` | relayer la réponse **au fil de l'eau** au lieu de la tamponner. Pour une API qui répond en `text/event-stream` — une API de modèle. Voir §3bis |

### La décision de conception qui compte : le verbe ne vient pas de l'agent

Un agent qui déclarerait lui-même *« cette requête est un `refund` de 75 USD »*
choisirait la règle qui le gouverne. Il suffirait d'annoncer `amount: 1` et d'envoyer un
corps à 100 000 pour passer sous tous les plafonds — et l'audit enregistrerait une
autorisation qui ne décrit pas ce qui s'est produit.

Ici, le verbe, la cible et le montant sont **extraits de la requête réelle**. L'agent
n'annonce rien : il envoie son appel HTTP, et Oathrion le lit. L'enveloppe refuse en 400
tout champ `action` ou `amount` qu'un client essaierait de fournir.

### `amountScale` n'est pas un détail

Stripe envoie `7500` pour 75 USD. Un plafond écrit « 500 » par un exploitant veut dire
500 dollars. **Sans conversion déclarée, un plafond de 500 laisserait passer 500 000.**
C'est une division explicite, par règle, jamais devinée.

### 2bis. Les en-têtes sont une liste d'autorisation — et pourquoi c'est critique

C'était une liste de **refus** : douze noms interdits, tout le reste transmis. Pour un
pare-feu, c'est à l'envers, et ce n'était pas théorique :

| En-tête | Ce que l'agent obtenait |
|---|---|
| `Stripe-Account: acct_autre` | **agir sur un autre compte Stripe Connect** |
| `Stripe-Version` | changer la sémantique de l'API sous la règle |
| `Idempotency-Key` | reprendre le contrôle de la déduplication |

La règle inspecte `body.charge` et le plafond. **Aucun des deux ne voit le changement de
compte.** Un agent compromis par injection de prompt remboursait sur le compte d'un
tiers, dans les limites autorisées, et l'audit enregistrait une action parfaitement
conforme : la règle « le verbe ne vient pas de l'agent » était contournée par le canal
d'à côté.

Désormais : **rien ne passe sauf ce que la règle nomme.** Le défaut est
`content-type` + `accept`. `authorization`, `cookie`, `host`, `accept-encoding` et les
en-têtes de transport sont refusés **même en les nommant** — le serveur refuse de
démarrer et le dit, plutôt que de les filtrer en silence.

`accept-encoding` est dans ce plancher pour une raison mécanique : le transport ne
décompresse pas, donc un `gzip` demandé par l'agent reviendrait comme des octets abîmés
lus en UTF-8 — une réponse corrompue rendue comme valide.

#### Le symptôme à connaître avant de l'attribuer à Oathrion

Une liste d'autorisation a un coût opérationnel, et il vaut mieux le lire ici que le
découvrir en production. **Si votre fournisseur exige un en-tête que la règle ne nomme
pas, il le refusera** — et ce que vous verrez est ceci :

```
HTTP/1.1 400 Bad Request          ← le statut DU FOURNISSEUR
x-oathrion-decision: ALLOW          ← Oathrion avait bien autorisé
```

Les deux lignes sont correctes ensemble, et c'est voulu : la **décision de gouvernance**
et la **réponse de l'API** sont deux informations distinctes. Oathrion ne confond jamais
« autorisé » avec « réussi », et ne fabrique pas un 200 pour faire plaisir.

Ce n'est pas une hypothèse : au premier passage du banc d'endurance, `forwardHeaders` ne
nommait que `content-type` alors que l'amont exigeait `MCP-Protocol-Version`. **Les 2 100
appels ont été refusés en 400 par l'amont**, avec `x-oathrion-decision: ALLOW` sur chacun.
L'allowlist faisait exactement son travail.

La correction est toujours la même : **nommer l'en-tête dans la règle.** Demandez à votre
fournisseur la liste de ce qu'il attend — c'est une liste courte, et la poser une fois
vaut mieux qu'un plancher permissif pour toujours.

### 2ter. Les APIs REST qui mettent la ressource dans l'URL

Une API sur deux écrit la cible dans le chemin, pas dans le corps :

```
POST /v1/charges/ch_123/capture
POST /repos/acme/backend/issues
PATCH /customers/cus_42
```

Ces routes **n'étaient pas gouvernables** : la cible était introuvable, et Oathrion refusait
en 422 à chaque appel. Déclarez un segment nommé et lisez-le :

```json
{
  "id": "stripe_capture",
  "destination": "stripe",
  "method": "POST",
  "path": "/v1/charges/{charge}/capture",
  "action": "charge",
  "target": "path.charge",
  "amount": "body.amount",
  "amountScale": 100,
  "forwardHeaders": ["content-type"]
}
```

`{charge}` vaut **un** segment, comme `*` — un joker qui traverserait les `/` ferait d'une
règle écrite pour capturer une charge une règle couvrant ses sous-ressources.

**Une source `path.x` dont le motif ne déclare pas `{x}` refuse le démarrage**, avec la
liste des segments réellement déclarés. À l'exécution ce serait un 422 à chaque appel : un
refus correct au mauvais moment, avec un motif qui parle de la requête alors que la faute
est dans la configuration.

#### Le segment est DÉCODÉ pour être jugé, et relayé tel quel

Un agent qui connaît une politique de refus sur `ch_interdit` appellerait
`/v1/charges/ch%5Finterdit/capture`. Si Oathrion jugeait la chaîne encodée, il ne
reconnaîtrait pas la cible refusée, autoriserait — et le fournisseur, lui, décoderait et
agirait sur la charge interdite.

Donc : **la cible jugée est décodée, le chemin relayé est inchangé, octet pour octet.**
Deux rôles, deux valeurs. Un segment qui ne se décode pas (`%zz`) fait échouer
l'appariement : une cible dont on n'est pas sûr de la valeur n'est pas une cible.

### Deny by default

Une requête qu'aucune règle ne reconnaît est **refusée en 403**, avec le motif et ce
qu'il faut déclarer. Pas transmise « puisqu'on ne sait pas la juger ». Un pare-feu qui
laisse passer ce qu'il ne comprend pas n'est pas un pare-feu, c'est un journal.

---

## 3. Ce que l'agent reçoit

| Décision | Statut | Corps |
|---|---|---|
| ALLOW | **celui du fournisseur** (200, 201, 422…) | la réponse du fournisseur, telle quelle |
| BLOCK | `403` | la décision, le motif, la politique, `forwarded: false` |
| APPROVAL_REQUIRED | `202` | `approvalId` et `approvalWindowMs` — reçu, pas exécuté |
| Aucune règle | `403` | `intercept_no_rule` et la correction |
| Requête illisible par la règle | `422` | quel champ manque |

Trois en-têtes de gouvernance sur **chaque réponse jugée** — autorisation, refus et
approbation en attente — lisibles sans parser le corps : `x-oathrion-decision`,
`x-oathrion-rule`, `x-oathrion-execution-id`.

**Sur un refus aussi, et c'est là qu'ils comptent le plus.** Le statut d'une réponse
autorisée est celui du fournisseur : un 403 d'Oathrion et un 403 rendu par le fournisseur
arrivent donc tous les deux en 403. L'en-tête les distingue — `BLOCK` pour le premier,
`ALLOW` pour le second — et la question se tranche par une lecture d'en-tête au lieu d'une
analyse de corps.

`x-oathrion-credential-injected`, lui, n'appartient qu'à la voie autorisée : il n'y a pas de
credential à injecter dans une requête qui ne part pas.

> Cette phrase était fausse jusqu'à cette révision : les trois en-têtes n'étaient posés que
> sur la voie autorisée, donc `if (headers['x-oathrion-decision'] === 'BLOCK')` ne se
> déclenchait jamais. Trouvé en écrivant `npm run demo`, qui attendait l'en-tête annoncé
> ici et ne le trouvait pas.

Le statut est **celui du fournisseur** et non 200 d'office : un agent qui reçoit 200 pour
un 422 de Stripe croirait son remboursement passé.

---

## 3bis. Mettre Oathrion devant une API de modèle

Sans `stream`, Oathrion attend la réponse ENTIÈRE du fournisseur puis la rend d'un coup. Pour
une API de modèle qui émet ses jetons pendant plusieurs secondes, cela supprime le
streaming que l'application de l'utilisateur attend, et une réponse longue bute sur le
plafond de 1 Mio et fait échouer l'appel.

```json
{
  "id": "modele_chat",
  "destination": "openai",
  "method": "POST",
  "path": "/v1/chat/completions",
  "action": "api.request",
  "target": "body.model",
  "stream": true,
  "forwardHeaders": ["content-type", "accept"]
}
```

Mesuré, sur un amont qui attend 250 ms entre deux événements : **premier octet à 32 ms,
dernier à 279 ms**. Le même amont sans `stream` : **tout à 325 ms**. C'est la seule mesure
qui distingue les deux modes — le contenu final est identique.

### `api.request` et non `call_api`

`call_api` est délibérément **sans portée de permission**, donc atteignable par tout agent,
donc non câblable à un outil. Une règle qui le nomme **refuse le démarrage**, avec le motif.
`api.request` existe pour cet usage et exige `call:external-api`.

### Le mode est DÉCLARÉ, jamais deviné

Oathrion pourrait regarder le `content-type` de la réponse et basculer tout seul. Ce serait
laisser le **fournisseur** choisir la façon dont Oathrion traite sa réponse — la même raison
qui fait que le verbe ne vient pas de l'agent.

### Les plafonds sont déplacés, pas retirés

| Borne | Valeur | Ce qu'elle empêche |
|---|---|---|
| octets | 64 Mio | un amont qui émet sans fin |
| silence | 60 s | un amont tombé après ses en-têtes |
| durée totale | 10 min | un amont qui émet un octet toutes les 30 s et ne déclenche jamais le délai de silence |

Le dépassement **coupe** au lieu de refuser : à cet instant l'agent a déjà reçu des octets,
et HTTP n'offre pas de reprise. `truncated` est alors **persisté dans le reçu** — un
auditeur doit savoir que l'agent a agi sur une réponse partielle, alors que l'effet chez le
fournisseur, lui, a eu lieu en entier.

La **contre-pression** est en place : si l'agent lit moins vite que le fournisseur n'émet,
l'amont est mis en pause. Sans elle le tampon intermédiaire grossirait sans borne, ce qui
reconstituerait en mémoire exactement ce que le mode flux évite.

### ⚠ UN PLAFOND DE MONTANT BLOQUE UN APPEL DE MODÈLE

L'interaction la plus coûteuse à découvrir en production, et elle n'est pas un défaut :

```
BLOCK — "Au-dessus de 500, un humain" caps this action at 500,00 €,
        but the action declares no numeric "amount"
```

Un appel de modèle ne porte pas de montant. Un plafond en euros ne peut pas le borner, et
le moteur **refuse plutôt que de laisser passer** — fail-closed, dans le bon sens.

Donc : **un plafond de montant posé à l'échelle de l'organisation bloque tous les verbes
sans montant.**

**La correction tient en un champ**, et c'est celui que le jeu de politiques livré emploie
déjà pour `pol_purchase_limit` — `condition.actions` restreint le plafond aux verbes qui
portent un montant :

```json
{
  "type": "MAX_TRANSACTION_AMOUNT",
  "condition": {
    "kind": "amountAtMost", "max": 500, "currency": "EUR",
    "actions": ["refund", "payment", "payout", "charge"]
  }
}
```

L'alternative — porter le plafond sur certains agents avec `appliesToAgentIds` — marche
aussi, et reste utile quand c'est l'AGENT qu'on veut borner plutôt que le verbe. Mais
`condition.actions` est le bon outil ici : un plafond en euros est une règle sur des
verbes financiers, pas sur une personne.

Un refus sec sur une CIBLE (`targetMatches`) n'a, lui, besoin d'aucun montant et gouverne
bien tout agent.

### Ce qu'un flux ne permet plus

Oathrion ne voit jamais la réponse en une fois. Il n'en disait rien aujourd'hui — le corps
n'est ni inspecté ni persisté — donc rien n'est perdu ici. Mais une future inspection de
réponse serait impossible sur un flux, et une requête **retenue pour approbation** est
toujours relayée en mode tamponné : l'agent a reçu un 202, sa connexion est fermée, il n'y
a personne vers qui faire couler quoi que ce soit.

---

## 3ter. Les APIs AWS — signer au lieu d'injecter

AWS ne s'authentifie pas par une valeur dans un en-tête : il faut **signer la requête**, et
la signature couvre la méthode, le chemin, la chaîne de requête, les en-têtes signés et le
**hachage du corps**. Aucun en-tête statique ne peut la produire — c'est pour ça que S3,
Bedrock, Lambda, SQS et DynamoDB étaient hors de portée.

```bash
OATHRION_SIGV4_AWS_BEDROCK='{"region":"eu-west-3","service":"bedrock"}'
```

Le credential va dans le coffre du locataire, sous l'une des deux formes :

```
AKIDEXAMPLE:wJalrXUtnFEMI...                                   # clé longue durée
{"accessKeyId":"…","secretAccessKey":"…","sessionToken":"…"}    # credentials temporaires
```

**La région et le service ne sont pas devinés depuis l'hôte.** `iam.amazonaws.com` est en
`us-east-1` sans que son nom le dise, et une déduction fausse produit une signature
qu'AWS refuse avec « signature mismatch » — sans dire que la cause est la région. Une
région mal écrite **refuse le démarrage**.

### Signer RENFORCE la garantie d'Oathrion

Avec un en-tête statique, la garantie est « l'agent n'a pas la clé ». Avec une signature,
elle devient « **la requête elle-même est scellée** » : un agent ne peut pas faire signer
une requête puis en envoyer une autre, puisque le chemin, la méthode, les en-têtes signés
et le hachage du corps sont dans la signature. Un octet modifié invalide tout.

### Ce qui est vérifié, et ce qui ne l'est pas

L'implémentation suit la spécification d'AWS et est éprouvée contre **une seconde
implémentation** écrite dans le test depuis ce même texte, sur sept scénarios (GET nu,
corps JSON, chaîne de requête à trier, paramètres à encoder, chemin accentué, credentials
temporaires, corps vide), plus les règles une par une : l'encodage d'URI qui n'est pas
celui de JavaScript, le `Trim()` des valeurs d'en-tête, le tri de la chaîne de requête
**après** encodage, et les en-têtes « sautés » qui ne doivent jamais être signés.

**Elle n'est pas éprouvée contre un vrai point d'entrée AWS.** Ce dépôt n'a pas de
credential AWS et n'en fabriquera pas. **Faites un appel réel avant de vous y fier.**

---

## 3quater. Les téléversements — `multipart/form-data`

Le corps part **octet pour octet**, frontière comprise. Deux choses à savoir.

**La cible ne peut pas venir du corps.** Un corps multipart est relayé tel quel mais
jamais analysé : lisez la cible dans l'URL (`path.<segment>`), la chaîne de requête ou un
en-tête. Une règle qui déclarerait `body.*` sur une telle route refuse en 422, et le motif
le dit.

**Le corps est bufférisé en entier.** Oathrion ne diffuse pas une requête entrante : il lui
faut la requête complète pour en extraire la cible, la hacher quand une signature AWS la
couvre, et la garer si un humain doit approuver. `OATHRION_MAX_BODY_BYTES` borne cela —
10 Mio par défaut, et un corps plus gros est **refusé, pas tronqué**.

> Le défaut que ça corrige : `rawBody` n'était capturé que par les parseurs JSON et
> form-encoded. Un multipart n'étant réclamé par aucun des deux, **le relais envoyait un
> corps vide** — et le fournisseur recevait une requête bien formée, avec les bons
> en-têtes, sans contenu.
>
> Et un second, trouvé par le test : le corps brut voyageait dans une chaîne écrite en
> UTF-8. 288 octets envoyés, **293 reçus** ; 2 Mio d'aléatoire devenaient 3 Mio. Un
> fichier systématiquement corrompu, sans erreur nulle part. Le corps voyage maintenant
> en latin1 — un octet, un point de code — et `server/intercept/raw-body.ts` porte cette
> convention à un seul endroit.

---

## 3quinquies. Si Oathrion échoue, la réponse dit si la requête est partie

C'est le cas le moins fréquent et le plus important à traiter correctement : Oathrion a
accepté la requête, et quelque chose a échoué **à l'intérieur** — la base n'a pas répondu,
un plafond de quota a été atteint, l'enregistrement de la décision n'a pas abouti.

La version précédente répondait **500, sans rien d'autre**. Ni la décision, ni — et c'est
le point — si la requête avait été transmise au fournisseur. Pour un agent, « je ne sais
pas si votre remboursement est parti » est la plus mauvaise réponse possible : il ne peut
ni réessayer sans risquer un doublon, ni renoncer sans risquer une perte.

La réponse porte maintenant un booléen établi par **observation**, et une phrase qui dit
quoi faire :

```json
{
  "error": "intercept_gateway_failed",
  "code": "gateway_failed",
  "forwarded": false,
  "message": "Oathrion n'a PAS transmis la requête : la décision n'a pas pu être
              enregistrée. Rien n'est parti au fournisseur, le réessai est sûr.
              Référence de relais rel_…",
  "interception": { "rule": "…", "destination": "…", "ref": "rel_…" }
}
```

`forwarded: true` dit l'inverse, et le message devient **« NE RÉESSAYEZ PAS à l'identique :
l'effet a probablement eu lieu »**, avec le statut que le fournisseur avait rendu.

### Ce que votre agent doit faire de cette réponse

| `forwarded` | Ce qui est certain | Ce qu'il faut faire |
|---|---|---|
| `false` | Rien n'a atteint le fournisseur | Réessayer est **sûr** |
| `true` | Le fournisseur a répondu, Oathrion n'a pas pu l'enregistrer | **Ne pas** réessayer à l'identique ; réconcilier avec le fournisseur par `ref` |

**Aucun en-tête `x-oathrion-decision` n'est posé sur cette réponse.** Rien n'a été jugé,
donc rien n'est annoncé : un agent qui lirait `ALLOW` croirait son action gouvernée et
relâchée.

La cause exacte est journalisée **côté serveur** avec la référence de relais, et tenue hors
de la réponse — une erreur interne peut nommer une table, une contrainte, un hôte de base.

> **Statut honnête.** La branche `forwarded: false` est éprouvée de bout en bout
> (`server/test/intercept-gateway-failure.test.ts`, déclenchée par un plafond de quota
> réel). La branche `forwarded: true` — fournisseur contacté, puis échec d'enregistrement —
> est écrite et lisible mais **non exercée** : la déclencher demanderait d'injecter une
> panne après le relais.

## 4. Le credential — ce qui rend le contournement impossible

**Oathrion injecte la clé du fournisseur ; l'agent ne la détient pas.** C'est le cœur de la
garantie : un agent qui n'a pas la clé ne peut pas appeler l'API, qu'il connaisse son
adresse ou non.

Deux sources, dans cet ordre :

| Source | Protection |
|---|---|
| **Le coffre** (`server/connectors/vault.ts`) | chiffré AES-256-GCM, **par locataire**, révocable. **Préférez-le**, et il accepte désormais n'importe quelle destination enregistrée — voir §4bis |
| `OATHRION_INTERCEPT_KEY_<DESTINATION>` | **en clair dans l'environnement du processus**, et valable pour **tout le déploiement**. Repli : sans lui, une destination sans credential de locataire n'injecterait rien et l'agent devrait porter sa propre clé — ce qui rend le contournement possible |

La réponse porte `credentialInjected`. Quand il vaut `false`, l'agent porte encore sa
propre clé et **pourrait appeler l'API directement** : la console le dit, et ce document
aussi.

### 4bis. Une clé PAR LOCATAIRE, et la divulgation quand il n'y en a pas

Le coffre n'acceptait qu'un connecteur du catalogue, lequel contient une seule entrée :
`github`. Donc pour Stripe, Jira ou une API interne, **aucun locataire ne pouvait avoir sa
propre clé** : tous partageaient celle du déploiement. Correct pour une installation par
client — la forme livrée — bloquant à la deuxième organisation.

```bash
# sceller la clé de CE locataire pour une destination enregistrée
curl -X PUT $OATHRION/api/destinations/stripe/credential \
  -H "authorization: Bearer $CLE_ADMIN" -H 'content-type: application/json' \
  -d '{"secret":"sk_live_..."}'
```

**L'état rendu est `stored_unverified`, jamais `connected`.** Oathrion ne sait pas comment
une API quelconque valide une clé : il n'y a pas de sonde, donc il n'y a pas de
vérification à annoncer. La première preuve que la clé est bonne viendra du premier appel
relayé, avec le statut du fournisseur. Une pastille verte sur une clé que personne n'a
essayée serait un faux statut « protégé ».

`GET /api/destinations` dit, pour chaque destination, laquelle des trois situations vous
êtes dans :

| Champ | Ce que ça veut dire |
|---|---|
| `credential.tenant` | ce locataire a sa propre clé, scellée et révocable. L'état et l'empreinte (6 caractères de SHA-256), jamais la clé |
| `credential.shared: true` | **la clé injectée est celle du DÉPLOIEMENT, commune à tous les locataires.** À lire avant d'héberger une deuxième organisation |
| `credential.none: true` | Oathrion n'injectera rien, et le relais le dira dans sa réponse |

Et `DELETE /api/destinations/:id/credential` rend `fallsBackToDeploymentKey` : révoquer la
clé d'un locataire **ne coupe pas l'injection** si la variable du déploiement existe — elle
y retombe. Pour couper vraiment, retirez aussi la variable. `remoteStillValid` est toujours
vrai : Oathrion oublie la clé, il ne l'invalide pas chez le fournisseur.

Ce qui ne part **jamais** vers le fournisseur : la clé Oathrion de l'agent
(`authorization`), les cookies, `x-forwarded-*`. Les relayer divulguerait le credential
d'authentification d'Oathrion à un tiers.

---

## 4bis. L'approbation humaine survit à l'attente et au redémarrage

Un ALLOW est synchrone : la requête reste en mémoire et part dans la même requête HTTP.
Rien n'est écrit.

Une **approbation** est autre chose : un humain décide en minutes, parfois après un
redémarrage, parfois depuis une autre instance. La requête est donc **garée dans un sas
persisté** (`pending_interceptions`, migration 022), et la réponse `202` annonce la
fenêtre réelle dans `approvalWindowMs` — alignée sur `OATHRION_ACTION_APPROVAL_TTL_MS`,
15 minutes par défaut.

> **Ce qui était faux avant.** La requête vivait dans une `Map` du processus avec un TTL
> de **soixante secondes**. Mesuré : *« après 61 s, la requête est : PERDUE »*. Un
> opérateur qui approuvait après une minute voyait son approbation réussir et rien partir,
> un redémarrage les effaçait toutes, et sur deux instances approuver sur l'une ne
> relâchait pas une requête garée sur l'autre. Le test qui couvrait ce chemin approuvait
> dans la milliseconde : il passait, et il ne prouvait rien.

**C'est le seul endroit où ce produit persiste un corps de requête**, et c'est un
arbitrage assumé : pour compléter une requête après qu'un humain l'ait approuvée, il faut
l'avoir gardée. Trois garde-fous :

1. **chiffré** (AES-256-GCM), le locataire dans le contexte authentifié — une ligne
   déplacée chez un autre client ne déchiffre pas ;
2. **à usage unique** — la reprise est une suppression conditionnelle, et c'est elle qui
   décide : deux approbations simultanées, une seule repart avec la requête ;
3. **expirante** — une ligne périmée n'est jamais rendue, même sans balayage.

Et la **destination est re-résolue** à la reprise, jamais relue depuis la ligne : si
l'exploitant l'a retirée du registre entre-temps, ou sortie de la portée du locataire,
rien n'est relayé.

Sans `OATHRION_KEK`, garer une requête échoue et la route répond **503**, pas 202 :
annoncer une approbation en attente pour une requête qu'on n'a pas gardée serait la
promesse la plus coûteuse de ce chemin.

Prouvé par `verify:intercept` : on gare, on **tue le processus**, on le relance, on
approuve — et la requête part, avec son corps exact et le credential injecté par Oathrion.

## 5. Ce qui est tracé, et ce qui ne l'est pas

**Tracé** : une exécution par requête jugée, avec le verbe, la cible, le montant évalué,
la décision, la politique, la règle (`interceptRule`) et l'horodatage. Plus la chaîne
d'audit chaînée existante.

**Pas tracé, délibérément** : le corps et les en-têtes de la requête. Un corps d'API
financière porte des noms, des adresses, parfois un numéro de carte. Le mettre dans les
métadonnées d'exécution le mettrait dans la table que ce produit promet de pouvoir
montrer à un auditeur. La requête brute vit en mémoire, est reprise **une seule fois** par
le relais, et n'est écrite nulle part.

**Compté, pas tracé** : le trafic refusé *avant* toute décision — « aucune règle »,
destination indisponible, requête illisible. Il n'atteint pas le moteur, donc il n'y a pas
de décision à enregistrer, et fabriquer une exécution inventerait une décision que le
moteur n'a pas rendue. Le compteur `oathrion_intercept_refusals_total{reason}` le rend
visible sur `/metrics`. **C'est une limite : ce trafic n'a pas de ligne individuelle dans
l'audit.**

---

## 5bis. Le rayon d'explosion — à calculer avant le pilote

Oathrion **borne** les dégâts d'un agent compromis, il ne les supprime pas. La formule :

```
dégâts maximum = plafond de la politique
               × débit autorisé (RATE_LIMIT_DECISION, défaut 300/min)
               × temps avant qu'un humain regarde
```

Avec un plafond de 500 et le débit par défaut, c'est **150 000 par minute** sur les routes
que vous avez déclarées. Si personne ne regarde pendant une heure, 9 millions.

Les trois leviers, dans l'ordre d'efficacité :

1. **`APPROVAL_REQUIRED` au-dessus d'un seuil bas** — le seul qui met un humain dans la
   boucle, et désormais utilisable (fenêtre de 15 min, survit au redémarrage) ;
2. **`maxTransactionAmount` sur le mandat de l'agent**, qui s'applique avant toute
   politique ;
3. **`RATE_LIMIT_DECISION`** baissé pour la durée du pilote.

Faites ce calcul et écrivez le résultat **avant** d'ouvrir le trafic. Un pilote dont
personne n'a chiffré le pire cas a un pire cas que personne n'a choisi.

## 5ter. Ce qu'Oathrion coûte en millisecondes

**22,5 ms de surcoût médian** sur la voie du pare-feu, mesurés sur 400 appels appariés
(`npm run profile:intercept`). C'était 34,9 ms avant trois optimisations ; la mesure A/B
et les arbitrages sont dans `docs/PILOT-READINESS.md` §5quinquies.

Pour un agent, c'est **1 à 4 % d'un seul tour** : son appel de modèle coûte de 500 ms à
plusieurs secondes. Pour l'API appelée, prise seule, c'est visible — sur un amont à 2,6 ms,
Oathrion multiplie le temps par neuf.

### Ce chiffre dépend d'une chose, et ce n'est pas le code

Un aller-retour vers PostgreSQL coûte **0,91 ms** sur le montage de mesure (base dans un
conteneur voisin). Un appel relayé en fait seize, avec quatre validations durables. **La
latence d'Oathrion est un compte d'allers-retours de base.** Sur un déploiement où la base
est sur le même hôte — aller-retour à ~0,1 ms — le même code paie quelques millisecondes.

Donc : **rapprochez la base d'Oathrion.** C'est le seul réglage qui change l'ordre de
grandeur, et il ne demande aucune modification du produit.

### Voir où va le temps sur VOTRE installation

```bash
OATHRION_TIMING_HEADER=1   # puis redémarrer
```

Chaque réponse relayée porte alors un en-tête `Server-Timing` standard détaillant les
phases internes (`persist`, `settle`, `auth`, `tool`, `upstream`, `vault`…).

**Éteint par défaut, et pas par frilosité** : publier la durée de chaque phase donne un
oracle temporel à l'appelant — la différence entre « aucune politique ne correspond » et
« une politique a été évaluée puis a refusé » devient lisible de l'extérieur. C'est
acceptable pour diagnostiquer sa propre installation, pas comme défaut d'une passerelle
exposée à des agents.

### Ce qui n'est pas mesuré, et qu'il ne faut pas supposer

Les appels du banc sont **séquentiels**. Rien ici ne dit la latence sous concurrence, ni le
comportement quand l'amont lui-même ralentit. Pire : le plan d'identité d'Oathrion parle à
PostgreSQL de façon **synchrone et bloquante**, donc le processus ne chevauche pas deux
requêtes pendant l'authentification. **Aucun chiffre de débit ne doit être avancé** avant
qu'un banc de charge existe. Il n'en existe pas.

## 6. La limite qu'il faut dire avant de vendre

> **Ce pare-feu ne gouverne que le trafic qui passe par lui.**

Un agent qui peut joindre `api.stripe.com` directement n'est pas intercepté, et aucun
logiciel ne peut l'en empêcher depuis l'intérieur de ce processus. Ce qui rend le
contournement *impossible* plutôt que déconseillé est une propriété de votre
déploiement :

1. **le credential du fournisseur ne vit que dans Oathrion** — c'est le levier principal,
   et il est à votre main dès maintenant ;
2. et, si vous voulez la ceinture et les bretelles, une politique réseau qui refuse
   l'egress de l'agent sauf vers Oathrion. Cela appartient à votre VPC, pas à ce logiciel.

L'écran « Pare-feu » de la console affiche cette phrase sous le journal, pour qu'un
opérateur qui lit « 0 bloqué » ne le confonde pas avec « rien ne passe par ici ».

---

## 7. Vérifier soi-même

```bash
npm run build
DATABASE_URL=postgres://… npm run verify:intercept
```

**61 contrôles**, le bundle livré devant une API cible qui enregistre ce qu'elle reçoit :

* une route non déclarée → 403, **zéro** requête chez l'API ;
* ALLOW → **exactement une** requête, méthode, chemin et corps intacts, clé du
  fournisseur injectée, clé Oathrion de l'agent absente ;
* BLOCK → **zéro** requête ;
* APPROVAL_REQUIRED → zéro jusqu'à l'approbation, puis **une**, et approuver deux fois
  n'en fait pas deux ;
* le montant évalué est 600 et non 60 000 — `amountScale` appliquée ;
* un 422 du fournisseur est rendu tel quel, pas maquillé en succès ;
* le corps de la requête, **la réponse du fournisseur** et la clé du fournisseur sont
  **absents** de la trace et de l'audit ;
* et une requête garée survit à un **arrêt du processus** : on la gare, on tue, on
  relance, on approuve, elle part ;
* un corps **form-encoded** arrive octet pour octet, et `Stripe-Account`,
  `Stripe-Version`, `Idempotency-Key` envoyés par l'agent **ne sont pas relayés**.

Et hors ligne, sans réseau de sortie :

```bash
npx vitest run server/test/intercept-firewall.test.ts    # 26 contrôles
```

---

## 8. Les refus de démarrage

`server/config-check.ts` refuse de démarrer, en nommant le motif, quand une règle :

* nomme un verbe absent de `shared/policy/actions.ts` — une route interceptée mais non
  gouvernée serait pire qu'une route non interceptée : elle aurait l'air contrôlée ;
* vise une destination non enregistrée — la requête serait reconnue, autorisée, et
  n'atteindrait personne ;
* est **rendue inatteignable** par une règle plus générale déclarée avant elle. Sur un
  pare-feu, une règle morte est une règle dont l'auteur croit qu'elle protège quelque
  chose.
