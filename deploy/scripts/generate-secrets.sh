#!/usr/bin/env bash
# Prints fresh random values to STDOUT. Writes nothing to disk: paste them into
# placet.env (mode 600) or your secret manager yourself.
set -euo pipefail
rand() { openssl rand -base64 "$1" | tr -d '\n=+/' | cut -c1-"$2"; }
echo "POSTGRES_PASSWORD=$(rand 48 40)"
echo "OATHRION_SESSION_SECRET=$(rand 64 64)"
# La clé qui emballe les clés de chiffrement du coffre de credentials des connecteurs.
# Obligatoire pour connecter un service : sans elle, POST /api/connectors/<id>/connect
# répond 503 en nommant cette variable. 32 octets EXACTEMENT, en base64 — contrairement
# aux valeurs ci-dessus, ce n'est pas une chaîne aléatoire quelconque mais une clé AES.
echo "OATHRION_KEK=$(openssl rand -base64 32)"
# Accounts are created in the database (OATHRION_ACCOUNTS=database) with
# dist/workspace-create.cjs: no administrator password is generated here.
