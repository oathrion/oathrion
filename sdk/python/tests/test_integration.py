"""Integration test: the Python SDK against a REAL Oathrion server.

WHY THIS EXISTS ALONGSIDE THE UNIT TESTS
----------------------------------------
``test_client.py`` proves the SDK behaves correctly *given* a response. It
cannot prove the SDK and the server agree on what a response *is*, because it
writes both sides of that conversation. Every field name, every status code,
the shape of an error body — all asserted against fixtures the SDK author wrote,
so all of it would keep passing after the server changed underneath.

Here the server is the real Node process: real Express app, real decision
engine, real SQLite database, real authentication, real fail-closed posture,
over real HTTP on a real port. Nothing about the decision is simulated. This is
also what proves the two SDKs agree with each other — they are independently
written against the same live contract rather than against each other.

It carries the same five scenarios as the TypeScript integration test, so a
divergence between the two clients shows up as a failure rather than as a
support ticket.

SKIPPED, NEVER FAKED
--------------------
If Node or the repository is not available the test SKIPS with a reason. It does
not substitute a mock server and report a pass — a green integration test that
never contacted a server is worse than no integration test, because it is
believed.

Run with::

    python3 -m unittest discover -s sdk/python -v
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Optional

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from oathrion import (  # noqa: E402
    OathrionClient,
    OathrionHttpError,
    OathrionNotAllowedError,
)

REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT = "agt_billing"

ADMIN_KEY = "py-int-admin-key-000001"
OPERATOR_KEY = "py-int-operator-key-0001"
CONSOLE_EMAIL = "admin@placet.local"
CONSOLE_PASSWORD = "py-int-console-password-1"

# A policy naming `stripe.refund` explicitly.
#
# This is the load-bearing fixture of the phase. Oathrion is fail-closed, and
# `stripe.refund` is NOT in the built-in verb catalogue — so with no policy
# naming it, the decision is BLOCK by `sys_undeclared_action`, which is correct
# for an action nobody declared.
#
# The documented way to govern a verb Oathrion has never heard of is therefore to
# DECLARE it, by writing a policy whose `condition.actions` names it. That is
# exactly what the quickstart instructs, so running the scenarios through this
# policy proves the escape hatch works rather than asserting it in prose.
#
# `MAX_TRANSACTION_AMOUNT`, not `REQUIRE_HUMAN_APPROVAL`: the type selects the
# rule evaluator, and only this one reads an `amountAtMost` condition.
STRIPE_REFUND_POLICY: Dict[str, Any] = {
    "id": "pol_stripe_refund_py",
    "name": "Stripe refund threshold (python)",
    "description": "Refunds up to 500 EUR are automatic; above that a human decides.",
    "type": "MAX_TRANSACTION_AMOUNT",
    "condition": {
        "kind": "amountAtMost",
        "field": "amount",
        "max": 500,
        "currency": "EUR",
        "actions": ["stripe.refund"],
    },
    "scope": "organization",
    "appliesTo": "All agents",
    "effect": "require_approval",
    "status": "enabled",
    "action": "APPROVAL_REQUIRED",
    "risk": "high",
    "rule": "stripe.refund.amount > EUR 500 -> require_approval",
    "priority": 80,
}


def _free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _raw_request(
    url: str, method: str = "GET", body: Optional[dict] = None, token: Optional[str] = None
) -> Any:
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        request.add_header("content-type", "application/json")
    if token:
        request.add_header("authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return json.loads(response.read().decode() or "null")
    except urllib.error.HTTPError as exc:
        raise AssertionError(
            f"{method} {url} returned HTTP {exc.code}: {exc.read().decode()[:400]}"
        ) from exc


@unittest.skipUnless(shutil.which("npx"), "npx is not on PATH; cannot boot a real Oathrion server")
@unittest.skipUnless(
    (REPO_ROOT / "server" / "index.ts").exists(), f"Oathrion server not found under {REPO_ROOT}"
)
class TestAgainstLiveServer(unittest.TestCase):
    """The five required scenarios, through the public SDK surface."""

    process: Optional[subprocess.Popen] = None
    tmpdir: Optional[str] = None
    base_url: str = ""
    client: OathrionClient

    @classmethod
    def setUpClass(cls) -> None:
        port = _free_port()
        cls.base_url = f"http://127.0.0.1:{port}"
        cls.tmpdir = tempfile.mkdtemp(prefix="placet-py-int-")

        env = {
            **os.environ,
            "NODE_ENV": "development",
            "PORT": str(port),
            "OATHRION_DB": str(Path(cls.tmpdir) / "test.db"),
            "OATHRION_SESSION_SECRET": "0123456789abcdef0123456789abcdef0123456789abcdef",
            "OATHRION_API_KEYS": (
                f"Py Admin:admin:{ADMIN_KEY},Py Operator:operator:{OPERATOR_KEY}"
            ),
            "OATHRION_CONSOLE_USERS": f"{CONSOLE_EMAIL}:admin:{CONSOLE_PASSWORD}",
            # Seeding is opt-in — a fresh Oathrion governs nothing at all — so the
            # starter configuration is requested explicitly. `config`, not
            # `demo`: the ledger datasets would fabricate executions that count
            # toward real KPIs and daily spend.
            "OATHRION_SEED": "config",
        }
        # DATABASE_URL leaking in from the shell would redirect the server at a
        # PostgreSQL instance it cannot use, and it would fail to boot.
        env.pop("DATABASE_URL", None)

        cls.process = subprocess.Popen(
            ["npx", "tsx", "server/index.ts"],
            cwd=str(REPO_ROOT),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )

        deadline = time.time() + 90
        while time.time() < deadline:
            if cls.process.poll() is not None:
                output = cls.process.stdout.read() if cls.process.stdout else ""
                raise AssertionError(f"Oathrion server exited during boot:\n{output[-2000:]}")
            try:
                _raw_request(f"{cls.base_url}/api/health")
                break
            except Exception:
                time.sleep(1)
        else:
            cls.tearDownClass()
            raise AssertionError("Oathrion server did not become healthy within 90s")

        # Policy creation requires a console session: `requireCapability("manage")`
        # with a user identity. An operator API key is deliberately insufficient
        # — machine credentials cannot rewrite the rules that bind them.
        login = _raw_request(
            f"{cls.base_url}/api/auth/login",
            "POST",
            {"email": CONSOLE_EMAIL, "password": CONSOLE_PASSWORD},
        )
        token = login["token"]
        _raw_request(f"{cls.base_url}/api/policies", "POST", STRIPE_REFUND_POLICY, token)

        cls.client = OathrionClient(
            base_url=cls.base_url, api_key=OPERATOR_KEY, agent_id=AGENT, timeout=15
        )

    @classmethod
    def tearDownClass(cls) -> None:
        if cls.process is not None:
            cls.process.terminate()
            try:
                cls.process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                cls.process.kill()
        if cls.tmpdir:
            shutil.rmtree(cls.tmpdir, ignore_errors=True)

    # -------------------------------------------------------------- #

    def test_health(self) -> None:
        self.assertEqual(self.client.health()["status"], "ok")

    def test_scenario_a_allowed_action(self) -> None:
        """A: a refund within the policy limit is ALLOWED."""
        decision = self.client.evaluate(
            action="stripe.refund",
            target="customer_123",
            input={"amount": 75, "currency": "EUR"},
        )
        self.assertEqual(decision.decision, "ALLOW")
        self.assertTrue(decision.allowed)
        self.assertFalse(decision.pending_approval)
        # Proof the decision came from the real engine and not from a default:
        # a policy identifier the SDK never had a way to invent.
        self.assertTrue(decision.policy_id)
        self.assertTrue(decision.request_id)

    def test_scenario_b_blocked_action(self) -> None:
        """B: a verb the org has forbidden is BLOCKED."""
        decision = self.client.evaluate(action="delete_customer", target="customer_123")
        self.assertEqual(decision.decision, "BLOCK")
        self.assertTrue(decision.blocked)
        self.assertFalse(decision.allowed)

    def test_scenario_c_approval_required(self) -> None:
        """C: over the threshold, a human is required — and that is not a yes."""
        decision = self.client.evaluate(
            action="stripe.refund",
            target="customer_123",
            input={"amount": 750, "currency": "EUR"},
        )
        self.assertEqual(decision.decision, "APPROVAL_REQUIRED")
        self.assertTrue(decision.pending_approval)
        self.assertFalse(decision.allowed)

    def test_a_dry_run_files_no_approval_and_a_persisted_one_does(self) -> None:
        """The distinction an approval flow lives or dies on.

        This test was originally written asserting that an APPROVAL_REQUIRED
        always carries an ``approval_id``. It failed, and the server was right:
        ``/api/evaluate`` defaults to ``persist: false``, which is a DRY RUN. A
        dry run answers "this WOULD need approval" and records nothing, so there
        is no approval for anyone to act on and ``approval_id`` is null.

        The trap is specific and quiet. An integrator using the default, seeing
        APPROVAL_REQUIRED and telling the user "waiting for approval" waits
        forever, because the request was never filed. Both halves are pinned
        here so neither can drift, and the null is asserted as intended
        behaviour rather than tolerated as an absence.
        """
        dry = self.client.evaluate(
            action="stripe.refund",
            target="customer_123",
            input={"amount": 750, "currency": "EUR"},
        )
        self.assertEqual(dry.decision, "APPROVAL_REQUIRED")
        self.assertIsNone(dry.approval_id, "a dry run must file no approval")
        self.assertFalse(dry.raw.get("persisted"))
        self.assertIsNone(dry.raw.get("executionId"))

        real = self.client.evaluate(
            action="stripe.refund",
            target="customer_123",
            input={"amount": 750, "currency": "EUR"},
            persist=True,
        )
        self.assertEqual(real.decision, "APPROVAL_REQUIRED")
        self.assertTrue(real.raw.get("persisted"))
        self.assertTrue(
            real.approval_id, "a persisted hold must be identifiable to a reviewer"
        )
        self.assertTrue(real.raw.get("executionId"))

        # And the approval is genuinely in the queue a human reads — checked
        # over the API rather than inferred from the id being non-null.
        queue = _raw_request(f"{self.base_url}/api/approvals", token=ADMIN_KEY)
        items = queue if isinstance(queue, list) else queue.get("items", [])
        self.assertIn(real.approval_id, [item.get("id") for item in items])

    def test_scenario_d_undeclared_action_is_blocked_by_the_server(self) -> None:
        """D: a verb nobody declared is BLOCKED. OATHRION_UNDECLARED_ACTION defaults to block."""
        decision = self.client.evaluate(
            action="custom.company.operation", target="customer_123"
        )
        self.assertEqual(decision.decision, "BLOCK")
        self.assertFalse(decision.allowed)
        self.assertIn("sys_", decision.policy_id or "")

    def test_scenario_e_invalid_credential_is_refused(self) -> None:
        """E: a bad credential yields an error, never a decision."""
        rogue = OathrionClient(
            base_url=self.base_url, api_key="not-a-real-key", agent_id=AGENT, timeout=15
        )
        with self.assertRaises(OathrionHttpError) as ctx:
            rogue.evaluate(action="stripe.refund", target="customer_123", input={"amount": 1})
        self.assertTrue(ctx.exception.is_auth_failure)
        self.assertFalse(hasattr(ctx.exception, "decision"))

    def test_anonymous_request_is_refused(self) -> None:
        with self.assertRaises(AssertionError):
            # Raised by the helper on any non-2xx: reaching /api/evaluate with
            # no credential at all must not produce a decision either.
            _raw_request(
                f"{self.base_url}/api/evaluate",
                "POST",
                {"agentId": AGENT, "action": "stripe.refund", "target": "c1"},
            )

    def test_require_allow_raises_on_a_real_hold(self) -> None:
        with self.assertRaises(OathrionNotAllowedError) as ctx:
            self.client.require_allow(
                action="stripe.refund",
                target="customer_123",
                input={"amount": 750, "currency": "EUR"},
            )
        self.assertEqual(ctx.exception.decision.decision, "APPROVAL_REQUIRED")

    def test_malformed_payload_is_refused_with_a_json_envelope(self) -> None:
        """A rejected request must still be machine-readable, not an HTML page.

        The malformed id here is what surfaced P8-4: this assertion originally
        got a 404, because the endpoint accepted any non-empty string as an
        agent id and only discovered the problem at the registry lookup. The
        documented grammar is now applied at the door, so an impossible id is a
        400 and a merely unknown one stays a 404.
        """
        placet = OathrionClient(base_url=self.base_url, api_key=OPERATOR_KEY, timeout=15)
        with self.assertRaises(OathrionHttpError) as ctx:
            placet.evaluate(agent_id="!!not-valid!!", action="stripe.refund", target="c1")
        self.assertEqual(ctx.exception.status, 400)
        self.assertTrue(ctx.exception.is_request_invalid)
        self.assertTrue(ctx.exception.body, "the 400 body must be parseable JSON")

    def test_unknown_but_well_formed_agent_is_a_404_not_a_decision(self) -> None:
        placet = OathrionClient(base_url=self.base_url, api_key=OPERATOR_KEY, timeout=15)
        with self.assertRaises(OathrionHttpError) as ctx:
            placet.evaluate(agent_id="agt_nonexistent", action="stripe.refund", target="c1")
        self.assertEqual(ctx.exception.status, 404)
        self.assertFalse(hasattr(ctx.exception, "decision"))

    def test_both_sdks_see_the_same_decision_for_the_same_action(self) -> None:
        """The Python client and a hand-built request must agree.

        If the SDK quietly rewrote a field name, this is where it shows: the raw
        request is written against the documented HTTP contract, the SDK request
        against the SDK's own understanding of it.
        """
        raw = _raw_request(
            f"{self.base_url}/api/evaluate",
            "POST",
            {
                "agentId": AGENT,
                "action": "stripe.refund",
                "target": "customer_123",
                "input": {"amount": 75, "currency": "EUR"},
            },
            OPERATOR_KEY,
        )
        viaSdk = self.client.evaluate(
            action="stripe.refund",
            target="customer_123",
            input={"amount": 75, "currency": "EUR"},
        )
        self.assertEqual(raw["decision"], viaSdk.decision)
        self.assertEqual(raw.get("policyId"), viaSdk.policy_id)


if __name__ == "__main__":
    unittest.main()
