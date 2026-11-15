# Démarrage pilote — local, en une commande

## 1. Lancer

```bash
nvm use 22          # le .nvmrc du projet ; better-sqlite3 est compilé pour cette ABI
npm ci
npm run pilot:up    # OATHRION_PILOT_PORT=5055 npm run pilot:up si 5000 est pris
```

La commande génère des secrets frais dans `deploy/placet.local.env` (mode 600,
git-ignoré), construit l'image, applique les migrations **avant** le serveur, démarre, et
**attend que `/api/ready` réponde 200** avant d'afficher vos identifiants. Si la sonde ne
passe pas, elle échoue en montrant les journaux : « c'est parti » n'est pas « ça marche ».

```
  Oathrion répond sur  http://127.0.0.1:5000
  Console            http://127.0.0.1:5000/console
  PostgreSQL          127.0.0.1:55433
```

La base est **vide** (`OATHRION_SEED=`) : vous voyez la vôtre, pas une démonstration.

```bash
npm run pilot:logs    # suivre
npm run pilot:down    # arrêter — les données sont CONSERVÉES
npm run pilot:destroy # arrêter ET SUPPRIMER le volume de données (irréversible)
```

> Cette pile **n'est pas une configuration de production** : pas de TLS, PostgreSQL
> publié sur la boucle locale, secrets sur le disque. Pour un client, c'est
> `deploy/docker-compose.yml` avec un domaine — voir `deploy/README.md`.

## 2. Vérifier que la sécurité est active

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:5000/api/agents         # 401
curl -s -o /dev/null -w '%{http_code}\n' -H 'Authorization: Bearer faux' \
  http://127.0.0.1:5000/api/agents                                                # 401
```

Puis, avec une clé `viewer` créée depuis la console, une écriture répond **403** : le RBAC
est `requireCapability` sur chaque route, pas une étiquette.

## 3. Valider le produit sans client

Chaque commande démarre ce dont elle a besoin et refuse de passer en silence.

```bash
npm run build

# le pare-feu, devant une API cible qui enregistre ce qu'elle reçoit
DATABASE_URL=postgres://… npm run verify:intercept      # 41/41

# le registre d'outils déclaré et la vérification de schéma
DATABASE_URL=postgres://… npm run verify:tools          # 49/49

# le relais MCP contre un serveur qui n'importe rien d'Oathrion
DATABASE_URL=postgres://… npm run verify:mcp            # 37/37

# les refus de démarrage, un réglage dangereux à la fois
DATABASE_URL=postgres://… npm run verify:prod-config    # 41/41

# la pile de production complète, TLS compris
npm run verify:compose                                  # 20/20

# les 27 propriétés, et les 25 mutants qui les mordent
npm run conformance -- --mutants
```

Un `DATABASE_URL` est nécessaire pour les scripts qui démarrent le bundle. En local :

```bash
docker run -d --name pg -e POSTGRES_PASSWORD=verify -p 55432:5432 postgres:17
export DATABASE_URL=postgres://postgres:verify@127.0.0.1:55432/postgres
```

> **La version majeure n'est pas un détail.** `postgres:17` est celle que
> `deploy/docker-compose.yml` épingle, et ce n'est pas une préférence : `pg_dump` et
> `pg_restore` sont compatibles **vers l'avant seulement**. Une sauvegarde prise sur un
> PostgreSQL 17 ne se restaure pas sur un 16 — l'erreur est
> `pg_restore: error: unsupported version (1.16) in file header`, et elle arrive le jour
> où l'on n'a plus que la sauvegarde. Cette page recommandait `postgres:16-alpine`, et
> `verify:dr` démarrait sa machine de remplacement en 16 : l'exercice de reprise échouait
> donc à la restauration. Il lit désormais la version dans le compose, et il n'y a plus
> qu'un endroit où elle est déclarée.

## 3bis. La démonstration de cinq minutes

```bash
npm run build
npm run demo
```

Une commande, et la chaîne complète : un faux fournisseur local, une base PostgreSQL
jetable, et le **bundle de production** d'Oathrion devant. Elle passe deux appels
identiques à un montant près, puis affiche ce que le fournisseur a reçu.

Le résultat attendu, en entier :

```
  POST /v1/refunds  amount=7500  (75 €)
    → HTTP 200   x-oathrion-decision: ALLOW

  POST /v1/refunds  amount=45000 (450 €)
    → HTTP 403   x-oathrion-decision: BLOCK

  requêtes arrivées chez le fournisseur : 1
```

**C'est le fournisseur qui sert de témoin.** Deux appels sont partis de l'agent, un seul
est arrivé — et le fournisseur, dans cette démonstration, ne refuse rien par lui-même.
La seule chose qui a décidé est Oathrion.

Ce que la démonstration **n'établit pas**, et qu'elle écrit elle-même à l'écran :
l'injection du credential est rapportée par Oathrion, pas par le témoin — le faux
fournisseur de ce dépôt n'enregistre pas les en-têtes reçus. Cette propriété est prouvée
par `npm run verify:intercept` et `destination-credential.test.ts`, contre le credential
réellement présenté.

La base jetable et les deux serveurs sont détruits à la fin, y compris en cas d'échec.

## 4. La suite de tests

```bash
npm test                      # 2300+ tests, aucun accès réseau sortant
bash script/run-suite-per-file.sh   # un fichier par processus : un blocage est attribué
```

Le second est la façon de la maison : `vitest run` exécute tout dans un worker, donc un
fichier qui pend arrête la suite sans dire lequel.

## 5. Première action gouvernée

1. Console → **Agents** → déclarez votre agent, avec sa portée de permission et son mandat.
2. Console → **Politiques** → au moins une règle.
3. Console → **Couverture** → elle liste ce qui bloque encore, dans l'ordre.
4. Console → **Politiques → bac à sable** → essayez une action autorisée, une bloquée.
5. Console → **Pare-feu** → le journal et les approbations en attente.

Pour brancher un agent existant : `docs/CONNECT-EXISTING-AGENT.md`.
