#!/usr/bin/env bash
# Liveness and readiness of a running Oathrion. Exit 0 only when ready.
#   OATHRION_URL=https://placet.example.com ./check-health.sh
set -euo pipefail
url="${OATHRION_URL:-${PLACET_URL:-http://127.0.0.1:5000}}"
live=$(curl -s -o /dev/null -w '%{http_code}' "$url/api/live")
ready=$(curl -s -o /dev/null -w '%{http_code}' "$url/api/ready")
echo "live=$live ready=$ready"
[[ "$ready" == "200" ]]
