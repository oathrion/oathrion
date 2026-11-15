# Astreinte Oathrion — la page de 3 h du matin

Ce document se lit **réveillé en pleine nuit**. Il est donc écrit dans cet ordre : le
symptôme qu'on vient de voir, la commande qui dit ce qui se passe, et ce qu'on fait.

Il ne contient aucun conseil qui n'ait été éprouvé par une commande de ce dépôt. La
colonne « preuve » de chaque section nomme le banc qui l'a provoqué pour de vrai.

---

## 0. Les quatre signaux, et aucun autre

Quatre choses justifient de réveiller quelqu'un. Tout le reste attend le matin.

| | Signal | Ce que ça veut dire | Alerte |
|---|---|---|---|
| **1** | `oathrion_ready == 0` sur toutes les instances | plus personne ne sert de trafic | immédiate |
| **2** | une chaîne de reçus est rompue | corruption, ou écriture hors d'Oathrion | immédiate |
| **3** | aucune sauvegarde récente | une panne matérielle ordinaire devient une perte définitive | sous 1 h |
| **4** | le magasin de quotas est injoignable | en `closed` : du trafic légitime est refusé · en `open` : la protection anti-force-brute a disparu | sous 15 min |

Le signal 3 est une **absence**, et c'est le seul qui ne se déclenche jamais tout seul :
une sauvegarde qui échoue bruyamment se remarque, celle qui n'a jamais été lancée ne
produit aucun événement. Voir §4.

---

## 1. Brancher la supervision

### La page de métriques

```bash
# Dans l'environnement d'Oathrion
OATHRION_METRICS_TOKEN=$(openssl rand -hex 32)
```

Puis, côté collecteur :

```yaml
scrape_configs:
  - job_name: placet
    metrics_path: /api/metrics
    authorization:
      type: Bearer
      credentials: "<le même jeton>"
    static_configs:
      - targets: ["placet.interne:5000"]
```

Trois choses à savoir avant de la câbler :

- **Sans la variable, la route n'est pas montée.** `/api/metrics` répond alors exactement
  ce que répond n'importe quelle URL inexistante — 401 sans credential, 404 avec. Si
  votre collecteur voit un 401, la première chose à vérifier est la variable, pas le
  proxy. La ligne de démarrage le dit : `metrics: page NOT MOUNTED`.
- **Un jeton de moins de 32 caractères refuse le démarrage.** Un jeton court n'est pas
  une protection faible : c'est une protection qui en a l'air, et la page qu'elle garde
  décrit tout le trafic du déploiement.
- **Aucune série ne porte d'identifiant de locataire.** Ni pour la cardinalité, ni pour
  la discrétion : une étiquette par client livrerait la liste de vos clients, et leur
  volume d'affaires, à quiconque lit un tableau de bord. Pour les chiffres **d'un**
  client, voir §6.

### Les deux contrôles périodiques

Oathrion ne peut pas se surveiller lui-même sur ces deux points — l'un porte sur des
fichiers qu'il ne voit pas, l'autre serait un auto-contrôle. Deux lignes de cron :

```cron
# Fraîcheur des sauvegardes — toutes les 15 minutes
*/15 * * * *  BACKUP_DIR=/var/backups/placet MAX_AGE_HOURS=26 /opt/placet/deploy/scripts/check-backup-freshness.sh --prometheus > /var/lib/node_exporter/textfile/placet-backup.prom.tmp && mv /var/lib/node_exporter/textfile/placet-backup.prom{.tmp,}

# Intégrité des chaînes de reçus — toutes les heures
17 * * * *    cd /opt/placet && DATABASE_URL=... npm run audit:chains -- --prometheus > /var/lib/node_exporter/textfile/placet-chains.prom.tmp && mv /var/lib/node_exporter/textfile/placet-chains.prom{.tmp,}
```

L'écriture passe par un `.tmp` puis un `mv` : le collecteur lit ces fichiers en continu,
et il lirait un fichier à moitié écrit sans s'en plaindre.

### Les alertes qui correspondent

```yaml
groups:
  - name: placet
    rules:
      - alert: OathrionToutesInstancesIndisponibles
        expr: max(oathrion_ready) == 0
        for: 2m

      - alert: OathrionChaineDeRecusRompue
        expr: min(oathrion_receipt_chain_ok) == 0
        for: 0m          # aucune tolérance : ce n'est pas un incident transitoire

      - alert: OathrionAuditDeChaineMuet
        expr: time() - oathrion_receipt_chain_audit_timestamp_seconds > 7200
        for: 0m          # l'audit lui-même ne tourne plus

      - alert: OathrionAucuneSauvegardeRecente
        expr: oathrion_backup_fresh == 0 or absent(oathrion_backup_fresh)
        for: 10m

      - alert: OathrionMagasinDeQuotasInjoignable
        expr: increase(oathrion_rate_limit_outcomes_total{outcome="store_unavailable"}[5m]) > 0
        for: 0m

      - alert: OathrionLimiteurOuvert
        expr: oathrion_rate_limit_fail_closed == 0
        for: 0m          # légal, mais personne ne doit l'apprendre pendant un incident

      - alert: OathrionEtiquetteHorsListe
        expr: increase(oathrion_metric_label_violations_total[1h]) > 0
        for: 0m          # un défaut de la supervision elle-même
```

Deux remarques sur ces règles, et elles valent plus que les règles :

**`absent()` et `== 0` ne sont pas la même alerte.** `OathrionAucuneSauvegardeRecente`
teste les deux, parce qu'un fichier de métriques jamais écrit ne vaut pas mieux qu'une
sauvegarde absente. Côté Oathrion, le problème ne se pose pas : la page émet **toutes** ses
séries, y compris à zéro, précisément pour que `== 0` suffise.

**`OathrionAuditDeChaineMuet` surveille le surveillant.** Sans elle, un cron désactivé
laisserait `oathrion_receipt_chain_ok` à sa dernière valeur — `1` — indéfiniment, et le
tableau de bord resterait vert pendant que plus rien n'est vérifié.

---

## 2. SIGNAL 1 — « plus rien ne répond »

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://votre-placet/api/live    # le processus
curl -s https://votre-placet/api/ready | jq .                             # la dépendance
```

| Ce que vous voyez | Ce que c'est | Ce que vous faites |
|---|---|---|
| `live` 200, `ready` 503, `database.ok: false` | PostgreSQL est tombé | réparez la base. **Oathrion n'a rien perdu** : il refuse d'autoriser plutôt que de deviner, et redevient prêt **sans redémarrage** |
| `live` 200, `ready` 503, `accepting.ok: false` | arrêt gracieux en cours | normal pendant un déploiement. Si ça dure : quelque chose empêche le drain de finir |
| `live` ne répond pas | le processus est mort | le superviseur doit le relancer. S'il boucle, lisez la **première** ligne du journal : une configuration invalide refuse de démarrer **en nommant la variable** |
| `oathrion_uptime_seconds` se réinitialise sans cesse | boucle de redémarrage | idem — c'est presque toujours une variable d'environnement |

> **Ne restaurez pas une sauvegarde pour une base indisponible.** Une base qui ne répond
> pas n'est pas une base perdue, et restaurer par-dessus détruirait ce qu'elle contient
> encore.

*Preuve : `npm run chaos:postgres` (15/15) arrête réellement PostgreSQL sous une instance
vivante et vérifie la reprise sans redémarrage.*

---

## 3. SIGNAL 2 — « une chaîne de reçus est rompue »

```bash
DATABASE_URL=... npm run audit:chains
```

Codes de sortie : `0` toutes les chaînes tiennent · `1` au moins une est rompue · `2`
impossible de vérifier. **Le 2 n'est pas un verdict favorable.**

La sortie nomme le locataire, la position, et le reçu :

```
✗ org_7xez3j2dt8zjfqfsoiko — 2 reçus — ROMPUE au n°1 : content: le contenu du reçu
  "rcpt_331791be…" a changé depuis son écriture
```

Quatre défauts sont distingués, parce qu'ils ne se diagnostiquent pas pareil :

| Motif | Ce qui s'est passé |
|---|---|
| `content` | **le reçu nommé** a été modifié après son écriture |
| `link` | le `prevHash` ne nomme pas son prédécesseur : la suite a été réécrite |
| `sequence` | un trou ou un doublon : un reçu a été retiré ou inséré |
| `genesis` | le premier reçu ne part pas du point de départ de ce locataire |

### Le coût de cette vérification, mesuré

`verifyReceiptChain` est en **O(n)** sur les reçus du locataire, et rien ne purge les
reçus (`docs/limitations.md` : « aucune purge automatique »). Donc ce coût **grandit pour
toujours**.

Mesuré par `npm run verify:soak` sur un passage de 12 minutes, qui a produit 11 631
reçus :

| Reçus du locataire | Durée d'une vérification |
|---|---|
| 1 | 16 ms — **mesuré** |
| 11 220 | 251 ms — **mesuré** |
| 100 000 | ~2,2 s — extrapolé |
| 1 000 000 | **~22 s** — extrapolé |

La pente mesurée est de **~22 µs par reçu**, et elle est bien linéaire sur toute la
plage observée. Les deux dernières lignes sont une extrapolation de cette pente, pas une
mesure : elles sont marquées comme telles.

Conséquence pratique : le passage horaire de `audit:chains` reste confortable jusqu'à
quelques centaines de milliers de reçus par locataire. Au-delà, espacez-le — et sachez
que `GET /api/actions/receipts/verify`, que **le client** appelle, porte le même coût sur
une requête HTTP. Un relevé isolé est monté à 496 ms là où la tendance donnait 250 ms :
prévoyez de la marge, et mesurez sur une copie de votre volume réel plutôt que de croire
ce tableau, qui vient d'une machine de test.

**La vérification par étapes** (`GET /api/actions/receipts/verify?mode=incremental`,
migration 29) reprend au point de la dernière vérification réussie. Elle vérifie que
l'**ancre**, le dernier reçu déjà vérifié, est intacte, et ne relit que ce qui a été écrit
depuis. Mesuré sur une chaîne de 300 000 reçus : **3,4 s en complet, 3,5 ms par étapes**
après 100 reçus de plus (journal §5.35). Sans point de reprise, elle fait une
vérification complète, et sa réponse le dit (`mode: "full"`).

Sa limite, éprouvée par `receipt-chain-incremental.test.ts` : elle **ne voit pas** une
modification d'un reçu plus ancien que l'ancre. La réponse donne
`lastFullVerification`, la date de la dernière vérification COMPLÈTE réussie. Gardez donc
les deux : la vérification par étapes aussi souvent que vous le voulez, et une
vérification complète planifiée (`audit:chains`, ou la route sans paramètre) chaque nuit
ou chaque semaine selon le volume.

### Ce qu'il faut faire, dans cet ordre

1. **Ne réécrivez rien, ne restaurez rien par-dessus.** L'état actuel est une pièce.
2. Prenez un `pg_dump` **maintenant**, et mettez-le de côté séparément des sauvegardes
   tournantes (la rétention l'effacerait).
3. Cherchez qui a écrit : les journaux d'accès PostgreSQL, puis l'audit applicatif.
4. Décidez **avec le client** : une chaîne rompue est un fait qui le concerne, et sa
   route `GET /api/actions/receipts/verify` le lui dira de toute façon.

> Une rupture **n'est pas une panne de disponibilité**. Oathrion continue de servir. Le
> réflexe « redémarrer pour voir » ne répare rien ici et détruit du contexte.

### Les limites de ce que la chaîne prouve

La chaîne rend la **modification, la suppression et la réorganisation** détectables. Elle
n'arrête pas quelqu'un qui a un accès en écriture à la base et qui **recalcule toute la
chaîne** — il n'existe pas de défense cryptographique contre cela sans une ancre
extérieure (signature par une clé hors base, ou publication périodique des têtes).

Ce qu'elle couvre, en revanche : **les seize champs du reçu, résumé lisible compris.**
`result_summary` — « Remboursement de 25 émis (ref_…) », la ligne qu'un auditeur lit en
premier — était hors de l'empreinte jusqu'au renommage ARIA → Placet, ce qui permettait de la
réécrire sans rompre la chaîne. Elle y est désormais, et `verify:obs` le vérifie en la
falsifiant en base.

*Preuve : `npm run verify:obs` falsifie un reçu en base (`failed` réécrit en `succeeded`)
et exige que l'audit sorte 1 — après avoir exigé qu'il sorte 0 sur la même base intacte.*

---

## 4. SIGNAL 3 — « aucune sauvegarde récente »

```bash
BACKUP_DIR=/var/backups/placet ./deploy/scripts/check-backup-freshness.sh
```

`0` un dump récent existe et son empreinte concorde · `1` aucun, trop vieux, ou empreinte
fausse · `2` impossible de regarder.

| Ce que vous lisez | Ce que c'est |
|---|---|
| `AUCUNE SAUVEGARDE` | ce n'est pas « la dernière a échoué ». Vérifiez que l'unité ou la ligne de cron **existe encore** : c'est la panne qui survit le plus souvent à un changement de machine |
| `TROP VIEUX` | lancez `backup.sh` à la main **d'abord**, cherchez la cause ensuite |
| `EMPREINTE ABSENTE OU DIFFÉRENTE` | un dump tronqué est **pire** qu'un dump absent : il ressemble à une sauvegarde |
| sortie `2` | le répertoire n'existe pas ou n'est pas lisible par l'utilisateur du cron |

Et la seule chose qui transforme une sauvegarde en restauration : **l'avoir essayée**.
Un exercice de restauration par mois, dans une base neuve, est la différence entre un
fichier et un plan de reprise. La procédure est dans
[`OPERATIONS.md`](OPERATIONS.md) §3.

*Preuve : `npm run verify:backup` (21/21) exécute les scripts réels, restaure dans une
base neuve, et vérifie que la chaîne de reçus retrouve la même tête qu'avant.*

---

## 5. SIGNAL 4 — « le magasin de quotas est injoignable »

```promql
increase(oathrion_rate_limit_outcomes_total{outcome="store_unavailable"}[5m]) > 0
```

```bash
curl -s https://votre-placet/api/ready | jq .      # la base, elle, va peut-être bien
```

Les deux jauges sont séparées exprès : `oathrion_database_reachable` et
`oathrion_rate_limit_store_reachable` peuvent diverger, et savoir laquelle est tombée est la
moitié du diagnostic.

| Posture | Ce qui se passe | Urgence |
|---|---|---|
| `oathrion_rate_limit_fail_closed == 1` (défaut) | les routes limitées répondent **503** avec un `Retry-After`. Pas 429 : le quota n'est pas épuisé, le compteur est injoignable — dire au client de ralentir serait faux | du trafic légitime est refusé |
| `oathrion_rate_limit_fail_closed == 0` | les requêtes passent — **y compris les tentatives de connexion**. La protection anti-force-brute a disparu sans que rien ne le dise | traitez-le comme un incident de sécurité |

> **`oathrion_rate_limit_store_reachable` ne sonde rien.** Elle rapporte ce que le limiteur a
> constaté au **dernier** passage. Sans trafic, elle garde sa valeur — et un scrape ne la
> rafraîchit pas, puisque `/api/metrics` est une sonde et ne traverse pas le limiteur.
> C'est pourquoi l'alerte porte sur `increase(...)` du compteur, et pas sur la jauge.

*Preuve : `npm run verify:obs` renomme la table du limiteur sous une instance vivante,
vérifie le 503, le compteur, la jauge, et la remontée sans redémarrage.*

---

## 6. « Et pour UN client en particulier ? »

Cette page est à l'échelle du **déploiement**. Les chiffres d'un locataire se lisent sur
ses propres routes, avec un credential de son organisation — il n'existe volontairement
aucune route qui parcoure tous les clients :

```bash
curl -s "$BASE/api/usage"                    -H "Authorization: Bearer $TOKEN"  # quotas
curl -s "$BASE/api/actions/receipts/verify"  -H "Authorization: Bearer $TOKEN"  # sa chaîne
curl -s "$BASE/api/actions/receipts"         -H "Authorization: Bearer $TOKEN"  # ses reçus
```

Côté exploitant, `npm run audit:chains` voit tous les locataires — parce qu'il lit la
base, que vous possédez, et non une API.

---

## 7. Lire la page de métriques à la main

```bash
curl -s https://votre-placet/api/metrics -H "Authorization: Bearer $OATHRION_METRICS_TOKEN"
```

Les quelques séries qui servent le plus souvent :

| Série | Ce qu'elle répond |
|---|---|
| `oathrion_action_decisions_total{decision}` | le produit décide-t-il encore ? un effondrement d'`allow` est un incident client |
| `oathrion_action_refusals_total{code}` | **la plus utile.** Un flot d'`agent_mismatch` est une intégration qui présente le grant d'un autre agent ; un flot de `grant_expired` est une horloge ou un TTL trop court ; `race_lost` en masse veut dire que deux processus présentent le même grant |
| `oathrion_downstream_calls_total{outcome}` | `business_error` = **le client refuse** (normal) · `transport_error` = **le réseau ou le fournisseur est tombé** (pas normal). Les confondre fait chercher une panne là où il y a un refus légitime |
| `oathrion_auth_failures_total{reason}` | `missing_credential` en masse = une intégration mal déployée · `invalid_credential` en masse = une clé révoquée encore en service, ou quelqu'un qui essaie |
| `oathrion_http_responses_total{surface,class}` | où ça casse, sans jamais exposer un chemin d'URL ni un identifiant |

### Ce que la page ne dit pas, et ne dira pas

- **Aucune latence, aucun quantile.** Un histogramme utile exige des tranches choisies
  d'après une distribution mesurée sur une charge réelle ; celle d'Oathrion ne l'est pas. Des
  tranches inventées produiraient des quantiles d'allure crédible et sans fondement. Ce
  qui est connu, c'est le plafond : une instance tient environ **90–190 requêtes
  authentifiées par seconde**, parce que le plan d'identité passe par un pont synchrone
  sur une seule connexion. Voir [`COMMERCIAL_READINESS.md`](COMMERCIAL_READINESS.md).
- **Aucun identifiant de locataire**, d'agent, de clé, de reçu ou de chemin d'URL. C'est
  une contrainte de construction du registre, pas une discipline : une valeur d'étiquette
  hors de l'ensemble déclaré est rangée dans `other` et comptée dans
  `oathrion_metric_label_violations_total`.
- **Aucune trace distribuée.** Les journaux portent un `requestId` par requête, et c'est
  la corrélation disponible aujourd'hui.

---

## 8. Ce qui n'a pas d'astreinte

Dit ici pour que personne ne l'apprenne en cherchant la procédure à 3 h du matin.

| | État |
|---|---|
| Bascule automatique vers une autre région | **n'existe pas.** Un pilote est mono-région |
| Archivage WAL (RPO de quelques secondes) | **non implémenté par Oathrion** — c'est à votre PostgreSQL (pgBackRest, WAL-G, ou un service managé). Avec le dump horaire seul, le RPO est **d'une heure** |
| Restauration sur une **autre** machine | procédure éprouvée sur la même machine ; **non testée** ailleurs |
| Ancre extérieure des chaînes de reçus | **non implémentée.** Voir §3 |
