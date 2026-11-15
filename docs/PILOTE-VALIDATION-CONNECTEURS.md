# Pilote — valider un connecteur contre le vrai service

Ce document dit **exactement** quoi préparer et quelle commande lancer pour qu'un connecteur
passe de « testé en local contre un service simulé » à « éprouvé de bout en bout ». Rien
ici n'a encore été exécuté contre un vrai compte : à la date de ce document, aucun
credential de test GitHub, Slack (jeton de bot), Linear ou Stripe n'existait sur la machine de
mesure. L'état de chaque connecteur est dans `docs/FINAL-PILOT-READINESS.md`.

**Premier connecteur du pilote : GitHub.** C'est le seul dont le jeton se limite, chez le
fournisseur, à un dépôt et à une permission ; un dépôt de test se crée en une minute et se
nettoie entièrement ; et `verify:launch` relit chaque création directement chez GitHub.

Règles communes :

- un compte, un dépôt, un canal, une équipe **de test** — jamais de données de production ;
- les credentials vont dans `~/.config/placet/<service>-test.env`, écrits avec `nano`,
  `chmod 600`. Ils ne se collent ni dans une conversation, ni dans un ticket, ni dans une
  capture d'écran ;
- le banc refuse un jeton trop puissant ou d'un autre type ; il n'imprime jamais un secret
  (il vérifie lui-même que sa sortie n'en contient aucun) ;
- **sortie 0** = tout ce qui était fourni a été éprouvé ; **2** = au moins un service sans
  credential (rien n'est réputé réussi) ; **1** = un contrôle a échoué.

---

## 1. GitHub

### Ce qu'il faut

| Élément | Exigence |
|---|---|
| Compte | un compte GitHub personnel ou une organisation de test |
| Dépôt | **un dépôt de test dédié**, privé ou public, qu'on accepte de voir recevoir une issue (fermée ensuite) — par exemple `votre-compte/placet-essai` |
| Jeton | *fine-grained personal access token* : <https://github.com/settings/personal-access-tokens/new> → **Repository access : Only select repositories** → ce dépôt seul ; **Repository permissions : Issues — Read and write ; Metadata — Read-only** ; rien d'autre ; expiration courte (7 jours) |

Un jeton *classic* (`ghp_…`) ou un jeton ouvrant tous les dépôts n'est pas un credential de
test : ne pas l'utiliser.

### Le fichier

```bash
nano ~/.config/placet/github-test.env
```

contenu (deux lignes, sans guillemets) :

```
OATHRION_GITHUB_TEST_TOKEN=github_pat_…
OATHRION_GITHUB_TEST_REPO=votre-compte/placet-essai
```

```bash
chmod 600 ~/.config/placet/github-test.env
```

### Les commandes

Une base PostgreSQL jetable (le bundle de production ne tourne que sur PostgreSQL) :

```bash
docker run -d --name placet-essai-pg -e POSTGRES_USER=placet -e POSTGRES_PASSWORD=essai -p 127.0.0.1:55496:5432 postgres:17
```

Puis, depuis la racine du dépôt :

```bash
npm run build
```

```bash
set -a; . ~/.config/placet/github-test.env; set +a; DATABASE_URL=postgres://placet:essai@127.0.0.1:55496/postgres npm run verify:launch
```

(sortie 2 attendue tant que Slack et Linear ne sont pas fournis ; le bloc GitHub doit être
entièrement vert.) Le banc du connecteur seul, plus détaillé :

```bash
set -a; . ~/.config/placet/github-test.env; set +a; npm run verify:github
```

### Ce que la commande doit démontrer, et où

| Exigence du pilote | Contrôle de `verify:launch` (section) |
|---|---|
| Authentification réussie | « github : le service accepte le credential, Oathrion le scelle » (2) |
| Connectivité réelle | « github : la ressource de test figure dans ce que le service liste », puis « le périmètre devient deux politiques » (2) |
| Action autorisée qui atteint GitHub | « lecture du contexte : AUTORISÉE et réussie chez le service » (3) |
| Action bloquée qui n'atteint pas GitHub | « action hors périmètre : BLOQUÉE … et jamais tentée chez le service » (3) |
| Approbation requise, rien avant | « issue GitHub : RETENUE avant approbation, rien de parti » (3) |
| Exécution après approbation, une seule | « … approuvée : le service l'a créée », « RELUE directement chez GitHub », « une seconde approbation ne relâche rien » (3) |
| Refus réel du fournisseur | « REFUS RÉEL de GitHub (issue inexistante) : tentative faite, échec dit tel quel » et « l'exécution enregistrée porte l'échec » (3) |
| Reçus et audit véridiques | « l'audit nomme le scénario guidé comme acteur » (3) ; l'issue porte l'identifiant d'exécution `placet-execution` |
| Nettoyage | l'issue est fermée (`not_planned`) (4) |

**Délai incertain (effet inconnu) contre le vrai GitHub : non provocable de façon sûre.**
Le délai minimal d'un connecteur est 1 s (`OATHRION_CONNECTOR_TIMEOUT_MS`) et GitHub répond
d'ordinaire plus vite ; provoquer une coupure au milieu d'une écriture réelle demanderait
de manipuler le réseau. Ce comportement est éprouvé contre un service simulé
(`unknown-effect.test.ts`, parcours de lancement « EFFET INCONNU ») et **reste non éprouvé
contre GitHub**. Le connecteur peut être dit « validé de bout en bout » pour tout le reste ;
cette réserve s'écrit à côté.

### Après

Révoquer le jeton chez GitHub (<https://github.com/settings/personal-access-tokens>),
supprimer `~/.config/placet/github-test.env` si le test est fini, supprimer le conteneur
`placet-essai-pg` (`docker rm -f placet-essai-pg`, il ne contient que des données de test).

---

## 2. Slack — à part, et avec un jeton de BOT

Le jeton actuellement présent dans `~/.config/placet/slack-test.env` est un jeton
**utilisateur** (`xoxp-`/`xoxe.xoxp-`) : Oathrion le refuse par conception, un agent ne doit
pas parler au nom d'une personne. Il faut :

1. Une application Slack de test dans un espace de test : <https://api.slack.com/apps> →
   *Create New App* → *From scratch*.
2. **OAuth & Permissions → Bot Token Scopes** : `chat:write`, `channels:read`,
   `channels:history`, `groups:read`, `groups:history` ; **aucun** *User Token Scope*.
3. *Install to Workspace* ; copier le **Bot User OAuth Token** (`xoxb-…`).
4. Un canal de test ; y inviter le bot (`/invite @le-nom-de-l-app`) ; noter son identifiant
   (`C0…`, dans les détails du canal).
5. Remplacer le contenu de `~/.config/placet/slack-test.env` (avec `nano`, `chmod 600`) :

```
OATHRION_SLACK_TEST_TOKEN=xoxb-…
OATHRION_SLACK_TEST_CHANNEL=C0…
```

Commande : la même que pour GitHub, en chargeant aussi ce fichier. Le banc publie un
résumé (après approbation), le relit chez Slack, puis le supprime ; il ne révoque pas le
jeton (c'est le vôtre).

## 3. Linear — à part

1. Un espace Linear de test et une **équipe de test** (clé courte, par exemple `ESSAI`).
2. *Settings → Security & access → Personal API keys* → créer une clé (`lin_api_…`).
3. `~/.config/placet/linear-test.env` (`nano`, `chmod 600`) :

```
OATHRION_LINEAR_TEST_KEY=lin_api_…
OATHRION_LINEAR_TEST_TEAM=ESSAI
```

Le banc crée une tâche (après approbation), la relit chez Linear, **éprouve le refus d'un
doublon au même identifiant** (la garantie d'idempotence sur laquelle la règle de rejeu ne
se fie pas tant qu'elle n'est pas démontrée), puis archive la tâche.

## 4. Stripe — mode TEST seulement

Le seul connecteur qui déplace de l'argent. Le banc **refuse une clé réelle** (`sk_live_`,
`rk_live_`) avant tout appel, et le serveur la refuse aussi tant que l'exploitant n'a pas
posé `OATHRION_STRIPE_ALLOW_LIVE=true` — ce que le banc ne fait jamais.

1. Un compte Stripe en **mode test** ; au moins un paiement de test **réussi**, en EUR ou
   USD, d'au moins 1,00 (tableau de bord → *Paiements* → *Créer un paiement*, carte
   `4242 4242 4242 4242`).
2. *Développeurs → Clés API* (mode test) : de préférence **Créer une clé restreinte**
   « Oathrion » — lecture sur *Balance*, *PaymentIntents*, *Customers*, écriture sur
   *Refunds*, rien d'autre ; sinon la clé secrète de test (`sk_test_…`).
3. `~/.config/placet/stripe-test.env` (`nano`, `chmod 600`) :

```
OATHRION_STRIPE_TEST_KEY=rk_test_…
```

Le compte n'est pas une variable : c'est celui de la clé, lu chez Stripe à la connexion.

Le banc lit les paiements par le scénario guidé, tente un remboursement sur un compte non
choisi (bloqué, jamais tenté), puis **rembourse 1,00** sur un paiement de test réussi :
retenu avant approbation (relu chez Stripe : rien de parti), approuvé, **relu chez Stripe**
(montant, paiement, exécution en métadonnée), seconde approbation sans effet, et la clé
d'idempotence de l'exécution rejouée directement : **Stripe doit rendre le même
remboursement**. Un remboursement ne s'annule pas : il reste dans le compte de test, marqué
`placet_execution`. Aucun argent réel.

## 5. OAuth « en un clic » — non éprouvé contre les vrais fournisseurs

La connexion par jeton ci-dessus ne prouve rien de l'OAuth. Pour l'éprouver, il faut une
instance joignable en HTTPS (`OATHRION_PUBLIC_URL`), une application Slack et une application
Linear enregistrées avec l'URL de retour `<OATHRION_PUBLIC_URL>/api/connectors/oauth/callback`,
et `OATHRION_SLACK_CLIENT_ID/SECRET`, `OATHRION_LINEAR_CLIENT_ID/SECRET` dans l'environnement du
serveur (`docs/connectors.md`, « Ce que l'exploitant doit enregistrer »). Jusque-là, l'OAuth
n'est éprouvé que contre un fournisseur simulé.
