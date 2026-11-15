"""The Oathrion Python client.

WHAT IT IS
----------
A thin, typed HTTP client for one endpoint: ``POST /api/evaluate``. It manages
the base URL, the credential, serialisation, timeouts and error typing, and it
does nothing else.

WHAT IT IS FORBIDDEN FROM BEING
-------------------------------
A second policy engine. There is no rule evaluation in this module, no cache of
previous decisions, no local allow-list, no offline mode, and no default
decision of any kind::

    your agent -> OathrionClient -> POST /api/evaluate -> Oathrion decision engine

Three specific temptations are closed off, because each has shipped in real
authorization clients and each is a fail-open:

1. Turning a transport failure into a decision. A timeout means Oathrion did not
   answer. It does not mean yes, and it does not mean no. It raises.
2. Turning APPROVAL_REQUIRED into ALLOW. ``Decision.allowed`` is true only for
   ALLOW, and ``require_allow`` raises on a hold exactly as on a block.
3. Caching an ALLOW. Policies, mandates, daily spend counters and agent status
   all change between calls; a cached yes is a decision taken under conditions
   that no longer hold.

DEPENDENCIES
------------
The standard library only — ``urllib.request``, not ``requests``. An
authorization client is the last place you want a dependency tree, and this way
``pip install`` cannot fail on a machine that is about to make security
decisions.

A DECISION IS NOT ENFORCEMENT
-----------------------------
When you ask Oathrion over HTTP and then act on the answer yourself, Oathrion cannot
physically stop your process from ignoring the answer. What it guarantees is
that the decision is authoritative, attributable and recorded: a BLOCK you chose
to override is a BLOCK in the audit log. For Oathrion to sit physically between the
agent and the tool, use the MCP gateway. ``docs/security-model.md`` states both
guarantees side by side rather than letting the stronger one be assumed.
"""

from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any, Dict, Mapping, Optional

from .errors import (
    OathrionConnectionError,
    OathrionHttpError,
    OathrionNotAllowedError,
    OathrionProtocolError,
    OathrionTimeoutError,
)

#: The only three values Oathrion may return. Anything else is a protocol error.
DECISIONS = ("ALLOW", "BLOCK", "APPROVAL_REQUIRED")

DEFAULT_TIMEOUT = 10.0


@dataclass(frozen=True)
class Decision:
    """A decision Oathrion made. Only ever constructed from a real response."""

    decision: str
    reason: str = ""
    policy_id: Optional[str] = None
    policy_name: Optional[str] = None
    risk: Optional[str] = None
    approval_id: Optional[str] = None
    request_id: Optional[str] = None
    #: The untouched response body, for fields this dataclass does not name.
    raw: Dict[str, Any] = field(default_factory=dict)

    # The three properties are defined exhaustively against `decision` rather
    # than as negations of one another. `blocked = not allowed` would have
    # quietly made a hold look like a block, and `allowed = not blocked` would
    # have made a hold look like permission.

    @property
    def allowed(self) -> bool:
        """True only for ALLOW. APPROVAL_REQUIRED is not permission."""
        return self.decision == "ALLOW"

    @property
    def blocked(self) -> bool:
        return self.decision == "BLOCK"

    @property
    def pending_approval(self) -> bool:
        return self.decision == "APPROVAL_REQUIRED"


class OathrionClient:
    """Client for Oathrion's generic authorization endpoint.

    ::

        from oathrion import OathrionClient

        client = OathrionClient(base_url="http://127.0.0.1:5000", api_key="...")
        decision = client.evaluate(
            agent_id="agt_billing",
            action="stripe.refund",
            target="customer_123",
            input={"amount": 75, "currency": "EUR"},
        )
        if decision.allowed:
            stripe.Refund.create(...)
    """

    def __init__(
        self,
        base_url: str,
        api_key: str,
        *,
        timeout: float = DEFAULT_TIMEOUT,
        agent_id: Optional[str] = None,
        opener: Optional[Any] = None,
    ) -> None:
        if not base_url:
            raise ValueError("OathrionClient requires a base_url.")
        if not api_key:
            raise ValueError("OathrionClient requires an api_key.")

        # Normalised once so joining a path cannot silently drop a segment when
        # the caller omits or doubles the trailing slash.
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout = timeout
        self.default_agent_id = agent_id
        #: Injected in tests. Defaults to `urllib.request.urlopen`.
        self._opener = opener or urllib.request.urlopen

    # ------------------------------------------------------------------ #

    def evaluate(
        self,
        *,
        action: str,
        target: str,
        agent_id: Optional[str] = None,
        input: Optional[Mapping[str, Any]] = None,
        persist: bool = False,
        **extra: Any,
    ) -> Decision:
        """Submit an action for a decision.

        Returns ONLY when Oathrion returned a decision. Anything else raises — see
        ``errors.py`` for why a failure is structurally incapable of being a
        decision in this SDK.

        ``target`` is required, deliberately. A policy authorises an action *on
        something*, and an omitted target matches no target-scoped rule — so a
        convenient default would be a fail-open produced by convenience.

        ``persist`` — READ THIS IF YOU ARE BUILDING AN APPROVAL FLOW
        -----------------------------------------------------------
        Default ``False``, which makes the call a DRY RUN: Oathrion evaluates the
        action, records nothing, and tells you what it *would* decide.

        That has a consequence which is easy to get wrong. A dry run returning
        APPROVAL_REQUIRED creates **no approval record**, so nothing appears in
        anybody's review queue and there is nothing for a human to approve. An
        integrator who reads that decision, shows the user "waiting for
        approval" and waits will wait forever — the request was never filed.
        ``approval_id`` is ``None`` on a dry run for exactly this reason, and
        that is the signal to check.

        Pass ``persist=True`` when the action is real. The evaluation is then
        recorded, an ALLOW is dispatched through the gateway, and an
        APPROVAL_REQUIRED files a real approval whose ``approval_id`` a reviewer
        can act on.

        Use the default for exploring rules; use ``persist=True`` for anything a
        human is expected to answer.
        """
        if not action:
            raise ValueError("evaluate() requires an `action` verb.")
        if not target:
            raise ValueError(
                "evaluate() requires a `target`: Oathrion authorises an action on a "
                "specific resource, and omitting it would evaluate against no "
                "target-scoped rule."
            )

        body: Dict[str, Any] = {"action": action, "target": target, **extra}
        if persist:
            body["persist"] = True
        resolved_agent = agent_id or self.default_agent_id
        if resolved_agent is not None:
            body["agentId"] = resolved_agent
        if input is not None:
            body["input"] = dict(input)

        payload = self._post("/api/evaluate", body)
        return self._parse_decision(payload)

    def require_allow(self, **kwargs: Any) -> Decision:
        """Evaluate, and raise ``OathrionNotAllowedError`` unless the answer is ALLOW.

        For call sites where continuing without permission is not a meaningful
        option, so forgetting to check the result is impossible rather than
        merely discouraged. It raises on APPROVAL_REQUIRED too.
        """
        decision = self.evaluate(**kwargs)
        if not decision.allowed:
            raise OathrionNotAllowedError(decision)
        return decision

    def health(self) -> Dict[str, Any]:
        """Liveness check against the server's health endpoint."""
        return self._request("GET", "/api/health", None)

    # ------------------------------------------------------------------ #

    def _post(self, path: str, body: Mapping[str, Any]) -> Any:
        return self._request("POST", path, body)

    def _request(self, method: str, path: str, body: Optional[Mapping[str, Any]]) -> Any:
        url = f"{self.base_url}{path}"
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(url, data=data, method=method)
        request.add_header("authorization", f"Bearer {self.api_key}")
        if data is not None:
            request.add_header("content-type", "application/json")

        try:
            with self._opener(request, timeout=self.timeout) as response:
                raw = response.read()
                status = getattr(response, "status", None) or response.getcode()
        except urllib.error.HTTPError as exc:
            # urllib raises on 4xx/5xx, so the error body is read from the
            # exception rather than from a response object.
            raw = exc.read() if hasattr(exc, "read") else b""
            raise OathrionHttpError(
                exc.code,
                _loads_or_none(raw),
                _error_message(_loads_or_none(raw), exc.code),
            ) from exc
        except socket.timeout as exc:
            raise OathrionTimeoutError(self.timeout, exc) from exc
        except urllib.error.URLError as exc:
            # A timeout surfaces here too on some platforms, wrapped in URLError.
            if isinstance(exc.reason, socket.timeout):
                raise OathrionTimeoutError(self.timeout, exc) from exc
            raise OathrionConnectionError(
                f"Could not reach Oathrion at {self.base_url}. No decision was "
                f"received, so the action is NOT authorised.",
                exc,
            ) from exc
        except (TimeoutError, socket.gaierror, ConnectionError, OSError) as exc:
            if isinstance(exc, TimeoutError):
                raise OathrionTimeoutError(self.timeout, exc) from exc
            raise OathrionConnectionError(
                f"Could not reach Oathrion at {self.base_url}. No decision was "
                f"received, so the action is NOT authorised.",
                exc,
            ) from exc

        payload = _loads_or_none(raw)
        if status >= 400:
            # Reached when the opener does not raise for error statuses, which
            # is the case for some custom openers and for injected test doubles.
            raise OathrionHttpError(status, payload, _error_message(payload, status))
        return payload

    def _parse_decision(self, payload: Any) -> Decision:
        """Validate that a 200 body really is a decision. Refuses to guess."""
        if not isinstance(payload, dict):
            raise OathrionProtocolError("Oathrion returned a 200 with no JSON object body.", payload)

        decision = payload.get("decision")
        if decision not in DECISIONS:
            raise OathrionProtocolError(
                f"Oathrion returned a 200 whose \"decision\" is {decision!r}, which is "
                f"not one of {', '.join(DECISIONS)}.",
                payload,
            )

        return Decision(
            decision=decision,
            reason=payload.get("reason") or "",
            policy_id=payload.get("policyId"),
            policy_name=payload.get("policyName"),
            risk=payload.get("risk"),
            approval_id=payload.get("approvalId"),
            request_id=payload.get("requestId"),
            raw=payload,
        )


def _loads_or_none(raw: bytes) -> Any:
    """Parse defensively.

    A proxy in front of Oathrion can return HTML for a 502, and letting
    ``json.loads`` raise there would surface a bare ``JSONDecodeError`` that
    tells the caller nothing about what actually happened.
    """
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None


def _error_message(payload: Any, status: int) -> str:
    if isinstance(payload, dict):
        message = payload.get("message") or payload.get("error")
        if message:
            return str(message)
    return f"Oathrion returned HTTP {status}."
