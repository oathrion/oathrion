# Connecteurs et intégrations — l'inventaire, et ce qui est réellement joint

Ce document répond à une seule question, pour chaque chemin par lequel Oathrion peut
atteindre un système extérieur : **est-ce réel, et comment le vérifier soi-même ?**

Chaque ligne porte une commande. Rien ici n'est à croire sur parole.

> **Ce qu'Oathrion contrôle, et ce qu'il ne contrôle pas.** Oathrion décide des actions qui
> passent **par ses chemins configurés** : `POST /api/execute`, la passerelle MCP, le
> pare-feu, et les connecteurs ci-dessous. Une action qu'un agent exécute avec ses propres
> identifiants, hors de ces chemins, n'est ni vue ni bloquée. Oathrion ne gouverne pas « tous
> les agents » : il gouverne ce qu'on fait passer par lui — et les connecteurs sont là pour
> que l'agent n'ait plus besoin de détenir de jeton GitHub, Slack, Linear ou de clé Stripe.

---

## 0. Le périmètre de lancement : GitHub, Slack, Linear, Stripe

> **Valider un connecteur contre le vrai service, pour le pilote** : la procédure exacte —
> credential de test, fichier, commande, ce que chaque contrôle démontre — est dans
> [`PILOTE-VALIDATION-CONNECTEURS.md`](PILOTE-VALIDATION-CONNECTEURS.md). GitHub d'abord.

Quatre connecteurs natifs, un seul chemin d'exécution : `AgentGateway.dispatch()` →
`ConnectorTool` → connecteur, après une décision. Les routes de connexion configurent ;
aucune n'exécute une action d'agent (`connector-single-path.test.ts`).

| | GitHub | Slack | Linear | Stripe |
|---|---|---|---|---|
| **Actions** | lister les dépôts · lire un dépôt · lire les issues et PR d'un dépôt · ouvrir une issue · commenter | lister les canaux du bot · lire les messages récents d'un canal · publier | lister les équipes · rechercher les issues d'une équipe · créer une issue · commenter | lire le solde · lister les paiements · chercher un client · **rembourser un paiement** (verbe FINANCIER) |
| **Cible** | `github.com/owner/repo` | `slack.com/<ID du canal>` | `linear.app/ENG`, `linear.app/ENG/ENG-12` | `stripe.com/acct_…`, `stripe.com/acct_…/pi_…` |
| **Connexion** | jeton à portée fine, guidé pas à pas | **OAuth en un clic** si l'exploitant a enregistré l'application ; sinon jeton de bot guidé | **OAuth en un clic** si l'exploitant a enregistré l'application ; sinon clé personnelle guidée | clé restreinte (`rk_test_`, conseillée) ou secrète de test (`sk_test_`), guidée |
| **Refusé à la connexion** | — | jeton utilisateur (`xoxp-`, `xoxe.xoxp-`), jeton d'application, de renouvellement | — | clé publiable (`pk_`) ; clé **réelle** (`sk_live_`, `rk_live_`) tant que l'exploitant n'a pas posé `OATHRION_STRIPE_ALLOW_LIVE=true` |
| **Révocation distante** | non (jeton personnel) | **oui** — `auth.revoke`, dite seulement si Slack la confirme | **oui** pour OAuth ; non pour une clé personnelle | non — Oathrion oublie la clé et dit qu'elle reste valide chez Stripe |
| **Idempotence** | marque d'exécution dans le corps (doublon reconnaissable) | marque d'exécution dans les métadonnées du message | UUID dérivé de l'exécution envoyé à Linear ; **refus du doublon démontré contre Linear** (`verify:launch`) ; la création reste exclue du rejeu automatique (décision de produit) | `Idempotency-Key: placet-<exécution>` ; **Stripe rend le même remboursement** à la même clé (démontré, `verify:launch`) ; exclu du rejeu automatique comme toute écriture |

**Stripe : ce que le connecteur garantit en plus, parce qu'il déplace de l'argent.** Le
remboursement est déclaré financier au catalogue d'actions : le plafond de dépense de
l'agent s'applique au montant **déclaré** (au-delà : approbation ; sans montant ou dans une
autre devise : refus). Le connecteur relit le paiement chez Stripe avant d'agir et refuse,
sans rien envoyer, une devise différente de celle du paiement ou un paiement non abouti ;
il convertit le montant en unités mineures par `shared/money.ts` (centimes pour EUR/USD,
aucune pour XOF/XAF) ; il exige toujours un montant (un remboursement total implicite
échapperait au plafond) ; il vérifie que le compte nommé par la cible est celui de la clé.
Ce connecteur est **distinct du paquet de règles Stripe** du pare-feu (§1bis), où l'agent
appelle lui-même `api.stripe.com` à travers Oathrion.

### Ce qui est prouvé, et où

| Preuve | Nature | Ce qu'elle établit |
|---|---|---|
| `connector-slack.test.ts` (24), `connector-linear.test.ts` (31), `connector-stripe.test.ts` (44), `connector-github-errors.test.ts` | **SIMULÉ** — un serveur local répond comme le service | erreurs traduites (jeton refusé, permission manquante, quota, introuvable, délai), cibles refusées sans appel, jeton absent des résultats |
| `connector-launch-path.test.ts` (34, mesuré sur `8a49b30`) | **LOCAL** — API, passerelle, moteur, coffre, approbations réels ; services simulés | ALLOW atteint le service une fois · BLOCK zéro requête · APPROVAL part une fois, ni le rejet ni le rejeu ne relâchent rien · isolation entre organisations · retour OAuth refusé sans le cookie du navigateur · voie MCP · scénario guidé |
| `connector-stripe-launch-path.test.ts` (17) | **LOCAL** — même nature que la ligne précédente | Stripe : clé réelle et publiable refusées sans appel · compte non choisi bloqué sans appel · remboursement retenu, parti une fois avec la clé d'idempotence de l'exécution · plafond de l'agent · permission `execute:payments` exigée · voie MCP · scénario guidé qui ne rembourse jamais |
| `npm run verify:launch` | **SERVICE RÉEL** | sans credential : les quatre services réels refusent une clé fabriquée avec leur propre message, et le bundle livré crée un espace par lien. Avec `OATHRION_*_TEST_*` : connexion, ressources, scénario, chaque création **relue chez le fournisseur**, puis nettoyée |

**État mesuré :** GitHub, Slack et Linear sont éprouvés ensemble de bout en bout
(`verify:launch` 47/47 sur `cdc206b`, `STRESS-TEST-LOG.md` § 5.11). Stripe (mode test) :
parcours complet vert contre le vrai service le 21 octobre — connexion, lecture, refus hors
périmètre, remboursement retenu, approuvé, **relu chez Stripe**, idempotence rendue par
Stripe — dans un passage à 56/60 dont les quatre échecs sont des délais réseau de la phase 0
(`STRESS-TEST-LOG.md` § 5.12). Un passage entièrement vert avec les quatre services reste à
faire sur une connexion stable.

### Le choix des ressources est une règle, pas un réglage

Choisir « ce dépôt », « ce canal », « cette équipe » écrit deux politiques visibles
(`server/connectors/guardrails.ts`) : un **BLOCK_TOOL sur l'hôte, sauf les ressources
choisies** (`exceptTargets`, apparié à la cible entière), et une règle d'écriture —
approbation (défaut), blocage, ou libre. Une ressource que la connexion n'atteint pas est
refusée au moment du choix.

### Ce que l'exploitant doit enregistrer pour l'OAuth en un clic

| Variable | Pour |
|---|---|
| `OATHRION_PUBLIC_URL` | l'adresse HTTPS publique d'Oathrion ; le retour est `<url>/api/connectors/oauth/callback` |
| `OATHRION_SLACK_CLIENT_ID`, `OATHRION_SLACK_CLIENT_SECRET` | une application Slack, portées de **bot** `chat:write channels:read channels:history groups:read groups:history`, sans portée utilisateur |
| `OATHRION_LINEAR_CLIENT_ID`, `OATHRION_LINEAR_CLIENT_SECRET` | une application OAuth Linear, portées `read issues:create comments:create` |

Sans elles, la console propose la connexion par jeton — présentée comme telle, avec les
étapes. **Le flot OAuth n'a été éprouvé que contre un fournisseur simulé** : il faut une
URL publique et des applications enregistrées pour l'éprouver contre Slack et Linear.
**GitHub App** (installation avec choix des dépôts) : non livrée ; le jeton à portée fine
est le chemin de lancement, explicitement présenté comme tel.

---

## 1. Le classement

| Chemin | Classement | Ce qui le prouve | Limite connue |
|---|---|---|---|
| **Paquets de règles** (`server/intercept/packs.ts`) — openai, anthropic, stripe, slack, google (**google : non utilisable en production, hors périmètre**) | `REAL_AND_TESTED` localement ; **Stripe : `REAL_AND_VERIFIED` contre le vrai service en mode test** (`verify:stripe`, 30/30) ; **OpenAI : vérifié en partie** (injection, refus, relais — `verify:openai`, 22/29, parcours payant en attente de crédit) ; **Slack : vérifié en partie** (injection, refus, reçu exact — `verify:slack`, 18/18 sans jeton sur `8a49b30`) | `intercept-packs.test.ts` — 27/27 : l'extraction du verbe, de la cible et du montant sur un corps réaliste, la conversion des centimes, et le refus d'un paquet inconnu | **Non vérifiés contre le service réel.** Chaque paquet déclare ses propres limites — voir `npm run packs` |
| **Connecteur GitHub** (`server/connectors/github.ts`) | `REAL_AND_TESTED` localement ; **VALIDÉ de bout en bout contre GitHub** (`STRESS-TEST-LOG.md` § 5.10–5.11) | `npm run verify:github` (12/12 sans credential) · `npm run verify:launch` | Pas d'OAuth (jeton à portée fine) · pas de révocation distante · cinq verbes non destructifs |
| **Connecteur Slack** (`server/connectors/slack.ts`) | `REAL_AND_TESTED` localement ; **VALIDÉ de bout en bout contre Slack** (§ 5.11) | `connector-slack.test.ts` (24) · `connector-launch-path.test.ts` · `npm run verify:launch` | Bot seulement · OAuth éprouvé contre un fournisseur simulé uniquement |
| **Connecteur Linear** (`server/connectors/linear.ts`) | `REAL_AND_TESTED` localement ; **VALIDÉ de bout en bout contre Linear** (§ 5.11) | `connector-linear.test.ts` (31) · `connector-launch-path.test.ts` · `npm run verify:launch` | OAuth éprouvé contre un fournisseur simulé uniquement · une clé personnelle a les droits de son auteur |
| **Connecteur Stripe** (`server/connectors/stripe.ts`) | `REAL_AND_TESTED` localement ; **parcours complet vert contre Stripe en mode test** (§ 5.12) ; jamais en mode réel | `connector-stripe.test.ts` (44) · `connector-stripe-launch-path.test.ts` (17) · `npm run verify:launch` avec `OATHRION_STRIPE_TEST_KEY` | Pas d'OAuth (Stripe Connect non livré) · pas de révocation distante · une clé restreinte ne dit pas ses permissions : un 403 de Stripe est rendu tel quel · un remboursement ne s'annule pas |
| **Point de contrôle sur un connecteur** (ALLOW/BLOCK/APPROVAL) | `REAL_AND_TESTED` | `server/test/connector-control-point.test.ts` — 13/13, passerelle réelle, politiques réelles, catalogue d'actions réel | Prouvé contre un connecteur espion : un zéro appel réseau serait ambigu |
| **Coffre de credentials chiffré** (`server/connectors/vault.ts`) | `REAL_AND_TESTED` | `server/test/connector-vault.test.ts` — 19/19, AES-256-GCM, jeton absent de tout dump, enveloppe non déchiffrable par un autre locataire | KEK fournie par l'environnement ; aucun gestionnaire de secrets cloud n'est implémenté |
| **Relais MCP sortant** (`server/gateway/tools/mcp-client.ts`) | `REAL_AND_TESTED` | `npm run verify:mcp` — 37/37 contre `examples/mcp-server/`, qui n'importe rien d'Oathrion | Un serveur indépendant écarte la mélecture partagée, pas un désaccord avec une implémentation tierce |
| **Registre d'outils déclaré** (`OATHRION_TOOLS`) | `REAL_AND_TESTED` | `npm run verify:tools` — 49/49 | Pas de transformation de valeur · pas d'argument optionnel |
| **Découverte `tools/list` et vérification de schéma** | `REAL_AND_TESTED` | `npm run mcp:discover` · `upstream-schema.test.ts` 14/14 contre `examples/mcp-server/` · `verify:tools` prouve le refus dans le bundle livré | Compare des NOMS, pas des types. Un serveur sans `tools/list` n'est pas vérifiable : le reçu le dit |
| **Passerelle MCP entrante** (`server/mcp/`) | `REAL_AND_TESTED` | `conformance` 27/27, `server/test/mcp-single-path.test.ts` | — |
| **Webhooks de notification** (`server/notifications/`) | `REAL_AND_TESTED` comme transport | HMAC-SHA256 réel, `node:https`, gardes SSRF au niveau socket ; `npm run chaos` couvre 5 scénarios réseau contre un receveur réel | Non vérifié contre la forme de charge utile d'un service précis (Slack, Teams) |
| **Les cinq outils intégrés** (`server/gateway/tools/simulated-tools.ts`) | `SIMULATED` | Ils se déclarent simulés ; `GET /api/tools` rend `simulated: true` | Le relais de remboursement devient réel dès qu'une destination MCP est configurée |
| **Écran « Integrations »** (`client/src/pages/integrations.tsx`, table `integrations`) | `SIMULATED` — **décoratif** | Rien. Le bouton « Connect » bascule un booléen. Aucun credential, aucun appel | **Retiré de la navigation.** Remplacé par l'écran « Connecteurs » |
| **OpenAI / Anthropic / Google / Slack / Gmail / Notion** (entrées du seed) | `MISSING` (comme entrées du seed) | Rien. Slack a désormais un connecteur natif (§0), sans rapport avec ces lignes. Ce sont des lignes de démonstration dans `shared/seed/integrations.ts` | Aucun code ne les joint. Leur `connected: true` est une donnée de démonstration, pas un état |
| **Révocation distante d'un credential** | `REAL_AND_TESTED` pour Slack et Linear OAuth ; `MISSING` ailleurs | `connector-slack.test.ts`, `connector-linear.test.ts` | GitHub, clé Linear personnelle, clé Stripe, destinations du pare-feu : Oathrion oublie, le fournisseur garde. Voir §5 |
| **Rafraîchissement OAuth** (`server/connectors/oauth.ts`, voie pare-feu) | `REAL_AND_TESTED` contre un fournisseur local | `oauth-refresh.test.ts` — 24/24 : l'échange, le cache à vol unique, la marge d'expiration, et ce qui n'est jamais journalisé. Activé par `OATHRION_OAUTH_<DESTINATION>` | **Le flot d'autorisation initial n'existe pas** : l'exploitant colle un jeton de rafraîchissement obtenu ailleurs. **Jamais éprouvé contre un vrai fournisseur** (Google, Microsoft, Salesforce) : les instructions Google ont été retirées (audit 9fb5091) |
| **Signature AWS SigV4** (`server/connectors/sigv4.ts`, voie pare-feu) | `REAL_AND_TESTED` | `sigv4.test.ts` — 32/32, deux implémentations indépendantes produisant la même signature. Activé par `OATHRION_SIGV4_<DESTINATION>` | Jamais éprouvé contre une vraie API AWS |
| **OAuth : le flot d'autorisation à trois pattes** | `REAL_AND_TESTED` contre un fournisseur simulé, pour Slack et Linear ; `MISSING` pour GitHub et la voie pare-feu | `connector-launch-path.test.ts` §5 : `state` à usage unique, cookie du navigateur, jeton vérifié avant scellement | Non éprouvé contre Slack et Linear réels : exige `OATHRION_PUBLIC_URL` en HTTPS et les applications enregistrées |

### Ce qui a changé de classement par ce chantier

`SIMULATED` → `REAL` : le connecteur GitHub, le coffre chiffré, et le point de contrôle
appliqué à un verbe de connecteur. Le chiffrement d'enveloppe existait depuis la phase S1
et **n'avait aucun consommateur** — `script/verify-disaster-recovery.ts` l'écrivait :
« Aucune donnée n'est chiffrée en base aujourd'hui ». Il en a un maintenant.

---

## 1bis. Les paquets de règles — plusieurs outils, sans écrire leurs règles

```bash
npm run packs            # ce que chaque paquet gouverne, ET ce qu'il ne gouverne pas
npm run packs stripe     # un seul
```

Cinq paquets livrés : **openai · anthropic · stripe · slack · google**.

```bash
OATHRION_INTERCEPT_PACKS=openai,stripe
```

### Pourquoi ils existent

La voie pare-feu gouverne n'importe quelle API HTTP — c'est sa force. Mais pour chaque
outil, il fallait écrire à la main le chemin exact, où lire la cible dans le corps, où
lire le montant, son échelle, et quels en-têtes relayer. **Ce n'est pas de la
configuration, c'est de l'expertise par API.**

Et une erreur n'y est pas visible. Stripe compte en **centimes** : un exploitant qui écrit
un plafond « 100 » pense 100 euros, et sans `amountScale: 100` Oathrion compare 7500 à 100.
Dans ce sens-là tout est refusé — donc corrigé. Dans l'autre, un plafond de 100 000 laisse
passer 1 000 € en croyant en autoriser 100 000. **Silencieux, et c'est celui-là qui
coûte.**

### Ce qu'un paquet ne fait pas, et c'est délibéré

**Il ne déclare pas sa destination.** Une destination porte sa portée par locataire
(`organizations`), et un paquet ne peut pas savoir quels locataires ont le droit
d'atteindre votre compte Stripe. Un paquet qui déclarerait la sienne contournerait le
cadrage par locataire — l'isolation la plus importante du produit.

Vous déclarez donc toujours la destination, avec l'identifiant du paquet comme `id` :

```bash
OATHRION_DESTINATIONS=[{"id":"stripe","url":"https://api.stripe.com","organizations":["org_acme"]}]
OATHRION_INTERCEPT_KEY_STRIPE=sk_live_…
```

Si elle manque, **le démarrage refuse** en nommant chaque règle concernée. Un nom de
paquet inconnu refuse aussi : le tolérer ferait croire qu'un outil est gouverné alors
qu'il ne l'est pas.

### La limite qu'il faut lire avant de vendre

**Le destinataire d'un courriel Gmail n'est pas gouvernable.** L'API encode le message
entier en base64url dans `raw` ; l'adresse du destinataire est dans ce blob. Oathrion lit
des champs, il ne décode pas du base64 pour analyser des en-têtes RFC 2822 — et il ne doit
pas : un extracteur qui se tromperait sur un format aussi tordu produirait une cible
fausse, donc une décision prise sur autre chose que la réalité.

Une politique peut limiter **la boîte expéditrice** et **le nombre d'envois**. Jamais le
« à qui ». `npm run packs google` le dit à l'écran.

Chaque paquet porte ses propres limites, affichées aussi fort que ce qu'il couvre — un
catalogue qui ne montrerait que sa couverture laisserait croire qu'il couvre le reste.

### Stripe : vérifié contre le vrai service

`npm run verify:stripe` fait passer de vraies requêtes à `api.stripe.com` à travers le
bundle de production, avec `OATHRION_INTERCEPT_PACKS=stripe` tel qu'un exploitant l'active.
**30/30 avec une clé de test réelle**, en mode test Stripe :

| ce qui est prouvé | comment |
|---|---|
| un **vrai paiement** de 50 € aboutit à travers Oathrion | réponse `succeeded` de Stripe |
| un paiement de 500 € est **refusé** et n'atteint jamais Stripe | liste lue **directement chez Stripe** : un seul paiement existe |
| deux **vrais remboursements** aboutissent, par `charge` et par `payment_intent` | réponses `succeeded` |
| un remboursement de 200 € est refusé et n'arrive jamais | liste lue chez Stripe : exactement deux remboursements |
| l'agent ne tient **jamais** la clé Stripe | Stripe cite la clé qu'Oathrion a injectée ; un mutant qui coupe l'injection fait répondre « You did not provide an API key » |
| le `client_secret` rendu par Stripe n'est **pas** écrit dans la base d'Oathrion | recherche de la vraie valeur dans les exécutions stockées |
| la clé n'apparaît nulle part | sortie du banc, journal du processus, base |

Le banc refuse toute clé de production (`sk_live_`, `rk_live_`) avant le moindre appel,
et supprime le client de test qu'il a créé.

#### Ce que le vrai Stripe a corrigé

Le paquet était écrit d'après la documentation, et ses tests locaux vérifiaient ce que
**j'avais compris** de l'API. Le vrai service a montré trois défauts qu'aucun d'eux ne
pouvait voir :

1. **`/v1/refunds` lisait `currency`**, et les limites du paquet conseillaient même de
   l'envoyer. Stripe répond `Received unknown parameter: currency` : un remboursement
   prend la devise de la charge. Un agent qui suivait ce conseil voyait **tous** ses
   remboursements rejetés.
2. **Les remboursements ne lisaient que `charge`**, alors que les bibliothèques Stripe
   actuelles désignent le paiement par `payment_intent`. La règle accepte désormais l'un
   ou l'autre (`target: "body.payment_intent|body.charge"`).
3. **`amountScale: 100` partout.** Stripe compte l'euro en centimes mais le franc CFA en
   francs. Pour une organisation en XOF ou XAF, chaque montant était jugé **cent fois trop
   petit** — dans le sens qui laisse passer. `amountUnit: "minor"` prend l'échelle dans le
   registre des devises d'Oathrion.

Le même défaut figurait dans **cinq exemples** du dépôt (`.env.example`, deux pages de
documentation, l'en-tête de `rules.ts` et le message d'erreur des règles) : tous
enseignaient à lire `currency` sur un remboursement. Corrigés.

#### Ce qui reste non prouvé

* **`/v1/payouts`** : un virement de test exige un solde disponible. Aucun virement n'est
  créé ; la réconciliation LIT la liste des virements (§5.22 du journal), et cette lecture
  est éprouvée contre le vrai Stripe.
* **`/v1/charges/{charge}/capture`** : non exercé. La capture d'un PaymentIntent
  (`/v1/payment_intents/{id}/capture`) n'est pas couverte du tout, et elle est refusée.
* **Le jugement d'un remboursement dans la devise de l'organisation** n'est juste que si
  le compte Stripe facture dans cette devise : la requête ne dit pas la devise de la charge.
* Le mode production de Stripe : jamais, et le banc le refuse.

### OpenAI : vérifié en partie, et en pause faute de crédit

`npm run verify:openai` passe par le même montage que Stripe. **OpenAI n'a pas de mode
test** : avec une vraie clé, chaque appel autorisé est facturé. Le banc plafonne donc
chaque réponse à 16 jetons, choisit le modèle le moins cher que le compte expose, et
affiche son coût maximal (moins de 0,001 $) avant le premier appel payant. Il refuse une
clé d'administration (`sk-admin-`).

**Vérifié contre le vrai service** (22/29 avec une vraie clé) :

* Oathrion **injecte** la clé : OpenAI cite les derniers caractères de la clé injectée, pas
  ceux de la clé de l'agent ;
* un modèle refusé par la politique **ne part pas** : 403 venu d'Oathrion, alors que toute
  requête relayée revient d'OpenAI ;
* la clé réelle est acceptée, et Oathrion relaie la vraie réponse d'OpenAI telle quelle,
  y compris une erreur ;
* la clé n'apparaît nulle part.

**Non vérifié** : la réponse d'un modèle, le flux jusqu'à `[DONE]`, les embeddings, l'API
Responses, et le fait qu'Oathrion n'écrit pas la réponse en base. Le compte de test n'a
plus de crédit et OpenAI répond `You have no credits remaining` (429). Le banc reprendra
tel quel, avec `npm run verify:openai`, quand le compte en aura.

#### Ce que le banc OpenAI a trouvé dans Oathrion

**Le transport d'Oathrion abandonnait toute connexion lente.** Chaque appel relayé vers
OpenAI échouait en 502, alors qu'OpenAI était joignable. Sur la machine de test, la
route IPv6 tombait par intermittence et l'IPv4 mettait plus d'une seconde à s'établir.
Or Node n'accorde par défaut que **250 ms** à chaque adresse, puis abandonne. Un
déploiement en Afrique de l'Ouest qui appelle des API hébergées aux États-Unis est
exactement dans ce cas.

Corrigé : `CONNECT_ATTEMPT_MS = 2 500` aux deux points de connexion du transport. Relancé
avec l'IPv6 toujours cassé, Oathrion a joint OpenAI normalement. Voir
`server/notifications/webhook-connect-timeout.test.ts`.

**Une limite de politique** : refuser un modèle par son nom compare le nom exact. Refuser
`gpt-4o` laisse passer `gpt-4o-2024-08-06`, le même modèle sous un autre nom. Autorisez
explicitement les modèles voulus plutôt que d'en interdire certains.

### Slack : vérifié en partie, et un reçu qui mentait

`npm run verify:slack` passe de vraies requêtes à `slack.com`. **Slack se prouve
autrement que Stripe** : son API répond HTTP 200 même quand elle refuse, et ne cite pas le
jeton reçu. La preuve d'injection passe donc par la nature de l'erreur — `not_authed`
quand aucun jeton n'arrive, `invalid_auth` quand un jeton faux arrive. Oathrion injecte un
jeton invalide, Slack répond `invalid_auth` : un jeton est arrivé, et ce ne peut pas être
celui de l'agent.

**Vérifié contre le vrai service, sans jeton** (18/18 sur `8a49b30`) : l'injection, le refus d'un canal
interdit (Slack ne répond jamais 403, donc un 403 vient d'Oathrion), le refus d'un chemin
non couvert, et le reçu correct d'un appel refusé par Slack.

**Non vérifié** : la publication réelle d'un message avec un vrai jeton de bot.

#### Ce que le vrai Slack a corrigé dans Oathrion

**Le reçu disait « envoyé » pour un message que Slack avait refusé.** Oathrion jugeait la
réussite d'un relais sur le statut HTTP ; Slack répond 200 à un refus. Une règle peut
désormais déclarer `successField` — le champ du corps qui dit si le fournisseur a
réellement réussi — et le paquet Slack déclare `"ok"`. La réussite exige un statut 2xx
**et** la valeur `true` ; un champ absent ou illisible est un échec.

Le champ voyage avec une requête garée en attente d'approbation (migration 24) : sans cela,
un message approuvé par un humain puis refusé par Slack redevenait « envoyé ».

### Statut des autres paquets

**Implémentés, éprouvés localement, NON VÉRIFIÉS contre le service réel.** Les chemins et
les champs viennent de la documentation publiée de chaque fournisseur ;
`server/test/intercept-packs.test.ts` (27/27) prouve que l'extraction donne la bonne
valeur sur un corps réaliste, et ne prouve pas que le fournisseur se comporte comme sa
documentation le dit.

---

## 2. Le connecteur GitHub

### Ce qu'il fait réellement

| Verbe Oathrion | Appel GitHub | Portée requise |
|---|---|---|
| `github.repos.list` | `GET /user/repos` (dépôts accessibles au jeton) | `read:repository` |
| `github.repo.read` | `GET /repos/{owner}/{repo}` | `read:repository` |
| `github.issue.search` | `GET /repos/{owner}/{repo}/issues` | `read:repository` |
| `github.issue.create` | `POST /repos/{owner}/{repo}/issues` | `write:repository` |
| `github.issue.comment` | `POST /repos/{owner}/{repo}/issues/{n}/comments` | `write:repository` |

Le test de connexion est un `GET /user`. Les capacités sont dérivées de l'en-tête
`x-oauth-scopes` que GitHub renvoie — donc de ce que le service annonce, pas de ce que
l'exploitant a coché.

### La forme de la cible : `github.com/owner/repo`

L'hôte est **obligatoire**, et ce n'est pas une préférence de style. Les trois verbes sont
déclarés `outbound` dans `shared/policy/actions.ts`, donc l'allowlist de domaine du mandat
de l'agent les gouverne — et cette allowlist a besoin d'un hôte lisible. Écrite
`owner/repo`, la cible produisait un BLOCK légitime : *« does not resolve to a destination
that can be checked against the agent's approved domains »*.

Le mandat de l'agent doit donc lister `github.com` dans `allowedDomains`. C'est la
barrière qui décide où un agent peut agir, et elle fonctionne.

La forme courte est refusée **nommément**, avec le message qui dit quoi écrire — tolérée,
elle aurait produit un refus du mandat dont le motif est exact et incompréhensible.

### Créer le credential

1. <https://github.com/settings/personal-access-tokens/new>
2. **Repository access** → *Only select repositories* → votre dépôt de test, et rien d'autre.
3. **Repository permissions** → `Issues: Read and write`, `Metadata: Read-only`
   (GitHub l'exige dès qu'une autre permission est accordée).
4. N'accordez rien d'autre. Copiez le jeton (`github_pat_…`).
5. Console Oathrion → **Connecteurs** → collez-le → **Connecter**.

Oathrion le vérifie contre GitHub **avant** de le stocker : un jeton refusé ne laisse aucune
ligne dans le coffre. Il est ensuite scellé en AES-256-GCM et n'est jamais réaffiché.
Seuls six caractères de son SHA-256 sont montrés, pour que vous puissiez le reconnaître.

### Variables d'environnement

| Variable | Obligatoire | Rôle |
|---|---|---|
| `OATHRION_KEK` | **oui, pour connecter quoi que ce soit** | 32 octets (base64 ou hex) : la clé qui emballe les clés de chiffrement. Sans elle, `POST /api/connectors/:id/connect` répond **503** et nomme la variable. Oathrion ne stocke jamais un credential en clair, même transitoirement |
| `OATHRION_KEK_ID` | non (défaut `1`) | Le nom de la clé active, inscrit dans l'enveloppe. Nécessaire pour la rotation |
| `OATHRION_KEK_RETIRED_IDS` | non | Les clés retirées encore nécessaires pour relire d'anciens enregistrements |
| `OATHRION_GITHUB_API_ORIGIN` | non | Pour une instance GitHub Enterprise. **Variable de déploiement** : un locataire ne choisit pas où part son jeton |
| `OATHRION_GITHUB_TEST_TOKEN` | non | Uniquement pour `npm run verify:github` |
| `OATHRION_GITHUB_TEST_REPO` | non | `owner/repo` du dépôt de test, pour le même script |

Générer une KEK :

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

### Vérifier soi-même

```bash
npm run verify:github
```

Sans credential : 12 contrôles réels passent (GitHub refuse un jeton invalide, Oathrion cite
*son* message, les cibles mal formées sont refusées sans appel). Le script sort en **2** —
« impossible à mettre en place » — et jamais en 0 : *« je n'ai pas pu tester » ne doit pas
pouvoir se lire « j'ai testé »*.

Avec credential, sur un dépôt que vous acceptez de salir d'une issue :

```bash
OATHRION_GITHUB_TEST_TOKEN=github_pat_… \
OATHRION_GITHUB_TEST_REPO=votre-compte/votre-depot-de-test \
  npm run verify:github
```

S'y ajoutent alors : le compte réel, les capacités, une lecture, un 404 sur un dépôt
absent, l'ouverture d'une issue, un commentaire, les refus d'exécution, et le cycle
complet jusqu'à la révocation.

---

## 3. Oathrion contrôle-t-il réellement ces actions ?

Oui, et par un seul chemin. `Connector.execute()` n'a qu'un appelant :
`ConnectorTool.run()`. `run` est `protected`, donc seul `CountingTool.execute()` y conduit,
et son seul appelant est `AgentGateway.dispatch()` — qui ne l'appelle qu'après une
décision. `server/test/connector-single-path.test.ts` relit toutes les sources de
`server/` et fait échouer la suite si un second appelant apparaît.

Ce que cela donne, mesuré par `server/test/connector-control-point.test.ts` :

| Cas | Résultat |
|---|---|
| ALLOW | le connecteur est atteint **exactement une fois**, avec la cible et les métadonnées telles quelles |
| BLOCK (politique sur la cible) | **zéro appel**, et l'exécution est enregistrée — un refus est un événement |
| Portée de permission manquante | zéro appel |
| Allowlist de domaine du mandat | zéro appel (c'est elle qui a imposé l'hôte dans la cible) |
| APPROVAL_REQUIRED | zéro appel jusqu'à l'approbation ; une fois approuvé, **un** appel ; approuver deux fois n'en fait pas deux ; un rejet n'en fait aucun |
| Locataire d'un autre | refus nommé `tenant_mismatch`, zéro appel |

Un verbe de connecteur **ne peut pas** échapper au catalogue d'actions : `ToolRegistry`
refuse de câbler un verbe absent de `shared/policy/actions.ts`, et c'est cette entrée qui
fait appliquer la portée de permission, le plafond de mandat et l'allowlist de domaine.

### Les limites de couverture — à lire avant de vendre quoi que ce soit

**Un agent qui détient ses propres credentials n'est pas contrôlé par Oathrion.** Si votre
agent possède son propre jeton GitHub et appelle `api.github.com` directement, Oathrion ne
voit rien et ne peut rien. Le contrôle existe parce que le credential est **dans le
coffre d'Oathrion et nulle part ailleurs** : c'est une propriété de votre déploiement, pas
une garantie du logiciel.

**`/api/evaluate` ne force rien.** Un client qui demande un avis et ignore la réponse
n'est pas empêché. Seul le chemin passerelle (`/api/execute`, `/api/mcp`) est inévitable.
C'est déjà écrit dans `docs/limitations.md` et cela vaut identiquement pour les
connecteurs.

**Deux credentials pour un service, c'est deux chemins.** Si le même jeton GitHub est
aussi configuré dans un serveur MCP branché par `OATHRION_TOOLS`, l'agent dispose de deux
routes et Oathrion ne gouverne que celle qu'il connaît.

---

## 4. L'idempotence, et ce qu'elle ne couvre pas

L'API GitHub n'a pas d'en-tête d'idempotence : rejouer `POST /issues` crée une seconde
issue. Oathrion garantit qu'un grant n'est consommé qu'une fois, donc **il ne rejoue pas de
lui-même**. Mais si la réponse de GitHub se perd sur le réseau, Oathrion voit un échec là où
l'issue existe.

Ce qu'Oathrion fait : l'identifiant d'exécution est inscrit dans le corps de l'issue et du
commentaire (`<!-- placet-execution: exe_… -->`), ce qui rend un doublon reconnaissable par
un humain et par une recherche. Ce n'est pas une déduplication, et ce n'en porte pas le nom.

---

## 5. La révocation

« Déconnecter » fait exactement ceci : Oathrion **écrase l'enveloppe** et marque la ligne
`revoked`. Le jeton n'est plus déchiffrable, les actions suivantes sont refusées avec
`connector_not_connected`, et l'état « révoqué » reste distinct de « jamais configuré » —
la différence importe à l'exploitant qui cherche pourquoi un agent a cessé d'agir.

**Ce qu'Oathrion ne fait pas : invalider le jeton chez GitHub.** Aucune API ne le permet à
un tiers ; seul le compte qui a créé un jeton d'accès personnel peut le supprimer. La
réponse de l'API porte donc `remoteStillValid: true`, et la console l'affiche en rouge avec
le lien <https://github.com/settings/tokens>. Écrire « déconnecté » tout court laisserait
croire que le jeton est mort.

Un échec de test **ne révoque pas** : une coupure réseau n'est pas une révocation, et les
confondre ferait jeter un credential encore valide.

---

## 6. Ce qui n'est pas fait, et pourquoi

**OAuth pour GitHub.** Slack et Linear ont leur flot (§0). GitHub reste sur le jeton à
portée fine : une GitHub App (installation, choix des dépôts, jetons d'installation signés
par la clé de l'application) suppose une application enregistrée et une URL publique, et
n'est pas livrée pour le 31 octobre.

**Les connecteurs des entrées de démonstration.** OpenAI, Anthropic, Google, Slack, Gmail
et Notion apparaissent dans `shared/seed/integrations.ts` avec `connected: true`. Aucun
code ne les joint. Ce sont des données de démonstration de l'écran décoratif que ce
chantier remplace, et elles ne doivent pas être lues comme des intégrations.

**Un second connecteur du CATALOGUE** — mais il n'est plus la seule façon d'avoir une clé
par locataire, et c'est un changement qu'il faut lire ici.

Le coffre acceptait seulement un connecteur du catalogue, donc `github`. Toute autre
destination du pare-feu dépendait de `OATHRION_INTERCEPT_KEY_<DESTINATION>`, une variable
d'environnement valant pour **tout le déploiement** : deux organisations clientes
partageaient la même clé. `PUT /api/destinations/:id/credential` scelle désormais la clé
d'un locataire pour n'importe quelle destination enregistrée — chiffrée, révocable, à lui.

Ce que ça ne remplace PAS : un connecteur du catalogue **vérifie** le jeton contre le
service, lit les portées que le service confirme, et sait distinguer un quota épuisé d'une
permission manquante. Un credential de destination n'a aucune sonde : son état est
`stored_unverified` et il le reste jusqu'au premier appel relayé. Les deux chemins
coexistent donc pour une raison — l'un sait ce qu'il tient, l'autre sait seulement
l'injecter.

**Un second connecteur.** La règle de ce chantier est explicite : *un connecteur
réellement joint et éprouvé vaut mieux que cinq déclarés*. L'ordre de priorité pour la
suite, par utilité pour les utilisateurs cibles d'Oathrion — des équipes qui veulent
gouverner des agents de support et de finance :

1. ~~**Slack** — le canal d'approbation.~~ **FAIT** : Oathrion poste les demandes
   d'approbation avec deux boutons, et `POST /api/slack/interactions` reçoit le clic — la
   signature de l'application vérifiée sur le corps brut, un horodatage de moins de cinq
   minutes, une correspondance nominative déclarée, et la capacité `approve` vérifiée sur
   le rôle de la personne. Voir `server/routes-slack.ts`.

   Ce qui reste du Slack « connecteur » : lire les capacités d'un jeton de bot et
   distinguer un canal archivé d'une permission manquante. Le chemin actuel passe par un
   webhook entrant, qui n'a pas de capacités à lire.
2. **Un ERP ou un outil de facturation**, choisi par le premier pilote. Les verbes
   financiers du catalogue (`refund`, `payment`, `payout`) sont déjà gouvernés par le
   plafond de mandat et la politique de dépense quotidienne : c'est là qu'Oathrion a le plus
   de valeur, et c'est aussi là qu'un connecteur doit être le plus prudent.
3. **Jira ou Linear** — même forme que GitHub (lire, créer, commenter), donc peu de code
   nouveau et un cas d'usage immédiat pour un agent de support.

Aucun des trois n'est commencé. Les nommer ici n'est pas une promesse de livraison.

---

## 7. Les commandes, en un bloc

```bash
npm test                     # 2 200+ tests, aucun accès réseau
npm run verify:github        # GitHub, appels réels (2 sans jeton)
npm run verify:tools         # registre d'outils déclaré, 41/41
npm run verify:mcp           # relais MCP sortant, 37/37
npm run conformance          # 27 propriétés, 25 mutants
npm run verify:prod-config   # refus de démarrage, 41/41
npm run mcp:discover -- --destination=<id>   # ce qu'un serveur MCP déclare réellement
```

L'audit des chemins pour brancher un agent qui existe déjà — MCP, SDK, adaptateur,
appels directs — avec ce que chaque voie garantit et ce qu'elle ne garantit pas, est dans
[integrer-un-agent-existant.md](integrer-un-agent-existant.md).
