/**
 * MCP method router — the Oathrion half of the gateway.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO HOLD
 * ------------------------------------------
 * `tools/call` reaches a tool by exactly one route: `AgentGateway.execute()`.
 * This module never imports a tool implementation, never calls
 * `registry.resolve(...).execute(...)`, and holds no dispatch logic of its own.
 * It uses the registry only to *enumerate* verbs for `tools/list`.
 *
 * That restraint is the whole point. An MCP surface is the natural place to
 * accidentally build a second path to the tools — it has its own request shape,
 * its own error model and its own notion of a "tool", so re-implementing
 * dispatch here would feel local and reasonable. It would also mean the policy
 * engine, the mandate ceiling, the approval queue, the atomic run claim and the
 * audit chain all apply to REST callers and not to MCP callers, which is the
 * most valuable bug an attacker could hope to find in this product.
 *
 * `server/test/mcp-single-path.test.ts` asserts the invariant structurally as
 * well as behaviourally.
 *
 * WHERE THE CALLER'S IDENTITY COMES FROM
 * --------------------------------------
 * The organisation comes from the credential and from nothing else: the caller
 * receives an already tenant-scoped `Repositories` and `AgentGateway`, so there
 * is no tenant parameter in this file to get wrong. The audit actor is the
 * verified identity behind the credential.
 *
 * `io.modelcontextprotocol/clientInfo` is read for nothing. The spec says so
 * itself — "self-reported by the client and is not verified by the protocol
 * ... SHOULD NOT rely on it for security decisions" — and it is exactly the
 * field an agent would use to claim to be someone else.
 */

import { argumentProblem, argumentsFor } from "./action-arguments";
import type { AgentGateway } from "../gateway/agent-gateway";
import type { ToolRegistry } from "../gateway/tool-registry";
import { STDIO_TOOL_ID_PREFIX, wrappedCard } from "../gateway/wrapped-catalog";
import type { Repositories } from "../repositories/types";
import type { Identity } from "../auth";
import { resolveActingAgent } from "../identity/agent-binding";
import { can } from "@shared/roles";
import type { Capability } from "@shared/roles";
import type { Agent } from "@shared/types";
import { toolsForAgent, withheldWrappedTools, OATHRION_META_KEY } from "./tool-catalog";
import {
  OATHRION_RPC_ERRORS,
  JSON_RPC_ERRORS,
  META_KEYS,
  PROTOCOL_VERSION,
  RpcFault,
  SUPPORTED_PROTOCOL_VERSIONS,
  isPlainObject,
  negotiateLegacyVersion,
  type ProtocolMode,
  type RpcRequest,
} from "./protocol";

/** Everything a method handler is allowed to touch. */
export interface McpContext {
  identity: Identity;
  /** Tenant-scoped. Built from `identity.organizationId` by the route. */
  repositories: Repositories;
  /** Tenant-scoped. The ONLY way this module reaches a tool. */
  gateway: AgentGateway;
  registry: ToolRegistry;
  /** Caller-asserted agent id, from the `X-Oathrion-Agent-Id` header. */
  declaredAgentId: string | null;
  /**
   * Re-reads connector state when it is older than its freshness window, before tools
   * are listed or resolved. Optional so a test may build a context without connectors.
   */
  refreshTools?: () => Promise<void>;
  /** The revision the request speaks. Absent means current (2026-07-28). */
  protocol?: ProtocolMode;
}

/** Server identity, echoed in every result's `_meta`. */
/* La version du produit ; `version-coherence.test.ts` refuse qu'elle diverge de `package.json`. */
const SERVER_INFO = { name: "oathrion", version: "0.1.0-preview.1" } as const;

/**
 * How long a client may cache a tool listing: not at all.
 *
 * `ttlMs: 0` looks wasteful and is deliberate. A tool listing is a statement
 * about what an agent is currently permitted to attempt, and permissions are
 * revocable — an operator switching off `execute:payments` expects that to take
 * effect now, not when a cache expires. A cached listing would keep advertising
 * a revoked capability to a model, which is the one direction of staleness that
 * matters here.
 *
 * `cacheScope: "private"` for the same reason, and it is the more important of
 * the two: the listing is derived from the caller's credential and the agent it
 * declared, so a shared proxy caching it under `"public"` could serve one
 * agent's capabilities to another. The protocol's own definition of `"public"`
 * is "does not contain user-specific data", which this plainly does.
 */
const LISTING_CACHE = { ttlMs: 0, cacheScope: "private" } as const;

/**
 * `server/discover` describes the software, not the caller, so it is cacheable
 * across authorization contexts. Nothing in the payload varies by credential —
 * asserted by a test, because that is the property that makes `"public"` safe.
 */
const DISCOVER_CACHE = { ttlMs: 300_000, cacheScope: "public" } as const;

const INSTRUCTIONS = [
  "Oathrion is an authorization layer between an AI agent and real-world actions.",
  "Every tools/call is evaluated against organisation policy and the calling agent's mandate before anything runs.",
  "A call may be allowed and executed, held for human approval, or blocked outright.",
  "A held or blocked call returns isError: true and never reaches the underlying tool; the reason names the rule that decided.",
  "A held call is not a failure to retry: retrying will be held again. Wait for the approval to be resolved by a human.",
  "Tools listed here are the ones this agent is permitted to attempt. Being listed is not a guarantee the call will be allowed, because policies also depend on the arguments.",
  "Built-in demonstration tools are SIMULATED and say so in their result. Connector tools (github.*, slack.*, linear.*) make REAL calls to the connected service: an executed call has happened there.",
].join(" ");

/** Fields Oathrion derives for itself and therefore refuses to be told. */
const SPOOFABLE_FIELDS = ["actor", "identity", "organizationId", "organisationId", "role", "agentId", "approved", "decision"];

function requireCapabilityOrFault(identity: Identity, capability: Capability, method: string): void {
  if (can(identity.role, capability)) return;
  throw new RpcFault(
    OATHRION_RPC_ERRORS.forbidden,
    `Role "${identity.role}" cannot call "${method}". Required capability: ${capability}.`,
    403,
  );
}

/**
 * Refuses any attempt to supply an identity or a verdict as data.
 *
 * The REST surface has `rejectsClientActor` for the same reason: `actor` used to
 * be a body field written straight into the audit trail, so any caller could
 * attribute an action to anyone. The MCP surface needs the same guard, applied
 * to tool arguments as well as params, and it is stricter than the REST one:
 * `agentId` is refused here because the agent is declared in exactly one place
 * (the header), and `approved` / `decision` are refused because an argument
 * named like a verdict is an attempt to smuggle one.
 *
 * Refused rather than dropped, so an integration sending it is told.
 */
function rejectSpoofedIdentity(record: Record<string, unknown>, where: string): void {
  for (const field of SPOOFABLE_FIELDS) {
    if (field in record) {
      throw new RpcFault(
        OATHRION_RPC_ERRORS.identityNotAccepted,
        `"${field}" is not accepted in ${where}. Oathrion derives the caller identity from the presented credential and the decision from policy; neither can be supplied by the caller.`,
        400,
      );
    }
  }
}

/**
 * Resolves the agent this call acts as.
 *
 * The lookup goes through the tenant-scoped repository, which is what makes
 * cross-tenant access impossible rather than merely checked: an agent belonging
 * to another organisation is not "rejected", it is not found, because the query
 * cannot see it. The error text is identical in both cases on purpose — telling
 * a caller "that agent exists but is not yours" confirms the existence of
 * another tenant's resource.
 *
 * WHAT P6 CHANGED, AND WHAT IT DID NOT
 * ------------------------------------
 * `X-Oathrion-Agent-Id` is still caller-asserted, but it is no longer the only
 * input. The header is now passed to `resolveActingAgent`, the same chokepoint
 * the four REST entry points use, and when the presented credential is bound to
 * an agent the header is never *used* — only compared, and a mismatch is
 * refused. A bound MCP credential therefore cannot act as another agent no
 * matter what it sends.
 *
 * Still true, and stated rather than glossed: a credential with no binding can
 * name any agent in its own organisation, exactly as before. That is the
 * residual gap; `OATHRION_REQUIRE_AGENT_BINDING=true` closes it and ships off by
 * default. See `server/identity/agent-binding.ts` for why.
 */
async function resolveAgent(ctx: McpContext): Promise<Agent> {
  const outcome = resolveActingAgent(ctx.identity, ctx.declaredAgentId);
  if (!outcome.ok) {
    /*
     * `agent_not_declared` keeps the code and the wording this path has always
     * returned, because it is the same condition and MCP clients key on it. A
     * binding refusal is `forbidden`: the caller is authenticated and known,
     * and the request is refused on identity grounds rather than for naming
     * something unresolvable.
     */
    if (outcome.refusal === "agent_not_declared") {
      throw new RpcFault(
        OATHRION_RPC_ERRORS.agentUnresolved,
        'No agent declared. Send the Oathrion agent id in the "X-Oathrion-Agent-Id" header; Oathrion authorises actions per agent, so there is no default.',
        400,
      );
    }
    throw new RpcFault(OATHRION_RPC_ERRORS.forbidden, outcome.reason, 403);
  }

  /*
   * Looked up by the resolved id, not by the header. When the credential is
   * bound this is the credential's own agent, so a bound key cannot even probe
   * for the existence of another agent through this route.
   */
  const agent = await ctx.repositories.agents.findById(outcome.agentId);
  if (!agent) {
    throw new RpcFault(
      OATHRION_RPC_ERRORS.agentUnresolved,
      `Unknown agent "${outcome.agentId}".`,
      404,
    );
  }
  return agent;
}

function textResult(text: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    _meta: { [META_KEYS.serverInfo]: SERVER_INFO },
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/* Argument handling                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Turns tool arguments into the `(target, metadata)` pair the engine expects.
 *
 * Validated here rather than trusted from `inputSchema`, because a JSON Schema
 * advertised to a model is a hint to the model and not an enforcement boundary.
 * A caller can send anything at all; only this function decides what Oathrion reads.
 *
 * Unknown keys are refused rather than ignored. An ignored unknown key means a
 * model can believe it constrained a call — `{"max_amount": 100}` — while Oathrion
 * evaluated an unconstrained one.
 */
const KNOWN_ARGUMENTS = ["target", "reason", "amount", "currency", "category"];

/**
 * HTTP status for a refused request.
 *
 * Every fault raised while validating a call uses `400`, which gives the
 * endpoint one property worth stating plainly and asserting in a test:
 *
 *   **HTTP 200 from `/api/mcp` always means Oathrion processed the call and the
 *   body carries a decision. It never means "refused".**
 *
 * Bare JSON-RPC would allow `200` with an `error` object, and that is legal,
 * but it would make "was this action evaluated?" unanswerable from the status
 * line alone — for a control plane whose logs are evidence, that is a bad
 * trade. A blocked action still returns `200`, because a BLOCK *is* a decision.
 */
const REFUSED = 400;

function readArguments(raw: unknown, action = ""): { target: string; metadata: Record<string, unknown> } {
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      '"params.arguments" must be an object.',
      REFUSED,
    );
  }
  const args = isPlainObject(raw) ? raw : {};

  rejectSpoofedIdentity(args, "tool arguments");

  /*
   * Les arguments d'un verbe de connecteur s'AJOUTENT aux arguments communs, verbe par
   * verbe : `title` est accepté pour `github.issue.create` et refusé pour
   * `slack.message.post`. Voir `action-arguments.ts`.
   */
  const declared = argumentsFor(action)?.args ?? {};
  const accepted = [...KNOWN_ARGUMENTS, ...Object.keys(declared)];
  const unknown = Object.keys(args).filter((key) => !accepted.includes(key));
  if (unknown.length > 0) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      `Unknown argument(s): ${unknown.join(", ")}. Accepted: ${accepted.join(", ")}. Oathrion refuses arguments it does not evaluate, so a caller cannot believe it constrained a call that was in fact unconstrained.`,
      REFUSED,
    );
  }

  const target = args.target;
  if (typeof target !== "string" || target.trim().length === 0) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      '"target" is required and must be a non-empty string: it is what policies match on.',
      REFUSED,
    );
  }

  /*
   * `amount` is validated for type but NOT for range. Negative, zero, NaN and
   * Infinity are deliberately passed through to the engine, which has explicit
   * tests for each (`shared/policy/negative-amount.test.ts`). Screening them
   * here would create a second, weaker definition of "valid amount" in front of
   * the one that is actually tested.
   *
   * The one exception is a non-number `amount`, which is refused: a string
   * "750" reaching a numeric comparison is how a threshold gets silently
   * skipped.
   */
  const metadata: Record<string, unknown> = {};
  if (args.amount !== undefined) {
    if (typeof args.amount !== "number") {
      throw new RpcFault(
        JSON_RPC_ERRORS.invalidParams,
        '"amount" must be a number, not a string. A quoted amount cannot be compared against a policy threshold.',
        REFUSED,
      );
    }
    metadata.amount = args.amount;
  }
  for (const key of ["currency", "category", "reason"] as const) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== "string") {
      throw new RpcFault(JSON_RPC_ERRORS.invalidParams, `"${key}" must be a string.`, REFUSED);
    }
    metadata[key] = value;
  }

  for (const [name, spec] of Object.entries(declared)) {
    const value = args[name];
    if (value === undefined) {
      if (spec.required) {
        throw new RpcFault(JSON_RPC_ERRORS.invalidParams, `"${name}" is required for ${action}.`, REFUSED);
      }
      continue;
    }
    const problem = argumentProblem(name, spec, value);
    if (problem !== null) throw new RpcFault(JSON_RPC_ERRORS.invalidParams, problem, REFUSED);
    metadata[name] = value;
  }

  return { target: target.trim(), metadata };
}

/** Au-delà, des arguments ne sont plus une instruction mais un transfert de données. */
const MAX_WRAPPED_ARGUMENTS_BYTES = 256 * 1024;

/**
 * Les arguments d'un outil d'un serveur ENVELOPPÉ (`oathrion wrap`).
 *
 * L'exception assumée à `readArguments` : Oathrion ne connaît pas la forme des arguments
 * de chaque serveur MCP, donc il ne peut pas en refuser les clés inconnues — elles sont
 * toutes « inconnues » de lui, et toutes attendues par l'enfant. Il les transmet donc
 * TELLES QUELLES, sous `metadata.arguments`, et ne prétend en évaluer aucune : la règle
 * porte sur le verbe et sur la cible `mcp://<serveur>/<outil>`, pas sur un champ qu'il
 * aurait deviné. C'est le même contrat que l'avertissement de `readArguments` — un appelant
 * ne doit jamais croire qu'Oathrion a contraint ce qu'il n'a pas lu — tenu autrement : en
 * ne lisant rien, et en le disant.
 *
 * Pas de `rejectSpoofedIdentity` ici : ces clés ne vont pas à Oathrion, elles vont à
 * l'enfant. Un outil a le droit d'avoir un argument `agentId` ; Oathrion ne le lit pas.
 */
function readWrappedArguments(raw: unknown, action: string): { target: string; metadata: Record<string, unknown> } {
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new RpcFault(JSON_RPC_ERRORS.invalidParams, '"params.arguments" must be an object.', REFUSED);
  }
  const args = isPlainObject(raw) ? raw : {};
  if (Buffer.byteLength(JSON.stringify(args), "utf8") > MAX_WRAPPED_ARGUMENTS_BYTES) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      `Arguments larger than ${String(MAX_WRAPPED_ARGUMENTS_BYTES / 1024)} KiB are refused.`,
      REFUSED,
    );
  }
  const wrapped = wrappedCard(action)!;
  return {
    target: `mcp://${wrapped.server}/${wrapped.original}`,
    metadata: { arguments: args },
  };
}

/* -------------------------------------------------------------------------- */
/* Methods                                                                    */
/* -------------------------------------------------------------------------- */

async function serverDiscover(): Promise<Record<string, unknown>> {
  return {
    supportedVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    // `tools` only. Advertising `resources`, `prompts` or `completions` would
    // promise surfaces this gateway does not implement.
    capabilities: { tools: {} },
    instructions: INSTRUCTIONS,
    ...DISCOVER_CACHE,
    _meta: { [META_KEYS.serverInfo]: SERVER_INFO },
  };
}

async function toolsList(ctx: McpContext): Promise<Record<string, unknown>> {
  requireCapabilityOrFault(ctx.identity, "read", "tools/list");
  const agent = await resolveAgent(ctx);
  await ctx.refreshTools?.();

  const withheld = withheldWrappedTools(ctx.registry, agent);
  return {
    tools: toolsForAgent(ctx.registry, agent),
    ...LISTING_CACHE,
    _meta: {
      [META_KEYS.serverInfo]: SERVER_INFO,
      /* Les outils enveloppés retenus : nom et raison seulement, pour que le relais puisse le dire. */
      ...(withheld.length > 0 ? { [OATHRION_META_KEY]: { withheld: withheld.map(({ name, verb, toolClass, scope }) => ({ name, verb, toolClass, scope })) } } : {}),
    },
  };
}

async function toolsCall(ctx: McpContext, request: RpcRequest): Promise<Record<string, unknown>> {
  /*
   * `execute` and not `read`. The capability is the right to *ask* the control
   * plane to run something — never the right to bypass it — so an `approver`,
   * who may release someone else's held action but must not originate one,
   * cannot call a tool here either. Separation of duties has to hold on both
   * surfaces or it holds on neither.
   */
  requireCapabilityOrFault(ctx.identity, "execute", "tools/call");

  rejectSpoofedIdentity(request.params, "params");

  const name = request.params.name;
  if (typeof name !== "string" || name.length === 0) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      '"params.name" must name the tool to call.',
      REFUSED,
    );
  }

  const agent = await resolveAgent(ctx);

  /*
   * An unlisted name is a "finding the tool" failure, which the spec says must
   * be a protocol error rather than a tool result. Resolved against the same
   * filtered listing the agent was shown, so the answer is consistent with
   * `tools/list` by construction.
   *
   * Note what this check is NOT: it is not the authorization. An agent that
   * somehow named a tool it cannot use would still be stopped by the permission
   * barrier inside the engine. This exists so the error is a clear "no such
   * tool for you" instead of a policy denial that leaks the tool's existence.
   */
  await ctx.refreshTools?.();
  const available = toolsForAgent(ctx.registry, agent);
  const tool = available.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new RpcFault(
      JSON_RPC_ERRORS.invalidParams,
      `Unknown tool "${name}" for agent "${agent.id}". Call tools/list to see the tools this agent may attempt.`,
      404,
    );
  }

  const { target, metadata } = wrappedCard(name)
    ? readWrappedArguments(request.params.arguments, name)
    : readArguments(request.params.arguments, name);

  /*
   * THE CHOKEPOINT. Identical to what POST /api/execute calls, with the actor
   * taken from the verified credential. There is no branch below this line that
   * reaches a tool by any other means.
   */
  const outcome = await ctx.gateway.execute({
    agentId: agent.id,
    action: name,
    target,
    metadata,
    actor: ctx.identity.name,
  });

  /*
   * Le mode se lit dans le résultat quand l'outil a tourné. Quand il n'a PAS tourné
   * (bloqué, retenu pour approbation), il n'y a pas de résultat, et l'ancien défaut —
   * « SIMULATED » — disait d'un connecteur réel qu'il était simulé. Il vient alors de la
   * fiche du catalogue que l'agent a reçue, qui porte la nature réelle de l'outil.
   */
  const mode = outcome.toolResult ? readMode(outcome.toolResult) : modeOfListedTool(tool);

  const governance = {
    decision: outcome.decision,
    reason: outcome.reason,
    policyId: outcome.policyId,
    policyName: outcome.policyName,
    riskLevel: outcome.riskLevel,
    executionId: outcome.executionId,
    approvalId: outcome.approvalId,
    /** Whether the underlying tool was invoked at all. */
    attempted: outcome.attempted,
    /** Whether its side effect completed. Never inferred from `attempted`. */
    succeeded: outcome.succeeded,
    runState: outcome.runState,
    toolId: outcome.toolId,
    /*
     * Which downstream actually ran, read from the tool result rather than
     * asserted here.
     *
     * This field used to be a hard-coded `simulated: true`. That was accurate
     * while every tool was in-process and constructed its own answer, but once
     * a tool can dispatch to a real downstream MCP server the constant becomes
     * a false statement in the governance payload and in the audit entry beside
     * it — the one place in the system that must never overstate or understate
     * what happened. It is now derived: a tool reports its own mode, and
     * anything that does not report one is treated as SIMULATED, which is the
     * safe direction to be wrong in when describing a side effect.
     */
    mode,
    simulated: mode === "SIMULATED",
    /*
     * Ce que l'agent doit croire de l'effet, en un mot. `unknown` : la requête a atteint le
     * service et aucune réponse n'est venue (`dispatched: "unknown"`) — elle a peut-être
     * été appliquée. Relevé en préparant le test d'un vrai client : le texte disait « the
     * execution did not complete », qu'un agent lit « rien ne s'est passé, je réessaie ».
     */
    effect: effectOf(outcome),
  };

  /*
   * `isError` is true for anything that is not a completed execution, including
   * APPROVAL_REQUIRED.
   *
   * Calling a held action a success would be the worst possible answer: the
   * model would report to the user that the refund was issued while it sits in
   * a queue. Between "the model thinks it failed when it is pending" and "the
   * model thinks it succeeded when nothing happened", only the first is
   * recoverable — which is why the text below states explicitly that a held
   * call must not be retried, since `isError` conventionally invites a retry.
   */
  const isError = !(outcome.decision === "ALLOW" && outcome.succeeded);

  const text =
    outcome.decision === "ALLOW" && outcome.succeeded
      ? `Allowed and executed (${describeMode(governance.mode)}). ${outcome.reason}`
      : outcome.decision === "APPROVAL_REQUIRED"
        ? `Held for human approval — the tool was NOT called. ${outcome.reason} Approval ${outcome.approvalId ?? "(none)"} is pending; do not retry, the same decision will be reached again. The action resumes automatically once a human approves it.`
        : outcome.decision === "BLOCK"
          ? `Blocked — the tool was NOT called. ${outcome.reason}`
          : governance.effect === "unknown"
            ? `Outcome UNKNOWN — the request reached the service but no answer came back, so it may ` +
              `have been applied. Do not retry: a retry could apply it twice. A person must check in ` +
              `the service and, only if nothing happened, attest it in Oathrion, which then allows a retry. ` +
              `${outcome.reason}`
            : `Allowed, but the execution failed: nothing was applied as far as Oathrion can tell ` +
              `(the tool was not reached, or the service answered with an error). ${outcome.reason}` +
              serverAnswer(governance.mode, outcome.toolResult);

  /*
   * Un serveur ENVELOPPÉ qui a exécuté : l'agent reçoit la réponse de l'enfant, telle
   * quelle. C'est ce qu'il appelait — un `create_issue` qui rendrait « Allowed and
   * executed » au lieu de l'issue créée serait inutilisable. `structuredContent` est
   * celui de l'enfant, ou absent : un client valide ce champ contre le `outputSchema` de
   * l'outil, et la gouvernance d'Oathrion n'y a pas sa place. Elle voyage dans `_meta`.
   */
  if (governance.mode === "STDIO_MCP" && outcome.decision === "ALLOW" && outcome.succeeded) {
    const child = (outcome.toolResult?.result ?? null) as Record<string, unknown> | null;
    return {
      content: Array.isArray(child?.content) ? child.content : [],
      ...(child && "structuredContent" in child ? { structuredContent: child.structuredContent } : {}),
      isError: false,
      _meta: { [META_KEYS.serverInfo]: SERVER_INFO, [OATHRION_META_KEY]: governance },
    };
  }

  return textResult(text, {
    isError,
    structuredContent: governance,
    _meta: { [META_KEYS.serverInfo]: SERVER_INFO, [OATHRION_META_KEY]: governance },
  });
}

/**
 * Reads the execution mode a tool reported.
 *
 * Deliberately conservative: only an explicit `"LOCAL_MCP"` counts as a real
 * dispatch. An unrecognised or missing value reports SIMULATED, so a tool that
 * forgets to declare itself understates its effect rather than claiming one.
 */
function readMode(toolResult: Record<string, unknown> | null): "SIMULATED" | "LOCAL_MCP" | "CONNECTOR" | "STDIO_MCP" {
  const data =
    toolResult && typeof toolResult.data === "object" && toolResult.data !== null
      ? (toolResult.data as Record<string, unknown>)
      : toolResult;
  if (data?.mode === "LOCAL_MCP") return "LOCAL_MCP";
  if (data?.mode === "STDIO_MCP") return "STDIO_MCP";
  /*
   * Un connecteur natif (GitHub, Slack, Linear) signe son résultat de son identifiant
   * (`ConnectorTool`). Sans cette branche, un message Slack réellement publié par MCP
   * était annoncé à l'agent « executed (SIMULATED) » avec `simulated: true` — et un agent
   * qui croit à une simulation peut recommencer pour de vrai. Relevé en faisant passer
   * un vrai client (Cursor) sur la passerelle.
   */
  if (typeof data?.connector === "string" && data.connector !== "") return "CONNECTOR";
  return "SIMULATED";
}

function effectOf(outcome: { attempted: boolean; succeeded: boolean; toolResult: Record<string, unknown> | null }): "applied" | "none" | "unknown" {
  if (outcome.succeeded) return "applied";
  if (outcome.toolResult?.dispatched === "unknown") return "unknown";
  return "none";
}

/*
 * CE QUE LE SERVEUR A RÉPONDU, quand il a répondu par une erreur (essai de bout en bout du
 * 8 novembre). L'agent ne lisait que « the execution failed » : il ne savait pas que le chemin
 * était hors du dossier permis, et réessayait à l'aveugle. Sa réponse est rendue telle quelle,
 * comme l'est celle d'une exécution réussie, bornée en longueur.
 */
function serverAnswer(mode: ReturnType<typeof readMode>, toolResult: Record<string, unknown> | null): string {
  if (mode !== "STDIO_MCP") return "";
  const content = (toolResult?.result as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) return "";
  const text = content
    .map((part) => (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
    .filter((part) => part.trim() !== "")
    .join("\n")
    .trim();
  if (text === "") return "";
  return ` The server answered: ${text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text}`;
}

function modeOfListedTool(tool: { _meta?: Record<string, unknown> }): ReturnType<typeof readMode> {
  const meta = tool._meta?.[OATHRION_META_KEY] as { toolId?: unknown; simulated?: unknown } | undefined;
  if (meta?.simulated !== false) return "SIMULATED";
  if (typeof meta.toolId === "string" && meta.toolId.startsWith(STDIO_TOOL_ID_PREFIX)) return "STDIO_MCP";
  return typeof meta.toolId === "string" && meta.toolId.startsWith("connector_") ? "CONNECTOR" : "LOCAL_MCP";
}

function describeMode(mode: ReturnType<typeof readMode>): string {
  if (mode === "CONNECTOR") return "REAL call to the connected service";
  if (mode === "LOCAL_MCP") return "dispatched to the configured MCP server";
  if (mode === "STDIO_MCP") return "REAL call to the wrapped MCP server";
  return "SIMULATED";
}

/* -------------------------------------------------------------------------- */

/**
 * Dispatches one validated request.
 *
 * Throws `RpcFault` for anything the caller must be told at the protocol level;
 * the route turns that into a JSON-RPC error response with the prescribed HTTP
 * status.
 */
export async function routeMcp(
  ctx: McpContext,
  request: RpcRequest,
): Promise<Record<string, unknown>> {
  const legacy = ctx.protocol?.kind === "legacy";
  switch (request.method) {
    case "initialize":
      if (!legacy) break;
      /*
       * The handshake, for the revisions that have one. Stateless: no session id is
       * issued, every later request is authenticated and authorised on its own.
       * `listChanged: false` because the server sends no notifications — a client
       * re-lists when it needs to, and the list reflects the connectors' real state.
       */
      return {
        protocolVersion: negotiateLegacyVersion(request.params.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Oathrion authorizes each tool call before it runs: it may be allowed, held for human approval, or blocked. " +
          "Only tools of services that are actually connected are listed.",
      };
    case "ping":
      if (!legacy) break;
      return {};
    case "server/discover":
      // Intentionally NOT capability-gated beyond authentication: it describes
      // the server, exposes no tenant data, and a client needs it to negotiate
      // a version before it can do anything useful.
      return serverDiscover();
    case "tools/list":
      return toolsList(ctx);
    case "tools/call":
      return toolsCall(ctx, request);
    default:
      break;
  }
  /*
   * `404`, per the transport spec: "If the server does not implement the requested
   * RPC method, it MUST respond with 404 Not Found and a JSON-RPC error with code
   * -32601."
   *
   * In the current revision `initialize` lands here, and that is correct: 2026-07-28
   * removed the handshake. Only a request in the compatibility mode — see
   * `LEGACY_PROTOCOL_VERSIONS` — is answered.
   */
  throw new RpcFault(
    JSON_RPC_ERRORS.methodNotFound,
    legacy
      ? `Method "${request.method}" is not implemented. Supported: initialize, ping, tools/list, tools/call.`
      : `Method "${request.method}" is not implemented. This gateway implements MCP ${PROTOCOL_VERSION}: server/discover, tools/list, tools/call.`,
    404,
  );
}
