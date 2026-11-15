#!/usr/bin/env bash
# Prépare l'essai réel de `oathrion wrap` dans Cursor, devant le VRAI serveur
# @modelcontextprotocol/server-filesystem : une lecture, une écriture approuvée, les reçus.
#
#   npm run build
#   bash script/essai-cursor-wrap.sh [dossier]      # par défaut ~/essai-oathrion-fichiers
#
# Le script ne fait qu'ÉCRIRE un dossier de projet neuf, et à côté de lui le dossier d'état
# d'Oathrion (`<dossier>.etat`) ; il ne lance ni Cursor, ni npx, ni Oathrion. Il refuse un
# dossier qui existe déjà.
#
# L'état est HORS du projet : Cursor indexe tout le projet ouvert (et en envoie le contenu à
# ses serveurs), et l'agent y lit librement. Le premier essai, le 28 octobre, plaçait l'état
# dans le projet : `session.secret` et le lien d'invitation ont été indexés. Rien n'est écrit dans la configuration
# globale de Cursor (~/.cursor) : tout est dans le `.cursor/` du projet.
#
# Les serveurs de ~/.cursor/mcp.json sont chargés aussi dans ce projet. Le script lit leurs
# NOMS (rien d'autre, sans rien modifier) et `.cursor/cli.json` leur refuse tout appel, comme
# au shell, pour que l'agent ne puisse agir que par le serveur enveloppé.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="${1:-$HOME/essai-oathrion-fichiers}"
CLI="$REPO/dist/oathrion.mjs"

if [[ ! -f "$CLI" ]]; then
  echo "dist/oathrion.mjs manque : lancez d'abord « npm run build » dans $REPO" >&2
  exit 1
fi
if [[ -e "$DIR" || -e "$DIR.etat" ]]; then
  echo "$DIR ou $DIR.etat existe déjà : choisissez un autre dossier (rien n'a été touché)." >&2
  exit 1
fi

mkdir -p "$DIR/bac" "$DIR/.cursor" "$DIR.etat"
chmod 700 "$DIR.etat"
DIR="$(cd "$DIR" && pwd)"
STATE="$DIR.etat"
printf 'Note de départ, écrite par le script de préparation.\n' > "$DIR/bac/note.txt"

node - "$DIR" "$CLI" "$STATE" <<'EOF'
const { writeFileSync } = require("node:fs");
const [dir, cli, state] = process.argv.slice(2);
const mcp = {
  mcpServers: {
    fichiers: {
      command: process.execPath,
      args: [cli, "wrap", "--name", "fichiers", "--approbation", "client", "--", "npx", "-y", "@modelcontextprotocol/server-filesystem", `${dir}/bac`],
      env: { OATHRION_WRAP_HOME: state },
    },
  },
};
let globalServers = [];
try {
  const global = JSON.parse(require("node:fs").readFileSync(`${require("node:os").homedir()}/.cursor/mcp.json`, "utf8"));
  globalServers = Object.keys(global.mcpServers ?? {}).filter((name) => name !== "fichiers");
} catch {
  /* Pas de configuration globale, ou illisible : aucun serveur global à refuser. */
}
const deny = ["Shell(*)", ...globalServers.map((name) => `Mcp(${name}:*)`)];
const permissions = { permissions: { allow: ["Mcp(fichiers:*)"], deny } };
writeFileSync(`${dir}/.cursor/mcp.json`, `${JSON.stringify(mcp, null, 2)}\n`);
writeFileSync(`${dir}/.cursor/cli.json`, `${JSON.stringify(permissions, null, 2)}\n`);
EOF

cat <<EOF
Prêt : $DIR

Terminal 1, dans le projet :
  cd "$DIR"
  cursor-agent mcp enable fichiers
  cursor-agent mcp list-tools fichiers
  cursor-agent

Terminal 2, pendant que cursor-agent est ouvert :
  OATHRION_WRAP_HOME="$STATE" node "$CLI" console
  → la console s'ouvre, déjà connectée, sur les approbations.
  Pour write_file : le bandeau « outil caché » en tête des Approbations → « Les autoriser ».
  L'agent s'appelle « Cursor » (Agents → Cursor).

Dans cursor-agent, deux demandes :
  1. « Avec l'outil read_text_file du serveur fichiers, lis $DIR/bac/note.txt »
     → attendu : le texte de la note, sans approbation.
  2. « Avec l'outil write_file du serveur fichiers, écris "bonjour" dans $DIR/bac/essai.txt »
     → attendu : la question s'affiche DANS Cursor (Accepter / Refuser) ; sinon, approuvez
       dans la console (Approbations) en moins de 50 s.

Après avoir quitté cursor-agent :
  cat "$DIR/bac/essai.txt"
  OATHRION_WRAP_HOME="$STATE" node "$CLI" receipts verify --name fichiers
EOF
