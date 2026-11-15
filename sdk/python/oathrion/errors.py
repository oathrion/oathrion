"""Typed failures for the Oathrion Python client.

THE ONE RULE THIS MODULE ENFORCES
---------------------------------
A failure is never a decision. Every class here is an exception, none of them
carries a ``decision`` attribute, and there is no code path in this SDK that
converts one into ALLOW, BLOCK or APPROVAL_REQUIRED.

That asymmetry is deliberate and it is the whole safety argument for the
client. If a connection timeout produced a synthesised BLOCK, the SDK would be
answering authorization questions on its own — and the day somebody decided the
synthesised default should be ALLOW "so the agent keeps working during an
outage", the change would look like a one-word edit rather than like the
removal of the control plane. Making a failure structurally incapable of being
a decision closes that door.

A caller therefore has exactly two outcomes to handle: a ``Decision`` that Oathrion
produced, or an exception. There is no third state.
"""

from __future__ import annotations

from typing import Any, Optional


class OathrionError(Exception):
    """Base class, so callers can write ``except OathrionError``."""


class OathrionConnectionError(OathrionError):
    """No HTTP response was produced at all.

    DNS failure, refused connection, TLS failure. The action is NOT authorised,
    because nothing authorised it.
    """

    def __init__(self, message: str, cause: Optional[BaseException] = None) -> None:
        super().__init__(message)
        self.cause = cause


class OathrionTimeoutError(OathrionConnectionError):
    """The request exceeded the client timeout."""

    def __init__(self, timeout: float, cause: Optional[BaseException] = None) -> None:
        super().__init__(
            f"Oathrion did not answer within {timeout}s. No decision was received, "
            f"so the action is NOT authorised.",
            cause,
        )
        self.timeout = timeout


class OathrionHttpError(OathrionError):
    """Oathrion answered, and the answer was not a decision.

    401/403 (credential), 400 (payload), 429 (rate limit or quota), 5xx. The
    status and Oathrion's own error code are exposed so a caller can branch — but no
    branch of that decision tree may end in "proceed anyway".
    """

    def __init__(self, status: int, body: Optional[dict], message: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body or {}
        self.code = self.body.get("code") or f"http_{status}"
        self.request_id = self.body.get("requestId")

    @property
    def is_auth_failure(self) -> bool:
        """True for 401/403: the credential, not the request, is the problem."""
        return self.status in (401, 403)

    @property
    def is_request_invalid(self) -> bool:
        """True for 400: Oathrion could not interpret the request."""
        return self.status == 400


class OathrionProtocolError(OathrionError):
    """A 200 whose body this SDK cannot interpret as a decision.

    Raised rather than coerced. A missing ``decision``, or one outside the known
    three, means version skew or a proxy rewriting responses — and the safe
    reading of "I do not understand the answer" is not to pick one.
    """

    def __init__(self, message: str, payload: Any = None) -> None:
        super().__init__(message)
        self.payload = payload


class OathrionNotAllowedError(OathrionError):
    """Raised by ``require_allow`` when the decision was not ALLOW.

    Raised for APPROVAL_REQUIRED exactly as for BLOCK. A held action is waiting
    for a human and has NOT been authorised; treating "waiting" as permission is
    the single most likely way to misuse this client.
    """

    def __init__(self, decision: "Decision") -> None:  # noqa: F821
        if decision.decision == "APPROVAL_REQUIRED":
            message = f"Action held for human approval and NOT authorised: {decision.reason}"
        else:
            message = f"Action blocked: {decision.reason}"
        super().__init__(message)
        self.decision = decision
