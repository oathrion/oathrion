#!/usr/bin/env bash
# Restaure un dump dans une base VIDE, puis dit à quelle version de schéma elle est.
# Refuse de toucher une base qui porte déjà des tables : pas d'écrasement accidentel.
#
#   TARGET_URL=postgres://.../oathrion_restored ./restore.sh /var/backups/placet/placet-XXXX.dump
#   OATHRION_PG_CONTAINER=placet-postgres TARGET_URL=... ./restore.sh <fichier>
#
# Avec un conteneur, `TARGET_URL` doit être joignable DEPUIS LUI. Voir `pg-run.sh`.
#
# Ensuite, DANS CET ORDRE : pointez `DATABASE_URL` sur la base restaurée, appliquez les
# migrations en attente (`node dist/migrate.cjs`), PUIS démarrez Oathrion.
#
# Cet en-tête disait « redémarrez Oathrion, qui applique les migrations en attente au
# démarrage ». C'est FAUX : Oathrion refuse de démarrer sur un schéma en attente, en nommant
# les deux versions et la commande à lancer. Un exploitant qui suivait cette phrase
# restaurait, démarrait, et obtenait un processus qui refuse — sans que rien ne relie le
# refus à l'étape manquante. Constaté par `npm run verify:upgrade`.
#
# Oathrion refuse aussi un schéma PLUS RÉCENT que le sien, ce qui rend sûr le redéploiement
# d'une version antérieure : voir docs/OPERATIONS.md §8bis.
set -euo pipefail
# shellcheck source=pg-run.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-run.sh"

dump="${1:?usage: TARGET_URL=postgres://... restore.sh <fichier.dump>}"
: "${TARGET_URL:?set TARGET_URL (une base vide)}"
[[ -f "$dump" ]] || { echo "introuvable : $dump" >&2; exit 1; }

pg_run_check

# L'empreinte d'abord : restaurer un dump corrompu dans une base de secours pendant un
# incident est la pire façon de découvrir qu'il l'était.
if [[ -f "$dump.sha256" ]]; then
  sha256sum -c "$dump.sha256"
else
  echo "avertissement : aucune empreinte à côté de $dump" >&2
fi

tables=$(pg_run psql "$TARGET_URL" -Atc \
  "select count(*) from information_schema.tables where table_schema='public'")
if [[ "${tables//[$'\r\n ']/}" != "0" ]]; then
  echo "refus : la base cible n'est pas vide ($tables tables). Restaurez dans une base neuve." >&2
  exit 1
fi

start=$(date +%s)
pg_run pg_restore --no-owner --exit-on-error -d "$TARGET_URL" < "$dump"
version=$(pg_run psql "$TARGET_URL" -Atc 'select max(version) from schema_migrations')
echo "restauré en $(( $(date +%s) - start )) s ; version de schéma : ${version//[$'\r\n ']/}"
