#!/usr/bin/env bash
# Comment les commandes client PostgreSQL sont exécutées — une seule indirection,
# partagée par backup.sh et restore.sh.
#
# POURQUOI CE FICHIER EXISTE
#
# Les deux scripts appelaient `pg_dump`, `pg_restore` et `psql` directement. Or le kit
# de déploiement n'installe aucun de ces outils : l'image Oathrion est `node:20-slim`, et
# l'hôte d'un `docker compose up` n'a aucune raison de porter `postgresql-client`. Les
# deux scripts échouaient donc sur « pg_dump : commande introuvable ».
#
# `backup.sh` avait bien un mode `COMPOSE=1`… qui appelait quand même `pg_restore --list`
# sur l'hôte juste après. À moitié fait, donc cassé de la même façon.
#
#   (par défaut)              binaires de l'hôte
#   OATHRION_PG_CONTAINER=<nom>   dans ce conteneur (docker exec)
#   COMPOSE=1                 dans le service « postgres » du compose
#
# IMPORTANT — l'URL doit être joignable DEPUIS L'ENDROIT OÙ LE CLIENT TOURNE. Avec un
# conteneur, `127.0.0.1:5432` désigne le serveur lui-même ; le port publié sur l'hôte
# (souvent 55432) n'y existe pas. C'est la seule subtilité, et elle est répétée dans
# l'aide des deux scripts.
#
# `-i` et non `-it` : ces scripts tournent sous cron, sans terminal attaché.
#
# COMPATIBILITÉ DU RENOMMAGE, ET LE TROU QU'ELLE BOUCHE
#
# `server/env-compat.ts` honore les variables `PLACET_*` héritées — mais il ne tourne que
# dans le processus Node. Ces scripts shell lisent l'environnement eux-mêmes, donc la
# promesse de compatibilité s'arrêtait net à la frontière des langages : un exploitant
# dont le cron pose `PLACET_PG_CONTAINER` voyait sa sauvegarde échouer après la mise à
# jour, avec un message parlant d'un conteneur introuvable et rien qui mentionne le
# renommage. Trouvé parce que `verify:backup` est passé de 21/21 à 5/6.
#
# Le nom courant gagne, exactement comme côté Node.
PG_CONTAINER="${OATHRION_PG_CONTAINER:-${PLACET_PG_CONTAINER:-}}"
if [[ -z "${OATHRION_PG_CONTAINER:-}" && -n "${PLACET_PG_CONTAINER:-}" ]]; then
  echo "[oathrion] PLACET_PG_CONTAINER est obsolète ; renommez-la en OATHRION_PG_CONTAINER." >&2
fi

pg_run() {
  if [[ -n "$PG_CONTAINER" ]]; then
    docker exec -i "$PG_CONTAINER" "$@"
  elif [[ "${COMPOSE:-0}" == "1" ]]; then
    docker compose exec -T postgres "$@"
  else
    "$@"
  fi
}

# Échoue tôt, avec une raison nommée, plutôt qu'au milieu d'une sauvegarde.
pg_run_check() {
  if ! pg_run pg_dump --version > /dev/null 2>&1; then
    echo "les outils client PostgreSQL sont introuvables." >&2
    if [[ -n "$PG_CONTAINER" ]]; then
      echo "  conteneur « $PG_CONTAINER » : inexistant, arrêté, ou sans pg_dump." >&2
    elif [[ "${COMPOSE:-0}" == "1" ]]; then
      echo "  service compose « postgres » : lancez depuis le répertoire du compose." >&2
    else
      echo "  sur l'hôte : installez postgresql-client, ou passez par le conteneur" >&2
      echo "  (OATHRION_PG_CONTAINER=<nom>, ou COMPOSE=1 depuis deploy/)." >&2
    fi
    exit 2
  fi
}
