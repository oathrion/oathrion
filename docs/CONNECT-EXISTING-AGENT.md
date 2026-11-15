# Connecter un agent qui existe déjà

Vous avez des agents. Vous ne voulez pas les reconstruire. Voici les trois voies, ce
qu'elles garantissent, et ce qu'elles coûtent en modifications chez vous.

| Voie | Changement chez vous | Garantie |
|---|---|---|
| **MCP** | configurer un serveur MCP, déclarer vos outils | A — Oathrion sur le chemin |
| **Pare-feu HTTP** | **une URL de base** | A — Oathrion sur le chemin |
| **SDK / wrapper** | enrober vos fonctions d'outil | B — seulement les appels enrobés |

Le pare-feu demande le moins. Commencez par là.

> **Sans terminal : l'écran « Ajouter un agent existant »** (console → Agents). Il crée
> l'agent et sa clé, donne le fichier de configuration (Cursor, Claude Desktop) ou des
> exemples prêts à coller (Python, HTTP pour n8n, Make, Zapier), puis fait **fermer les
> autres portes** : révoquer la clé que l'agent détenait, et vérifier auprès du service
> qu'elle ne fonctionne plus. Les actions de l'agent apparaissent ensuite en direct.
> Claude Desktop n'y est pas vérifié, et l'écran le dit. Voir `STRESS-TEST-LOG.md` §5.16.

---

## Voie 1 — Pare-feu HTTP : changez l'URL de base

### Chez vous

```diff
- const stripe = new Stripe(key, { host: "api.stripe.com" });
+ const stripe = new Stripe(placetKey, {
+   host: "placet.acme.com",
+   basePath: "/api/v1/intercept/stripe-api",
+ });
```

Même méthode, même chemin, même corps. **Votre agent ne sait pas qu'il parle à un
pare-feu.** Et `placetKey` n'est pas votre clé Stripe : c'est une clé Oathrion liée à cet
agent. Votre clé Stripe part dans le coffre — c'est ce qui rend le contournement
impossible.

### Chez Oathrion

```bash
OATHRION_DESTINATIONS='[{"id":"stripe-api","url":"https://api.stripe.com","organizations":["org_…"]}]'
OATHRION_MCP_ALLOWED_DESTINATIONS=https://api.stripe.com
OATHRION_INTERCEPTS='[{
  "id": "stripe_refunds", "destination": "stripe-api",
  "method": "POST", "path": "/v1/refunds",
  "action": "refund", "target": "body.payment_intent|body.charge",
  "amount": "body.amount", "amountUnit": "minor"
}]'
```

Pour Stripe, `OATHRION_INTERCEPT_PACKS=stripe` fait la même chose sans rien écrire, avec des
règles vérifiées contre le vrai service. Ne lisez **pas** `currency` sur un remboursement :
Stripe la refuse.

**Le verbe ne vient pas de votre agent.** Il est extrait de la requête réelle. Un agent
qui pourrait annoncer « refund de 1 » tout en envoyant un corps à 100 000 choisirait la
règle qui le gouverne.

**`amountScale` n'est pas optionnel si votre API compte en centimes.** Stripe envoie
`7500` pour 75. Sans diviseur, un plafond de 500 laisse passer 500 000.

Une route qu'aucune règle ne reconnaît est **refusée**. C'est voulu : déclarez d'abord,
ouvrez ensuite.

### Si votre agent appelle une API de MODÈLE

C'est le cas le plus fréquent, et il demande deux choses de plus.

```diff
  {
    "id": "modele_chat", "destination": "openai",
    "method": "POST", "path": "/v1/chat/completions",
+   "action": "api.request",
    "target": "body.model",
+   "stream": true
  }
```

**`stream: true`** relaie la réponse au fil de l'eau. Sans lui, Oathrion attend la réponse
entière puis la rend d'un coup : votre application perd le streaming qu'elle attend, et
une réponse longue bute sur le plafond et fait échouer l'appel.

**`api.request`** et non `call_api` : ce dernier est délibérément sans portée de
permission, et une règle qui le nomme **refuse le démarrage**. Accordez
`call:external-api` à l'agent.

**Et vérifiez vos plafonds de montant.** Un appel de modèle ne porte pas de montant : un
plafond en euros posé à l'échelle de l'organisation le **bloque**, avec ce motif —
« caps this action at 500,00 €, but the action declares no numeric amount ». Portez le
plafond sur vos agents financiers (`appliesToAgentIds`) et donnez à l'agent de modèle son
propre mandat.

### Si votre API ne délivre que des jetons d'une heure — expérimental

> **Non éprouvé contre un vrai fournisseur.** Le renouvellement est testé contre un
> fournisseur local seulement (`server/test/oauth-refresh.test.ts`), jamais contre
> Google, Microsoft ou Salesforce. Oathrion n'offre pas non plus le parcours de
> consentement qui délivre le jeton de rafraîchissement : vous devez l'obtenir ailleurs.
> Google Workspace est hors du périmètre de lancement du 31 octobre.

Le principe : le secret du coffre est un jeton de **rafraîchissement**, et Oathrion injecte
le jeton d'accès qu'il permet d'obtenir.

```bash
# l'application, côté déploiement — le point d'échange est souvent sur une AUTRE origine
OATHRION_OAUTH_<DESTINATION>='{"tokenUrl":"https://<fournisseur>/token","clientId":"…","clientSecret":"…"}'
OATHRION_MCP_ALLOWED_DESTINATIONS=https://<api du fournisseur>,https://<point d'échange>
```

```bash
# le consentement, côté locataire — un jeton de rafraîchissement obtenu hors d'Oathrion
curl -X PUT $OATHRION/api/destinations/<destination>/credential \
  -H "authorization: Bearer $CLE_ADMIN" -H 'content-type: application/json' \
  -d '{"secret":"<le jeton de rafraîchissement>"}'
```

Oathrion garde le jeton d'accès en mémoire jusqu'à une minute de son échéance, ne l'écrit
jamais en base, et n'échange qu'une fois même sous appels concurrents.

Si l'échange échoue, **l'appel est refusé** (`oauth_unavailable`) au lieu de partir sans
credential : le motif nomme la cause probable, un jeton révoqué.

### Si vous voulez approuver depuis Slack

```bash
OATHRION_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/…
OATHRION_SLACK_SIGNING_SECRET=<le secret de signature de votre application Slack>
OATHRION_SLACK_APPROVERS=U123ABC:approbateur@acme.com
```

Et côté Slack, pointez l'« Interactivity Request URL » sur
`https://<votre-placet>/api/slack/interactions`.

**Les deux premières variables vont ensemble** : un webhook sans secret de signature
refuse le démarrage, parce que poster des boutons sans pouvoir vérifier qui clique serait
publier une URL qui relâche des actions d'agents.

**Et la troisième n'est pas optionnelle non plus.** Une signature valide prouve que
l'application Slack est la vôtre, pas que la personne qui a cliqué a le droit d'approuver :
un espace de travail contient toute l'entreprise. L'adresse doit par ailleurs être celle
d'un utilisateur de console ayant la capacité `approve` — cette liste donne une identité,
pas un droit.

Une personne appartenant à **plusieurs organisations** ne peut pas approuver depuis Slack :
un clic ne dit pas pour quel locataire elle agit. Elle approuve dans la console.

### Si votre agent lit la ressource dans l'URL

```diff
- "path": "/v1/charges/*/capture",  "target": "body.charge"
+ "path": "/v1/charges/{charge}/capture", "target": "path.charge"
```

Un segment nommé capture, et se lit avec `path.<nom>`. Indispensable pour une API REST qui
met la ressource dans le chemin, c'est-à-dire la plupart.

Détails complets : `docs/firewall.md`.

---

## Voie 2 — MCP : découvrir, puis relayer

Si vos agents parlent déjà MCP, c'est la voie la plus propre.

```bash
# 1. Déclarez le serveur de vos outils comme destination (même allowlist que ci-dessus)
# 2. Demandez-lui ce qu'il expose
npm run mcp:discover -- --destination=acme-erp --declare=refund
```

La commande émet un vrai `tools/list` et imprime une déclaration `OATHRION_TOOLS` à relire
— les sources d'arguments sont **devinées** depuis les noms, donc elle imprime au lieu
d'écrire.

Oathrion compare ensuite votre déclaration au schéma du serveur **à la dépêche** et refuse,
en nommant la correction : outil inexistant, argument requis non projeté, argument absent
du schéma (le serveur l'ignorerait **en silence**).

Détails : `docs/mcp.md`.

---

## Voie 3 — SDK et wrapper

Pour un agent qui n'est ni derrière le proxy ni en MCP.

```ts
import { OathrionClient } from "@oathrion/sdk";
import { withOathrion } from "./with-placet";   // examples/framework-adapter/

const placet = new OathrionClient({ baseUrl: process.env.OATHRION_URL!, apiKey: process.env.OATHRION_API_KEY! });
const governed = withOathrion(placet, { agentId: "support-agent", action: "refund" }, myRefundTool);
```

`withOathrion` accepte `execute`, `invoke`, `func`, `call`, `_run` ou une fonction nue — les
formes du SDK ai de Vercel, LangChain/LangGraph, LlamaIndex, CrewAI et du function calling
brut — et **conserve tout le reste de l'objet** (description, schéma) pour que l'outil
enrobé se glisse là où l'autre était.

**Garantie :** la fonction enrobée ne tourne pas sans ALLOW. Oathrion injoignable lève ;
APPROVAL_REQUIRED ne passe pas.

**Limite, et elle ne se contourne pas par un meilleur adaptateur :** il protège l'outil
qu'il a enrobé. Rien n'empêche d'appeler l'original.

**État honnête :** `withOathrion` vit dans `examples/`, donc hors du paquet publié — vous le
recopiez. Il est éprouvé contre des objets de la bonne forme, **pas contre les classes
réelles de LangChain**. Le promouvoir en API publique du SDK demande de l'avoir passé sur
deux frameworks installés, ce que ce dépôt ne fait pas encore.

---

## Dans tous les cas

1. **Déclarez l'agent** dans Oathrion, avec sa portée de permission et son mandat
   (plafond, devise, domaines autorisés). Oathrion autorise **par agent**.
2. **Délivrez une clé liée à cet agent.** Une clé liée gagne sur tout ce que le corps
   d'une requête prétend.
3. **Écrivez au moins une politique.** Sans elle, seules la posture par défaut, les
   permissions et le mandat décident.
4. **Mettez le credential du service dans le coffre** (Console → Connecteurs), pas dans
   l'agent.
5. **Ouvrez Couverture.** Elle liste ce qui bloque encore, dans l'ordre, avec le motif.
6. **Essayez les trois décisions** avant d'ouvrir le trafic réel : une action autorisée,
   une bloquée, une qui demande une approbation.

## Ce que vous devez dire à votre équipe

> Oathrion gouverne les actions qui **passent par lui**. Un agent qui garde sa propre clé
> d'API peut appeler le service directement, et Oathrion ne le verra pas. Le contournement
> devient impossible quand la clé ne vit que dans le coffre d'Oathrion.

`docs/SECURITY-BOUNDARIES.md` donne la liste complète des chemins couverts et non
couverts.
