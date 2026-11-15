# Runbook — incidents, sauvegardes, révocation, rollback

Ce document est fait pour être lu à 3 h du matin. Chaque section commence par la commande.

---

## Sondes

| | |
|---|---|
| `GET /api/live` | le processus répond. **200 même base coupée.** |
| `GET /api/ready` | la base répond. **503 quand elle est coupée**, et 200 à nouveau **sans redémarrage** |
| `GET /metrics` | compteurs Prometheus. Protégé par `OATHRION_METRICS_TOKEN` |

Un orchestrateur doit sonder `/api/ready` avant d'envoyer du trafic, et `/api/live` pour
décider de redémarrer. Les confondre fait redémarrer un processus sain dont la base est
momentanément absente — vérifié par `verify:compose`.

---

## « Oathrion répond 503 »

1. `npm run pilot:logs` ou `docker compose logs placet`.
2. `GET /api/live` → si 200, le processus vit et c'est la base.
3. Vérifier PostgreSQL : `docker compose ps`, `pg_isready`.
4. La base revenue, `/api/ready` repasse à 200 **tout seul**. Ne redémarrez pas Oathrion.

---

## « Oathrion refuse de démarrer »

**C'est le comportement voulu.** Le message nomme la variable manquante. Les refus
possibles sont tous énumérés et vérifiés par `npm run verify:prod-config` (41 cas).

Les plus fréquents : `OATHRION_SESSION_SECRET` absent ou de démonstration ·
`DATABASE_URL` sans `DATABASE_DRIVER=postgres` · `OATHRION_IDENTITY_PLANE` non déclaré ·
`RATE_LIMIT_STORE=memory` en production · une entrée de `OATHRION_DESTINATIONS` sans
`organizations` · une règle de `OATHRION_INTERCEPTS` nommant un verbe hors catalogue.

**Ne contournez pas en désactivant la vérification.** Chaque refus correspond à une faute
qui, passée, se révélerait à la première requête d'un client.

---

## Sauvegarde

```bash
bash deploy/scripts/backup.sh                    # dump chiffré
bash deploy/scripts/check-backup-freshness.sh    # échoue si la dernière est trop vieille
npm run verify:backup                            # prouve qu'une restauration donne la même base
```

La fraîcheur est vérifiée par un script et non par une habitude : une sauvegarde dont
personne ne constate l'âge est une sauvegarde qu'on découvre absente le jour où on en a
besoin.

## Restauration

```bash
bash deploy/scripts/restore.sh <fichier>
npm run verify:dr        # reprise après sinistre, de bout en bout
```

---

## Révoquer un credential de fournisseur

**Dans Oathrion** : Console → **Connecteurs** → *Déconnecter*. L'enveloppe est écrasée, la
ligne passe à `revoked`, et toute action suivante est refusée avec
`connector_not_connected`.

**Chez le fournisseur** : Oathrion **ne peut pas** invalider un jeton d'accès personnel —
aucune API ne le permet à un tiers. L'API répond `remoteStillValid: true` et la console
l'affiche en rouge. **Allez supprimer le jeton chez le fournisseur**
(<https://github.com/settings/tokens> pour GitHub). Tant que ce n'est pas fait, le jeton
reste utilisable par quiconque le détient.

**Si le credential est dans l'environnement** (`OATHRION_INTERCEPT_KEY_*`) : il faut
modifier la variable et redémarrer. C'est une des raisons de préférer le coffre.

## Rotation de la clé de chiffrement

1. nouvelle clé en `OATHRION_KEK`, nouveau `OATHRION_KEK_ID` ;
2. l'ancienne en `OATHRION_KEK_<ancien id>`, listée dans `OATHRION_KEK_RETIRED_IDS` ;
3. redémarrer — les anciens enregistrements restent lisibles ;
4. réemballer à loisir (`rewrap`).

Ne retirez une clé de `OATHRION_KEK_RETIRED_IDS` qu'après avoir réemballé : un
enregistrement dont la clé a disparu est perdu.

---

## Révoquer un accès humain ou un agent

| | |
|---|---|
| Session console | Console → Paramètres → sessions → révoquer. Effet **immédiat** : `resolveBearer` relit `revoked_at` à chaque appel |
| Clé d'API | Console → clés → révoquer |
| Agent | passer son statut à `paused` : ses actions sont refusées |
| Organisation entière | `organizationStore.setActive(false)` — les jetons sont refusés |

---

## Effacer un locataire

```bash
npm run tenant:export -- --organization=org_…    # D'ABORD : après, il n'y a plus rien
npm run tenant:purge -- --organization=org_… --confirm="<nom exact>" --by=… --reason=…
```

Quatre verrous : le locataire doit être **inactif**, la confirmation est son **nom**,
`--confirm` est obligatoire, et le registre d'effacement est écrit **avant** les
suppressions. Le coffre de credentials part avec — vérifié par `verify:erasure`.

**Irréversible.** La chaîne de reçus part aussi : après, vous ne pouvez plus montrer ce
que ce client a fait, seulement qu'un effacement a eu lieu.

---

## Rollback

```bash
npm run verify:upgrade     # prouve qu'une montée de version et son retour tiennent
```

Oathrion **refuse de démarrer sur un schéma plus récent que lui** : revenir à une version
antérieure après une migration exige de restaurer une sauvegarde d'avant. C'est une
limite réelle, pas un oubli — laisser un binaire ancien écrire dans un schéma neuf est la
façon la plus courante de corrompre une base.

Ordre d'un rollback : arrêter → restaurer la sauvegarde d'avant la migration → déployer
l'image précédente → vérifier `/api/ready`.

---

## Journaux

Structurés, sans secrets : `server/log-redaction.ts` rédige les credentials, et
`log-redaction.test.ts` l'assied. Chaque requête porte un identifiant de corrélation,
rendu dans l'en-tête et dans le corps des erreurs — citez-le dans un ticket.

---

## Escalade

1. `GET /api/ready` et `/api/live` — distinguer « base » de « processus ».
2. Journaux des 15 dernières minutes, avec l'identifiant de corrélation.
3. `GET /metrics` : `oathrion_action_decisions_total`, `oathrion_action_refusals_total`,
   `oathrion_intercept_refusals_total`.
4. Console → **Couverture** : ce qui est gouverné, et les échecs d'exécution.
5. Si une action a atteint un fournisseur alors qu'elle aurait dû être bloquée :
   **arrêtez le pilote**, conservez les journaux, et lisez
   `docs/SECURITY-BOUNDARIES.md` §2 — il est probable que l'agent détienne un credential
   direct.
