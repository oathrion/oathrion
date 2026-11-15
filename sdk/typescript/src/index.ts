/**
 * Oathrion TypeScript SDK — runtime authorization for AI agents.
 *
 *     AI can act. You decide what it can do.
 *
 * CHANGE THE ENDPOINT, NOT YOUR AGENT.
 *
 *     import { OathrionClient } from "@oathrion/sdk";
 *
 *     const placet = new OathrionClient({
 *       baseUrl: process.env.OATHRION_URL!,
 *       apiKey: process.env.OATHRION_API_KEY!,
 *     });
 *
 *     const decision = await placet.evaluate({
 *       agentId: "support-agent",
 *       action: "stripe.refund",
 *       target: "customer_123",
 *       input: { amount: 75, currency: "EUR" },
 *     });
 *
 *     if (decision.allowed) await stripe.refunds.create(...);
 *
 * The client is framework-agnostic on purpose: it knows about agents, actions,
 * policies and decisions, and nothing about LangChain, n8n, CrewAI or MCP.
 * Those are adapters that build an `AgentAction` — see `examples/`.
 */

export { OathrionClient } from "./client";
export type { OathrionClientOptions, DecisionResult } from "./client";

export {
  OathrionConnectionError,
  OathrionError,
  OathrionHttpError,
  OathrionNotAllowedError,
  OathrionProtocolError,
  OathrionTimeoutError,
} from "./errors";

export type { AgentAction, ApiErrorResponse, Decision, DecisionResponse } from "./types";
export { DECISIONS, isAllowed, isBlocked, needsApproval } from "./types";

/* ------------------------- noms hérités du renommage ---------------------- */

/**
 * Les anciens noms, toujours exportés.
 *
 * Ce SDK **entre dans le code du client** : un `import { PlacetClient }` vit dans son
 * dépôt, pas dans le nôtre. Renommer sans alias casserait sa compilation à la mise à
 * jour, pour un gain purement cosmétique — et il n'y a aucune raison de lui imposer ça.
 *
 * C'est la même règle que pour les variables d'environnement (`server/env-compat.ts`) et
 * les en-têtes HTTP (`shared/wire-headers.ts`) : le nom courant est le vrai, l'ancien
 * continue de fonctionner, et il disparaîtra à une version majeure annoncée. La seule
 * différence est qu'ici il n'y a rien à journaliser — un alias de type n'a pas de moment
 * d'exécution où prévenir.
 *
 * L'annotation de dépréciation est ce qui prévient : l'éditeur du client barre le nom et affiche
 * le remplaçant, au moment où il écrit la ligne plutôt qu'au moment où il déploie.
 */

/** @deprecated Renommé en `OathrionClient`. Cet alias disparaîtra à la 2.0. */
export { OathrionClient as PlacetClient } from "./client";
/** @deprecated Renommé en `OathrionClientOptions`. */
export type { OathrionClientOptions as PlacetClientOptions } from "./client";
/** @deprecated Renommé en `OathrionError`. */
export { OathrionError as PlacetError } from "./errors";
/** @deprecated Renommé en `OathrionConnectionError`. */
export { OathrionConnectionError as PlacetConnectionError } from "./errors";
/** @deprecated Renommé en `OathrionTimeoutError`. */
export { OathrionTimeoutError as PlacetTimeoutError } from "./errors";
/** @deprecated Renommé en `OathrionHttpError`. */
export { OathrionHttpError as PlacetHttpError } from "./errors";
/** @deprecated Renommé en `OathrionProtocolError`. */
export { OathrionProtocolError as PlacetProtocolError } from "./errors";
/** @deprecated Renommé en `OathrionNotAllowedError`. */
export { OathrionNotAllowedError as PlacetNotAllowedError } from "./errors";
