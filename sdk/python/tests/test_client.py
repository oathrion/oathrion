"""Unit tests for the Oathrion Python SDK.

Every test here is about ONE question: can a caller end up believing it was
permitted when Oathrion did not permit it?

So the fixtures are hostile rather than representative. They include a proxy
returning HTML for a 502, a 200 with no decision at all, a 200 whose decision is
a string nobody has ever defined, a body carrying ``allowed: true`` beside
``decision: "BLOCK"``, a timeout and a refused connection. Those are the shapes
that produce a fail-open in a client written to the happy path, and a suite
built only from well-formed responses would pass against a client that fails
open on every one of them.

Uses ``unittest`` from the standard library: pytest is not installed in this
environment, and a test suite that cannot run is not a test suite. Run with::

    python3 -m unittest discover -s sdk/python -v

The real-server integration test is in ``test_integration.py``.
"""

from __future__ import annotations

import io
import json
import socket
import unittest
import urllib.error
from typing import Any, Dict, Optional

from oathrion import (
    OathrionClient,
    OathrionConnectionError,
    OathrionHttpError,
    OathrionNotAllowedError,
    OathrionProtocolError,
    OathrionTimeoutError,
)

BASE_URL = "https://placet.test"
API_KEY = "test-key-abcdef"

ACTION = {
    "agent_id": "agt_billing",
    "action": "refund",
    "target": "customer:cus_1",
    "input": {"amount": 75, "currency": "EUR"},
}


def decision_body(**overrides: Any) -> Dict[str, Any]:
    body = {
        "decision": "ALLOW",
        "reason": "within limit",
        "policyId": "pol_refund_approval",
        "policyName": "Refund approval threshold",
        "risk": "low",
        "approvalId": None,
        "requestId": "req_1",
    }
    body.update(overrides)
    return body


class _FakeResponse(io.BytesIO):
    """Minimal stand-in for the object `urlopen` yields as a context manager."""

    def __init__(self, payload: bytes, status: int = 200) -> None:
        super().__init__(payload)
        self.status = status

    def getcode(self) -> int:
        return self.status

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def opener_returning(payload: Any, status: int = 200, calls: Optional[list] = None):
    """An opener double that records the requests it was handed."""

    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    def _open(request, timeout=None):  # noqa: ANN001
        if calls is not None:
            calls.append(request)
        return _FakeResponse(raw, status)

    return _open


def opener_raising(exc: BaseException, calls: Optional[list] = None):
    def _open(request, timeout=None):  # noqa: ANN001
        if calls is not None:
            calls.append(request)
        raise exc

    return _open


def http_error(status: int, body: Any) -> urllib.error.HTTPError:
    raw = body if isinstance(body, bytes) else json.dumps(body).encode()
    return urllib.error.HTTPError(
        url=f"{BASE_URL}/api/evaluate",
        code=status,
        msg="error",
        hdrs=None,  # type: ignore[arg-type]
        fp=io.BytesIO(raw),
    )


def client(opener) -> OathrionClient:  # noqa: ANN001
    return OathrionClient(base_url=BASE_URL, api_key=API_KEY, opener=opener)


class TestConstruction(unittest.TestCase):
    def test_refuses_missing_base_url_or_key(self) -> None:
        # A client silently built with no credential would send anonymous
        # requests and surface as a puzzling 401 far from the real mistake.
        with self.assertRaises(ValueError):
            OathrionClient(base_url="", api_key=API_KEY)
        with self.assertRaises(ValueError):
            OathrionClient(base_url=BASE_URL, api_key="")

    def test_tolerates_trailing_slash(self) -> None:
        calls: list = []
        placet = OathrionClient(
            base_url=BASE_URL + "/",
            api_key=API_KEY,
            opener=opener_returning(decision_body(), calls=calls),
        )
        placet.evaluate(**ACTION)
        self.assertEqual(calls[0].full_url, f"{BASE_URL}/api/evaluate")


class TestRequestShape(unittest.TestCase):
    def test_posts_to_evaluate_with_bearer_credential(self) -> None:
        calls: list = []
        client(opener_returning(decision_body(), calls=calls)).evaluate(**ACTION)

        request = calls[0]
        self.assertEqual(request.full_url, f"{BASE_URL}/api/evaluate")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(request.get_header("Authorization"), f"Bearer {API_KEY}")

        body = json.loads(request.data.decode())
        self.assertEqual(body["agentId"], "agt_billing")
        self.assertEqual(body["action"], "refund")
        self.assertEqual(body["target"], "customer:cus_1")
        self.assertEqual(body["input"], {"amount": 75, "currency": "EUR"})

    def test_default_agent_used_only_when_call_omits_one(self) -> None:
        calls: list = []
        placet = OathrionClient(
            base_url=BASE_URL,
            api_key=API_KEY,
            agent_id="agt_default",
            opener=opener_returning(decision_body(), calls=calls),
        )
        placet.evaluate(action="refund", target="c1")
        self.assertEqual(json.loads(calls[0].data.decode())["agentId"], "agt_default")

        placet.evaluate(action="refund", target="c1", agent_id="agt_explicit")
        self.assertEqual(json.loads(calls[1].data.decode())["agentId"], "agt_explicit")

    def test_requires_a_target(self) -> None:
        calls: list = []
        with self.assertRaises(ValueError):
            client(opener_returning(decision_body(), calls=calls)).evaluate(
                action="refund", target=""
            )
        # And it never reached the wire, so no half-specified action was judged.
        self.assertEqual(calls, [])

    def test_requires_an_action(self) -> None:
        with self.assertRaises(ValueError):
            client(opener_returning(decision_body())).evaluate(action="", target="c1")


class TestDecisionsAreReportedExactly(unittest.TestCase):
    def test_each_decision_sets_exactly_one_flag(self) -> None:
        cases = {
            "ALLOW": (True, False, False),
            "BLOCK": (False, True, False),
            "APPROVAL_REQUIRED": (False, False, True),
        }
        for value, (allowed, blocked, pending) in cases.items():
            with self.subTest(decision=value):
                result = client(opener_returning(decision_body(decision=value))).evaluate(**ACTION)
                self.assertEqual(result.decision, value)
                self.assertEqual(result.allowed, allowed)
                self.assertEqual(result.blocked, blocked)
                self.assertEqual(result.pending_approval, pending)

    def test_approval_required_is_never_permission(self) -> None:
        # The single most likely misuse of this client. A held action is waiting
        # for a human; reading it as a soft yes defeats the approval mechanism.
        result = client(
            opener_returning(decision_body(decision="APPROVAL_REQUIRED", approvalId="apr_1"))
        ).evaluate(**ACTION)
        self.assertFalse(result.allowed)
        self.assertTrue(result.pending_approval)
        self.assertEqual(result.approval_id, "apr_1")

    def test_ignores_a_body_claiming_permission_the_decision_does_not_grant(self) -> None:
        """A buggy or hostile intermediary appends ``allowed: true`` to a BLOCK.

        Flags must derive from ``decision`` alone. Trusting a server-supplied
        convenience field would make that field the soft spot an attacker
        targets instead of the decision.
        """
        result = client(
            opener_returning(decision_body(decision="BLOCK", allowed=True, blocked=False))
        ).evaluate(**ACTION)
        self.assertEqual(result.decision, "BLOCK")
        self.assertFalse(result.allowed)
        self.assertTrue(result.blocked)

    def test_exposes_the_correlation_id(self) -> None:
        result = client(opener_returning(decision_body(requestId="req_abc"))).evaluate(**ACTION)
        self.assertEqual(result.request_id, "req_abc")


class TestAFailureIsNeverADecision(unittest.TestCase):
    def test_http_errors_raise_and_carry_no_decision(self) -> None:
        for status in (400, 401, 403, 429, 500, 503):
            with self.subTest(status=status):
                placet = client(
                    opener_raising(
                        http_error(status, {"message": "refused", "code": "bad_request"})
                    )
                )
                with self.assertRaises(OathrionHttpError) as ctx:
                    placet.evaluate(**ACTION)
                self.assertEqual(ctx.exception.status, status)
                # The invariant: no error in this SDK carries a decision.
                self.assertFalse(hasattr(ctx.exception, "decision"))

    def test_error_carries_arias_own_code_and_request_id(self) -> None:
        placet = client(
            opener_raising(
                http_error(
                    403,
                    {
                        "message": "credential is bound to another agent",
                        "code": "agent_binding_violation",
                        "requestId": "req_binding",
                    },
                )
            )
        )
        with self.assertRaises(OathrionHttpError) as ctx:
            placet.evaluate(**ACTION)
        self.assertEqual(ctx.exception.code, "agent_binding_violation")
        self.assertEqual(ctx.exception.request_id, "req_binding")
        self.assertTrue(ctx.exception.is_auth_failure)
        self.assertFalse(ctx.exception.is_request_invalid)

    def test_authentication_failure_is_distinguishable(self) -> None:
        placet = client(opener_raising(http_error(401, {"message": "no credential"})))
        with self.assertRaises(OathrionHttpError) as ctx:
            placet.evaluate(**ACTION)
        self.assertTrue(ctx.exception.is_auth_failure)

    def test_connection_failure_raises_rather_than_guessing(self) -> None:
        placet = client(opener_raising(urllib.error.URLError("connection refused")))
        with self.assertRaises(OathrionConnectionError) as ctx:
            placet.evaluate(**ACTION)
        # Not even a synthesised BLOCK: that is how a client acquires its own
        # opinion, and the next edit makes the default ALLOW.
        self.assertFalse(hasattr(ctx.exception, "decision"))

    def test_socket_timeout_raises_timeout_error(self) -> None:
        placet = client(opener_raising(socket.timeout("timed out")))
        with self.assertRaises(OathrionTimeoutError):
            placet.evaluate(**ACTION)

    def test_timeout_wrapped_in_urlerror_is_still_a_timeout(self) -> None:
        # Platform-dependent: some raise `socket.timeout`, some wrap it.
        placet = client(opener_raising(urllib.error.URLError(socket.timeout("timed out"))))
        with self.assertRaises(OathrionTimeoutError):
            placet.evaluate(**ACTION)

    def test_html_error_body_from_a_proxy_does_not_crash_the_client(self) -> None:
        placet = client(opener_raising(http_error(502, b"<html>502 Bad Gateway</html>")))
        with self.assertRaises(OathrionHttpError) as ctx:
            placet.evaluate(**ACTION)
        self.assertEqual(ctx.exception.status, 502)
        self.assertIn("502", str(ctx.exception))


class TestAnUninterpretable200IsRefused(unittest.TestCase):
    def test_malformed_or_unknown_decisions_raise(self) -> None:
        cases = {
            "no decision field": {"reason": "ok"},
            "a decision nobody defined": {"decision": "PROBABLY_FINE"},
            "a lowercase decision": {"decision": "allow"},
            "a null decision": {"decision": None},
            "a list instead of an object": [1, 2, 3],
        }
        for label, body in cases.items():
            with self.subTest(case=label):
                with self.assertRaises(OathrionProtocolError):
                    client(opener_returning(body)).evaluate(**ACTION)

    def test_empty_body_raises(self) -> None:
        with self.assertRaises(OathrionProtocolError):
            client(opener_returning(b"")).evaluate(**ACTION)

    def test_non_json_200_raises(self) -> None:
        with self.assertRaises(OathrionProtocolError):
            client(opener_returning(b"<html>hello</html>")).evaluate(**ACTION)


class TestRequireAllow(unittest.TestCase):
    def test_returns_the_decision_when_allowed(self) -> None:
        result = client(opener_returning(decision_body())).require_allow(**ACTION)
        self.assertEqual(result.decision, "ALLOW")

    def test_raises_on_block_and_on_hold_alike(self) -> None:
        for value in ("BLOCK", "APPROVAL_REQUIRED"):
            with self.subTest(decision=value):
                placet = client(
                    opener_returning(decision_body(decision=value, reason="over the limit"))
                )
                with self.assertRaises(OathrionNotAllowedError) as ctx:
                    placet.require_allow(**ACTION)
                self.assertEqual(ctx.exception.decision.decision, value)
                self.assertIn("over the limit", str(ctx.exception))


class TestTheClientHoldsNoOpinionOfItsOwn(unittest.TestCase):
    def test_no_caching_of_a_previous_allow(self) -> None:
        """A cached yes is a decision taken under conditions that may have moved.

        Daily spend counters advance, policies are edited, agents are paused,
        mandates expire. The second call here returns BLOCK, and the SDK must
        report BLOCK — which it can only do if it actually asked again.
        """
        answers = [decision_body(decision="ALLOW"), decision_body(decision="BLOCK")]
        calls: list = []

        def _open(request, timeout=None):  # noqa: ANN001
            calls.append(request)
            return _FakeResponse(json.dumps(answers[len(calls) - 1]).encode())

        placet = client(_open)
        self.assertEqual(placet.evaluate(**ACTION).decision, "ALLOW")
        self.assertEqual(placet.evaluate(**ACTION).decision, "BLOCK")
        self.assertEqual(len(calls), 2)

    def test_unknown_action_is_sent_to_the_server_not_decided_locally(self) -> None:
        """Fail-closed is the SERVER's rule, and this pins where it is enforced.

        If the SDK filtered unknown verbs itself it would be a second policy
        engine — one that could be relaxed independently of Oathrion, and whose
        notion of "unknown" would drift from the real catalogue.
        """
        calls: list = []
        result = client(
            opener_returning(
                decision_body(
                    decision="BLOCK",
                    policyId="sys_undeclared_action",
                    reason="is not a declared action and no policy names it",
                ),
                calls=calls,
            )
        ).evaluate(
            agent_id="agt_billing", action="custom.company.operation", target="customer_123"
        )

        self.assertEqual(len(calls), 1)
        sent = json.loads(calls[0].data.decode())
        self.assertEqual(sent["action"], "custom.company.operation")
        self.assertEqual(result.decision, "BLOCK")
        self.assertFalse(result.allowed)

    def test_no_default_decision_exists_anywhere(self) -> None:
        """There is no way to obtain a Decision without a server response.

        Constructing one by hand is possible in Python and always will be; what
        matters is that no *client method* produces one from nothing. Every path
        out of `evaluate` is either a parsed 200 or an exception.
        """
        for exc in (
            urllib.error.URLError("refused"),
            socket.timeout("timed out"),
            http_error(500, {"message": "boom"}),
        ):
            with self.subTest(failure=type(exc).__name__):
                with self.assertRaises(Exception) as ctx:
                    client(opener_raising(exc)).evaluate(**ACTION)
                self.assertNotIsInstance(ctx.exception, type(None))
                self.assertFalse(hasattr(ctx.exception, "allowed"))


if __name__ == "__main__":
    unittest.main()
