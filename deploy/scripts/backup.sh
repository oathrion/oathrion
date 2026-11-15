#!/usr/bin/env bash
# Sauvegarde à chaud, cohérente, de la base Oathrion (pg_dump format custom) + rétention.
#
#   DATABASE_URL=postgres://... BACKUP_DIR=/var/backups/placet RETENTION_DAYS=14 ./backup.sh
#   OATHRION_PG_CONTAINER=placet-postgres ./backup.sh        # via un conteneur
#   COMPOSE=1 ./backup.sh                              # depuis le répertoire du compose
#
# Avec un conteneur, `DATABASE_URL` doit être joignable DEPUIS LUI : `127.0.0.1:5432`,
# et non le port publié sur l'hôte. Voir `pg-run.sh`.
#
# RPO = l'intervalle entre deux exécutions (cron horaire → ≤ 1 h). Pour descendre plus
# bas, l'archivage WAL de PostgreSQL (pgBackRest / WAL-G) — voir docs/OPERATIONS.md.
set -euo pipefail
# shellcheck source=pg-run.sh
source "$(dirname "${BASH_SOURCE[0]}")/pg-run.sh"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/placet}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
: "${DATABASE_URL:?set DATABASE_URL}"

pg_run_check

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# Un suffixe aléatoire en plus de l'horodatage. Le nom était à la seconde près, donc
# DEUX SAUVEGARDES DANS LA MÊME SECONDE S'ÉCRASAIENT en silence — une sauvegarde manuelle
# lancée juste après un passage de cron, par exemple, et il n'en restait qu'une. Trouvé
# par `npm run verify:backup`, qui en prend deux coup sur coup.
out="$BACKUP_DIR/placet-$(date -u +%Y%m%dT%H%M%SZ)-$(od -An -N3 -tx1 /dev/urandom | tr -d ' \n').dump"
tmp="$out.partial"

# Et, par sécurité, jamais d'écrasement : un fichier de sauvegarde qui en remplace un
# autre est une perte, pas une mise à jour.
[[ -e "$out" ]] && { echo "refus : $out existe déjà" >&2; exit 1; }

# Le `.partial` est retiré si quoi que ce soit échoue : un fichier tronqué dans un
# répertoire de sauvegardes est pire que pas de fichier du tout, parce qu'il ressemble
# à une sauvegarde.
cleanup_partial() { rm -f "$tmp"; }
trap cleanup_partial EXIT

pg_run pg_dump -Fc --no-owner -d "$DATABASE_URL" > "$tmp"

# Un dump que pg_restore ne sait pas lister n'est pas une sauvegarde. Lu sur l'entrée
# standard : le fichier est sur l'hôte, et le client peut tourner dans un conteneur.
pg_run pg_restore --list < "$tmp" > /dev/null

mv "$tmp" "$out"
trap - EXIT
chmod 600 "$out"
sha256sum "$out" > "$out.sha256"

# La rétention s'applique aux dumps ET à leurs empreintes, jamais à autre chose.
# LES DEUX PRÉFIXES. Les sauvegardes écrites avant le renommage s'appellent
# `aria-*.dump` ; une rétention qui ne connaîtrait que le nom courant ne les
# supprimerait JAMAIS, et le répertoire grossirait indéfiniment sans que rien ne le
# signale — jusqu'au disque plein, c'est-à-dire jusqu'à la première sauvegarde qui
# échoue pour une raison sans rapport apparent.
for prefix in placet aria; do
  find "$BACKUP_DIR" -maxdepth 1 -name "$prefix-*.dump" -mtime +"$RETENTION_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -name "$prefix-*.dump.sha256" -mtime +"$RETENTION_DAYS" -delete
done

echo "backup: $out ($(du -h "$out" | cut -f1))"
