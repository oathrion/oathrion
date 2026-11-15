# Feuille de route — des agents existants, branchés facilement, et Oathrion incontournable

**Objectif.** Toute personne, même non technique, branche ses agents existants sur Oathrion
en quelques minutes ; et une fois branché, un agent **ne peut plus agir sans passer par les
règles** — ou, s'il le fait par une porte restée ouverte, **cela se voit**.

Ce document dit ce qui existe (avec la preuve), ce qu'il faut construire, dans quel ordre,
et à quoi on reconnaîtra que c'est fait. Rédigé le 21 octobre 2026, sur `95a0e17`.

---

## 1. La vérité sur « incontournable »

Oathrion ne contrôle pas un agent par logiciel : **un agent qui garde sa propre clé d'un
service peut toujours l'appeler directement.** Oathrion devient incontournable quand l'agent
n'a **plus d'autre chemin**. Trois verrous, du plus simple au plus fort :

| Verrou | Ce qu'il établit | État |
|---|---|---|
| **1. Garde des clés** — le credential du service vit dans le coffre d'Oathrion ; l'agent ne reçoit qu'une clé Oathrion liée à lui | l'agent ne peut pas joindre le service sans Oathrion | ✅ coffre AES-256-GCM (`connector-vault.test.ts`), connecteurs GitHub, Slack, Linear, Stripe |
| **2. Porte fermée chez le fournisseur** — l'ancienne clé de l'agent est révoquée, et Oathrion **vérifie** qu'elle ne fonctionne plus | il n'existe plus de seconde route connue | ✅ vérification auprès du service, **conservée sur la fiche de l'agent** (`STRESS-TEST-LOG` §5.16, §5.18) ; pas encore réévaluée dans le temps (c'est la réconciliation) |
| **3. Réconciliation** — Oathrion compare ce que le service a enregistré avec ses propres reçus ; une action sans reçu est une alerte | une route oubliée ou inconnue **se voit** | ✅ les quatre connecteurs (GitHub, Slack, Linear, Stripe), à la demande ET automatique (toutes les heures par défaut), avec une alerte unique par écriture (webhook, Slack) — éprouvée contre les vrais services (`STRESS-TEST-LOG` §5.19 à §5.21) |

Ce qui se vend honnêtement : *« sur les services connectés, l'agent n'a pas d'autre
chemin ; et toute action qui aurait contourné Oathrion est détectée et signalée »*.

Ce qu'Oathrion ne garantira jamais, et que le produit doit dire : un agent qui tourne hors
du contrôle du client avec des clés qu'Oathrion ne connaît pas. Les modes d'intégration
« enveloppe » (SDK, `withOathrion`) et « avis » (`POST /api/evaluate`) ne sont **jamais**
présentés comme incontournables (`docs/integrer-un-agent-existant.md` §2).

---

## 2. Où on en est

| Brique | État | Preuve |
|---|---|---|
| Voies d'intégration : MCP, pare-feu HTTP, SDK TS/Python | réelles et testées | `docs/CONNECT-EXISTING-AGENT.md`, `conformance`, `verify:mcp`, `verify:intercept` |
| Client MCP vérifié | **Cursor** seulement | `STRESS-TEST-LOG` §2.7, §5.4 |
| Connecteurs natifs | GitHub, Slack, Linear, Stripe — éprouvés contre les vrais services | `verify:launch` (§5.11, §5.12) |
| Démarrage guidé (outil → périmètre → agent → vérification) | réel ; séance à blanc passée | `PILOTE-RECETTE-UTILISATEUR.md`, §5.15 |
| Approbation depuis Slack | existe | `server/routes-slack.ts`, `slack-approval.test.ts` |
| Connexion d'entreprise (OIDC) | existe | `server/routes-oidc.ts` |
| Webhook d'événements | existe | `server/notifications/` |
| Mettre un agent en pause | existe (statut `paused`) | `PATCH /api/agents/:id` |
| **« Ajouter un agent existant »** | ✅ première version : écran en cinq étapes, fichiers et exemples prêts, vérification des anciennes clés, actions en direct | `STRESS-TEST-LOG` §5.16 |
| **Ce qui manque encore** | le pare-feu HTTP se déclare toujours par variables d'environnement ; Claude Desktop non vérifié ; l'état « portes fermées » n'est pas conservé ; pas d'installation en un clic pour Cursor | — |

---

## 3. « Ajouter un agent existant » — l'écran à construire

Un parcours de quatre étapes, sur le modèle du démarrage guidé actuel.

1. **Où vit votre agent ?** Catalogue avec logos : Cursor, Claude, ChatGPT, n8n, Zapier,
   Make, Microsoft Copilot, « agent développé en interne ». Chaque entrée a sa fiche :
   bouton d'installation en un clic quand l'outil en offre un (lien d'installation MCP de
   Cursor), sinon un fichier à télécharger et une vidéo courte, écran par écran.
2. **Que fait-il ?** L'utilisateur coche les services ; Oathrion les connecte (OAuth en un
   clic quand l'exploitant a enregistré l'application, jeton guidé sinon — l'existant).
3. **Fermez les autres portes.** Oathrion liste les credentials que l'agent détenait,
   donne pour chacun le lien exact de révocation chez le fournisseur, puis **vérifie**
   quand c'est possible (exemple : la clé présentée une dernière fois au service répond
   « non reconnue »). Badge visible partout : **🔒 incontournable** ou **⚠ une clé directe
   existe encore**. Une clé ne se « vérifie révoquée » que si l'utilisateur la fournit à ce
   moment-là ; elle n'est alors ni gardée ni journalisée.
4. **Vérifiez.** Le scénario des trois décisions — autorisé, retenu pour approbation,
   bloqué — joué **par le vrai agent** de l'utilisateur, avec le reçu de chacune.

Puis, sur la page de l'agent : **des règles toutes faites en langage courant**, à cocher
(« rien au-dessus de 50 € sans mon accord », « seulement ce dépôt », « jamais d'e-mail hors
de l'entreprise »), traduites en politiques visibles ; et **« Arrêter cet agent »**,
toujours à portée de main.

**Fait quand** : trois personnes non techniques branchent un agent Cursor ou Claude Desktop
seules (critère de `PILOTE-RECETTE-UTILISATEUR.md`), et le badge dit vrai dans les deux
états (contrôlé contre un vrai service).

---

## 4. La réconciliation — ce qui rend le contournement visible

Pour chaque service connecté, Oathrion lit périodiquement ce que le service a enregistré et
le confronte à ses reçus. Chaque écriture faite par Oathrion porte déjà une marque :

| Service | Marque posée par Oathrion aujourd'hui | Ce qu'Oathrion relit | Une action « hors Oathrion », c'est… |
|---|---|---|---|
| **Stripe** | `metadata[placet_execution]` + `Idempotency-Key: placet-<exécution>` sur chaque remboursement | `GET /v1/refunds` (et les événements) du compte | un remboursement **sans** `placet_execution`. Cas réel relevé le 21 octobre : sur le compte de test, 8 remboursements sans marque (ceux du banc `verify:stripe`, passé par le pare-feu) contre 1 marqué — la réconciliation les aurait signalés |
| **GitHub** | marque d'exécution dans le corps de l'issue ou du commentaire | issues et commentaires récents des dépôts choisis | une création sans marque, ou d'un auteur qu'Oathrion ne connaît pas |
| **Slack** | métadonnées du message | historique des canaux choisis | un message du bot sans métadonnées Oathrion |
| **Linear** | identifiant d'issue dérivé de l'exécution | issues récentes de l'équipe | une issue dont l'identifiant ne correspond à aucune exécution |

Règles : la réconciliation **ne bloque rien** (elle arrive après) ; elle **alerte** (console,
Slack, webhook) et **nomme** l'action, l'heure et l'acteur vus chez le fournisseur ; elle
dit « non vérifié » plutôt que « rien trouvé » quand le service n'a pas répondu ; elle ne
lit que les ressources choisies, avec les droits déjà accordés.

**Fait quand** : contre le vrai Stripe (mode test) et le vrai GitHub, une action faite
**hors** Oathrion avec un autre credential est signalée, et une action faite par Oathrion ne
l'est pas — dans `verify:launch`.

---

## 5. Les intégrations à venir, par priorité

### A. Les services sur lesquels les agents agissent

| Priorité | Intégrations | Pourquoi | À prévoir |
|---|---|---|---|
| 1 | **Gmail / Google Workspace** (Gmail, Agenda, Drive) · **Microsoft 365** (Outlook, Teams, SharePoint) | l'envoi d'e-mail est l'action la plus risquée et la plus demandée | applications OAuth à enregistrer et à faire valider (Google exige une vérification pour les portées Gmail) |
| 2 | **Wave, Orange Money, MTN MoMo**, **PayPal** | l'argent du marché visé ; Oathrion gère déjà XOF et XAF | accès API marchand à obtenir auprès de chaque opérateur ; mode test indispensable |
| 3 | **HubSpot, Salesforce** · **Zendesk, Intercom** | agents commerciaux et de support | OAuth |
| 4 | **Notion, Jira / Confluence** · **WhatsApp Business / Twilio** | savoir interne, tâches, messages aux clients | WhatsApp : modèles de messages validés par Meta |
| 5 | **Shopify, QuickBooks / Xero** · bases de données (lecture seule) · **AWS / Google Cloud** | commerce, comptabilité, infrastructure — les plus sensibles, en dernier | la signature AWS SigV4 existe déjà côté pare-feu, jamais éprouvée contre AWS |

Chaque connecteur suit la règle des quatre existants : **réel ou absent**, vérifié contre
le vrai service avant d'être annoncé, avec son périmètre, ses écritures sous approbation par
défaut, et sa marque de réconciliation.

### B. Les outils où vivent les agents

1. **Claude** (Desktop, Code) et **ChatGPT** — acceptent des serveurs MCP ; le public non
   technique est là. **Non vérifiés aujourd'hui** : à éprouver avant toute promesse.
2. **n8n, Zapier, Make** — automatisations sans code.
3. **Microsoft Copilot Studio** — entreprises déjà sur Microsoft.
4. Développeurs : **OpenAI Agents SDK, LangChain / LangGraph, CrewAI, Vercel AI SDK** —
   adaptateurs publiés, bâtis sur le SDK existant (aujourd'hui `withOathrion` est un exemple
   à recopier, pas un paquet).

### C. Autour (entreprises)

- **Approuver depuis son téléphone** : Slack existe ; ajouter e-mail, Teams, WhatsApp,
  notification.
- **Comptes d'entreprise** : OIDC existe ; préréglages Google, Microsoft Entra, Okta ;
  synchronisation des membres (SCIM).
- **Audit** : webhook existant ; export vers Datadog, Splunk ; rapport PDF pour un auditeur.

---

## 6. L'ordre proposé

| # | Chantier | Pourquoi d'abord |
|---|---|---|
| 1 | **Réconciliation** — ✅ les quatre connecteurs, à la demande et automatique, avec alerte (§5.19 à §5.22), Stripe compris : remboursements, virements manuels, paiements annulés, clients supprimés, litiges acceptés. Non jugés : les nouveaux paiements et clients (indiscernables de ceux du site) | prouve « incontournable » |
| 2 | **Écran « Ajouter un agent existant »** — ✅ livré (§5.16), éprouvé avec le vrai Cursor (§5.17), portes conservées sur la fiche de l'agent (§5.18). Reste : installation en un clic pour Cursor | rend l'intégration faisable par une personne non technique |
| 3 | **Claude Desktop vérifié** de bout en bout. Cursor l'est désormais par l'écran, contre le vrai GitHub (`STRESS-TEST-LOG` §5.17) | le client le plus demandé, et le seul gros absent |
| 4 | **Gmail** | premier nouveau connecteur, le plus demandé |
| 5 | **Règles en langage courant** à cocher | réduit l'écart entre « je veux » et « la politique dit » |
| 6 | **Mobile money** (un opérateur d'abord) | différenciation sur le marché visé |

Chaque chantier se termine comme les précédents : tests, banc contre le vrai service quand
il y en a un, journal dans `STRESS-TEST-LOG.md`, et l'état réel — pas l'état espéré — dans
`FINAL-PILOT-READINESS.md`.
