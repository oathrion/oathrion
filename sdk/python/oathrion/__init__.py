"""Oathrion Python SDK — runtime authorization for AI agents.

    AI can act. You decide what it can do.

CHANGE THE ENDPOINT, NOT YOUR AGENT.

    from oathrion import OathrionClient

    client = OathrionClient(base_url=os.environ["OATHRION_URL"],
                        api_key=os.environ["OATHRION_API_KEY"])

    decision = client.evaluate(
        agent_id="support-agent",
        action="stripe.refund",
        target="customer_123",
        input={"amount": 75, "currency": "EUR"},
    )

    if decision.allowed:
        stripe.Refund.create(...)

Framework-agnostic on purpose: it knows about agents, actions, policies and
decisions, and nothing about LangChain, CrewAI, n8n or MCP. Those are adapters
that build the same call — see `examples/`.
"""

from .client import DECISIONS, OathrionClient, Decision
from .errors import (
    OathrionConnectionError,
    OathrionError,
    OathrionHttpError,
    OathrionNotAllowedError,
    OathrionProtocolError,
    OathrionTimeoutError,
)

__all__ = [
    "OathrionClient",
    "Decision",
    "DECISIONS",
    "OathrionError",
    "OathrionConnectionError",
    "OathrionTimeoutError",
    "OathrionHttpError",
    "OathrionProtocolError",
    "OathrionNotAllowedError",
]

# ----------------------------- noms hérités -------------------------------
#
# Ce SDK entre dans le code du client : un `from placet import PlacetClient` vit dans son
# dépôt, pas dans le nôtre. Les anciens noms restent donc des alias, exactement comme
# pour les variables d'environnement et les en-têtes HTTP — le nom courant est le vrai,
# l'ancien continue de fonctionner, et il disparaîtra à une version majeure annoncée.
#
# Des alias de module et non des sous-classes : `except PlacetError` doit attraper ce que
# le code courant lève, et une sous-classe ne l'attraperait pas dans l'autre sens.
PlacetClient = OathrionClient
PlacetError = OathrionError
PlacetConnectionError = OathrionConnectionError
PlacetTimeoutError = OathrionTimeoutError
PlacetHttpError = OathrionHttpError
PlacetProtocolError = OathrionProtocolError
PlacetNotAllowedError = OathrionNotAllowedError

__all__ += [
    "PlacetClient",
    "PlacetError",
    "PlacetConnectionError",
    "PlacetTimeoutError",
    "PlacetHttpError",
    "PlacetProtocolError",
    "PlacetNotAllowedError",
]

__version__ = "0.1.0a1"
