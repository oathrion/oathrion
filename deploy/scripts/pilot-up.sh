#!/usr/bin/env bash
# `npm run pilot:up` — la pile complète en une commande, en local.
#
# Génère des secrets frais, construit l'image, applique les migrations, démarre, et
# n'affiche les identifiants qu'une fois `/api/ready` à 200. Tant que ce n'est pas le
# cas, il échoue en montrant les journaux : « c'est parti » n'est pas « ça marche ».
#
# CE QUE CETTE PILE N'EST PAS : une configuration de production. Pas de TLS, PostgreSQL
# publié sur la boucle locale, secrets sur le disque. Voir l'en-tête de
# `deploy/docker-compose.local.yml` pour la liste complète des différences voulues.
set -euo pipefail

cd "$(dirname "$0")/.."
ENV_FILE="placet.local.env"
# Le nom hérité `PLACET_PILOT_PORT` reste lu : ce script shell n'a pas le shim de
# `server/env-compat.ts` (leçon du renommage précédent).
PORT="${OATHRION_PILOT_PORT:-${PLACET_PILOT_PORT:-5000}}"
export OATHRION_PILOT_PORT="$PORT"
COMPOSE=(docker compose -p placet-local -f docker-compose.local.yml --env-file "$ENV_FILE")

if ! docker compose version >/dev/null 2>&1; then
  echo "Le plugin « docker compose » est absent. Installez-le, puis relancez." >&2
  exit 2
fi

# UNE PILE « placet-local » APPARTIENT À UN SEUL DOSSIER.
#
# Le nom de projet Compose et le volume de données sont fixes. Deux copies d'Oathrion
# (un dépôt et une archive décompressée pour un test, par exemple) partageaient donc la
# même pile : lancer la seconde remplaçait les conteneurs de la première, gardait SON
# volume, et y appliquait d'autres secrets — mot de passe PostgreSQL compris. Mesuré le
# 19 octobre 2026. On refuse plutôt que de reprendre la pile d'un autre dossier.
OWNER="$(docker ps -a --filter label=com.docker.compose.project=placet-local \
  --format '{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null | head -n1)"
if [ -n "$OWNER" ] && [ "$OWNER" != "$(pwd)" ]; then
  echo "" >&2
  echo "Une pile Oathrion locale existe déjà, lancée depuis un AUTRE dossier :" >&2
  echo "  $OWNER" >&2
  echo "" >&2
  echo "  Rien n'a été modifié. La reprendre ici remplacerait ses conteneurs et ses secrets" >&2
  echo "  tout en gardant son volume de données. Arrêtez-la depuis son dossier d'abord :" >&2
  echo "    (cd \"$OWNER/..\" && npm run pilot:down)" >&2
  exit 2
fi

# Les secrets ne sont RÉGÉNÉRÉS que si le fichier n'existe pas : régénérer à chaque
# passage changerait le mot de passe PostgreSQL alors que le volume garde l'ancien, et
# la base refuserait la connexion sans que rien n'en dise la raison.
if [ -f "$ENV_FILE" ]; then
  echo "→ secrets existants réutilisés ($ENV_FILE)"
else
  echo "→ génération de secrets frais dans $ENV_FILE"
  rand() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
  ADMIN_PASSWORD="$(rand 32 28)"
  {
    echo "# Généré par pilot:up. Secrets LOCAUX, jamais versionnés, jamais réutilisés ailleurs."
    echo "POSTGRES_PASSWORD=$(rand 48 40)"
    echo "OATHRION_SESSION_SECRET=$(rand 64 64)"
    # 32 octets EXACTEMENT : c'est une clé AES-256, pas une chaîne aléatoire quelconque.
    echo "OATHRION_KEK=$(openssl rand -base64 32)"
    echo "OATHRION_KEK_ID=1"
    # Le premier administrateur. `Pilote/` nomme son organisation : sans ce préfixe il
    # atterrirait dans l'organisation par défaut, qui porte les données de démonstration.
    echo "OATHRION_CONSOLE_USERS=Pilote/admin@pilote.local:admin:${ADMIN_PASSWORD}"
    echo "OATHRION_API_KEYS="
    # Pas de données de démonstration : un pilote doit voir SA base, vide.
    echo "OATHRION_SEED="
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "   mode 600, et ignoré par git."
fi

# LE PORT EST VÉRIFIÉ AVANT DE CONSTRUIRE, et c'est une leçon d'un passage réel : une
# instance Oathrion lancée à la main écoute sur 5000 par défaut, donc le conflit est
# probable. Sans ce contrôle, Docker échoue après plusieurs minutes de build par
# « failed to bind host port 127.0.0.1:5000/tcp: address already in use » — exact, et
# illisible pour qui ne sait pas que quelque chose tourne déjà.
if (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}\b") ||
   (command -v lsof >/dev/null 2>&1 && lsof -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1); then
  echo "" >&2
  echo "Le port ${PORT} est déjà occupé sur cette machine." >&2
  echo "" >&2
  echo "  Probablement une instance Oathrion lancée à la main : 5000 est son port par défaut." >&2
  echo "  Rien n'a été construit ni démarré. Deux suites possibles :" >&2
  echo "" >&2
  echo "    OATHRION_PILOT_PORT=5055 npm run pilot:up    # utiliser un autre port" >&2
  echo "    …ou arrêter ce qui écoute sur ${PORT}, puis relancer." >&2
  exit 2
fi

echo "→ construction et démarrage (la première fois prend quelques minutes)"
"${COMPOSE[@]}" up -d --build

echo "→ attente de /api/ready"
ready=""
for _ in $(seq 1 90); do
  code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/api/ready" || true)"
  if [ "$code" = "200" ]; then ready="oui"; break; fi
  sleep 2
done

if [ -z "$ready" ]; then
  echo ""
  echo "La pile a démarré mais /api/ready n'a pas répondu 200." >&2
  echo "Les journaux, pour que la cause soit lisible plutôt que devinée :" >&2
  echo "" >&2
  "${COMPOSE[@]}" logs --tail=60 migrate placet >&2 || true
  exit 1
fi

# Un fichier de secrets écrit avant le renommage porte `PLACET_CONSOLE_USERS` : les deux
# noms sont lus, le courant d'abord.
ADMIN_LINE="$( (grep '^OATHRION_CONSOLE_USERS=' "$ENV_FILE" || grep '^PLACET_CONSOLE_USERS=' "$ENV_FILE") | head -1 | cut -d= -f2-)"
ADMIN_EMAIL="$(printf '%s' "$ADMIN_LINE" | sed 's|^[^/]*/||; s|:.*||')"
ADMIN_PASS="$(printf '%s' "$ADMIN_LINE" | awk -F: '{print $NF}')"

cat <<EOF

  Oathrion répond sur  http://127.0.0.1:${PORT}
  Console            http://127.0.0.1:${PORT}/console
  PostgreSQL          127.0.0.1:55433  (base « placet », utilisateur « placet »)

  Administrateur      ${ADMIN_EMAIL}
  Mot de passe        ${ADMIN_PASS}

  Ces identifiants sont dans deploy/${ENV_FILE} (mode 600). Pas de TLS sur cette pile :
  elle est faite pour voir le produit tourner, pas pour porter des données réelles.

  npm run pilot:logs    suivre les journaux
  npm run pilot:down    arrêter les conteneurs — LES DONNÉES SONT CONSERVÉES
  npm run pilot:destroy arrêter ET SUPPRIMER le volume de données (irréversible)
EOF
