#!/usr/bin/env bash
# Dans le conteneur de `concurrents.Dockerfile` : chaque hook concurrent, installé comme sa
# documentation le dit, devant le corpus entier. Les relevés vont dans /out.
set -euo pipefail
cd /bench
RUN="tsx script/bench/vrais-hooks.ts --preparer --mode bypassPermissions"

# claude-bulkhead : le greffon, tous ses hooks PreToolUse.
$RUN --nom bulkhead --config /opt/bulkhead/hooks/hooks.json --racine-plugin /opt/bulkhead --sortie /out/bulkhead.json

# claude-guardrails, variante « full » : ses règles permissions.deny et ses hooks.
$RUN --nom guardrails --config /opt/guardrails/full/settings.json --racine-plugin /opt/guardrails/full --sortie /out/guardrails.json

# karanb192/claude-code-hooks : le « guard-pack », réglages par défaut.
$RUN --nom karanb192 --config /opt/karanb192/plugins/guard-pack/hooks/hooks.json --racine-plugin /opt/karanb192/plugins/guard-pack --sortie /out/karanb192.json
