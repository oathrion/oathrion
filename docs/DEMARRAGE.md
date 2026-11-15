# Démarrer avec Oathrion — qui fait quoi

Ce document sépare deux métiers qu'il ne faut pas confondre : **héberger Oathrion** (une
fois, par l'exploitant) et **l'utiliser** (par l'équipe cliente, dans le navigateur).

> **État réel au 19 octobre 2026.** Aucun service Oathrion hébergé n'est en ligne. Ce qui
> est livré : le logiciel, la pile de déploiement (`deploy/`) et le parcours client. Une
> équipe ne peut donc démarrer seule qu'**une fois qu'un exploitant a déployé une
> instance** et lui a remis un lien.

---

## 1. Côté exploitant — une fois, puis une commande par client

Ce côté exige un terminal, Docker et un nom de domaine. C'est normal : c'est le métier
de l'hébergeur, pas celui du client.

1. **Déployer** une instance avec PostgreSQL et HTTPS — `deploy/README.md`,
   `DEPLOYMENT.md`.
2. **Déclarer** dans l'environnement du serveur :

   | Variable | Rôle |
   |---|---|
   | `OATHRION_ACCOUNTS=database` | les comptes sont créés en base, aucun mot de passe dans l'environnement |
   | `OATHRION_PUBLIC_URL=https://…` | l'adresse publique, pour les liens d'accueil et le retour OAuth |
   | `OATHRION_SESSION_SECRET`, `OATHRION_KEK` | sessions, coffre chiffré des connecteurs |
   | `OATHRION_SLACK_CLIENT_ID/SECRET` (optionnel) | « Connecter Slack » en un clic |
   | `OATHRION_LINEAR_CLIENT_ID/SECRET` (optionnel) | « Connecter Linear » en un clic |

   Sans les applications OAuth, le client connecte Slack et Linear par jeton, avec des
   étapes guidées dans la console. GitHub se connecte toujours par jeton à portée fine.
3. **Créer l'espace d'un client** :

   ```bash
   npm run workspace:create -- --org "Acme" --email admin@acme.com
   ```

   La commande imprime **un lien**, valable 7 jours, utilisable une fois. Remettez-le par
   un canal de confiance. Elle refuse de « créer » un espace qui a déjà un administrateur.

## 2. Côté client — sans terminal, sans Docker, sans fichier `.env`

1. **Ouvrir le lien.** La page dit l'espace, l'adresse et le rôle ; la personne choisit son
   nom et son mot de passe, et arrive connectée.
2. **Démarrage guidé**, cinq étapes dont la progression est lue dans l'état réel :
   1. *Votre espace* — inviter un approbateur (un lien par personne, à copier).
   2. *Vos outils* — GitHub, Slack, Linear, Stripe. « Connecté » n'apparaît que si le service a
      répondu. Une erreur dit quoi faire : jeton utilisateur au lieu du bot, permission
      manquante, bot absent du canal, connexion expirée.
   3. *Ce qui est autorisé* — choisir le dépôt, le canal, l'équipe, le compte Stripe, et le sort des
      écritures : sur approbation (défaut), libres, interdites. Le choix devient des règles
      visibles sur l'écran Politiques.
   4. *Votre agent* — une clé liée à cet agent seul, et la configuration MCP ou HTTP à
      copier.
   5. *Vérification* — un scénario réel : lire, préparer une tâche, proposer une issue,
      lire les derniers paiements Stripe (jamais de remboursement automatique), tenter une
      action hors périmètre. On voit « Autorisé », « Approbation requise » et
      « Bloqué », on approuve dans la page, et chaque résultat porte le lien vers le service
      et le reçu d'audit.

### Ce qui reste à faire par le client, et ce n'est pas caché

- **Sans OAuth configuré**, créer un jeton chez GitHub, Slack ou Linear, ou une clé de
  test Stripe (deux minutes, étapes affichées). Une clé Stripe réelle est refusée tant que
  l'exploitant ne l'a pas autorisée (`OATHRION_STRIPE_ALLOW_LIVE=true`).
- **Inviter le bot Slack** dans chaque canal utilisable (`/invite @Oathrion`) : un bot ne
  voit que là où il est invité, et c'est voulu.
- **Brancher son agent** : coller la configuration MCP dans son client, ou appeler l'API
  HTTP. La passerelle accepte les révisions MCP `2025-06-18`, `2025-03-26` (poignée de main
  `initialize`) et `2026-07-28`. **Vérifiée avec un vrai client : Cursor** (`cursor-agent`
  2026.08.11) — connexion, découverte des seuls outils connectés, une action autorisée, une
  bloquée, une retenue pour approbation (services simulés en local). Claude Desktop et les
  autres clients **n'ont pas été vérifiés**.

  Pour Cursor, dans `.cursor/mcp.json` (projet) ou `~/.cursor/mcp.json` :

  ```json
  { "mcpServers": { "oathrion": { "url": "https://<votre-oathrion>/api/mcp",
      "headers": { "Authorization": "Bearer <clé de l'agent>" } } } }
  ```

  puis `cursor-agent mcp enable placet` (ou approuver le serveur dans l'éditeur).

## 3. Ce qu'Oathrion contrôle

Les actions qui passent **par lui** : les connecteurs, la passerelle MCP, `POST
/api/execute`, le pare-feu. Un agent qui garde ses propres identifiants GitHub, Slack ou
Linear et appelle ces services directement n'est ni vu ni bloqué. Le démarrage guidé est
construit pour que l'agent n'en ait plus besoin : les jetons sont dans le coffre de
Oathrion, l'agent n'a qu'une clé Oathrion.

## 4. Vérifier soi-même

```bash
npm run verify:launch     # le parcours complet sur le bundle livré, contre les vrais services
```

Sans credential de test, la commande prouve que les trois services réels sont joints et
que l'espace se crée par lien, puis sort en **2** : le reste n'a pas été éprouvé.
