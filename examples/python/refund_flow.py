"""Oathrion from Python: the three answers, and what to do with each.

    python3 examples/python/refund_flow.py

Expects OATHRION_URL and OATHRION_API_KEY, and an agent and policy that already exist.
``bash examples/quickstart/quickstart.sh`` creates exactly those.

The SDK has no dependencies — standard library only — so there is nothing to
install beyond having the ``sdk/python`` directory on the path.

The shape to take away is the explicit three-way branch. There are three
decisions, and code that handles two of them has an unhandled case that
executes by default.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "sdk" / "python"))

from oathrion import OathrionClient, OathrionError, OathrionNotAllowedError  # noqa: E402

BASE_URL = os.environ.get("OATHRION_URL", "http://127.0.0.1:5000")
API_KEY = os.environ.get("OATHRION_API_KEY")
AGENT_ID = os.environ.get("OATHRION_AGENT_ID", "agt_support_bot")

if not API_KEY:
    print("Set OATHRION_API_KEY. Run examples/quickstart/quickstart.sh first if you need a server.")
    raise SystemExit(3)

placet = OathrionClient(base_url=BASE_URL, api_key=API_KEY, agent_id=AGENT_ID)


def issue_refund(customer: str, amount: float) -> None:
    """Stands in for the thing that actually moves money."""
    print(f"      -> refund of {amount} EUR issued to {customer}")


def attempt_refund(customer: str, amount: float) -> None:
    print(f"\n  {amount} EUR to {customer}")

    try:
        decision = placet.evaluate(
            action="stripe.refund",
            target=customer,
            input={"amount": amount, "currency": "EUR", "category": "refunds"},
            # A real refund is about to happen, so this is not a "what would you
            # say if" question. Without persist the decision is not recorded and
            # an APPROVAL_REQUIRED files no approval for anyone to act on.
            persist=True,
        )
    except OathrionError as error:
        # Reaching Oathrion failed. This is NOT a BLOCK, and the difference matters:
        # a block is an answer, this is the absence of one. Nothing may proceed.
        # "The authorization service was down" has never been a good reason for
        # an agent to have moved money on its own judgement.
        print(f"      NO DECISION — {error}")
        print("      the refund does NOT happen; nothing authorized it.")
        return

    # Three decisions, three branches, and a final `else` that refuses. Writing
    # this as `if decision.allowed: ... else: ...` would work today and would
    # quietly do the wrong thing the day a fourth decision is added.
    if decision.decision == "ALLOW":
        print(f"      ALLOW — {decision.reason}")
        issue_refund(customer, amount)

    elif decision.decision == "APPROVAL_REQUIRED":
        # Not a failure, and not permission either. Someone has to answer.
        print(f"      APPROVAL_REQUIRED — {decision.reason}")
        print(f"      approval {decision.approval_id or '(none filed)'} is waiting for a human.")

    elif decision.decision == "BLOCK":
        print(f"      BLOCK — {decision.reason}")
        print(f"      policy: {decision.policy_name or 'unnamed'}")

    else:
        # Unreachable today, because the SDK rejects a decision string it does
        # not recognise before returning. Present because "we did not recognise
        # the answer" must never fall through to the permissive branch.
        raise AssertionError(f"unhandled decision: {decision.decision!r}")


def main() -> None:
    print(f"Oathrion at {BASE_URL}, acting as {AGENT_ID}")

    attempt_refund("cus_12345", 75)   # under the ceiling
    attempt_refund("cus_12345", 750)  # over it

    # `require_allow` is the same call for places where continuing without
    # permission is not a meaningful option. It raises on BLOCK *and* on
    # APPROVAL_REQUIRED, so forgetting to check is impossible rather than
    # merely discouraged.
    print("\n  require_allow on a 900 EUR refund")
    try:
        placet.require_allow(
            action="stripe.refund",
            target="cus_12345",
            input={"amount": 900, "currency": "EUR", "category": "refunds"},
            persist=True,
        )
        print("      allowed")
    except OathrionNotAllowedError as error:
        print(f"      raised: {error}")


if __name__ == "__main__":
    main()
