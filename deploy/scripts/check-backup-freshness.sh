#!/usr/bin/env bash
# Alarme sur l'ABSENCE d'une sauvegarde récente.
#
#   BACKUP_DIR=/var/backups/placet MAX_AGE_HOURS=2 ./check-backup-freshness.sh
#   ./check-backup-freshness.sh --prometheus > /var/lib/node_exporter/textfile/placet-backup.prom
#
# ## Pourquoi cette alarme porte sur une absence
#
# Une sauvegarde qui échoue bruyamment se remarque : le cron envoie un courriel, le
# code de sortie est non nul, quelqu'un regarde. Celle qui ne se remarque pas est celle
# qui n'a jamais été lancée — unité systemd désactivée après un redémarrage, ligne de
# cron perdue dans une migration de machine, disque plein depuis trois semaines. Dans ce
# cas il n'y a aucun échec à détecter : il n'y a RIEN, et rien ne déclenche rien.
#
# C'est le mode de panne qui transforme une panne matérielle ordinaire en perte de
# données définitive, et la seule défense est une alarme qui se déclenche sur le silence.
# `docs/OPERATIONS.md` le portait déjà comme consigne écrite ; ceci en fait une commande.
#
# ## Codes de sortie — c'est le contrat
#
#   0  un dump existe, il est plus récent que MAX_AGE_HOURS, et son empreinte concorde
#   1  AUCUN dump, ou le plus récent est trop vieux, ou son empreinte ne concorde pas
#   2  impossible de regarder (répertoire inexistant ou illisible). PAS « tout va bien »
#
# Le 2 est séparé du 1 pour la même raison que dans `audit-chains.ts` : un superviseur
# qui confond « rien de cassé » et « je n'ai pas pu regarder » rassure pendant la panne.
set -uo pipefail

BACKUP_DIR="${BACKUP_DIR:-/var/backups/placet}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
PROMETHEUS=0
[[ "${1:-}" == "--prometheus" ]] && PROMETHEUS=1

# La sortie humaine va sur stderr quand stdout est réservé au collecteur.
say() { if ((PROMETHEUS)); then echo "$@" >&2; else echo "$@"; fi; }

emit() {
  # $1 = fraîcheur (0/1), $2 = âge en secondes (-1 si inconnu), $3 = empreinte OK (0/1)
  ((PROMETHEUS)) || return 0
  cat <<PROM
# HELP oathrion_backup_fresh 1 si un dump plus recent que le seuil existe.
# TYPE oathrion_backup_fresh gauge
oathrion_backup_fresh $1
# HELP oathrion_backup_age_seconds Age du dump le plus recent. -1 si aucun dump.
# TYPE oathrion_backup_age_seconds gauge
oathrion_backup_age_seconds $2
# HELP oathrion_backup_checksum_ok 1 si l'empreinte du dump le plus recent concorde.
# TYPE oathrion_backup_checksum_ok gauge
oathrion_backup_checksum_ok $3
# HELP oathrion_backup_check_timestamp_seconds Date du dernier passage de ce controle.
# TYPE oathrion_backup_check_timestamp_seconds gauge
oathrion_backup_check_timestamp_seconds $(date -u +%s)
PROM
}

if [[ ! -d "$BACKUP_DIR" ]]; then
  say "IMPOSSIBLE DE REGARDER : $BACKUP_DIR n'existe pas ou n'est pas un répertoire."
  say "Sortie 2 — ce n'est pas un verdict favorable."
  emit 0 -1 0
  exit 2
fi
if [[ ! -r "$BACKUP_DIR" ]]; then
  say "IMPOSSIBLE DE REGARDER : $BACKUP_DIR n'est pas lisible par $(id -un)."
  emit 0 -1 0
  exit 2
fi

# Le plus récent par date de modification. `find … -printf` plutôt que `ls -t` : un nom
# de fichier contenant un espace ou un saut de ligne casse `ls` et pas celui-ci.
# LES DEUX PRÉFIXES, et c'est le détail qui décide si cette alarme dit vrai. Les
# sauvegardes écrites avant le renommage s'appellent `aria-*.dump` : une recherche
# limitée au nom courant aurait annoncé « AUCUNE SAUVEGARDE » à 3 h du matin devant un
# répertoire plein de dumps parfaitement valides — un réveil pour rien, qui est la
# façon la plus sûre de faire désactiver une alerte.
newest="$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'placet-*.dump' -o -name 'aria-*.dump' \) -type f -printf '%T@ %p\0' 2>/dev/null \
          | sort -zrn | head -zn1 | cut -z -d' ' -f2- | tr -d '\0')"

if [[ -z "$newest" ]]; then
  say "AUCUNE SAUVEGARDE dans $BACKUP_DIR."
  say ""
  say "Ce n'est pas « la dernière a échoué » : c'est qu'il n'y en a aucune. Vérifiez que"
  say "l'unité ou la ligne de cron qui lance backup.sh existe ENCORE — c'est la panne"
  say "qui survit le plus souvent à un changement de machine."
  emit 0 -1 0
  exit 1
fi

now="$(date -u +%s)"
mtime="$(stat -c %Y "$newest")"
age=$(( now - mtime ))
limit=$(( MAX_AGE_HOURS * 3600 ))

# L'empreinte, parce qu'un dump présent et tronqué est pire qu'un dump absent : il
# ressemble à une sauvegarde, et on ne le découvre que le jour où on la restaure.
# `--quiet` ne taît que les lignes « OK » : un ÉCHEC reste imprimé, et sur stdout. En
# mode --prometheus, stdout est le fichier que le collecteur analyse, donc cette ligne
# s'y serait glissée au milieu des métriques — et seulement quand un dump est corrompu,
# c'est-à-dire exactement quand on a besoin que le fichier soit lisible. Les deux flux
# sont donc jetés, et le verdict est le code de retour.
checksum_ok=0
if [[ -r "$newest.sha256" ]] \
   && (cd "$BACKUP_DIR" && sha256sum -c --quiet "$(basename "$newest").sha256" >/dev/null 2>&1); then
  checksum_ok=1
fi

fresh=0
(( age <= limit )) && fresh=1

say "dernier dump   $newest"
say "âge            $(( age / 3600 )) h $(( (age % 3600) / 60 )) min (seuil : ${MAX_AGE_HOURS} h)"
say "empreinte      $( ((checksum_ok)) && echo "concorde" || echo "ABSENTE OU DIFFÉRENTE" )"

emit "$fresh" "$age" "$checksum_ok"

if (( ! fresh )); then
  say ""
  say "TROP VIEUX. La dernière sauvegarde a plus de ${MAX_AGE_HOURS} h : tout ce qui a été"
  say "décidé depuis n'est pas récupérable. Lancez backup.sh à la main, PUIS cherchez"
  say "pourquoi le passage automatique ne s'est pas fait."
  exit 1
fi
if (( ! checksum_ok )); then
  say ""
  say "EMPREINTE NON VÉRIFIÉE. Un dump dont l'empreinte manque ou diffère ne doit pas être"
  say "compté comme une sauvegarde : il ressemble à une sauvegarde, ce qui est pire."
  exit 1
fi
exit 0
