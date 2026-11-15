#!/usr/bin/env bash
#
# Oathrion quickstart, end to end, against a server with NOTHING in it.
#
# This is the documented five-minute path, written as a script so it can be RUN
# rather than believed. Everything in docs/quickstart.md is a narration of what
# happens below, and if this script stops working the documentation is wrong.
#
# It starts from an EMPTY database on purpose. A fresh Oathrion has no agents and no
# policies — seeding is opt-in via OATHRION_SEED — so a quickstart that assumed
# `agt_billing` already existed would work on a demo box and fail on the first
# real install. The first thing this does is create the agent.
#
#   1. start a server
#   2. sign in to the console
#   3. create an agent
#   4. create a policy that governs stripe.refund
#   5. ask Oathrion about a small refund   -> ALLOW
#   6. ask Oathrion about a large refund   -> APPROVAL_REQUIRED
#   7. ask about an action nobody declared -> BLOCK
#   8. read the audit trail
#
set -euo pipefail
cd "$(dirname "$0")/../.."

PORT="${PORT:-5111}"
BASE="http://127.0.0.1:$PORT"
DB="$(mktemp -u /tmp/placet-quickstart-XXXXXX.db)"
ADMIN_KEY="quickstart-admin-key-00001"
CONSOLE_EMAIL="admin@placet.local"
CONSOLE_PASSWORD="quickstart-console-pw-1"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mFAILED: %s\033[0m\n' "$*" >&2; exit 1; }

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$DB"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
say "1. Starting Oathrion on $BASE (empty database, no seed data)"
# ---------------------------------------------------------------------------
#
# Refuse the port if something already answers on it.
#
# Without this the script is silently wrong rather than broken: our own server
# fails to bind, the health poll below succeeds against the STRANGER, and every
# step afterwards runs against a database this script did not create. That was
# not hypothetical — it happened on a cold-checkpoint run, where a leftover
# server from an earlier session owned 5111 and step 3 failed with a confusing
# "agent already exists" for an agent this run had never created.
#
# Failing loudly is the right answer rather than picking a free port: if
# something is already listening, the user has a server they probably care
# about, and quietly relocating would hide that from them too.
if curl -sf -o /dev/null --max-time 2 "$BASE/api/health" 2>/dev/null; then
  fail "something is already listening on $BASE.

  This script needs the port to itself — it starts its own server against a
  throwaway database, and talking to an existing one would mix this walkthrough
  into data it does not own.

  Stop it, or choose another port:  PORT=5112 bash $0"
fi

NODE_ENV=development \
PORT="$PORT" \
OATHRION_DB="$DB" \
OATHRION_SESSION_SECRET="$(openssl rand -hex 32)" \
OATHRION_API_KEYS="Quickstart Admin:admin:$ADMIN_KEY" \
OATHRION_CONSOLE_USERS="$CONSOLE_EMAIL:admin:$CONSOLE_PASSWORD" \
  npx tsx server/index.ts >/tmp/placet-quickstart.log 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 60); do
  curl -sf "$BASE/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$BASE/api/health" >/dev/null || { cat /tmp/placet-quickstart.log; fail "server did not start"; }
echo "   up."

# ---------------------------------------------------------------------------
say "2. Signing in to the console"
# ---------------------------------------------------------------------------
# Creating agents and policies is an administrative act, so it needs a signed-in
# human, not an agent's API key. This is deliberate: an operator key can ASK for
# a decision but cannot rewrite the rules that produce it.
TOKEN=$(curl -sf -X POST "$BASE/api/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$CONSOLE_EMAIL\",\"password\":\"$CONSOLE_PASSWORD\",\"organization\":\"org_default\"}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["token"])')
[ -n "$TOKEN" ] || fail "no console token"
echo "   signed in."

# ---------------------------------------------------------------------------
say "3. Creating the agent"
# ---------------------------------------------------------------------------
# A fresh Oathrion knows no agents. An unknown agentId is a 404, not a decision —
# Oathrion will not answer authorization questions about an agent it has never heard
# of, because "I don't know who that is" must never resolve to "allowed".
CREATED=$(curl -s -o /tmp/qs-agent.json -w '%{http_code}' -X POST "$BASE/api/agents" \
  -H "Authorization: Bearer $ADMIN_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "agt_support_bot",
    "name": "Support Bot",
    "description": "Handles customer refunds raised from the support inbox.",
    "provider": "openai",
    "model": "gpt-4o",
    "status": "active",
    "owner": "support@example.com",
    "mandate": {
      "maxTransactionAmount": 500,
      "currency": "EUR",
      "allowedCategories": ["refunds"],
      "blockedCategories": [],
      "allowedDomains": ["api.stripe.com"]
    },
    "permissions": [
      { "scope": "execute:payments", "label": "Issue refunds", "granted": true, "risk": "high" }
    ],
    "policyIds": [],
    "tags": ["support"]
  }')
[ "$CREATED" = "201" ] || { cat /tmp/qs-agent.json; fail "agent not created (HTTP $CREATED)"; }
echo "   agt_support_bot created."

# ---------------------------------------------------------------------------
say "4. Creating a policy that governs stripe.refund"
# ---------------------------------------------------------------------------
# This step is not optional, and it is the one most likely to be skipped.
#
# `stripe.refund` is NOT in Oathrion's built-in action catalogue. An action Oathrion has
# never heard of is BLOCKED by default — that is the OATHRION_UNDECLARED_ACTION
# posture, and it is a feature: an agent inventing a new verb at runtime is
# precisely the event you want stopped rather than waved through.
#
# So the policy below is what makes `stripe.refund` a known action AND what
# governs it: at most 500 EUR without a human, above that an approval.
POLICY=$(curl -s -o /tmp/qs-policy.json -w '%{http_code}' -X POST "$BASE/api/policies" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "pol_refund_ceiling",
    "name": "Refund ceiling",
    "description": "Refunds up to 500 EUR run autonomously. Above that, a human decides.",
    "type": "MAX_TRANSACTION_AMOUNT",
    "condition": {
      "kind": "amountAtMost",
      "field": "amount",
      "max": 500,
      "currency": "EUR",
      "actions": ["stripe.refund"]
    },
    "scope": "organization",
    "appliesTo": "All agents",
    "effect": "require_approval",
    "status": "enabled",
    "action": "APPROVAL_REQUIRED",
    "risk": "high",
    "priority": 80,
    "rule": "amount <= 500 EUR for stripe.refund"
  }')
[ "$POLICY" = "201" ] || { cat /tmp/qs-policy.json; fail "policy not created (HTTP $POLICY)"; }
echo "   pol_refund_ceiling created."

# ---------------------------------------------------------------------------
# The three questions. This is the whole product.
# ---------------------------------------------------------------------------
ask() {
  curl -sf -X POST "$BASE/api/evaluate" \
    -H "Authorization: Bearer $ADMIN_KEY" \
    -H 'Content-Type: application/json' \
    -d "$1"
}
decision_of() { python3 -c 'import sys,json; print(json.load(sys.stdin)["decision"])'; }

# Note `category` in every request below. The agent's mandate restricts it to
# the "refunds" category, and Oathrion fails closed: an action that declares NO
# category cannot be shown to be inside the mandate, so it is blocked rather
# than waved through. Omitting the field is not a neutral act.
say "5. A 75 EUR refund — under the ceiling"
D=$(ask '{"agentId":"agt_support_bot","action":"stripe.refund","target":"cus_12345","input":{"amount":75,"currency":"EUR","category":"refunds"}}' | decision_of)
echo "   -> $D"
[ "$D" = "ALLOW" ] || fail "expected ALLOW, got $D"

say "6. A 750 EUR refund — over the ceiling"
D=$(ask '{"agentId":"agt_support_bot","action":"stripe.refund","target":"cus_12345","input":{"amount":750,"currency":"EUR","category":"refunds"}}' | decision_of)
echo "   -> $D"
[ "$D" = "APPROVAL_REQUIRED" ] || fail "expected APPROVAL_REQUIRED, got $D"

say "7. An action nobody declared"
D=$(ask '{"agentId":"agt_support_bot","action":"stripe.transfer_balance","target":"acct_9","input":{"amount":10,"category":"refunds"}}' | decision_of)
echo "   -> $D"
[ "$D" = "BLOCK" ] || fail "expected BLOCK, got $D"

# ---------------------------------------------------------------------------
say "8. A real decision, and the audit trail"
# ---------------------------------------------------------------------------
# Steps 5-7 were DRY RUNS. `/api/evaluate` does not persist unless you ask it
# to, so nothing above was recorded, no approval was filed, and the audit trail
# is still empty. That is the right default for "what would you say if...", and
# it is a trap worth knowing about: a dry-run APPROVAL_REQUIRED creates NOTHING
# for a human to approve, so an integration that waits for someone to click will
# wait forever.
#
# `"persist": true` is what makes it real. Now the decision is recorded whether
# the answer was yes or no — a refusal nobody can point to afterwards is not
# much of a control.
ask '{"agentId":"agt_support_bot","action":"stripe.refund","target":"cus_12345","input":{"amount":120,"currency":"EUR","category":"refunds"},"persist":true}' >/dev/null
COUNT=$(curl -sf "$BASE/api/audit" -H "Authorization: Bearer $ADMIN_KEY" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["total"])')
echo "   $COUNT audit entries recorded."
[ "$COUNT" -gt 0 ] || fail "expected audit entries"

# A note on what did NOT happen: `runState` came back "skipped", because no tool
# is registered for `stripe.refund` in this build. Oathrion authorised the action and
# recorded that it did; it did not call Stripe. Wiring a real downstream tool is
# a separate step, and the decision is the part Oathrion is responsible for.

printf '\n\033[32mQuickstart complete. ALLOW, APPROVAL_REQUIRED and BLOCK all verified.\033[0m\n\n'
