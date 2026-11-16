import { clearSessionCookie, setSessionCookie } from "./session-cookie";
import fs from "node:fs";
import { DATABASE_UNAVAILABLE_MESSAGE, DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS, isDatabaseUnavailable } from "./database-unavailable";
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Express, Request, Response } from "express";
import { DEFAULT_ORGANIZATION_ID, isOrganizationId, type OrganizationId } from "@shared/tenancy";
import type { Server } from "node:http";
import type { Execution } from "@shared/types";
import { z } from "zod";
import {
  initializeRepositories,
  repositoriesFor,
  repositoryExecutor,
  seedIfEmpty,
  usageReportFor,
  type Repositories,
} from "./repositories";
import { connectorPlaneFor, lookupConnector, type ConnectorPlane } from "./connectors";
import { MandateService } from "./mandates";
import { registerMandateRoutes } from "./routes-mandates";
import { registerConnectorRoutes } from "./routes-connectors";
import { notifyScenario, runScenario, ScenarioError } from "./scenario";
import { registerSlackRoutes } from "./routes-slack";
import { registerOidcRoutes } from "./routes-oidc";
import { registerInterceptRoutes } from "./routes-intercept";
import { parseInterceptRules } from "./intercept/rules";
import { InterceptTool, INTERCEPT_TOOL_ID } from "./intercept/forward";
import { PendingInterceptionStore } from "./intercept/pending-store";
import { AgentNotFoundError, DecisionService } from "./services/decision-service";
import { AgentGateway, ToolUnreachableError } from "./gateway/agent-gateway";
import {
  mayDependOnGatingApproval,
  NOT_LOOKED_UP,
  retryabilityOf,
  type GatingApproval,
} from "./gateway/retryability";
import { toolRegistry, type ToolRegistry } from "./gateway/tool-registry";
import { wrappedGeneration, wrappedTools } from "./gateway/tools/stdio-mcp-tool";
import { gatewayLedgerFor } from "./gateway/gateway-ledger";
import {
  authenticate,
  changePassword,
  ensureCapability,
  login,
  loginThrottled,
  openSession,
  registerFailedLogin,
  registerFailedTokenRedemption,
  tokenRedemptionThrottled,
  requireCapability,
  requireIdentity,
} from "./auth";
import { passwordProblems } from "./passwords";
import { sendApiError } from "./api-error";
import { applyApiVersioning } from "./api-version";
import { QuotaExceededError, importQuotaOverrides } from "./quotas";
import { tagged } from "./request-context";
import { mayActOnExecution, resolveActingAgent, statusFor } from "./identity/agent-binding";
import { headHash, verifyAuditChain } from "./audit-chain";
import {
  agentActionSchema,
  ContractError,
  normalizeAgentAction,
  toEngineMetadata,
} from "@shared/api/evaluate-contract";
import { ERROR_CODES } from "@shared/error-codes";
import { can, capabilitiesOf, roleAtMost, ROLES } from "@shared/roles";
import { apiKeyStore, toPublicKey } from "./repositories/api-keys";
import { generateKey } from "./api-keys";
import crypto from "node:crypto";
import { sessionStore } from "./repositories/sessions";
import { DEFAULT_CURRENCY, type CurrencyCode } from "@shared/money";
import { organizationStore } from "./repositories/organizations";
import { normaliseEmail, userStore } from "./repositories/users";
import {
  DEFAULT_TOKEN_TTL_MS,
  identityTokenStore,
  isTokenExpired,
  toPublicToken,
} from "./repositories/identity-tokens";
import { hashPassword } from "./passwords";
import { configureNotifications, notifier } from "./notifications";
import { sanitizeDeliveryDetail } from "./notifications/detail";
import { activeFailMode, rateLimit } from "./rate-limit";
import { countResponses, registerMetricsRoute } from "./observability/route";
import { readWireHeader } from "@shared/wire-headers";
import { increment } from "./observability/metrics";
import {
  JSON_RPC_ERRORS,
  RpcFault,
  parseFrame,
  rpcFailure,
  rpcSuccess,
  validateRequestHeaders,
} from "./mcp/protocol";
import { validateHttpEnvelope } from "./mcp/http-validation";
import { routeMcp } from "./mcp/router";
import { withheldWrappedTools } from "./mcp/tool-catalog";
import { isRegisteredDestination } from "./authority/destinations";
import { authorityFor, initializeActionAuthority } from "./authority";
import { registerActionRoutes } from "./routes-actions";
import { registerFeedbackRoutes } from "./routes-feedback";

/**
 * La version du produit, lue une fois au chargement du module.
 *
 * Lue depuis `package.json` plutôt que depuis une variable d'environnement : une
 * variable se trompe silencieusement, et une version fausse dans un tableau de retours
 * est pire qu'une version absente — elle fait croire qu'un problème est corrige alors
 * qu'on regarde la mauvaise livraison. Le repli sur `"unknown"` est delibere : mieux
 * vaut l'avouer que mentir.
 */
const PRODUCT_VERSION: string = (() => {
  /*
   * La valeur scellée au build gagne (voir `script/build.ts`). La lecture de fichier
   * qui suit ne sert que sous `tsx` — développement, tests, démarrage rapide — où le
   * dépôt est sur le disque et où aucun `define` n'est appliqué.
   */
  const sealed = process.env.OATHRION_BUILD_VERSION;
  if (sealed && sealed.length > 0) return sealed;
  try {
    /*
     * Lecture de fichier plutôt que `require` : le dépôt interdit les imports CommonJS
     * (@typescript-eslint/no-require-imports), et un `import` statique de JSON ferait
     * entrer `package.json` dans le graphe du bundle — donc dans l'artefact livré, avec
     * la liste complète des dépendances et des scripts internes.
     */
    const here = path.dirname(fileURLToPath(import.meta.url));
    const raw = fs.readFileSync(path.join(here, "..", "package.json"), "utf8");
    return String((JSON.parse(raw) as { version?: string }).version ?? "unknown");
  } catch {
    return "unknown";
  }
})();
import { isShuttingDown } from "./lifecycle";
import { isLocalMode } from "./local-mode";
import { waitForApprovalSignal } from "./approval-events";
import { activeHub, HubClosingError, ServerConflictError } from "./local-hub";
import { ClaudeAsks } from "./local-claude-asks";
import { LOCAL_ADMIN_EMAIL, LOCAL_ORGANIZATION } from "./local-bootstrap";
import { checkLocalLoginTicket, mintLocalLoginTicket } from "@shared/local-login-ticket";
import { claimDecideToken } from "./local-decide-links";
import { reconcileAlert, reconcileOnce } from "./connectors/reconcile";
import { receiptGapIntervalMs, reconcileIntervalMs, startReconcileScheduler } from "./connectors/reconcile-scheduler";
import { findNewReceiptGaps, receiptGapAlert } from "./authority/receipt-gaps";
import {
  agentCreateSchema,
  firstIssue,
  mandateSchema,
  MAX_PERMISSIONS,
  permissionSchema,
  policyCreateContract,
  toAgent,
  toPolicy,
} from "@shared/validation";

/*
 * ---------------------------------------------------------------------------
 * TENANT SCOPE
 * ---------------------------------------------------------------------------
 *
 * There is no module-level `repositories`, `decisionService` or `gateway` any more.
 * A single shared instance was the actual cross-tenant defect: every query it ran
 * spanned the whole table, so `GET /api/agents` returned every customer's agents.
 *
 * Instead each organization gets its own set of instances, built on first use and
 * memoised. The memo is a cache, not state: `repositoriesFor` is itself cached, and
 * `DecisionService` / `AgentGateway` hold no mutable per-request data — they are
 * bound to a `Repositories` at construction, which is exactly the binding we need to
 * be per-tenant.
 *
 * The scope comes from `identity.organizationId`, which comes from the credential.
 * No route reads a tenant from the URL, the body or a header.
 */
interface TenantScope {
  /** La version de l'ensemble des serveurs enveloppés quand cette portée a été construite. */
  wrappedGeneration: number;
  repositories: Repositories;
  decisionService: DecisionService;
  gateway: AgentGateway;
  /**
   * Le registre d'outils DE CE LOCATAIRE : la base, plus ses connecteurs et le relais du
   * pare-feu. C'est celui que `gateway` emploie.
   *
   * Exposé pour la passerelle MCP, qui recevait le registre GLOBAL : `tools/list` ne
   * montrait donc aucun connecteur, et `tools/call` refusait `slack.message.post` comme
   * « outil inconnu » alors que `POST /api/execute` le servait. Deux portes sur le même
   * moteur doivent voir les mêmes outils.
   */
  registry: ToolRegistry;
  /**
   * Le plan des connecteurs de CE locataire.
   *
   * Par locataire et non par processus, parce que les credentials le sont : un plan
   * partagé porterait le coffre d'une organisation et le servirait à toutes. C'est la
   * même raison que pour `repositories`, et elle est plus grave ici — ce que l'on
   * partagerait serait un jeton d'accès à un service tiers.
   */
  connectors: ConnectorPlane;
  /**
   * Le sas des requêtes interceptées qui attendent un humain.
   *
   * Par locataire comme le coffre, et pour la même raison : ses lignes portent des corps
   * de requête chiffrés sous une clé liée à l'organisation.
   */
  pendingInterceptions: PendingInterceptionStore;
  /**
   * La devise de compte du locataire — la MÊME valeur que celle passée au service de
   * décision, lue une seule fois. Exposée pour l'extraction du pare-feu, qui en a besoin
   * pour convertir un montant en unité mineure quand la requête ne nomme pas sa devise.
   * Deux lectures séparées pourraient diverger ; une seule ne le peut pas.
   */
  currency: CurrencyCode;
}

const scopes = new Map<OrganizationId, TenantScope>();

/** Le repère « la démo a été vue » (`/api/local/readiness`) : un fichier, dans le dossier du pivot. */
const DEMO_SEEN = "demo-seen";
function markDemoSeen(dir: string): void {
  try {
    fs.writeFileSync(path.join(dir, DEMO_SEEN), `${new Date().toISOString()}\n`, { mode: 0o600 });
  } catch {
    /* sans repère, l'étape reste simplement proposée */
  }
}

/**
 * Trancher une approbation du pivot local DEPUIS UNE NOTIFICATION (10 novembre,
 * `notes/CONCEPTION-MASCOTTES.md`) : la même voie que le bouton de la console
 * (`gateway.resolveApproval`), au nom de la personne devant l'écran. Rend ce qui a été fait.
 */
export async function resolveLocalApproval(organization: OrganizationId, approvalId: string, status: "approved" | "rejected", resolvedBy: string): Promise<string> {
  const result = await scopeFor(organization).gateway.resolveApproval(approvalId, status, resolvedBy);
  if (!result?.approval) return "This request no longer exists";
  if (result.approval.expired) return "Too late: the request had expired, nothing was released";
  if (status === "rejected") return "Refused: the action did not run";
  return result.succeeded === false ? "Approved, but the action failed" : "Approved: the action ran";
}

function scopeFor(organization: OrganizationId): TenantScope {
  const existing = scopes.get(organization);
  /* Un serveur enveloppé inscrit ou retiré depuis : la portée est reconstruite avec la nouvelle liste. */
  if (existing && existing.wrappedGeneration === wrappedGeneration()) return existing;
  const repositories = repositoriesFor(organization);
  /*
   * The tenant's unit of account, read once per scope.
   *
   * This is where the deployment-wide `ORG_CURRENCY` constant used to be implicit. Every
   * ceiling, every rendered amount and every connector call for this tenant is denominated
   * in what this resolves to, and nothing downstream falls back to EUR.
   *
   * An unknown organization resolves to the default rather than throwing: `requireIdentity`
   * has already established that the caller belongs to this tenant, so an absent row means
   * the registry and the credential disagree — a condition the authentication path reports,
   * not one this factory should turn into a 500 on every request.
   *
   * Scopes are cached, so changing a tenant's currency takes effect on the next process
   * start. `organizationStore.setCurrency` is documented as a correction made before any
   * amount exists, which is the only case where changing it is meaningful at all.
   */
  const currency = organizationStore.find(organization)?.currency ?? DEFAULT_CURRENCY;
  const decisionService = new DecisionService(repositories, notifier, currency);

  /*
   * LES OUTILS DE CONNECTEUR REJOIGNENT LE REGISTRE GOUVERNÉ, ET PAR LÀ SEULEMENT.
   *
   * `extendedWith` passe par le constructeur de `ToolRegistry`, donc un verbe de
   * connecteur absent de `shared/policy/actions.ts` refuse la construction de la portée —
   * au même endroit et pour la même raison qu'un outil intégré. Un connecteur n'ouvre
   * aucune porte à côté de la passerelle : il devient un `Tool`, et un `Tool` n'est
   * atteignable que par `AgentGateway.dispatch()`, après un ALLOW.
   *
   * `refresh()` est volontairement NON attendu ici. `scopeFor` est synchrone — il est
   * appelé au milieu du traitement d'une requête — et le défaut de `ConnectorTool` est
   * « simulé ». Un inventaire en retard d'un instant annonce donc moins que la réalité,
   * jamais plus. Les routes de connexion et de révocation rafraîchissent, elles, en
   * attendant.
   */
  const connectors = connectorPlaneFor(repositoryExecutor(), organization);
  void connectors.refresh();

  /*
   * LE RELAIS D'INTERCEPTION REJOINT LE REGISTRE GOUVERNÉ, comme un connecteur.
   *
   * Chaque verbe nommé par une règle de `OATHRION_INTERCEPTS` est câblé sur ce relais, donc
   * il passe par le constructeur de `ToolRegistry` : un verbe absent de
   * `shared/policy/actions.ts` refuse la construction de la portée, au même endroit et
   * pour la même raison qu'un outil intégré. Le proxy n'ouvre aucune porte à côté de la
   * passerelle — il devient un `Tool`, et un `Tool` n'est atteignable que par
   * `AgentGateway.dispatch()`, après un ALLOW.
   *
   * Une seule instance de relais pour tous les verbes : il n'a pas d'état par verbe, et
   * son compteur d'invocations doit compter les relais, pas les routes.
   */
  const interceptActions: Record<string, string> = {};
  for (const rule of INTERCEPT_RULES) interceptActions[rule.action] = INTERCEPT_TOOL_ID;

  const pendingInterceptions = new PendingInterceptionStore(repositoryExecutor(), organization);

  /*
   * LES SERVEURS MCP ENVELOPPÉS (`oathrion wrap`), inscrits avant que le serveur n'accepte
   * une requête. Ils passent par le même constructeur : leurs verbes ont été enregistrés
   * au catalogue avec une portée, sinon la construction de la portée échouerait.
   */
  const wrapped = wrappedTools();
  const registry = toolRegistry.extendedWith(
    [
      ...connectors.tools.values(),
      ...wrapped.tools,
      /*
       * Le coffre DU LOCATAIRE — le relais ouvre lui-même, après un ALLOW — et le sas,
       * pour qu'une approbation rendue après un redémarrage retrouve sa requête.
       */
      ...(Object.keys(interceptActions).length > 0
        ? [new InterceptTool(connectors.vault, pendingInterceptions)]
        : []),
    ],
    { ...connectors.actionMap, ...wrapped.actionMap, ...interceptActions },
  );

  const built: TenantScope = {
    wrappedGeneration: wrappedGeneration(),
    repositories,
    decisionService,
    connectors,
    pendingInterceptions,
    gateway: new AgentGateway(decisionService, repositories, registry, currency, organization, gatewayLedgerFor(organization)),
    registry,
    currency,
  };
  scopes.set(organization, built);
  return built;
}

/**
 * The only way a handler obtains data access. Going through `requireIdentity` means
 * an unauthenticated request cannot reach a repository at all: the helper throws
 * rather than falling back to a default organization.
 */
function scope(req: Request): TenantScope {
  return scopeFor(requireIdentity(req).organizationId);
}

/** Test seam: drops the per-organization instances after the database is replaced. */
export function resetTenantScopes(): void {
  scopes.clear();
}

/**
 * `agentId` is optional in every body schema below, and that is a P6 change with
 * a reason: a credential bound to one agent should not have to repeat it, and a
 * request that omits it is not malformed for such a caller. Omitting it is still
 * refused for an unbound one — by `actingAgent`, with `agent_not_declared` and
 * the same 400 the schema used to give, so the status a client sees is unchanged
 * while the message and code became specific about what is missing.
 */
const decisionSchema = z.strictObject({
  agentId: z.string().min(1).optional(),
  action: z.string().min(1),
  target: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  persist: z.boolean().optional(),
});

const executeSchema = z.strictObject({
  agentId: z.string().min(1).optional(),
  action: z.string().min(1),
  target: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Same body as an evaluation, minus the dry-run switch: this route always acts.
 *
 * Declared here rather than derived from `agentActionSchema` so its strictness —
 * rejecting an unknown key — does not depend on whether Zod's object-derivation
 * helpers preserve `strictObject` semantics across versions. The field list is
 * deliberately identical to the shared contract's, because an integrator who
 * learned one body should not discover that the other spells things differently.
 */
const executionCreateSchema = z.strictObject({
  agentId: z.string().min(1).optional(),
  action: z.string().min(1),
  target: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  amount: z.union([z.number(), z.string()]).optional(),
  currency: z.string().min(1).optional(),
  category: z.string().optional(),
  context: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The approval body carries no identity. The approver is derived from the
 * authenticated caller, so a client cannot claim to be someone else.
 * `.strict()` makes an attempt to smuggle `resolvedBy` a hard 400 rather than a
 * silently ignored field.
 */
const approvalResolveSchema = z.strictObject({
  note: z.string().trim().max(500).optional(),
});

/*
 * Les tickets de connexion locale déjà servis, jusqu'à leur échéance : un ticket ne sert
 * qu'une fois. En mémoire suffit — après un redémarrage, l'échéance (deux minutes) borne
 * ce qu'un ticket rejoué pourrait encore faire.
 */
const usedLocalTickets = new Map<string, number>();

function claimLocalTicket(nonce: string, expiresAt: number): boolean {
  const now = Date.now();
  for (const [seen, until] of usedLocalTickets) if (until <= now) usedLocalTickets.delete(seen);
  if (usedLocalTickets.has(nonce)) return false;
  usedLocalTickets.set(nonce, expiresAt);
  return true;
}

const agentPatchSchema = z.strictObject({
  status: z.enum(["active", "paused", "draft", "review"]).optional(),
  currentTask: z.string().nullable().optional(),
  mandate: mandateSchema.optional(),
  permissions: z.array(permissionSchema).max(MAX_PERMISSIONS).optional(),
});

const policyTogglePatch = z.strictObject({
  status: z.enum(["enabled", "disabled", "draft"]),
});

/**
 * How many recent executions the audit stream is assembled from, and how many
 * events a single page may carry. Both are bounded so one request cannot pull
 * the whole ledger into memory; `windowTruncated` tells the caller when the
 * first bound actually bit.
 */
const AUDIT_EXECUTION_WINDOW = 500;
const DEFAULT_AUDIT_PAGE = 200;
const MAX_AUDIT_PAGE = 500;

/**
 * Per-credential request budgets for the pilot. High-frequency decision
 * traffic gets a generous window; state-changing management routes (creating
 * or resolving things) are tighter, since a burst there is never a normal
 * polling pattern.
 *
 * The budgets, the window and the dimensions are unchanged by P0-7 — what changed is
 * where the counters live. See `rate-limit/index.ts` for why they are now in a shared
 * store rather than in this process, and why the store is PostgreSQL and not Redis.
 */
/*
 * Les plafonds ne sont plus ici. Ils étaient trois littéraux — 120, 30, 60 par minute —
 * qu'aucun exploitant ne pouvait ajuster sans recompiler, alors qu'un agent réel dont le
 * trafic les dépasse reçoit des 429 qui ressemblent à une panne. Ils vivent désormais
 * dans `server/rate-limit/limits.ts`, lus depuis l'environnement et validés au
 * démarrage ; le middleware les lit à chaque requête, comme il lit déjà son store et son
 * mode d'échec.
 */
const decisionRateLimit = rateLimit("decision");

/*
 * Les règles d'interception, lues UNE fois au chargement du module.
 *
 * Au chargement et non par requête : une règle mal formée doit refuser le démarrage, pas
 * échouer au premier appel d'un client. C'est la même règle que pour `OATHRION_TOOLS`, et
 * `server/config-check.ts` en rend le motif nommé.
 */
const INTERCEPT_RULES = parseInterceptRules();
const writeRateLimit = rateLimit("write");
const approvalRateLimit = rateLimit("approval");
/*
 * The two public token-redemption routes — P2 identity. Ten attempts per minute,
 * keyed by IP because there is no identity yet (`quotaKey` falls back to `req.ip`).
 * A token is 32 random bytes, so this is not what makes guessing infeasible; it is
 * what stops an unauthenticated endpoint from being used as a free CPU sink, and
 * what bounds an attempt to enumerate token ids.
 */
/*
 * No `rateLimit(...)` constant for the two token-redemption routes.
 *
 * There was one, and it was wrong: those routes are public, so the limiter keys on
 * the address, and counting every attempt throttled *successful* onboarding behind a
 * corporate NAT. They use `tokenRedemptionThrottled` / `registerFailedTokenRedemption`
 * instead, which count refusals only — the same shape as the sign-in throttle. The
 * full reasoning is on those functions in `server/auth.ts`.
 */

/**
 * Refuses a request that tries to name its own author.
 *
 * `actor` used to be an optional string in the request body, and it was written
 * straight into the audit trail. Any caller could therefore attribute an action
 * to anyone: an operator key could file a purchase under a director's name, and
 * the real identity behind the credential was recorded nowhere. Attribution is
 * now taken from the authenticated credential only. The field is rejected
 * rather than silently dropped, so an integration still sending it is told.
 */
function rejectsClientActor(req: Request, res: Response): boolean {
  if (req.body && typeof req.body === "object" && "actor" in req.body) {
    fail(
      res,
      400,
      "actor is not accepted. The audit trail records the authenticated identity behind the credential.",
    );
    return true;
  }
  return false;
}

/**
 * The agent this request may act as, or `null` when the refusal has been sent.
 *
 * Every route that used to read `parsed.data.agentId` and hand it to the engine
 * now reads it through here. The pattern is deliberately the same as
 * `rejectsClientActor` and `ensureCapability`: the helper answers and the route
 * returns, so the check cannot be half-applied.
 *
 * `requested` is the caller's value and is passed in only to be compared — the
 * id this returns comes from `resolveActingAgent`, which prefers the credential
 * binding. A route must use the returned value and not its own `parsed.data`,
 * which is what `server/test/agent-binding-single-path.test.ts` checks textually.
 */
function actingAgent(req: Request, res: Response, requested: string | null): string | null {
  const outcome = resolveActingAgent(requireIdentity(req), requested);
  if (!outcome.ok) {
    fail(res, statusFor(outcome.refusal), outcome.reason, outcome.refusal);
    return null;
  }
  return outcome.agentId;
}

/** Express 5 types route params as `string | string[]`; the control plane only uses scalars. */
function param(req: Request, name: string): string {
  const raw = (req.params as Record<string, string | string[]>)[name];
  return Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? "");
}

/**
 * The single refusal helper used by every route.
 *
 * `code` is optional on purpose. Passing one is how a route says "I distinguish this
 * condition and a client may branch on it"; omitting it derives a code from the HTTP
 * status, which is honest about the fact that the route knows no more than the status.
 * Making it mandatory would have forced a classification onto ~34 handlers in one
 * sweep — a large diff over working code, inventing precision nobody measured.
 *
 * The body gained `message` and `code` and `requestId`; `error` is unchanged, so no
 * existing caller or test breaks. See shared/error-codes.ts for why both keys are sent.
 */
/** Le journal du hook Claude Code du pivot : son fichier, et ses lignes lisibles. */
function readHookJournal(hubDir: string): { file: string; lines: import("../cli/wrap/claude-journal").JournalEntry[] } {
  const file = path.join(hubDir, "claude-code", "journal.jsonl");
  if (!fs.existsSync(file)) return { file, lines: [] };
  const lines = fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line: string) => line.trim() !== "")
    .flatMap((line: string) => {
      try {
        return [JSON.parse(line) as import("../cli/wrap/claude-journal").JournalEntry];
      } catch {
        return [];
      }
    });
  return { file, lines };
}

function fail(res: Response, status: number, message: string, code?: string) {
  sendApiError(res, status, message, code);
}

/**
 * Wraps an async handler so rejected promises become 500s instead of hanging
 * sockets.
 *
 * The failure is logged with its stack on the server; the caller receives a
 * bare status. An exception raised deep in the stack carries a message written
 * for whoever debugs it — a file path, a SQL fragment, the offending value —
 * and returning it verbatim hands that description of the deployment to anyone
 * able to provoke a crash. `AgentNotFoundError` is the exception: it is raised
 * deliberately to answer the caller, and it says nothing the caller does not
 * already know.
 */
function handle(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response) => {
    fn(req, res).catch((err: unknown) => {
      // `headersSent` has to be checked on *every* branch, not just the 500:
      // a handler that already streamed a response and then threw would make
      // this call `res.status().json()` on a finished response, which Express
      // reports as ERR_HTTP_HEADERS_SENT — an unhandled rejection that masks the
      // real error in the logs.
      if (res.headersSent) {
        console.error(tagged("[api]"), req.method, req.path, "(after response sent)", err);
        return;
      }
      if (err instanceof AgentNotFoundError) {
        return fail(res, 404, err.message, ERROR_CODES.notFound);
      }
      /*
       * P3 — a quota refusal is a deliberate, safe-to-disclose answer, so unlike a
       * generic exception its message is returned verbatim. It was written for the
       * caller and contains only numbers about their own organization: the ceiling,
       * how many they hold, and when it resets. Turning it into a bare 500 would tell
       * a customer their control plane is broken when in fact it is working exactly as
       * configured.
       *
       * `Retry-After` is set only for the period counter, where waiting genuinely
       * resolves the refusal. Sending it on the 409 would invite a client to retry a
       * ceiling on live rows that no amount of waiting moves.
       */
      if (err instanceof QuotaExceededError) {
        if (err.resetAt !== null) {
          const seconds = Math.ceil((Date.parse(err.resetAt) - Date.now()) / 1000);
          res.setHeader("Retry-After", String(Math.max(seconds, 1)));
        }
        return sendApiError(res, err.status, err.message, ERROR_CODES.quotaExceeded, {
          counter: err.counter,
          limit: err.limit,
          used: err.used,
          resetAt: err.resetAt,
        });
      }
      /*
       * Tagged with the correlation id, which is the whole point of P1-2 here: this
       * line carries the stack trace and the caller receives only "Internal Server
       * Error". The id in the response body is now the key that joins the two, so a
       * user quoting it lets an operator find this exact stack.
       */
      console.error(tagged("[api]"), req.method, req.path, err);
      /*
       * Une base injoignable : 503 et `Retry-After`, comme le gestionnaire global
       * (server/database-unavailable.ts). Ce chemin-ci renvoyait encore 500 pendant une
       * coupure de PostgreSQL sous trafic.
       */
      if (isDatabaseUnavailable(err)) {
        res.setHeader("Retry-After", String(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS));
        return sendApiError(res, 503, DATABASE_UNAVAILABLE_MESSAGE);
      }
      fail(res, 500, "Internal Server Error", ERROR_CODES.internalError);
    });
  };
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  /*
   * PHASE 11 — the engine is opened before anything else, and before the first
   * `repositoriesFor` call. On SQLite this is a no-op (server/db.ts already opened and
   * migrated the file at import time); on PostgreSQL it opens the pool and verifies the
   * schema, and it THROWS if either fails. Thrown, not caught: a control plane that
   * cannot reach its source of truth must not begin serving requests, and the
   * alternative — carrying on and letting each request fail — would leave the health
   * probe answering for a server that can never answer anything else.
   */
  await initializeRepositories();
  await seedIfEmpty();

  /*
   * Chantier 1 — the per-organization entries of OATHRION_QUOTAS are synchronised into
   * `organization_quotas` before the first request, so that from here on the database
   * is the one place a tenant's ceiling is read from. Idempotent, so every boot of every
   * replica runs it. An entry contradicting a ceiling the application wrote THROWS and
   * the boot stops with both values named: same reasoning as the engine check above — a
   * server unsure which ceiling applies must not start enforcing one of them.
   */
  const quotaImport = importQuotaOverrides(organizationStore.list().map((o) => o.id));
  if (quotaImport.imported + quotaImport.updated + quotaImport.removed > 0) {
    // eslint-disable-next-line no-console -- boot-time data migration report, same exemption as server/db.ts
    console.log(
      `[quotas] OATHRION_QUOTAS synchronised into the database: ${quotaImport.imported} imported, ` +
        `${quotaImport.updated} updated, ${quotaImport.removed} removed, ` +
        `${quotaImport.unchanged} already matched.`,
    );
  }

  /* -------------------------------- Versioning ---------------------------- */

  /**
   * P2 — `/api/v1/...` is resolved to `/api/...` here, before anything else.
   *
   * Mounted inside `registerRoutes` rather than in `server/index.ts` on purpose: this
   * function is what the integration harness boots, so a middleware mounted here is
   * exercised by the suite and cannot exist in production while being absent under test.
   * It must precede `authenticate()` below — see `server/api-version.ts` for why making
   * the gate itself version-aware was rejected.
   *
   * The 30 routes registered further down are unchanged and unaware of versions.
   */
  applyApiVersioning(app);

  /* ------------------------------ Observability --------------------------- */

  /*
   * Le compteur de réponses, monté avant le portail d'authentification pour qu'un 401
   * compte lui aussi. Un déploiement sous attaque de credentials se voit dans
   * `oathrion_http_responses_total{surface="auth",class="4xx"}`, et il ne s'y verrait pas si
   * la mesure commençait après le portail.
   */
  app.use(countResponses());

  /*
   * `/api/metrics`, montée AVANT `authenticate()` parce qu'elle porte son propre jeton
   * — et pas inscrite dans `PUBLIC_API_PATHS`, dont le commentaire promet que chacun de
   * ses membres ne divulgue aucun compte. Voir `server/observability/route.ts`.
   */
  const metricsMounted = registerMetricsRoute(app, { state: deploymentState });
  if (metricsMounted) {
    // eslint-disable-next-line no-console -- ligne de démarrage, même exemption que [quotas]
    console.log("[metrics] /api/metrics mounted, token required");
  }

  /* ---------------------------------- Auth -------------------------------- */

  /**
   * Everything under /api is closed by default. The gate is mounted before any
   * route so a handler added later cannot accidentally be public.
   */
  app.use(authenticate());

  configureNotifications();

  /**
   * Every execution the API returns carries a server-computed `retry` block.
   *
   * §8: the console must reflect backend truth, not re-derive it. The three reasons a
   * retry is refused — non-`allow` decision, run not `failed`, attempt ceiling spent —
   * live in `retryabilityOf`, the same function the retry endpoint's 409 is worded
   * from. The console previously knew only about the run state and so offered an
   * enabled button on executions the server was always going to refuse.
   *
   * It describes the execution, not the caller: a viewer sees the same value an
   * operator does, and the capability check for pressing the button stays separate.
   */
  const withRetryability = (execution: Execution, gating: GatingApproval) => ({
    ...execution,
    retry: retryabilityOf(execution, gating),
  });

  /**
   * `withRetryability` for one execution, fetching its gating approval.
   *
   * The lookup is skipped for an execution that cannot reach the approval check
   * — see `mayDependOnGatingApproval` — and the sentinel is passed instead of
   * `null`, because `null` asserts something stronger ("never gated") than this
   * caller checked. If the skip is ever wrong, `retryabilityOf` throws rather
   * than answering.
   */
  const withRetryabilityFetched = async (
    repositories: Repositories,
    execution: Execution,
  ): Promise<ReturnType<typeof withRetryability>> => {
    if (!mayDependOnGatingApproval(execution)) {
      return withRetryability(execution, NOT_LOOKED_UP);
    }
    const gating = await repositories.approvals.findByExecutionId(execution.id);
    return withRetryability(execution, gating ? { expiresAt: gating.expiresAt ?? null } : null);
  };

  /**
   * `withRetryability` for a page of executions, in two queries rather than one
   * per row.
   *
   * Only the rows that can actually reach the approval check are looked up, so a
   * page of 300 succeeded runs still costs one execution query and no approval
   * query at all.
   */
  const withRetryabilityMany = async (
    repositories: Repositories,
    executions: Execution[],
  ): Promise<ReturnType<typeof withRetryability>[]> => {
    const needing = executions.filter(mayDependOnGatingApproval);
    const expiries =
      needing.length === 0
        ? new Map<string, string | null>()
        : await repositories.approvals.findGatingExpiries(needing.map((e) => e.id));

    return executions.map((execution) => {
      if (!mayDependOnGatingApproval(execution)) {
        return withRetryability(execution, NOT_LOOKED_UP);
      }
      // Absent from the map means no approval row: never gated. Present with a
      // null value means gated with no deadline, which `isExpired` treats as
      // expired. The distinction is the reason the map is not `Map<string,
      // string>` with a default.
      const gating = expiries.has(execution.id)
        ? { expiresAt: expiries.get(execution.id) ?? null }
        : null;
      return withRetryability(execution, gating);
    });
  };


  /* ------------------------------- Probes -------------------------------- */

  /**
   * The readiness answer, computed once and served by two paths.
   *
   * ## History, because it explains the shape
   *
   * This began as a hard-coded `{ status: "ok" }` — true of any process that ran one
   * line of JavaScript, identical whether the database was reachable or the volume
   * holding it had vanished. It then gained a real query against SQLite: the only
   * dependency, cheap to probe, and the thing that actually breaks (missing file,
   * read-only volume, corrupt page). P1-1 changes none of that logic; it separates
   * *which question* the answer is answering.
   *
   * Extracted into a function rather than copied into the new `/api/ready`: two probe
   * endpoints that are supposed to agree and are computed separately will eventually
   * disagree, and the failure mode is a load balancer acting on one answer while an
   * operator reads the other.
   *
   * ## Disclosure
   *
   * Every probe below is unauthenticated by necessity — a probe carries no credential —
   * so the body is deliberately dull: no version, no path, no hostname, no dependency
   * versions, no schema state, and no counts, since "412 executions" would tell an
   * outsider how busy the tenant is. `detail` is a fixed string, never the underlying
   * error, which would carry the database path. The full error goes to the server log.
   */
  const readiness = async () => {
    // Through the repository, not a direct database import: the route layer talks
    // to the store through one seam everywhere else, and a health check is not a
    // good reason to make an exception.
    // The default organization is used purely as a handle to reach `ping`, which
    // checks connectivity and reads no tenant data. This route is unauthenticated,
    // so there is no identity to take a scope from, and it must not report on any
    // particular customer's data either way.
    // `ping` promises to resolve rather than throw, but this does not rely on that
    // promise. A rejection would be forwarded to the Express error handler and
    // answered as a 500 — or, worse, fall through to the SPA catch-all and return an
    // HTML page to a probe expecting JSON. A health check must degrade calmly; that
    // is its entire job.
    let databaseOk = false;
    try {
      databaseOk = await repositoriesFor(DEFAULT_ORGANIZATION_ID).ping();
    } catch (error) {
      console.error(tagged("[health] database check threw:"), error);
    }

    /*
     * A draining instance is not ready, even though it is still perfectly capable of
     * answering. Reporting `degraded` from the first moment of the drain is what
     * gives the load balancer time to route new work elsewhere BEFORE the listener
     * closes. Without this window the probe races `server.close()` and clients get
     * connection resets on every deploy.
     *
     * `accepting: false` is the signal; the database check keeps reporting the truth
     * separately so an operator reading the body can tell a deploy apart from an
     * actual dependency failure.
     */
    const accepting = !isShuttingDown();
    const ready = databaseOk && accepting;

    return {
      ready,
      body: {
        status: ready ? "ok" : "degraded",
        checks: {
          database: {
            ok: databaseOk,
            detail: databaseOk ? "reachable" : "unreachable",
          },
          accepting: {
            ok: accepting,
            detail: accepting ? "accepting requests" : "draining",
          },
        },
        uptimeSeconds: Math.floor(process.uptime()),
      },
    };
  };

  /**
   * L'état que le registre de métriques ne peut pas connaître tout seul.
   *
   * Déclarée en `function` et non en `const` : elle est passée à
   * `registerMetricsRoute` quelques dizaines de lignes PLUS HAUT, et une `const` ne
   * serait pas encore initialisée à cet instant. Le corps, lui, n'appelle `readiness`
   * qu'au moment d'un scrape, donc après l'initialisation.
   *
   * Une seule lecture de la disponibilité, partagée avec `/api/ready` : deux calculs
   * censés concorder finissent par diverger, et ici la divergence se lirait comme « le
   * tableau de bord dit prêt, l'équilibreur dit non ».
   */
  async function deploymentState() {
    const { ready, body } = await readiness();
    return {
      ready,
      databaseReachable: body.checks.database.ok,
      draining: !body.checks.accepting.ok,
      rateLimitFailClosed: activeFailMode() === "closed",
    };
  }

  /**
   * GET /api/live — liveness. Is this process still the process, or should it be
   * restarted?
   *
   * ## Why this had to be separate
   *
   * `/api/health` checks the database and answers 503 when it is unreachable. That is
   * correct for readiness and actively harmful as liveness, and `/api/health` was the
   * only endpoint on offer — while `DEPLOYMENT.md` §14 answered the question "is the
   * service alive?" by pointing at it. Follow that documentation into a Kubernetes
   * `livenessProbe` and the outage amplifies itself:
   *
   *   1. The database becomes unreachable — a failover, a full volume, a network blip.
   *   2. Every instance answers 503.
   *   3. The kubelet concludes every container is dead and restarts them all.
   *   4. Each restart re-runs migrations at boot (server/db.ts) against the database
   *      that is already struggling, and drops the in-flight requests that would have
   *      survived, and empties the process. Nothing about a restart can fix a
   *      dependency outside the container.
   *
   * The rule this encodes: liveness may only fail for something a restart can
   * actually repair. A dependency failure is not that. So this endpoint reports on the
   * process and on nothing it does not own.
   *
   * ## Why it stays 200 while draining
   *
   * During a graceful shutdown the process is alive and deliberately finishing its
   * in-flight work. Answering 503 here would make the kubelet kill the container
   * mid-drain, defeating `server/lifecycle.ts` entirely — the drain exists precisely so
   * a governed tool call is not cut off between the side effect and its audit record.
   * Readiness is what turns traffic away during a drain; liveness must not.
   *
   * It reaches no dependency, so it is cheap enough to probe every second, and it
   * discloses only an uptime — no version, no hostname, no schema state.
   */
  app.get("/api/live", (_req, res) => {
    res.status(200).json({
      status: "alive",
      /*
       * Reported so a probe consumer can detect a crash-loop: an uptime that keeps
       * resetting is a process being restarted, which is the one thing a liveness
       * endpoint answering 200 cannot otherwise reveal.
       */
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  /**
   * GET /api/ready — readiness. Should this instance receive traffic right now?
   *
   * Fails when the database is unreachable or the process is draining: both mean
   * requests routed here will fail or be cut off, and both are conditions another
   * instance may not share. This is the endpoint a load balancer and a rolling deploy
   * must read.
   *
   * Identical in body and status to `/api/health`, which is kept as its long-standing
   * name (see below). Adding the correctly-named path rather than renaming the old one
   * is what keeps every existing probe, smoke test and compose file working.
   */
  app.get("/api/ready", async (_req, res) => {
    const { ready, body } = await readiness();
    res.status(ready ? 200 : 503).json(body);
  });

  /**
   * GET /api/health — retained, unchanged, as an alias of `/api/ready`.
   *
   * Kept rather than removed or redirected: it is referenced by the Dockerfile
   * HEALTHCHECK, by `npm run smoke`, by DEPLOYMENT.md and by anything an operator has
   * already wired up. Breaking a probe endpoint to improve its name would mean every
   * existing deployment reports unhealthy at the moment it takes this release.
   *
   * "health" is the ambiguous word — it is why liveness and readiness were conflated
   * here in the first place — so the two unambiguous names now exist beside it and the
   * documentation points at those. This one is a compatibility surface.
   */
  app.get("/api/health", async (_req, res) => {
    const { ready, body } = await readiness();
    res.status(ready ? 200 : 503).json(body);
  });

  /**
   * POST /api/auth/login — exchanges an e-mail and password for a short-lived,
   * signed session token. The browser never holds an API key; the password is
   * verified against a scrypt hash and is never logged or echoed back.
   *
   * Every failure answers the same 401 with the same message. The server knows
   * more than that — the account may be suspended, or belong to no active
   * organization — but telling the client which would answer "does this person have
   * an account here?" to anyone who asks. The distinction is logged server-side, at
   * warning level and without the address, so an operator can still diagnose a
   * genuine sign-in problem.
   */
  app.post("/api/auth/login", async (req, res) => {
    const ip = req.ip ?? "unknown";
    // Awaited: the throttle counter is shared across instances (P0-7), so reading it
    // is a round trip rather than a map lookup.
    if (await loginThrottled(ip)) {
      increment("oathrion_auth_failures_total", { reason: "login_throttled" });
      return fail(res, 429, "Too many attempts. Try again in a minute.", ERROR_CODES.loginThrottled);
    }

    const parsed = z
      .strictObject({
        email: z.string().trim().min(3).max(320),
        /*
         * Trimmed here and NOT inside `login()`. A password pasted or autofilled with a
         * stray space or newline must not fail for a reason invisible in the UI, and the
         * configured secrets are refused at boot if they carry edge whitespace
         * (`auth-credential-parsing.test.ts`), so nothing is made reachable that was not
         * reachable before. `login()` itself still compares exactly — the tolerance lives
         * at the edge, where the accident happens, not in the credential check.
         */
        password: z.string().trim().min(1).max(256),
        /** Only needed by a user who belongs to more than one organization. */
        organization: z.string().trim().max(50).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "email and password are required");

    let organization: OrganizationId | undefined;
    if (parsed.data.organization !== undefined && parsed.data.organization !== "") {
      if (!isOrganizationId(parsed.data.organization)) {
        return fail(res, 400, "organization is not a valid organization id");
      }
      organization = parsed.data.organization;
    }

    const { session: issued, failure } = login(parsed.data.email, parsed.data.password, organization);
    if (!issued) {
      await registerFailedLogin(ip);
      /*
       * Le motif, jamais l'adresse. `login()` distingue réellement ces cas — contrairement
       * à `resolveBearer` — donc la métrique peut les porter sans rien inventer, et un
       * `login_account_suspended` répété est l'information qu'un client cherche à entrer
       * dans un compte que l'exploitant a fermé.
       */
      increment("oathrion_auth_failures_total", { reason: `login_${failure ?? "invalid_credentials"}` });
      if (failure && failure !== "invalid_credentials") {
        // Not the address, not the password, not an identifier: only the reason.
        console.warn(`[auth] sign-in refused (${failure})`);
      }
      return fail(res, 401, "Invalid credentials", ERROR_CODES.invalidCredentials);
    }

    /*
     * Le cookie protégé de la console (`server/session-cookie.ts`) : un rechargement de page
     * ne déconnecte plus. Le jeton reste aussi dans le corps, pour les scripts et le SDK.
     */
    setSessionCookie(req, res, issued.token, issued.expiresAt);
    res.json({
      token: issued.token,
      expiresAt: issued.expiresAt,
      identity: issued.identity,
      capabilities: capabilitiesOf(issued.identity.role),
    });
  });

  /**
   * POST /api/local/login — la console LOCALE, sans mot de passe (`oathrion console`).
   *
   * N'existe qu'en mode local (`oathrion wrap`) : ailleurs, 404, comme une route inconnue.
   * Le ticket est signé avec le secret de session de cet Oathrion local, vaut deux minutes,
   * et ne sert qu'une fois (`shared/local-login-ticket.ts`). Il ouvre une session pour la
   * personne de l'espace local, par le même `openSession` que le mot de passe et le SSO :
   * seule la PREUVE change, jamais ce qui la suit.
   */
  /*
   * GET /api/local/login — « suis-je une console locale ? », avant toute session. La page de
   * connexion s'en sert pour dire comment entrer : `oathrion console`, pas un mot de passe
   * que la personne n'a jamais choisi. Le lien « approuvez ici » que reçoit l'agent mène à
   * cette page — et ce lien ne peut pas porter de ticket, puisqu'il passe par l'agent.
   */
  /*
   * La version qui tourne (le paquet du serveur local : taille, date). Une console ouverte avant
   * une mise à jour la compare, et se recharge quand elle change (essai réel du 10 novembre : un
   * onglet ouvert avant la mise à jour montrait encore l'ancienne console).
   */
  const LOCAL_BUILD = (() => {
    try {
      const stat = fs.statSync(process.argv[1] ?? "");
      return `${String(stat.size)}:${String(Math.round(stat.mtimeMs))}`;
    } catch {
      return null;
    }
  })();
  app.get("/api/local/login", (_req, res) => {
    if (!isLocalMode()) return fail(res, 404, "Not found");
    /* Un pivot qui s'arrête ne se présente plus comme pivot : les clients en lanceront un neuf. */
    const hub = activeHub();
    res.json({ local: true, hub: hub !== null && !hub.isClosing, name: process.env.OATHRION_WRAP_NAME?.trim() || null, build: LOCAL_BUILD });
  });

  /*
   * GET /api/local/decider?n=<jeton> — le bouton « Décider » d'une notification qui ouvre une
   * adresse au lieu de rappeler le pivot (Windows). Le jeton, à usage unique, est échangé
   * contre un lien de connexion NEUF, puis la console. Échu ou déjà servi : la console nue, qui
   * dit comment entrer.
   */
  app.get("/api/local/decider", (req, res) => {
    const hub = activeHub();
    if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
    const token = typeof req.query.n === "string" ? req.query.n : "";
    const secret = process.env.OATHRION_SESSION_SECRET?.trim() ?? "";
    if (secret === "" || !claimDecideToken(token)) return res.redirect(302, "/console");
    /* Une notification à boutons : la console s'ouvre sur CETTE décision (`local-decisions.ts`). */
    const decision = typeof req.query.e === "string" && hub.decisions.view(req.query.e) ? req.query.e : null;
    const next = decision ? `&next=${encodeURIComponent(`/decide?e=${decision}`)}` : "";
    return res.redirect(302, `/console#/connexion-locale?ticket=${mintLocalLoginTicket(secret)}${next}`);
  });

  /*
   * GET /api/local/servers — l'écran « Serveurs » de la console locale : chaque serveur sous
   * Oathrion (ce qu'il expose, les clients qui le portent, sa dernière action), et les
   * serveurs de Claude Code et de Cursor qui ne passent PAS par Oathrion, lus dans leurs
   * configurations sur cette machine (lecture seule ; `npx oathrion` les protège). N'existe
   * que si ce processus est un pivot.
   */
  /*
   * GET /api/local/activity — LA CHRONOLOGIE UNIQUE (`server/local-activity.ts`) : les actions
   * passées par Oathrion et celles que Claude Code a exécutées lui-même (journal du hook), sur un
   * seul fil, du plus récent au plus ancien. `?agent=` filtre ; l'état de la chaîne du journal
   * est relu à chaque fois (celle des reçus a sa route : `/api/actions/receipts/verify`).
   */
  app.get(
    "/api/local/activity",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { repositories } = scope(req);
      const { verifyJournal } = await import("../cli/wrap/claude-journal");
      const { timeline } = await import("./local-activity");
      const { file: journalFile, lines } = readHookJournal(hub.dir);
      const executions = await repositories.executions.list(2_000);
      const agent = typeof req.query.agent === "string" && req.query.agent !== "" ? req.query.agent : undefined;
      const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 2_000);
      const all = timeline(executions, lines, { limit: 100_000 });
      res.json({
        entries: agent ? all.filter((entry) => entry.agent === agent).slice(0, limit) : all.slice(0, limit),
        agents: [...new Set(all.map((entry) => entry.agent))].sort(),
        journal: verifyJournal(journalFile),
      });
    }),
  );

  /*
   * GET /api/local/summary — LE BILAN (`server/local-summary.ts`) : sur la période
   * (`?period=today`, par défaut, ou `7d`), combien d'actions sont passées seules, ont été
   * demandées à une personne, ont été bloquées ; les actions bloquées en tête ; et la preuve —
   * les DEUX chaînes relues en entier (reçus d'Oathrion, journal du hook Claude Code).
   */
  app.get(
    "/api/local/summary",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { repositories } = scope(req);
      const { verifyJournal } = await import("../cli/wrap/claude-journal");
      const { timeline } = await import("./local-activity");
      const { summarize } = await import("./local-summary");
      const { verifyLocalReceipts } = await import("./local-verify");
      const { file, lines } = readHookJournal(hub.dir);
      const now = new Date();
      const since = new Date(now);
      if (req.query.period === "7d") since.setTime(now.getTime() - 7 * 24 * 3_600_000);
      else since.setHours(0, 0, 0, 0);
      const receipts = await verifyLocalReceipts();
      const journal = verifyJournal(file);
      res.json({
        period: req.query.period === "7d" ? "7d" : "today",
        ...summarize(timeline(await repositories.executions.list(5_000), lines, { limit: 100_000 }), {
          since: since.toISOString(),
          until: now.toISOString(),
          receipts: { ok: receipts.ok, entries: receipts.entries, reason: receipts.reason },
          journal: { ok: journal.ok, entries: journal.entries, reason: journal.reason },
        }),
      });
    }),
  );

  /*
   * GET /api/local/receipts/:ref/share — LE REÇU PARTAGEABLE d'une ligne d'« Activity »
   * (`exe_…` ou `toolu_…`) : la déclaration, la preuve de sa chaîne relue à l'instant, signée
   * par la clé de cet Oathrion (`shared/receipt-share.ts`), dans un fichier HTML qui se vérifie
   * lui-même (`server/receipt-share-html.ts`). `?format=json` : le reçu seul.
   */
  app.get(
    "/api/local/receipts/:ref/share",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const ref = param(req, "ref");
      const identity = requireIdentity(req);
      const { repositories } = scope(req);
      const { verifyJournal } = await import("../cli/wrap/claude-journal");
      const { timeline } = await import("./local-activity");
      const { receiptStatement } = await import("./local-receipt");
      const { signingKey, signStatement } = await import("@shared/receipt-share");
      const { receiptHtml } = await import("./receipt-share-html");
      const { file, lines } = readHookJournal(hub.dir);
      const executions = await repositories.executions.list(5_000);
      const entry = timeline(executions, lines, { limit: 100_000 }).find((candidate) => candidate.ref === ref);
      if (!entry) return fail(res, 404, "No action with this reference.");

      let evidence: import("./local-receipt").ChainEvidence;
      if (entry.source === "claude-code") {
        const verdict = verifyJournal(file);
        evidence = {
          chain: "Claude Code journal kept by Oathrion's hook",
          entries: lines.filter((line) => line.toolUseId === ref).map((line) => ({ seq: line.seq, hash: line.hash })),
          chainIntact: verdict.ok,
          chainEntries: verdict.entries,
          /* L'empreinte de la dernière ligne (`verdict.last` est son heure, pas son empreinte). */
          chainHead: lines.at(-1)?.hash ?? null,
        };
      } else {
        const execution = await repositories.executions.findById(ref);
        if (!execution) return fail(res, 404, "No action with this reference.");
        const audit = execution.audit ?? [];
        const verdict = verifyAuditChain(identity.organizationId, ref, audit);
        evidence = {
          chain: "Oathrion's chained record of this execution",
          entries: audit.flatMap((item, index) => (item.hash ? [{ seq: index + 1, hash: item.hash }] : [])),
          chainIntact: verdict.ok,
          chainEntries: audit.length,
          chainHead: headHash(identity.organizationId, ref, audit),
        };
      }
      const key = signingKey(hub.dir);
      const shared = signStatement(
        receiptStatement(entry, evidence, { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint }, new Date().toISOString()),
        key.privateKey,
      );
      if (req.query.format === "json") return res.json(shared);
      res.setHeader("Content-Disposition", `attachment; filename="oathrion-receipt-${ref.replace(/[^a-zA-Z0-9_-]/g, "")}.html"`);
      res.type("text/html").send(receiptHtml(shared));
    }),
  );

  app.get(
    "/api/local/servers",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { repositories } = scope(req);
      const agents = new Map((await repositories.agents.list()).map((agent) => [agent.id, agent.name]));
      /* Compté en base, non tronqué : après une journée de travail, le compte reste juste. */
      const servers = await Promise.all(
        hub.serverStates().map(async (server) => {
          const prefix = `mcp.${server.name}.`;
          const { count, latest: last } = await repositories.executions.actionActivity(prefix);
          return {
            name: server.name,
            server: server.child,
            classes: server.classes,
            clients: server.agentIds.map((id) => agents.get(id) ?? id),
            actions: count,
            lastAction: last ? { at: last.timestamp, tool: last.action.slice(prefix.length), decision: last.decision, agentName: last.agentName } : null,
          };
        }),
      );
      const { findSources } = await import("../cli/wrap/setup");
      const { isWrapped } = await import("../cli/wrap/install");
      /*
       * `protectable` : ce que `npx oathrion` sait mettre derrière Oathrion — un serveur local,
       * ou un serveur distant dont le jeton est dans la configuration. Un serveur distant sans
       * jeton a sa connexion (OAuth) gérée par le client : il est nommé, pas proposé.
       */
      const unprotected: { client: string; where: string; name: string; protectable: boolean }[] = [];
      for (const source of findSources(homedir(), homedir()).sources) {
        const entries = source.kind === "file" ? source.config.mcpServers : source.servers;
        for (const [name, config] of Object.entries(entries)) {
          if (config === null || typeof config !== "object" || isWrapped(config)) continue;
          const headers = config.headers !== null && typeof config.headers === "object" && Object.keys(config.headers as object).length > 0;
          if (typeof config.url === "string") unprotected.push({ client: source.client, where: source.label, name, protectable: headers });
          else if (typeof config.command === "string" && config.command !== "") unprotected.push({ client: source.client, where: source.label, name, protectable: true });
        }
      }
      res.json({ servers, unprotected });
    }),
  );

  /*
   * GET /api/local/protection — ce qu'Oathrion couvre, agent par agent, et ce qu'il ne voit pas
   * (`server/local-protection.ts`). Lu sur le disque à chaque appel : rien n'est gardé.
   */
  app.get(
    "/api/local/protection",
    requireCapability("read"),
    handle(async (_req, res) => {
      if (!isLocalMode() || !activeHub()) return fail(res, 404, "Not found");
      const { claudeDesktopConfig, findSources, hooksPresent, permissionFile } = await import("../cli/wrap/setup");
      const { isWrapped } = await import("../cli/wrap/install");
      const { protectionReport } = await import("./local-protection");
      const home = homedir();
      const { sources } = findSources(home, home);
      const servers = sources.flatMap((source) =>
        Object.entries(source.kind === "file" ? source.config.mcpServers : source.servers)
          .filter(([, config]) => config !== null && typeof config === "object")
          .map(([name, config]) => ({ client: source.client, where: source.label, name, config, wrapped: isWrapped(config) })),
      );
      const userSettings = path.join(home, ".claude", "settings.json");
      const projects = new Set<string>();
      for (const source of sources) {
        if (source.client !== "Claude Code") continue;
        const path = permissionFile(source, home);
        if (path && path !== userSettings && hooksPresent(path) === true) projects.add(source.label.replace(/^Claude Code · /, ""));
      }
      const clients = [
        ...(fs.existsSync(path.join(home, ".claude")) || fs.existsSync(path.join(home, ".claude.json")) ? (["Claude Code"] as const) : []),
        ...(fs.existsSync(path.join(home, ".cursor")) ? (["Cursor"] as const) : []),
        ...(fs.existsSync(path.dirname(claudeDesktopConfig(home))) ? (["Claude Desktop"] as const) : []),
      ];
      res.json(protectionReport({ clients, servers, hooks: { allProjects: hooksPresent(userSettings) === true, projects: [...projects] } }));
    }),
  );

  /*
   * POST /api/local/accords — « décider une fois », depuis la console : ne plus demander pour
   * l'outil de cette demande. Une règle (`pol_wrap_<serveur>_toujours`), d'où `manage` ; le
   * pivot refuse tout ce qui n'est pas une ÉCRITURE d'un de ses serveurs. La demande elle-même
   * reste à approuver, par la route habituelle.
   */
  /*
   * LES PROGRAMMES (9 novembre) : ceux qui ont lancé un relais, confirmés, en attente ou
   * bloqués (`server/local-programs.ts`). Un programme en attente n'a aucune clé : rien de ce
   * qu'il demande ne passe tant qu'une personne ne l'a pas confirmé ici. Une identité de
   * l'agent est lisible par tous ceux qui voient la console ; seul celui qui gère les agents
   * décide.
   */
  app.get(
    "/api/local/programs",
    requireCapability("read"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { describeIdentity } = await import("./local-programs");
      res.json(hub.programs.list().map((program) => ({ ...program, description: describeIdentity(program) })));
    }),
  );

  /*
   * LES AGENTS QUI TOURNENT (10 novembre, `server/local-agent-watch.ts`) : ceux hors d'une prison
   * d'Oathrion, à arrêter ou à autoriser là. Arrêter ne vise qu'un processus que la veille voit
   * À L'INSTANT comme un agent hors prison : jamais un numéro de processus quelconque.
   */
  app.get(
    "/api/local/agents/running",
    requireCapability("read"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const allowed = hub.outsideAllowances.list();
      const { pausedHow } = await import("./local-agent-pause");

      res.json(
        hub.runningAgents().map((agent) => {
          const mascot = hub.mascots.of(agent.agent);
          return { ...agent, mascot: { id: mascot.id, name: mascot.name }, allowedOutside: agent.exe in allowed, allowedOnce: hub.isAllowedOnce(agent.launch), allowance: allowed[agent.exe] ?? null, paused: pausedHow(agent.pid) };
        }),
      );
    }),
  );

  /*
   * Les agents autorisés hors de la prison, et le retour sur ce choix (essai réel du 10 novembre :
   * autorisé d'un clic à 20 h 08, oublié à 20 h 54 — « je n'ai pas reçu de notification »).
   */
  /*
   * LE FIL D'ACTUALITÉ (`server/local-feed.ts`) : ce qui s'est passé, en phrases simples, avec la
   * mascotte de l'agent ; chaque élément porte aussi le texte à partager, sans rien de privé.
   */
  app.get(
    "/api/local/feed",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { buildFeed } = await import("./local-feed");
      const { repositories } = scope(req);
      res.json(buildFeed({ events: hub.events.list(), approvals: await repositories.approvals.list(200), executions: await repositories.executions.list(500), face: (agent) => hub.mascots.of(agent) }));
    }),
  );

  /*
   * LES MASCOTTES DES AGENTS (11 novembre) : le catalogue, et le choix de la personne pour chaque
   * agent (une mascotte, un nom). Le choix vaut pour toute la famille de l'agent (« Claude Code »,
   * « claude ») et se voit aussitôt dans les notifications, le fil et la console.
   */
  /* Une carte à partager, ouverte depuis la notification (`LocalHub.keepShareCard`). */
  app.get(
    "/api/local/share-cards/:token",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const card = hub.shareCard(param(req, "token"));
      if (!card) return fail(res, 404, "This card is no longer here: share it again from the notification, or from Home.");
      res.json(card);
    }),
  );

  /*
   * LA DÉCISION DANS LA CONSOLE (`server/local-decisions.ts`) : ce que « Decide » ouvre sous macOS
   * et Windows — la notification, avec la mascotte et ses boutons ; le bouton choisi agit par la
   * même voie que la notification de Linux ; puis « Was this right? » et la carte à partager.
   */
  app.get(
    "/api/local/decisions/:id",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const view = hub.decisions.view(param(req, "id"));
      if (!view) return fail(res, 404, "This decision is no longer here: it may have been made already. Your agents and what they did are on Home.");
      res.json(view);
    }),
  );

  app.post(
    "/api/local/decisions/:id",
    requireCapability("approve"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const id = param(req, "id");
      if (typeof body.action === "string") {
        const done = await hub.decisions.choose(id, body.action);
        if (typeof done === "string") return fail(res, 409, done);
      } else if (typeof body.right === "boolean") {
        if (!hub.decisions.judge(id, body.right)) return fail(res, 409, "Already answered, or nothing decided yet.");
      } else if (typeof body.share === "string") {
        const { SHARE_NETWORKS } = await import("@shared/share");
        const view = hub.decisions.view(id);
        if (!view || !view.share || !view.mascot || !(SHARE_NETWORKS as readonly string[]).includes(body.share)) return fail(res, 409, "Nothing to share here.");
        const token = hub.keepShareCard({ sentence: view.share, mascot: view.mascot, at: new Date().toISOString(), tone: view.danger ? "bad" : "good" });
        return res.json({ token });
      } else {
        return fail(res, 400, "action, right or share.");
      }
      res.json(hub.decisions.view(id));
    }),
  );

  /*
   * « PRÊT À X/5 » (12 novembre, le graal du parcours) : ce que la personne a déjà fait pour être
   * bien protégée, et ce qui manque, chacun avec son geste. Rien n'est inventé : chaque étape est
   * lue sur la machine (les configurations, le repère de la démo, l'appairage, les choix de
   * mascottes, les approbations tranchées).
   */
  app.get(
    "/api/local/readiness",
    requireCapability("read"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { findSources } = await import("../cli/wrap/setup");
      const { isWrapped } = await import("../cli/wrap/install");
      const { paired, readTelegram } = await import("./local-telegram");
      let protectedServers = 0;
      for (const source of findSources(homedir(), homedir()).sources) {
        for (const config of Object.values(source.kind === "file" ? source.config.mcpServers : source.servers)) {
          if (config !== null && typeof config === "object" && isWrapped(config)) protectedServers += 1;
        }
      }
      const decided = (await scope(req).repositories.approvals.list(1)).some((approval) => approval.status !== "pending");
      const telegram = readTelegram(hub.dir);
      /*
       * Branché AU MOINS UNE FOIS (le pivot garde la commande de chaque serveur lancé, `serveurs/`),
       * ou en ce moment : un client fermé le soir ne fait pas revenir « redémarre Cursor ».
       */
      const launched = (() => {
        try {
          return fs.readdirSync(path.join(hub.dir, "serveurs")).filter((name) => fs.existsSync(path.join(hub.dir, "serveurs", name, "commande.json"))).length;
        } catch {
          return 0;
        }
      })();
      const connected = Math.max(launched, hub.serverStates().length);
      res.json({
        steps: [
          /* Protégé pour de vrai : un client s'est branché par Oathrion (pas seulement sa configuration changée, avant qu'il redémarre). */
          { id: "protected", done: protectedServers > 0 && connected > 0, count: protectedServers, connected },
          { id: "demo", done: fs.existsSync(path.join(hub.dir, DEMO_SEEN)) },
          { id: "phone", done: paired(telegram), bot: paired(telegram) ? telegram.bot : null },
          /* Facultatif : un plaisir, pas une protection. */
          { id: "named", done: Object.keys(hub.mascots.list()).length > 0, optional: true },
          { id: "decision", done: decided },
        ],
      });
    }),
  );

  /* « Show me » dans la console : la démo, comme `oathrion demo`. */
  app.post(
    "/api/local/demo",
    requireCapability("manage"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const shown = hub.onDemo?.("pause") ?? { shown: false, detail: "This Oathrion has no desktop notifications." };
      if (shown.shown) markDemoSeen(hub.dir);
      res.status(shown.shown ? 200 : 409).json(shown);
    }),
  );

  app.get(
    "/api/local/mascots",
    requireCapability("read"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { CHOOSABLE_MASCOTS, MASCOT_NAMES } = await import("@shared/mascots");
      res.json({ catalog: CHOOSABLE_MASCOTS.map((id) => ({ id, name: MASCOT_NAMES[id] })), choices: hub.mascots.list() });
    }),
  );

  app.post(
    "/api/local/mascots",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const body = (req.body ?? {}) as Record<string, unknown>;
      const agent = typeof body.agent === "string" ? body.agent.trim() : "";
      if (agent === "" || agent.length > 120) return fail(res, 400, "agent: the agent's name.");
      const chosen = hub.mascots.choose(agent, body.mascot, body.nickname);
      if (typeof chosen === "string") return fail(res, 400, chosen);
      res.json({ agent, face: hub.mascots.of(agent), choice: chosen });
    }),
  );

  /*
   * LES RÉGLAGES DE LA CONSOLE LOCALE (11 novembre : une page simple au lieu de l'organisation, de
   * la facturation et des clés API) : l'état de chaque protection de la machine. Les notifications
   * se règlent ici ; la veille, la prison par défaut et les leurres se posent par une commande
   * (ils installent des services et des fichiers : la page dit laquelle).
   */
  /*
   * APPAIRER LE TÉLÉPHONE DEPUIS LA CONSOLE (16 novembre, `server/local-phone-pairing.ts`) : le
   * jeton du robot collé ici, puis le QR code ; la console relit l'état jusqu'au « Paired ».
   */
  const phonePairings = new Map<string, import("./local-phone-pairing").PhonePairing>();
  const phonePairing = async (dir: string) => {
    const { PhonePairing } = await import("./local-phone-pairing");
    const mascot = path.join(path.dirname(process.argv[1] ?? ""), "public", "mascots", "warden.png");
    if (!phonePairings.has(dir)) phonePairings.set(dir, new PhonePairing(dir, { mascot: fs.existsSync(mascot) ? mascot : null }));
    return phonePairings.get(dir)!;
  };
  app.get(
    "/api/local/phone",
    requireCapability("manage"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      res.json((await phonePairing(hub.dir)).status());
    }),
  );
  app.post(
    "/api/local/phone/pair",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const token = typeof (req.body as { token?: unknown })?.token === "string" ? (req.body as { token: string }).token : "";
      res.json(await (await phonePairing(hub.dir)).start(token));
    }),
  );
  app.post(
    "/api/local/phone/test",
    requireCapability("manage"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      try {
        await (await phonePairing(hub.dir)).test();
        res.json({ ok: true });
      } catch (error) {
        fail(res, 409, error instanceof Error ? error.message : String(error));
      }
    }),
  );

  app.get(
    "/api/local/settings",
    requireCapability("read"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const { readNotificationSettings } = await import("./local-notifications");
      const { paired, readTelegram } = await import("./local-telegram");
      const phoneOf = (dir: string) => {
        const telegram = readTelegram(dir);
        return paired(telegram) ? { paired: true, bot: telegram.bot } : { paired: false, bot: null };
      };
      const home = process.env.HOME ?? "";
      const notifications = readNotificationSettings(hub.dir);
      const watchOn = fs.existsSync(path.join(home, ".config", "systemd", "user", "oathrion-watch.service")) || fs.existsSync(path.join(home, ".config", "autostart", "oathrion-watch.desktop"));
      const jailed = ["cursor-agent", "claude", "agy"].filter((agent) => fs.existsSync(path.join(home, ".oathrion", "bin", agent)));
      res.json({
        notifications: { desktop: notifications.desktop !== false, slack: Boolean(notifications.slackWebhookUrl) },
        /* Le téléphone (`local-telegram.ts`) : appairé ou non, et le nom du robot — jamais son jeton. */
        phone: phoneOf(hub.dir),
        watch: { on: watchOn },
        /* La veille, la prison et les leurres n'existent que sous Linux : ailleurs, la console n'en parle pas comme d'un manque. */
        platform: process.platform,
        jail: { agents: jailed },
        decoys: { count: hub.decoyFiles().length },
      });
    }),
  );

  app.post(
    "/api/local/settings/notifications",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const desktop = (req.body as { desktop?: unknown } | undefined)?.desktop;
      if (typeof desktop !== "boolean") return fail(res, 400, "desktop: true or false.");
      const { readNotificationSettings, NOTIFICATIONS_FILE } = await import("./local-notifications");
      const next = { ...readNotificationSettings(hub.dir), desktop };
      fs.writeFileSync(path.join(hub.dir, NOTIFICATIONS_FILE), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
      res.json({ desktop });
    }),
  );

  /* Le fil-piège : combien de leurres sont posés, et les dernières lectures (`server/local-tripwire.ts`). */
  app.get(
    "/api/local/tripwire",
    requireCapability("read"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      res.json({ decoys: hub.decoyFiles().length, events: hub.tripEvents() });
    }),
  );

  app.get(
    "/api/local/agents/allowed",
    requireCapability("read"),
    handle(async (_req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      res.json(Object.entries(hub.outsideAllowances.list()).map(([exe, allowance]) => ({ exe, ...allowance })));
    }),
  );

  app.post(
    "/api/local/agents/allowed/revoke",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const exe = typeof (req.body as { exe?: unknown })?.exe === "string" ? (req.body as { exe: string }).exe : "";
      if (!hub.outsideAllowances.has(exe)) return fail(res, 404, "This program is not allowed to run without Oathrion's protection.");
      const was = hub.outsideAllowances.list()[exe]?.agent ?? exe;
      hub.outsideAllowances.revoke(exe);
      hub.events.record({ kind: "forgotten", agent: was, by: "you, from the console" });
      /* Signalé de nouveau dès le prochain balayage, s'il tourne encore dehors. */
      hub.forgetSignalled(exe);
      res.json({ revoked: exe });
    }),
  );

  app.post(
    "/api/local/agents/running/:pid/:action",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const action = param(req, "action");
      if (action !== "stop" && action !== "allow") return fail(res, 400, "The action is « stop » or « allow ».");
      const agent = hub.rescanAgents().find((a) => String(a.pid) === param(req, "pid") && !a.jailed);
      if (!agent) return fail(res, 404, "No agent outside a jail with this process number (it may have stopped).");
      const { resumeAgent, stopAgent } = await import("./local-agent-pause");
      if (action === "allow") {
        /* Autorisé dehors : s'il était en pause, il reprend où il en était. */
        hub.outsideAllowances.allow(agent.exe, agent.agent, requireIdentity(req).name);
        hub.events.record({ kind: "allowed", agent: agent.agent, by: "you, from the console" });
        return res.json({ allowed: agent.exe, resumed: resumeAgent(agent.pid) });
      }
      if (!stopAgent(agent.pid)) return fail(res, 409, "It could not be stopped.");
      hub.events.record({ kind: "stopped", agent: agent.agent, by: "you, from the console" });
      res.json({ stopped: agent.pid });
    }),
  );

  app.post(
    "/api/local/programs/:id/:decision",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const decision = param(req, "decision");
      if (decision !== "trust" && decision !== "block") return fail(res, 400, "The decision is « trust » or « block ».");
      const decided = hub.programs.decide(param(req, "id"), decision === "trust" ? "trusted" : "blocked", requireIdentity(req).name);
      if (!decided) return fail(res, 404, "No such program.");
      hub.events.record({ kind: decision === "trust" ? "trusted" : "blocked", agent: decided.name, by: "you, from the console" });
      res.json(decided);
    }),
  );

  app.post(
    "/api/local/accords",
    requireCapability("manage"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const approvalId = typeof (req.body as { approvalId?: unknown })?.approvalId === "string" ? (req.body as { approvalId: string }).approvalId : "";
      const { repositories } = scope(req);
      const approval = await repositories.approvals.findById(approvalId);
      const execution = approval?.executionId ? await repositories.executions.findById(approval.executionId) : undefined;
      const match = execution ? /^mcp\.([a-z0-9][a-z0-9_-]*)\./.exec(execution.action) : null;
      if (!execution || !match) return fail(res, 404, "This request does not come from a server behind Oathrion.");
      try {
        res.json({ policyId: await hub.grantAlways(match[1]!, execution.action, "from the console") });
      } catch (error) {
        fail(res, 400, error instanceof Error ? error.message : String(error));
      }
    }),
  );

  /* « Allow 1 hour » depuis la console : la permission d'une heure (`local-hour-passes.ts`) ; la console approuve ensuite la demande. */
  app.post(
    "/api/local/hour-pass",
    requireCapability("approve"),
    handle(async (req, res) => {
      const hub = activeHub();
      if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
      const approvalId = typeof (req.body as { approvalId?: unknown })?.approvalId === "string" ? (req.body as { approvalId: string }).approvalId : "";
      const { repositories } = scope(req);
      const approval = await repositories.approvals.findById(approvalId);
      const execution = approval?.executionId ? await repositories.executions.findById(approval.executionId) : undefined;
      const { HourPasses, passable, untilClock } = await import("./local-hour-passes");
      if (!approval || !execution || !passable(execution.action)) return fail(res, 404, "Only a write tool of a server behind Oathrion can be allowed for an hour; a destructive one is asked every time.");
      const pass = new HourPasses(hub.dir).grant(approval.agentId, execution.action);
      res.json({ until: pass.until, clock: untilClock(pass) });
    }),
  );

  /*
   * POST /api/local/hub — l'administration du PIVOT local par ses relais et ses consoles
   * (`server/local-hub.ts`). N'existe que si ce processus est un pivot (404 sinon). Chaque
   * requête porte un ticket d'`oathrion` signé avec le secret de session (en-tête
   * `x-oathrion-local`, deux minutes, usage unique) : celui qui l'émet sait lire ce secret,
   * comme `oathrion console`. Les clés rendues s'appellent `…Token`, que le journal masque.
   */
  /* Les questions du hook Claude Code, par pivot (`server/local-claude-asks.ts`). */
  let claudeAsks: ClaudeAsks | null = null;
  app.post("/api/local/hub", async (req, res) => {
    const hub = activeHub();
    if (!isLocalMode() || !hub) return fail(res, 404, "Not found");
    /*
     * Deux sortes de secrets : celui de la session (la console, et tout relais du dehors), et le
     * secret RELAIS d'une prison ouverte (`oathrion jail`), seul visible dedans : un relais qui
     * signe avec lui est CONFINÉ à cette prison.
     */
    const relayTicket = req.header("x-oathrion-relay");
    const confined = typeof relayTicket === "string" && relayTicket !== "";
    let check: ReturnType<typeof checkLocalLoginTicket> | null = null;
    let jail: ReturnType<typeof hub.jail> = null;
    if (confined) {
      for (const candidate of hub.jailSecrets()) {
        const attempt = checkLocalLoginTicket(candidate, relayTicket);
        if (attempt.ok) {
          check = attempt;
          jail = hub.jail(candidate);
          break;
        }
      }
    } else {
      const secret = process.env.OATHRION_SESSION_SECRET?.trim() ?? "";
      check = secret === "" ? null : checkLocalLoginTicket(secret, String(req.header("x-oathrion-local") ?? ""));
    }
    if (!check?.ok || !claimLocalTicket(check.nonce, check.expiresAt)) return fail(res, 403, "Local ticket missing, expired or already used.");

    const body = (req.body ?? {}) as Record<string, unknown>;
    const holder = typeof body.holder === "string" ? body.holder : "";
    /* Ce qu'un relais enfermé peut faire : les gestes d'un relais, jamais décider ni ouvrir la console. */
    const CONFINED_OPS = new Set(["attach", "server", "client", "preview-tools", "claude-ask", "claude-status", "journal", "status", "heartbeat", "detach"]);
    if (jail && (!CONFINED_OPS.has(String(body.op)) || (body.op === "attach" && body.kind === "console"))) {
      return fail(res, 403, "Not allowed from inside an Oathrion jail: only a person outside it decides.");
    }
    /* Un relais enfermé ne touche qu'aux porteurs de SA prison. */
    if (jail && body.op !== "attach" && holder !== "" && !jail.holders.has(holder)) return fail(res, 403, "This holder does not belong to this jail.");
    try {
      switch (body.op) {
        case "attach": {
          const id = hub.attachHolder(body.kind === "console" ? "console" : "relay");
          jail?.holders.add(id);
          return res.json({ holder: id });
        }
        case "jail-open": {
          /* `oathrion jail`, dehors : le secret de cette prison, lié au programme qu'il y lance. */
          const { parseIdentity } = await import("./local-programs");
          const identity = parseIdentity(body.program);
          if (!identity) return fail(res, 400, "jail-open: the identity of the program the jail starts.");
          /* Un agent jamais vu ne démarre pas : la personne est prévenue, et `oathrion jail` attend sa décision. */
          const name = typeof body.name === "string" && body.name.trim() !== "" ? body.name.slice(0, 80) : path.basename(identity.exe);
          const admitted = hub.admitProgram(name, identity, "An agent Oathrion has never seen wants to start: confirm it is yours");
          if ("quarantined" in admitted) return res.json({ quarantined: admitted.quarantined, programId: admitted.program.id, program: admitted.description });
          return res.json({ relaySecret: hub.openJail(identity) });
        }
        case "jail-started":
          /* `oathrion jail`, dehors : le processus de la prison, pour que la veille sache qui y est. */
          if (!hub.jailStarted(typeof body.relaySecret === "string" ? body.relaySecret : "", Number(body.pid))) return fail(res, 404, "No such jail.");
          return res.status(204).end();
        case "jail-close":
          hub.closeJail(typeof body.relaySecret === "string" ? body.relaySecret : "");
          return res.status(204).end();
        case "server": {
          const server = body.server as Record<string, unknown> | undefined;
          const name = typeof server?.name === "string" ? server.name : "";
          if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name) || typeof server?.command !== "string" || !Array.isArray(server.args)) {
            return fail(res, 400, "server: a name, a command and its arguments.");
          }
          const args = server.args.map(String);
          /* Enfermé : seulement la commande exacte d'un serveur connu, avec ses jetons pris au coffre ici, dehors. */
          if (jail && !hub.knownServer(name, server.command, args)) {
            return fail(res, 403, `"${name}" with this command is not a server Oathrion knows: from inside a jail, only the servers configured in your clients can be started.`);
          }
          const env = jail
            ? hub.confinedServerEnv(name)
            : (Object.fromEntries(Object.entries((server.env ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string")) as Record<string, string>);
          if (!jail) hub.rememberServer(name, server.command, args);
          const summary = await hub.attachServer(holder, {
            name,
            command: server.command,
            args,
            cwd: typeof server.cwd === "string" ? server.cwd : undefined,
            env,
          });
          return res.json({ summary });
        }
        case "client": {
          const client = typeof body.client === "string" && body.client.trim() !== "" ? body.client.slice(0, 80) : "Client MCP";
          const { parseIdentity } = await import("./local-programs");
          /* Enfermé : l'identité est celle qu'`oathrion jail` a relevée dehors, jamais celle que le relais déclare. */
          const issued = await hub.issueClientKey(holder, client, jail ? jail.identity : parseIdentity(body.program));
          /* Un programme jamais vu, ou bloqué : pas de clé, et ce qu'il faut dire à l'agent. */
          if ("quarantined" in issued) return res.json({ quarantined: issued.quarantined, programId: issued.program.id, program: issued.description });
          const { key, agentId, agentName } = issued;
          /* Enfermé : jamais de clé d'approbation ; la question ne se tranche que dans la console, dehors. */
          const approverToken = body.approver === true && !jail ? hub.issueApproverKey(holder) : null;
          return res.json({ agentToken: key, agentId, agentName, approverToken });
        }
        case "preview-tools": {
          /* Les outils du serveur de ce relais, pour un programme en quarantaine : aucune clé n'est émise. */
          return res.json({ tools: hub.previewTools(holder) });
        }
        case "accord": {
          /* « Décider une fois », pour toujours : demandé par le relais, après la réponse de la personne dans son client. */
          const server = typeof body.server === "string" ? body.server : "";
          const verb = typeof body.verb === "string" ? body.verb : "";
          const origin = typeof body.origin === "string" ? body.origin.slice(0, 80) : "from the MCP client";
          try {
            return res.json({ policyId: await hub.grantAlways(server, verb, origin) });
          } catch (error) {
            return fail(res, 400, error instanceof Error ? error.message : String(error));
          }
        }
        case "claude-ask": {
          /* Le hook Claude Code, en mode automatique : demander à une personne dans Oathrion. */
          const kind = body.kind === "file_write" ? "file_write" : body.kind === "shell" ? "shell" : null;
          const target = typeof body.target === "string" ? body.target.slice(0, 2_000) : "";
          if (!kind || !/^(shell|file):\/\//.test(target)) return fail(res, 400, "claude-ask: a kind (shell, file_write) and a shell:// or file:// target.");
          claudeAsks ??= new ClaudeAsks(hub.organization, hub.dir);
          return res.json(
            await claudeAsks.ask(
              {
                kind,
                target,
                ...(typeof body.command === "string" ? { command: body.command.slice(0, 1_000) } : {}),
                reason: typeof body.reason === "string" ? body.reason.slice(0, 400) : "",
                ...(typeof body.untrusted === "string" && body.untrusted.trim() !== "" ? { untrusted: body.untrusted.slice(0, 200) } : {}),
              },
              scopeFor(hub.organization).gateway,
            ),
          );
        }
        case "claude-status": {
          const approvalId = typeof body.approvalId === "string" ? body.approvalId : "";
          claudeAsks ??= new ClaudeAsks(hub.organization, hub.dir);
          return res.json({ status: await claudeAsks.status(approvalId) });
        }
        case "bundle": {
          /*
           * « No receipt, no merge » : le paquet signé de ce que Claude Code a fait dans un dépôt,
           * sur la fenêtre d'une branche (`server/local-bundle.ts`). Demandé par
           * `oathrion receipt bundle`, qui calcule la portée avec git.
           */
          const project = typeof body.project === "string" ? body.project : "";
          const raw = (body.scope ?? {}) as Record<string, unknown>;
          const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.slice(0, 300) : null);
          const since = text(raw.since);
          const until = text(raw.until) ?? new Date().toISOString();
          if (!path.isAbsolute(project) || !since || Number.isNaN(Date.parse(since))) return fail(res, 400, "bundle: an absolute project path and a since date.");
          const { verifyJournal } = await import("../cli/wrap/claude-journal");
          const { bundleStatement } = await import("./local-bundle");
          const { signDocument, signingKey } = await import("@shared/receipt-share");
          const { file, lines } = readHookJournal(hub.dir);
          const verdict = verifyJournal(file);
          const key = signingKey(hub.dir);
          const statement = bundleStatement({
            lines,
            project,
            home: homedir(),
            scope: { repository: text(raw.repository), branch: text(raw.branch), base: text(raw.base), head: text(raw.head), since, until },
            journal: { ok: verdict.ok, entries: verdict.entries, reason: verdict.reason, head: lines.at(-1)?.hash ?? null },
            issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint },
            issuedAt: new Date().toISOString(),
          });
          return res.json(signDocument(statement, key.privateKey));
        }
        case "journal": {
          /* Le hook de Claude Code enfermé : il AJOUTE au journal, par le pivot ; il ne peut pas le réécrire. */
          const { appendJournal } = await import("../cli/wrap/claude-journal");
          const record = body.record as Parameters<typeof appendJournal>[1] | undefined;
          if (!record || typeof record !== "object") return fail(res, 400, "journal: a record.");
          appendJournal({ OATHRION_WRAP_HOME: path.dirname(hub.dir) } as NodeJS.ProcessEnv, record, new Date());
          return res.status(204).end();
        }
        case "status":
          return res.json({ servers: hub.serverNames(), holders: hub.holderCount() });
        case "demo": {
          /* `oathrion demo` : la notification sur un agent pour de faux ; rien de réel n'est mis en pause. */
          const shown = hub.onDemo?.(body.kind === "decoy" ? "decoy" : "pause") ?? { shown: false, detail: "This Oathrion has no desktop notifications." };
          if (shown.shown) markDemoSeen(hub.dir);
          return res.status(shown.shown ? 200 : 409).json(shown);
        }
        case "retire":
          /*
           * Un pivot plus ancien que le paquet installé laisse la place (demandé par la veille,
           * dehors) : tout de suite s'il ne sert aucun agent ; sinon il continue, pour ne rien couper.
           */
          if (!hub.canRetire()) return res.status(409).json({ retiring: false, holders: hub.holderCount() });
          res.status(202).json({ retiring: true });
          setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
          return;
        case "heartbeat":
          return hub.heartbeat(holder) ? res.status(204).end() : fail(res, 404, "Unknown holder: attach again.");
        case "detach":
          hub.detach(holder);
          return res.status(204).end();
        default:
          return fail(res, 400, "op: attach, server, client, accord, claude-ask, claude-status, bundle, status, heartbeat or detach.");
      }
    } catch (error) {
      if (error instanceof ServerConflictError) return fail(res, 409, error.message);
      if (error instanceof HubClosingError) return fail(res, 503, error.message);
      return fail(res, 502, error instanceof Error ? error.message : String(error));
    }
  });

  app.post("/api/local/login", async (req, res) => {
    if (!isLocalMode()) return fail(res, 404, "Not found");
    const ip = req.ip ?? "unknown";
    if (await loginThrottled(ip)) return fail(res, 429, "Too many attempts. Try again in a minute.", ERROR_CODES.loginThrottled);

    const ticket = typeof (req.body as { ticket?: unknown } | undefined)?.ticket === "string" ? (req.body as { ticket: string }).ticket : "";
    const secret = process.env.OATHRION_SESSION_SECRET?.trim() ?? "";
    const check = secret === "" ? null : checkLocalLoginTicket(secret, ticket);
    if (!check?.ok || !claimLocalTicket(check.nonce, check.expiresAt)) {
      await registerFailedLogin(ip);
      /*
       * 403 et non 401 : un 401 dit à la console que SA session est morte, et elle se
       * déconnecte. Un lien périmé, ouvert dans un onglet déjà connecté, fermait ainsi une
       * session valide (vu à l'œil, le 28 octobre 2026).
       */
      return fail(
        res,
        403,
        'This sign-in link is no longer valid (it works once, for two minutes): run "oathrion console" again to get a new one.',
        ERROR_CODES.invalidCredentials,
      );
    }

    const organization = organizationStore.findByName(LOCAL_ORGANIZATION);
    const person = userStore.findByEmail(LOCAL_ADMIN_EMAIL);
    if (!organization || !person) return fail(res, 409, "The local workspace is not ready yet.");
    const { session: issued } = openSession(person, organization.id as OrganizationId);
    if (!issued) return fail(res, 403, "This account cannot open a session.");

    setSessionCookie(req, res, issued.token, issued.expiresAt);
    res.json({ token: issued.token, expiresAt: issued.expiresAt, identity: issued.identity, capabilities: capabilitiesOf(issued.identity.role) });
  });

  /**
   * POST /api/auth/password — a user changes their own password.
   *
   * Requires the current password even though the caller is already authenticated:
   * a stolen session token must not be enough to lock the real owner out of the
   * account. Every other session the account holds is revoked, the caller's own is
   * kept, and a service caller is refused outright — an API key has no password to
   * change, and P0-5 gives keys their own rotation path.
   */
  app.post("/api/auth/password", (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only console users have a password. Rotate an API key instead.");
    }

    const parsed = z
      .strictObject({
        currentPassword: z.string().trim().min(1).max(256),
        newPassword: z.string().trim().min(1).max(256),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "currentPassword and newPassword are required");

    const problems = passwordProblems(parsed.data.newPassword);
    if (problems.length > 0) return fail(res, 400, problems.join(" "));
    if (parsed.data.newPassword === parsed.data.currentPassword) {
      return fail(res, 400, "The new password must be different from the current one.");
    }

    const result = changePassword(
      identity.id,
      parsed.data.currentPassword,
      parsed.data.newPassword,
      identity.sessionId,
    );
    if (!result.ok) {
      // Deliberately the same 401 as a failed sign-in: this endpoint verifies a
      // password, so it is a guessing surface too.
      return fail(res, 401, "Invalid credentials");
    }

    res.json({ ok: true, otherSessionsRevoked: true });
  });

  /** GET /api/auth/session — who the current credential resolves to. */
  app.get("/api/auth/session", (req, res) => {
    const identity = requireIdentity(req);
    /* `localMode` : la console d'`oathrion wrap` n'arrive pas sur le parcours d'équipe. */
    res.json({ identity, capabilities: capabilitiesOf(identity.role), localMode: isLocalMode() });
  });

  /**
   * POST /api/auth/logout — revokes the session behind this request.
   * Revocation is server-side, so the token is dead everywhere immediately.
   */
  app.post("/api/auth/logout", (req, res) => {
    const identity = requireIdentity(req);
    if (!identity.sessionId) return fail(res, 400, "This credential is not a session.");
    const revoked = sessionStore.revoke(identity.sessionId, identity.name, identity.organizationId);
    /* Le cookie est effacé aussi : la session est morte côté serveur, il ne doit pas traîner. */
    clearSessionCookie(req, res);
    res.json({ revoked });
  });

  /**
   * GET /api/auth/sessions — the session ledger.
   * An admin sees every session; anyone else sees only their own.
   */
  app.get("/api/auth/sessions", (req, res) => {
    const identity = requireIdentity(req);
    const sessions =
      identity.role === "admin"
        ? // "Every session" means every session *in this organization*. An admin is an
          // administrator of their own tenant, not of the deployment.
          sessionStore.list(identity.organizationId)
        : sessionStore.listFor(identity.organizationId, identity.id);
    res.json({
      total: sessions.length,
      sessions: sessions.map((s) => ({
        ...s,
        current: s.id === identity.sessionId,
        active: !s.revokedAt && Date.parse(s.expiresAt) > Date.now(),
      })),
    });
  });

  /**
   * DELETE /api/auth/sessions/:id — revoke a session.
   * Your own always; someone else's only with `manage`.
   */
  app.delete("/api/auth/sessions/:id", (req, res) => {
    const identity = requireIdentity(req);
    const target = sessionStore.findIn(identity.organizationId, param(req, "id"));
    if (!target) return fail(res, 404, "Session not found");

    if (target.subject !== identity.id && !ensureCapability(req, res, "manage")) return;

    const revoked = sessionStore.revoke(target.id, identity.name, identity.organizationId);
    res.json({ revoked, sessionId: target.id });
  });

  /**
   * GET /api/organization — the caller's own tenant.
   *
   * What was on this screen before was a fixture: "Acme Corp / Enterprise / 42 seats /
   * eu-west-1", behind a "Demo data" badge. The organization has been a real row since
   * P0-1, so the fixture was replaced by the row rather than kept and relabelled.
   *
   * Only fields the database actually holds are returned. There is no `plan`, no `seats`
   * and no `region`, because Oathrion stores none of the three — inventing them here would
   * put the fixture back one layer down. Billing is out of scope (P3).
   *
   * The identity decides the tenant. There is no `:id` to tamper with.
   */
  app.get("/api/organization", (req, res) => {
    const identity = requireIdentity(req);
    const organization = organizationStore.find(identity.organizationId);
    // Unreachable through a valid credential: authentication resolves the organization
    // before this point. Answered explicitly rather than crashing on a null.
    if (!organization) return fail(res, 404, "Organization not found");

    const members = userStore.listMembers(identity.organizationId);
    res.json({
      id: organization.id,
      name: organization.name,
      createdAt: organization.createdAt,
      active: organization.active,
      memberCount: members.length,
      adminCount: members.filter((m) => m.role === "admin").length,
    });
  });

  /**
   * GET /api/usage — this organization's quota counters (P3).
   *
   * Exposed to the tenant, not only to the operator. Two reasons, both about the
   * failure this phase's roadmap entry names as its main risk — a ceiling that
   * interrupts a legitimate customer:
   *
   *  1. a customer who can see 480 of 500 agents can act before the wall, where one
   *     who only learns of the ceiling by being refused has already had a write fail;
   *  2. a client that has just been refused can verify the numbers the refusal quoted
   *     instead of taking them on trust from an error body.
   *
   * `read` capability, not `manage`. A quota is not a privileged administrative fact
   * about the deployment — it is a fact about the caller's own tenant, and anyone
   * allowed to list the agents is allowed to know how many more they may create.
   *
   * The organization comes from the identity. There is no parameter naming a tenant,
   * so there is nothing to tamper with, and the counts are computed by scoped queries
   * that cannot see another organization's rows.
   */
  app.get("/api/usage", requireCapability("read"), async (req, res) => {
    const identity = requireIdentity(req);
    /*
     * Through the repository layer, not `usageReport` directly: that function issues
     * Drizzle statements against the SQLite handle, which on a PostgreSQL deployment is
     * a stub that throws by design. This route answered 500 on every PostgreSQL
     * deployment until Phase 12.2 ran the smoke test on the engine production uses.
     */
    res.json({
      organizationId: identity.organizationId,
      counters: await usageReportFor(identity.organizationId),
    });
  });

  /**
   * GET /api/members — the real roster of this organization.
   *
   * Scoped by `identity.organizationId`, so an admin of one tenant cannot enumerate
   * another's users. `listMembers` returns `PublicUser`, a type that structurally cannot
   * carry a password hash.
   */
  app.get("/api/members", (req, res) => {
    const identity = requireIdentity(req);
    const members = userStore.listMembers(identity.organizationId);
    res.json({ total: members.length, members });
  });

  /**
   * PATCH /api/members/:id — change a member's role, or suspend and reinstate them.
   *
   * ## Why a human administrator, and not an admin API key
   *
   * The same rule as `/api/keys`, for the same reason: this route changes *who may
   * act*. A machine credential that can promote an account to admin is a
   * persistence mechanism — an attacker holding one leaked key could mint a human
   * identity with a plausible name, and survive the rotation of the key they came
   * in through while the operator believes the incident is closed. Administration
   * of people requires a person who signed in with a password.
   *
   * ## Why suspension and role live on the same route
   *
   * Both are edits to one membership row, and both are guarded by the same
   * last-admin check. Splitting them would duplicate that check, and the duplicate
   * is where the omission would eventually be.
   */
  app.patch("/api/members/:id", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can change a member.");
    }

    const parsed = z
      .strictObject({
        role: z.enum(ROLES).optional(),
        suspended: z.boolean().optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "Invalid member update");
    if (parsed.data.role === undefined && parsed.data.suspended === undefined) {
      return fail(res, 400, "Nothing to change: provide role, suspended, or both.");
    }

    const userId = param(req, "id");
    const membership = userStore.membership(identity.organizationId, userId);
    /*
     * A member of another organization reads as absent, so the reply is 404 and
     * never 403 — the same rule as `/api/keys/:id`. 403 would confirm that a
     * guessed user id exists somewhere in the deployment.
     */
    if (!membership) return fail(res, 404, "Member not found");

    /*
     * A role may not be granted wider than the granter's own. Today `manage`
     * belongs to `admin` alone so this cannot fire, and it is enforced anyway: a
     * boundary that depends on the capability matrix in another file staying
     * unchanged is not a boundary.
     */
    if (parsed.data.role && !roleAtMost(parsed.data.role, identity.role)) {
      return fail(res, 403, "A member cannot be given a role wider than your own.");
    }

    /*
     * The last-admin guard. Demoting or suspending the final active admin would
     * leave an organization that no tenant-facing endpoint could recover, because
     * recovering it requires an admin. Checked for both kinds of change, and
     * `hasAnotherActiveAdmin` counts only memberships that are themselves neither
     * suspended nor attached to a suspended account.
     */
    const losesAdmin =
      (parsed.data.role !== undefined && parsed.data.role !== "admin") ||
      parsed.data.suspended === true;
    if (
      membership.role === "admin" &&
      losesAdmin &&
      !userStore.hasAnotherActiveAdmin(identity.organizationId, userId)
    ) {
      return fail(
        res,
        409,
        "This is the last active administrator of this organization. Promote another one first.",
      );
    }

    if (parsed.data.role !== undefined && parsed.data.role !== membership.role) {
      userStore.grant(identity.organizationId, userId, parsed.data.role);
      /*
       * Every live session of this person in this organization is bound to the role
       * it was opened with, and `credentialStillValid` refuses one whose role no
       * longer matches. So the change already takes effect on their next request —
       * nothing is revoked here, and nothing needs to be.
       */
    }

    if (parsed.data.suspended === true) {
      userStore.suspendMembership(identity.organizationId, userId);
      /*
       * An outstanding invitation or reset token for somebody being cut off is a
       * live bypass that nobody would think to look for. Revoked here, in the same
       * request, rather than left for a cleanup job that may not exist.
       */
      const user = userStore.findById(userId);
      if (user) {
        identityTokenStore.revokeAllFor(identity.organizationId, user.email, identity.name);
      }
    } else if (parsed.data.suspended === false) {
      userStore.reinstateMembership(identity.organizationId, userId);
    }

    const updated = userStore.membership(identity.organizationId, userId);
    res.json({
      ok: true,
      member: {
        id: userId,
        role: updated?.role ?? membership.role,
        membershipStatus: updated?.suspendedAt ? "suspended" : "active",
        suspendedAt: updated?.suspendedAt ?? null,
      },
    });
  });

  /**
   * DELETE /api/members/:id — remove somebody from this organization.
   *
   * Deletes the membership, never the user: the account may belong to other
   * organizations, and `users` is deliberately not tenant-scoped. Executions in the
   * audit trail name this person as their actor, and the row that keeps that name
   * resolvable is the user, not the membership.
   *
   * Prefer suspension when the intent is temporary — removal forgets the role, and
   * re-adding requires deciding it again.
   */
  app.delete("/api/members/:id", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can remove a member.");
    }

    const userId = param(req, "id");
    const membership = userStore.membership(identity.organizationId, userId);
    if (!membership) return fail(res, 404, "Member not found");

    if (
      membership.role === "admin" &&
      !userStore.hasAnotherActiveAdmin(identity.organizationId, userId)
    ) {
      return fail(
        res,
        409,
        "This is the last active administrator of this organization. Promote another one first.",
      );
    }

    const user = userStore.findById(userId);
    userStore.revokeMembership(identity.organizationId, userId);

    /*
     * The sessions this person holds in THIS organization end now. Without this the
     * membership would be gone while the token stayed usable until
     * `credentialStillValid` next ran — which is one request, not zero, and
     * "removed" must not mean "removed after their next click". Sessions they hold
     * in other organizations are untouched: revoking those would be one tenant
     * signing someone out of another's console.
     */
    for (const session of sessionStore.listFor(identity.organizationId, userId, 500)) {
      if (session.revokedAt) continue;
      sessionStore.revoke(session.id, identity.name, identity.organizationId);
    }
    if (user) {
      identityTokenStore.revokeAllFor(identity.organizationId, user.email, identity.name);
    }

    res.json({ ok: true, removed: userId });
  });

  /* ----------------------------- Identity tokens ---------------------------- */

  /**
   * Invitations and password resets — the identity half of P2.
   *
   * ## Why there is no self-service "forgot my password"
   *
   * The roadmap called for one, answering identically whether the address exists or
   * not. It is deliberately NOT built here, and the reason is not effort: this build
   * has no e-mail transport. The only notification channel that exists is the
   * approval webhook (`server/notifications/`), which posts to an operator's
   * endpoint — sending a password-reset token there would put a credential in a
   * channel the account owner does not control, and logging it would put a
   * credential in the logs. With no way to deliver a token to the person who asked
   * for it, an unauthenticated reset endpoint could only return the token in its own
   * response, which is a complete authentication bypass: anyone could reset anyone's
   * password.
   *
   * So a reset is issued BY an administrator, handed over out of band, and redeemed
   * once. That is a real, secure, deliverable mechanism today. Self-service is
   * blocked on an e-mail transport, is recorded as such in the transition report,
   * and is not faked in the meantime.
   *
   * ## What is never returned twice
   *
   * The token appears exactly once, in the response to the request that created it.
   * Only `sha256(secret)` is stored, `PublicIdentityToken` has no digest field by
   * construction, and no route reads one back. This is the same contract as an API
   * key.
   */

  /**
   * POST /api/invitations — invite somebody, or issue a reset for a member.
   *
   * One route for both because they are one mechanism (see
   * `server/repositories/identity-tokens.ts`); `purpose` decides which
   * preconditions apply:
   *
   *   - `invite`: the address must NOT already be a member of this organization.
   *   - `reset` : the address MUST already be a member of this organization, so an
   *     administrator cannot mint a password change for a stranger's account —
   *     which, since `users` is deployment-wide, would otherwise be a way to take
   *     over an account belonging to another tenant.
   */
  app.post("/api/invitations", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can issue an invitation.");
    }

    const parsed = z
      .strictObject({
        email: z.string().trim().min(3).max(320),
        role: z.enum(ROLES).optional(),
        purpose: z.enum(["invite", "reset"]).optional(),
        /** Days, bounded by `MAX_TOKEN_TTL_MS` in the store. */
        expiresInDays: z.number().int().min(1).max(30).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) {
      // The zod issues are not echoed: the submitted value is somebody's address.
      return fail(res, 400, "Invalid invitation request");
    }

    const purpose = parsed.data.purpose ?? "invite";
    const email = normaliseEmail(parsed.data.email);
    // A minimal shape check. Not validation of deliverability — nothing here sends
    // mail — just a refusal to store something that cannot be an address at all.
    if (!/^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(email)) {
      return fail(res, 400, "email is not a usable address");
    }

    const existingUser = userStore.findByEmail(email);
    const existingMembership = existingUser
      ? userStore.membership(identity.organizationId, existingUser.id)
      : null;

    if (purpose === "invite" && existingMembership) {
      return fail(res, 409, "That address is already a member of this organization.");
    }
    if (purpose === "reset" && !existingMembership) {
      /*
       * 404 and not 403: to an administrator of THIS organization, an address that
       * is not one of their members is simply not there. Answering differently for
       * "exists in another tenant" would turn this route into a directory of every
       * account in the deployment.
       */
      return fail(res, 404, "That address is not a member of this organization.");
    }

    const role = purpose === "reset" ? existingMembership!.role : (parsed.data.role ?? "viewer");
    if (!roleAtMost(role, identity.role)) {
      return fail(res, 403, "An invitation cannot grant a role wider than your own.");
    }

    /*
     * One live token per address per purpose. Several valid tokens for one person
     * means several credentials that can leak, and an administrator who cannot see
     * how many exist cannot revoke them all. The existing one is reported rather
     * than silently replaced, so the answer to "did I already invite them?" is
     * visible instead of inferred.
     */
    const pending = identityTokenStore.livePending(identity.organizationId, purpose, email);
    if (pending) {
      return fail(
        res,
        409,
        `A ${purpose === "invite" ? "invitation" : "reset"} for that address is already outstanding. Revoke it first.`,
      );
    }

    const issued = identityTokenStore.create({
      organizationId: identity.organizationId,
      purpose,
      email,
      role,
      createdBy: identity.name,
      ttlMs: parsed.data.expiresInDays
        ? parsed.data.expiresInDays * 86_400_000
        : DEFAULT_TOKEN_TTL_MS,
    });

    res.status(201).json({
      invitation: toPublicToken(issued.record),
      token: issued.token,
      notice:
        "This is the only time the token is shown. Only a hash of it is stored, so it cannot be recovered. Deliver it to the recipient over a channel you trust.",
    });
  });

  /**
   * GET /api/invitations — the outstanding and historical tokens of one organization.
   *
   * Metadata only: `PublicIdentityToken` has no digest field, so no version of this
   * response can leak token material. Accepted, revoked and expired rows are
   * included — an inventory that hid them could not answer "was this revoked, or
   * did it never exist?", which is the question asked during a review.
   */
  app.get("/api/invitations", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    const tokens = identityTokenStore
      .list(identity.organizationId)
      .map((token) => toPublicToken(token));
    res.json({ total: tokens.length, invitations: tokens });
  });

  /**
   * DELETE /api/invitations/:id — revoke an unused token.
   *
   * Revoke, not delete: who invited whom, and whether it was ever accepted, is
   * exactly what a review reads. A token of another tenant reads as absent, so the
   * reply is 404 rather than 403.
   */
  app.delete("/api/invitations/:id", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can revoke an invitation.");
    }
    const id = param(req, "id");
    const token = identityTokenStore.findIn(identity.organizationId, id);
    if (!token) return fail(res, 404, "Invitation not found");

    const revoked = identityTokenStore.revoke(identity.organizationId, id, identity.name);
    if (!revoked) {
      /*
       * Already accepted or already revoked. 409 rather than a silent success,
       * because "revoked" and "was accepted three days ago" are different facts and
       * an administrator acting on an incident needs the second one.
       */
      return fail(res, 409, "That invitation is no longer outstanding.");
    }
    res.json({ ok: true, invitation: toPublicToken(identityTokenStore.findIn(identity.organizationId, id)!) });
  });

  /**
   * POST /api/invitations/accept — redeem an invitation. Public, unauthenticated.
   *
   * Creates the account if the address has none, sets the password the person
   * chooses, and grants the membership the token names. Issues NO session: the
   * person then signs in normally, so a token intercepted in transit yields an
   * account with a password the interceptor set — visible at the first sign-in
   * attempt by the real recipient — rather than a live session nobody can see.
   *
   * ## Why every refusal is the same 400
   *
   * Expired, replayed, revoked, unknown, wrong secret, suspended organization: one
   * message. Distinguishing them would confirm which token ids exist and which
   * organizations are live to an unauthenticated caller. The administrator sees the
   * real state in `GET /api/invitations`; the anonymous caller sees one answer.
   */
  /**
   * POST /api/invitations/inspect — ce qu'une invitation propose, AVANT de l'accepter.
   *
   * Publique, comme l'acceptation : la personne n'a pas encore de compte. Elle permet à
   * l'écran d'accueil de dire « Rejoindre Acme en tant qu'administrateur, avec
   * l'adresse a@acme.com » au lieu d'un formulaire anonyme — c'est ce qui rend le lien
   * utilisable sans explication du fondateur.
   *
   * Ce qu'elle révèle est ce que le lien révèle déjà à qui le détient : l'organisation,
   * l'adresse et le rôle. Un jeton inconnu, consommé, révoqué ou expiré reçoit la MÊME
   * réponse, et chaque échec compte dans le même étranglement que l'acceptation : la
   * route n'est pas un oracle de plus pour deviner des jetons.
   */
  app.post("/api/invitations/inspect", async (req, res) => {
    const ip = req.ip ?? "unknown";
    const retryAfter = await tokenRedemptionThrottled(ip);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return fail(res, 429, "Too many attempts. Try again shortly.", ERROR_CODES.rateLimited);
    }
    const parsed = z.strictObject({ token: z.string().trim().min(8).max(200) }).safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "token is required");

    const token = identityTokenStore.resolve(parsed.data.token);
    if (
      !token ||
      token.consumedAt ||
      token.revokedAt ||
      isTokenExpired(token) ||
      !organizationStore.isActive(token.organizationId)
    ) {
      await registerFailedTokenRedemption(ip);
      return fail(res, 400, "That invitation is not valid.");
    }
    res.json({
      purpose: token.purpose,
      organizationName: organizationStore.find(token.organizationId)?.name ?? "",
      email: token.email,
      role: token.role,
      expiresAt: token.expiresAt,
    });
  });

  app.post("/api/invitations/accept", async (req, res) => {
    const ip = req.ip ?? "unknown";
    const retryAfter = await tokenRedemptionThrottled(ip);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return fail(res, 429, "Too many attempts. Try again shortly.", ERROR_CODES.rateLimited);
    }

    const parsed = z
      .strictObject({
        token: z.string().trim().min(8).max(200),
        password: z.string().trim().min(1).max(256),
        name: z.string().trim().min(1).max(120).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "token and password are required");

    /*
     * Refusing costs the address one unit of its budget; the validation failures
     * below do not. A caller holding a valid token who picks too short a password is
     * not the attacker this counter is for, and burning their budget on a typo would
     * make a correctable mistake into a minute-long lockout.
     */
    const refuse = async () => {
      await registerFailedTokenRedemption(ip);
      return fail(res, 400, "That invitation is not valid.");
    };

    const token = identityTokenStore.resolve(parsed.data.token);
    if (!token || token.purpose !== "invite") return await refuse();
    if (token.consumedAt || token.revokedAt || isTokenExpired(token)) return await refuse();
    /*
     * A suspended organization suspends every credential it issued without deleting
     * anything — the rule stated in `shared/tenancy.ts`. An invitation is a
     * credential, so it stops working too.
     */
    if (!organizationStore.isActive(token.organizationId)) return await refuse();

    /*
     * The password is checked BEFORE the token is claimed. Claiming first and then
     * refusing a weak password would burn a single-use invitation on a typo, and the
     * recipient would have to ask for another one for no reason.
     */
    const problems = passwordProblems(parsed.data.password);
    if (problems.length > 0) return fail(res, 400, problems.join(" "));

    /*
     * Re-checked here and not only at issue time: an address invited last week may
     * have been added by hand in the meantime, and accepting would then overwrite a
     * live password using a token issued before that account existed.
     */
    const already = userStore.findByEmail(token.email);
    if (already && userStore.membership(token.organizationId, already.id)) return await refuse();

    // The atomic claim. Everything after this line happens at most once per token.
    if (!identityTokenStore.consume(token.id, token.email)) return await refuse();

    const user = userStore.ensure({
      email: token.email,
      name: parsed.data.name ?? token.email,
      passwordHash: hashPassword(parsed.data.password),
      passwordSource: "user",
    });
    /*
     * `ensure` never overwrites the password of an existing account — by design,
     * because boot-time adoption calls it on every restart. So for somebody who
     * already had an account in another organization, the password they just chose
     * has to be applied explicitly, and `source` becomes `user` so no environment
     * file can reset it later.
     */
    userStore.setPassword(user.id, hashPassword(parsed.data.password), "user");
    userStore.grant(token.organizationId, user.id, token.role);

    res.status(201).json({
      ok: true,
      organizationId: token.organizationId,
      email: user.email,
      role: token.role,
      notice: "Account ready. Sign in at /api/auth/login.",
    });
  });

  /**
   * POST /api/auth/password/reset — redeem a reset token. Public, unauthenticated.
   *
   * Sets the password and ends every session the account holds, in every
   * organization. That is not over-reach: a reset is issued because the person can
   * no longer use their password, and the usual reason is that somebody else can.
   * Leaving that somebody's session alive would defeat the act — the same rule
   * `changePassword` already applies, minus the exemption for the caller's own
   * session, because this caller has none.
   *
   * Same uniform 400 for every refusal, for the same reason as accepting an
   * invitation.
   */
  app.post("/api/auth/password/reset", async (req, res) => {
    const ip = req.ip ?? "unknown";
    const retryAfter = await tokenRedemptionThrottled(ip);
    if (retryAfter !== null) {
      res.setHeader("Retry-After", String(retryAfter));
      return fail(res, 429, "Too many attempts. Try again shortly.", ERROR_CODES.rateLimited);
    }

    const parsed = z
      .strictObject({
        token: z.string().trim().min(8).max(200),
        password: z.string().trim().min(1).max(256),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, "token and password are required");

    /** Counts against the address, on the same terms as accepting an invitation. */
    const refuse = async () => {
      await registerFailedTokenRedemption(ip);
      return fail(res, 400, "That reset token is not valid.");
    };

    const token = identityTokenStore.resolve(parsed.data.token);
    if (!token || token.purpose !== "reset") return await refuse();
    if (token.consumedAt || token.revokedAt || isTokenExpired(token)) return await refuse();
    if (!organizationStore.isActive(token.organizationId)) return await refuse();

    const user = userStore.findByEmail(token.email);
    if (!user) return await refuse();
    /*
     * The membership is re-checked at redemption, not only at issue. Somebody
     * removed or suspended between the two must not be able to walk back in with a
     * token that predates the removal.
     */
    const membership = userStore.membership(token.organizationId, user.id);
    if (!membership || membership.suspendedAt) return await refuse();

    const problems = passwordProblems(parsed.data.password);
    if (problems.length > 0) return fail(res, 400, problems.join(" "));

    if (!identityTokenStore.consume(token.id, token.email)) return await refuse();

    userStore.setPassword(user.id, hashPassword(parsed.data.password), "user");

    /*
     * Every session, in every organization this account belongs to. A session is
     * bound to the password's fingerprint, so `credentialStillValid` would refuse
     * them on their next request anyway — this makes it immediate and explicit
     * rather than one request late.
     */
    let revoked = 0;
    for (const m of userStore.membershipsOf(user.id)) {
      for (const session of sessionStore.listFor(m.organizationId, user.id, 500)) {
        if (session.revokedAt) continue;
        if (sessionStore.revoke(session.id, "system:password-reset", m.organizationId)) revoked += 1;
      }
    }

    res.json({
      ok: true,
      sessionsRevoked: revoked,
      notice: "Password updated. Sign in at /api/auth/login.",
    });
  });

  /* ------------------------------- API keys ------------------------------- */

  /**
   * The console's key inventory — P0-5.
   *
   * ## Why a human is required for all three of these
   *
   * Every route below refuses `identity.kind === "service"`, even an API key holding the
   * `admin` role. That is stricter than the capability model and it is deliberate: a key
   * that can mint keys is a persistence mechanism. An attacker who captures one machine
   * credential from a container's environment could otherwise issue itself a second one,
   * with a plausible name, and survive the rotation of the key it came in through — while
   * the operator, having rotated the leaked key, believes the incident is closed.
   *
   * Issuing a credential is an act of administration, so it requires an administrator who
   * signed in with a password. `manage` is required on top, so a human viewer cannot do it
   * either.
   */

  /**
   * GET /api/keys — one organization's keys, newest first.
   *
   * Returns metadata only: `PublicApiKey` has no digest field by construction, so there
   * is no version of this response that leaks credential material. Revoked and expired
   * keys are included — an inventory that hid them would be unable to answer "was this
   * key revoked, or did it never exist?", which is the question asked during a review.
   */
  app.get("/api/keys", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can read the key inventory.");
    }
    const keys = apiKeyStore.list(identity.organizationId).map(toPublicKey);
    res.json({ total: keys.length, keys });
  });

  /**
   * POST /api/keys — issue a key.
   *
   * The plaintext is in this response and nowhere else, ever: only its SHA-256 digest is
   * stored, so a key the operator fails to copy cannot be recovered by us, by them, or by
   * anyone who later steals the database. The response says so, because a UI claim that
   * the caller cannot verify is worth less than the server stating it.
   */
  app.post("/api/keys", requireCapability("manage"), handle(async (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can issue an API key.");
    }

    const schema = z.strictObject({
      name: z.string().trim().min(1).max(120),
      role: z.enum(ROLES),
      /*
       * An optional lifetime, in days, with a ceiling. Two years is not a security
       * control — it is a bound that keeps `expires_at` a real date rather than a value
       * far enough away to overflow into nonsense, and it makes the field's purpose
       * legible: this is for a contractor's integration or a migration window.
       */
      expiresInDays: z.number().int().min(1).max(730).optional(),
      /*
       * P6 — the agent this key speaks for, if it speaks for one.
       *
       * Optional, and that is the whole design decision. A key issued with an
       * `agentId` is *confined* to that agent: every request it makes acts as
       * that agent, and naming a different one in a body field or the
       * `X-Oathrion-Agent-Id` header is refused rather than honoured
       * (`server/identity/agent-binding.ts`). A key issued without one behaves
       * exactly as keys did before this phase.
       *
       * It is not made mandatory here because a key is also how an operator
       * drives the API by hand and how the seed fixtures authenticate, and
       * neither of those has one agent to be pinned to. The deployment-wide
       * switch `OATHRION_REQUIRE_AGENT_BINDING` is what an operator who wants
       * mandatory binding sets; refusing unbound keys at issue time would only
       * move the same decision to a place where existing keys escape it.
       */
      agentId: z.string().trim().min(1).max(120).optional(),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      // The zod issues are not returned: they echo the submitted values back, and the
      // submitted value here is a credential's name and role. Other routes in this file
      // return them; this one is on the credential surface.
      return fail(res, 400, "Invalid key request");
    }

    const { name, role, expiresInDays, agentId } = parsed.data;

    /*
     * The binding is validated at issue time, against this administrator's own
     * organisation.
     *
     * Checked here and not only at use time because the two failures are worth
     * very different amounts. A key bound to a typo’d or foreign agent id would
     * authenticate perfectly and then fail on every single request — a 403 that
     * looks like a policy refusal, appears days later in an agent runtime nobody
     * is watching, and takes a database query to explain. Refusing at issue time
     * puts the error in front of the person who made it, in the response to the
     * request that made it.
     *
     * The lookup is tenant-scoped, so an agent id belonging to another
     * organisation is simply not found and reads as unknown — the same answer a
     * nonexistent id gets, which is what stops this route from being used to
     * probe for another tenant’s agent ids.
     */
    if (agentId) {
      const agent = await scope(req).repositories.agents.findById(agentId);
      if (!agent) {
        return fail(res, 400, `Unknown agent "${agentId}". A key can only be bound to an agent in your own organisation.`);
      }
    }

    /*
     * A key may not be issued with a role wider than the issuer's own.
     *
     * Today `manage` belongs to `admin` alone, so the guard never fires — it is written
     * for the day the capability matrix changes. If `manage` were ever extended to
     * `approver`, its absence would silently become a privilege-escalation path: mint an
     * `admin` key, then use it. A boundary that depends on a table in another file being
     * unchanged is not a boundary, so it is enforced here as well.
     *
     * Compared as capability sets rather than by rank: `operator` and `approver` are
     * siblings by design, and a rank comparison would be meaningless between them.
     */
    if (!roleAtMost(role, identity.role)) {
      return fail(res, 403, "A key cannot be issued with a role wider than your own.");
    }

    const generated = generateKey();
    const key = apiKeyStore.create({
      id: `key_${crypto.randomBytes(12).toString("hex")}`,
      organizationId: identity.organizationId,
      name,
      role,
      secretHash: generated.hash,
      prefix: generated.displayPrefix,
      source: "user",
      createdBy: identity.name,
      // `null`, not `undefined`: the column is nullable and an unbound key must
      // store an explicit absence rather than whatever the driver does with a
      // missing property.
      agentId: agentId ?? null,
      expiresAt: expiresInDays
        ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString()
        : null,
    });

    res.status(201).json({
      key: toPublicKey(key),
      secret: generated.secret,
      notice:
        "This is the only time the key is shown. Only a hash of it is stored, so it cannot be recovered.",
    });
  }));

  /**
   * DELETE /api/keys/:id — revoke a key.
   *
   * Revoke, not delete: executions in the audit log name this key as their actor, and a
   * deleted row would turn a recorded decision into an orphan. The next request presenting
   * it is refused, because `resolveBearer` checks `revoked_at` on every call rather than
   * caching the answer.
   *
   * A key belonging to another tenant reads as absent — `findIn` is scoped — so the reply
   * is 404, never 403. 403 would confirm that the guessed id exists somewhere.
   */
  app.delete("/api/keys/:id", requireCapability("manage"), (req, res) => {
    const identity = requireIdentity(req);
    if (identity.kind !== "user") {
      return fail(res, 403, "Only a signed-in administrator can revoke an API key.");
    }

    const target = apiKeyStore.findIn(identity.organizationId, param(req, "id"));
    if (!target) return fail(res, 404, "Key not found");

    const reason = typeof req.body?.reason === "string" ? req.body.reason.slice(0, 200) : undefined;
    const revoked = apiKeyStore.revoke(identity.organizationId, target.id, identity.name, reason);

    /*
     * `revoked: false` means it was already revoked. Reported honestly rather than as a
     * success, and NOT as an error: the caller's intent is satisfied either way, and an
     * operator hitting the button twice during an incident should not be shown a failure.
     * The first revocation's actor and timestamp are preserved by the store.
     */
    res.json({ revoked, keyId: target.id, alreadyRevoked: !revoked });
  });

  /* ---------------------------- Notifications ---------------------------- */

  /**
   * GET /api/notifications — recent delivery attempts.
   * Answers "did the webhook actually fire?" without opening a log aggregator.
   */
  /*
   * `detail` is redacted here rather than where the delivery is recorded. The
   * distinction matters: the in-memory buffer and the server log keep the full
   * transport error, because the operator who owns the deployment needs the address
   * to debug it. This endpoint only requires the `read` capability, so a `viewer`
   * reads it — and a raw `connect ECONNREFUSED 10.4.2.19:9000` would hand the least
   * privileged role the internal address and port of the receiver, or a token
   * embedded in the webhook URL's path. See `server/notifications/detail.ts`.
   */
  app.get("/api/notifications", requireCapability("read"), (_req, res) => {
    res.json({
      channels: notifier.channelIds,
      deliveries: notifier.recentDeliveries().map((delivery) => ({
        ...delivery,
        detail: sanitizeDeliveryDetail(delivery.detail),
      })),
    });
  });

  /* ------------------------------- Decision ------------------------------ */

  /**
   * POST /api/decision — the core control-plane call.
   * An agent asks Oathrion for permission before touching a tool.
   */
  app.post(
    "/api/decision",
    requireCapability("execute"),
    decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;

      const parsed = decisionSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid body");

      const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
      if (agentId === null) return;

      const output = await scope(req).decisionService.decide({
        ...parsed.data,
        // Derived, never the body's own value: a bound credential's agent wins
        // and a mismatch has already been refused above.
        agentId,
        // Attributed to the authenticated caller, never a client-supplied
        // field — `decisionSchema` carries no `actor`. Without this the audit
        // trail fell back to the generic "Policy Engine" for every call made
        // through this route, losing which credential actually asked.
        actor: requireIdentity(req).name,
      });
      res.json({
        decision: output.decision,
        reason: output.reason,
        policyId: output.policyId,
        policyName: output.policyName,
        riskLevel: output.riskLevel,
        matched: output.matched,
        executionId: output.execution?.id ?? null,
        approvalId: output.approval?.id ?? null,
        execution: output.execution
          ? await withRetryabilityFetched(scope(req).repositories, output.execution)
          : null,
        approval: output.approval,
      });
    }),
  );

  /* -------------------------------- Gateway ------------------------------ */

  /**
   * POST /api/execute — the Gateway call.
   *
   * Unlike /api/decision (which only returns a verdict), this runs the full
   * loop: evaluate, then reach the tool if and only if the verdict is ALLOW.
   */
  app.post(
    "/api/execute",
    requireCapability("execute"),
    decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;

      const parsed = executeSchema.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid body");

      const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
      if (agentId === null) return;

      const result = await scope(req).gateway.execute({
        ...parsed.data,
        // Derived from the credential when it is bound. Spread first so this
        // wins over the body's own field rather than depending on key order.
        agentId,
        // Same reasoning as /api/decision: attribute to the verified caller,
        // never a client-supplied field.
        actor: requireIdentity(req).name,
      });
      res.json(result);
    }),
  );

  /**
   * POST /api/evaluate — spec-shaped evaluation.
   *
   * Same engine as /api/decision, but accepts `amount`, `category` and `context`
   * as top-level fields and answers with the compact contract from the spec.
   */
  app.post(
    "/api/evaluate",
    decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;

      /*
       * Alias normalisation runs before validation so the schema can stay
       * strict and still accept the documented alternative spellings (`agent`,
       * `resource`). It refuses ambiguous bodies rather than picking a winner;
       * that refusal is a 400, never a decision.
       */
      let normalized: unknown;
      try {
        normalized = normalizeAgentAction(req.body);
      } catch (error) {
        if (error instanceof ContractError) return fail(res, 400, error.message);
        throw error;
      }

      const parsed = agentActionSchema.safeParse(normalized);
      if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid body");

      // A dry run writes nothing, so `read` is enough to explore the rules.
      // Asking for persistence is asking the control plane to act: `execute`.
      const needed = parsed.data.persist ? "execute" : "read";
      if (!ensureCapability(req, res, needed)) return;

      const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
      if (agentId === null) return;

      const request = {
        agentId,
        action: parsed.data.action,
        target: parsed.data.target,
        metadata: toEngineMetadata(parsed.data),
        actor: requireIdentity(req).name,
      };

      /**
       * Persisting means acting. Routing a persisted evaluation through the
       * Gateway rather than the DecisionService alone is what keeps the run
       * state machine honest: previously an ALLOW recorded here was written as
       * `allowed` but never dispatched and never retryable, leaving a permanent
       * orphan that lied about its own status.
       */
      if (parsed.data.persist) {
        const result = await scope(req).gateway.execute(request);
        return res.json({
          decision: result.decision,
          reason: result.reason,
          policyId: result.policyId,
          policyName: result.policyName,
          risk: result.riskLevel.toLowerCase(),
          /*
           * The correlation id, echoed in the body as well as the header.
           * Header-only was enough for a human with curl and not enough for an
           * SDK: a caller holding a parsed decision object had no way to quote
           * the id when asking why that decision was reached, and the error
           * envelope already carried one — so a failure was traceable and a
           * decision was not.
           */
          requestId: req.requestId,
          persisted: true,
          /**
           * `executed` means ATTEMPTED and is kept for compatibility — see
           * `GatewayResult.executed`. A client asking "did the side effect
           * happen?" must read `succeeded`, or better `runState`, which is the
           * persisted state rather than a property of this one call.
           */
          executed: result.executed,
          attempted: result.attempted,
          succeeded: result.succeeded,
          runState: result.runState,
          executionId: result.executionId,
          approvalId: result.approvalId,
          toolId: result.toolId,
          toolResult: result.toolResult,
          matched: result.matched,
        });
      }

      const outcome = await scope(req).decisionService.decide({ ...request, persist: false });

      res.json({
        decision: outcome.decision,
        reason: outcome.reason,
        policyId: outcome.policyId,
        policyName: outcome.policyName,
        risk: outcome.riskLevel.toLowerCase(),
        // Same correlation id as the persisted branch above; see there.
        requestId: req.requestId,
        /** False means this call left no trace in the registry. */
        persisted: false,
        // A dry run touches no tool by construction, so all three are false/null
        // rather than absent: a client must not have to special-case this shape.
        executed: false,
        attempted: false,
        succeeded: false,
        runState: null,
        executionId: null,
        approvalId: null,
        toolId: null,
        toolResult: null,
        matched: outcome.matched,
      });
    }),
  );

  /**
   * POST /api/executions — create an execution by running the full control loop.
   * Identical semantics to /api/execute; kept because the spec names this route.
   */
  app.post(
    "/api/executions",
    requireCapability("execute"),
    decisionRateLimit,
    handle(async (req, res) => {
      /**
       * This route always acts. It used to accept `persist` (inherited from the
       * evaluate schema) and then ignore it, so a caller asking for a dry run
       * got a real tool call. Rather than quietly honour or quietly drop the
       * field, the route refuses it and points at the endpoint that supports it.
       */
      if (req.body && typeof req.body === "object" && "persist" in req.body) {
        return fail(
          res,
          400,
          'POST /api/executions always executes. Use POST /api/evaluate with "persist": false for a dry run.',
        );
      }

      if (rejectsClientActor(req, res)) return;

      /*
       * The same normalisation `/api/evaluate` applies. Both routes accept the
       * same body, so an integrator who learned one does not have to discover
       * that the other spells `agent` differently.
       */
      let normalized: unknown;
      try {
        normalized = normalizeAgentAction(req.body);
      } catch (error) {
        if (error instanceof ContractError) return fail(res, 400, error.message);
        throw error;
      }

      const parsed = executionCreateSchema.safeParse(normalized);
      if (!parsed.success) return fail(res, 400, parsed.error.issues[0]?.message ?? "Invalid body");

      const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
      if (agentId === null) return;

      const result = await scope(req).gateway.execute({
        agentId,
        action: parsed.data.action,
        target: parsed.data.target,
        metadata: toEngineMetadata(parsed.data),
        actor: requireIdentity(req).name,
      });
      res.status(201).json(result);
    }),
  );

  /**
   * GET /api/audit — the organisation-wide audit log.
   *
   * Flattens the audit trail of recent executions into a single chronological
   * stream, newest first. Optional filters: `?agentId=`, `?decision=`,
   * `?limit=`, `?offset=`.
   *
   * Two things this route is careful about, because an audit log that misleads
   * is worse than no audit log:
   *
   *   - `total` counts every event that matched the filters, not the number
   *     returned. It used to be reported after slicing, so a page of 200 out of
   *     900 events announced a total of 200 and the console drew a complete
   *     history that was not one.
   *   - The stream is built from a bounded window of the most recent
   *     executions. When the ledger is larger than that window, older events
   *     exist that this response does not contain, and `windowTruncated` says
   *     so rather than letting the caller assume completeness. Reading the full
   *     history means querying the database directly; this MVP does not carry a
   *     cursor API.
   */
  app.get(
    "/api/audit",
    requireCapability("read"),
    handle(async (req, res) => {
      const executions = await scope(req).repositories.executions.list(AUDIT_EXECUTION_WINDOW);
      const agentId = typeof req.query.agentId === "string" ? req.query.agentId : null;
      const decision = typeof req.query.decision === "string" ? req.query.decision : null;

      const requestedLimit = Number(req.query.limit);
      const limit =
        Number.isFinite(requestedLimit) && requestedLimit > 0
          ? Math.min(Math.floor(requestedLimit), MAX_AUDIT_PAGE)
          : DEFAULT_AUDIT_PAGE;

      const requestedOffset = Number(req.query.offset);
      const offset =
        Number.isFinite(requestedOffset) && requestedOffset > 0 ? Math.floor(requestedOffset) : 0;

      const matched = executions
        .filter((e) => (agentId ? e.agentId === agentId : true))
        .filter((e) => (decision ? e.decision === decision : true))
        .flatMap((execution) =>
          execution.audit.map((entry, index) => ({
            id: `aud_${execution.id}_${index}`,
            at: entry.at,
            actor: entry.actor,
            event: entry.event,
            detail: entry.detail,
            executionId: execution.id,
            agentId: execution.agentId,
            agentName: execution.agentName,
            action: execution.action,
            target: execution.target,
            decision: execution.decision,
            policyId: execution.policyId,
          })),
        )
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

      res.json({
        total: matched.length,
        limit,
        offset,
        windowTruncated: executions.length >= AUDIT_EXECUTION_WINDOW,
        events: matched.slice(offset, offset + limit),
      });
    }),
  );

  /* --------------------------------- MCP --------------------------------- */

  /**
   * POST /api/mcp — the Model Context Protocol gateway.
   *
   * Mounted under `/api` deliberately, and not at `/mcp`.
   *
   * `authenticate()` is mounted on `/api` and closes everything beneath it by
   * default. A bare `/mcp` path would sit OUTSIDE that gate, so the single most
   * security-sensitive endpoint in the product — the one an autonomous agent
   * talks to — would have been the one endpoint requiring no credential. MCP
   * clients are configured with a URL, so the path costs them nothing.
   *
   * Rate-limited on the same bucket as `/api/decision` and `/api/execute`,
   * because `tools/call` reaches the same engine and must not be a cheaper way
   * to reach it.
   */
  /*
   * GET /api/mcp — 405, per the Streamable HTTP transport: a server that offers no
   * server-initiated stream answers a GET with 405 Method Not Allowed. It answered 404,
   * which a real client (Cursor) read as « this is not a Streamable HTTP endpoint » and
   * fell back to the obsolete SSE transport.
   */
  app.get("/api/mcp", (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json(rpcFailure(null, JSON_RPC_ERRORS.methodNotFound, "This endpoint accepts POST only; it offers no server-initiated stream."));
  });

  app.post(
    "/api/mcp",
    decisionRateLimit,
    handle(async (req, res) => {
      /*
       * HTTP-envelope validation runs FIRST, before the JSON-RPC frame is even
       * looked at. An Origin check that runs after the body has been
       * interpreted has already lost, and rejecting here means a hostile page
       * cannot use the endpoint to probe behaviour at all.
       *
       * `id: null` on these responses is correct: the frame has not been parsed,
       * so the request id is genuinely unknown.
       */
      try {
        validateHttpEnvelope({
          origin: req.get("Origin"),
          accept: req.get("Accept"),
          // P6 — browser-attested, unforgeable by page script. Only consulted
          // when Origin is absent; see `FOREIGN_FETCH_SITES`.
          secFetchSite: req.get("Sec-Fetch-Site"),
        });
      } catch (error) {
        if (!(error instanceof RpcFault)) throw error;
        return res
          .status(error.status)
          .json(rpcFailure(null, error.code, error.message, error.data));
      }

      /*
       * JSON-RPC batching was removed from MCP in revision 2025-06-18 and has
       * not returned. An array body is refused rather than partially processed:
       * accepting one would mean deciding what a batch containing both an
       * allowed and a blocked action should return.
       */
      if (Array.isArray(req.body)) {
        return res
          .status(400)
          .json(
            rpcFailure(
              null,
              JSON_RPC_ERRORS.invalidRequest,
              "JSON-RPC batching is not supported; send one request per HTTP POST.",
            ),
          );
      }

      const frame = parseFrame(req.body);
      if (frame.kind === "invalid") {
        return res.status(400).json(rpcFailure(frame.id, frame.code, frame.message));
      }

      /*
       * A notification expects no response body at all, so there is nowhere to
       * report a refusal to. It is therefore acknowledged and dropped rather
       * than executed: every method this gateway implements either returns data
       * or authorises an action, and an action whose outcome the caller cannot
       * read must not be a way to trigger one silently.
       */
      if (frame.kind === "notification") return res.status(202).end();

      const request = frame.request;
      const identity = requireIdentity(req);
      const tenant = scope(req);
      /*
       * `readWireHeader` et non deux `req.get` : la précédence — nom courant d'abord,
       * nom hérité seulement s'il est seul — est écrite UNE fois, dans
       * `shared/wire-headers.ts`. Un appelant qui lirait dans l'autre ordre ferait
       * gagner le nom hérité, exactement la régression que `env-compat.ts` interdit du
       * côté des variables d'environnement.
       */
      const declaredAgent = readWireHeader("agentId", (header) => req.get(header));

      try {
        const protocol = validateRequestHeaders(req.headers, request);
        const result = await routeMcp(
          {
            identity,
            repositories: tenant.repositories,
            gateway: tenant.gateway,
            registry: tenant.registry,
            refreshTools: () => tenant.connectors.refreshIfStale(),
            protocol,
            declaredAgentId: declaredAgent && declaredAgent.length > 0 ? declaredAgent : null,
          },
          request,
        );
        return res.json(rpcSuccess(request.id ?? null, result));
      } catch (error) {
        if (error instanceof RpcFault) {
          return res
            .status(error.status)
            .json(rpcFailure(request.id ?? null, error.code, error.message, error.data));
        }
        /*
         * A quota reached is not a failure of the control plane, here no more than on the
         * REST routes: the agent gets the quota's own message, not "Internal error"
         * (STRESS-TEST-LOG §5.75).
         */
        if (error instanceof QuotaExceededError) {
          return res.status(error.status).json(
            rpcFailure(request.id ?? null, JSON_RPC_ERRORS.internalError, error.message, {
              counter: error.counter,
              limit: error.limit,
              used: error.used,
              resetAt: error.resetAt,
            }),
          );
        }
        /*
         * An unexpected throw is logged by `handle`'s wrapper via the rethrow
         * path everywhere else in this file. Here it must become a JSON-RPC
         * error instead of the REST error shape, so it is converted rather than
         * rethrown — an MCP client parsing `{error: {...}}` would otherwise get
         * a body it cannot read for the one case where the message matters.
         */
        console.error(tagged("[mcp]"), request.method, error);
        return res
          .status(500)
          .json(
            rpcFailure(
              request.id ?? null,
              JSON_RPC_ERRORS.internalError,
              "Internal error handling the MCP request.",
            ),
          );
      }
    }),
  );

  /**
   * GET /api/coverage — ce qui est RÉELLEMENT gouverné pour ce locataire.
   *
   * ## Pourquoi cette route existe et ne se déduit pas des autres
   *
   * Un exploitant peut déjà lire ses agents, ses politiques, ses outils et ses connecteurs
   * sur quatre écrans. Ce qu'il ne peut pas lire, c'est la seule question qui décide s'il
   * peut passer en pilote : **quelles actions sont effectivement contrôlées, et qu'est-ce
   * qui manque pour que la suivante le soit ?** Recomposer la réponse côté client voudrait
   * que la console connaisse les règles de couverture — c'est-à-dire qu'elle les
   * dédouble, et qu'une des deux copies prenne du retard.
   *
   * ## Chaque champ vient d'un comptage, jamais d'une estimation
   *
   * Les verbes gouvernés sont lus dans la table de ROUTAGE du registre, donc ce qui
   * atteindrait réellement un outil. Les règles du pare-feu sont celles qui sont
   * déclarées. Les agents, politiques, exécutions et approbations sont comptés en base,
   * dans la portée du locataire.
   *
   * ## Ce que `blocking` dit, et ce qu'il ne dit pas
   *
   * Il liste ce qui EMPÊCHE une première action gouvernée, dans l'ordre où il faut s'en
   * occuper. Il ne prétend pas que la liste vide signifie « vous êtes protégé » : la
   * couverture dépend aussi de ce qu'Oathrion ne peut pas voir — un agent qui détient ses
   * propres credentials. Le champ `caveat` porte cette phrase, et la console l'affiche.
   */
  app.get(
    "/api/coverage",
    requireCapability("read"),
    handle(async (req, res) => {
      const scoped = scope(req);
      const organizationId = requireIdentity(req).organizationId;
      /*
       * `statusCounts()` et NON `list(500)`.
       *
       * La version précédente lisait les 500 dernières exécutions puis comptait les
       * éléments du tableau. Tous les nombres de cet écran étaient donc plafonnés à 500,
       * et silencieusement : un exploitant avec dix mille exécutions lisait
       * « 500 exécutions, 480 autorisées » — des nombres qui ont l'air précis et qui sont
       * faux, sur l'écran dont il se sert pour décider s'il peut passer en pilote. Et le
       * plafond se trahissait d'une façon particulièrement trompeuse : les proportions
       * restaient vraisemblables, donc rien n'attirait l'œil.
       *
       * Un `GROUP BY` cadré au locataire rend la vérité pour le coût d'une requête,
       * quelle que soit la taille de la table.
       */
      const [agents, policies, executionCounts, approvals, connectors] = await Promise.all([
        scoped.repositories.agents.list(),
        scoped.repositories.policies.list(),
        scoped.repositories.executions.statusCounts(),
        scoped.repositories.approvals.list(),
        scoped.connectors.describe(),
      ]);

      /* Les verbes qui atteindraient un outil : la table de routage, pas un catalogue. */
      const registry = toolRegistry.extendedWith(
        [...scoped.connectors.tools.values(), ...wrappedTools().tools],
        { ...scoped.connectors.actionMap, ...wrappedTools().actionMap },
      );
      const governedActions = registry.actions().sort();

      const connected = connectors.filter((c) => c.status.state === "connected");

      /*
       * LES RÈGLES DU PARE-FEU, FILTRÉES PAR CE QUE CE LOCATAIRE PEUT RÉELLEMENT EMPLOYER.
       *
       * `OATHRION_INTERCEPTS` est une liste à l'échelle du DÉPLOIEMENT ; la destination que
       * chaque règle nomme, elle, est cadrée par locataire dans `OATHRION_DESTINATIONS`. La
       * version précédente listait les règles telles quelles, donc elle annonçait à un
       * locataire des règles dont la destination ne lui est pas ouverte — et que la route
       * d'interception refuse avec `intercept_destination_unavailable`.
       *
       * Deux conséquences, et la seconde est la grave :
       *
       *   · l'écran affichait un nombre de règles supérieur à ce qui est utilisable ;
       *   · `counts.interceptRules === 0` décide d'une entrée BLOQUANTE (« Brancher un
       *     outil ou une route »). Un locataire sans aucune règle utilisable mais avec
       *     des règles déclarées pour d'autres ne recevait donc PAS cet avertissement :
       *     l'écran lui disait que rien ne le bloquait, alors que son premier appel
       *     intercepté aurait été refusé.
       *
       * Le contrôle emploie `isRegisteredDestination` — la MÊME fonction que la route
       * d'interception — plutôt qu'une seconde interprétation de la portée.
       */
      const usableRules = INTERCEPT_RULES.filter((rule) =>
        isRegisteredDestination(rule.destination, process.env, organizationId),
      );
      const interceptRules = usableRules.map((rule) => ({
        id: rule.id,
        method: rule.method,
        path: rule.path,
        destination: rule.destination,
        action: rule.action,
      }));
      /*
       * Les règles déclarées mais FERMÉES à ce locataire, comptées et nommées à part.
       * Les cacher entièrement laisserait un exploitant chercher pourquoi sa règle
       * n'apparaît pas ; les mélanger aux utilisables était le défaut.
       */
      const unavailableRules = INTERCEPT_RULES.filter(
        (rule) => !isRegisteredDestination(rule.destination, process.env, organizationId),
      ).map((rule) => ({ id: rule.id, destination: rule.destination }));

      /*
       * Compté sur `status` et non sur `decision`. Les deux existent et ne disent pas la
       * même chose : `decision` est le verdict du moteur (`allow` / `block` /
       * `require_approval`), `status` est ce qu'il est DEVENU (`allowed`, `blocked`,
       * `pending`, `failed`). Un exploitant qui lit « 12 autorisées » veut savoir
       * combien ont effectivement été relâchées, pas combien ont reçu un avis favorable
       * — une action autorisée dont l'outil a échoué est `failed`, et la compter comme
       * autorisée masquerait exactement ce qui réclame son attention.
       */
      const counts = {
        agents: agents.length,
        policies: policies.filter((policy) => policy.status === "enabled").length,
        connectorsConnected: connected.length,
        /* Les règles UTILISABLES par ce locataire, pas les règles déclarées. */
        interceptRules: interceptRules.length,
        interceptRulesUnavailable: unavailableRules.length,
        executions: executionCounts.total,
        allowed: executionCounts.allowed,
        blocked: executionCounts.blocked,
        pendingApprovals: approvals.filter((a) => a.status === "pending").length,
        failed: executionCounts.failed,
      };

      /*
       * L'ordre compte : c'est la suite d'actions d'un exploitant qui part de rien. Un
       * agent sans politique est gouverné par la posture par défaut, ce qui est un état
       * valide mais pas celui qu'on veut en pilote — d'où l'entrée, même quand un agent
       * existe.
       */
      const blocking: { step: string; why: string; where: string }[] = [];
      if (counts.agents === 0) {
        blocking.push({
          step: "Declare an agent",
          why: "Oathrion authorises PER AGENT: with no declared agent, no action can be judged.",
          where: "/agents",
        });
      }
      if (counts.connectorsConnected === 0 && counts.interceptRules === 0) {
        blocking.push({
          step: "Connect a tool or a route",
          why:
            "No connector connected and no interception rule: an allowed action " +
            "would reach nothing. Connect a connector, or declare a route in OATHRION_INTERCEPTS.",
          where: "/connectors",
        });
      }
      if (counts.policies === 0) {
        blocking.push({
          step: "Write at least one policy",
          why:
            "With no active policy, only the default posture, the agent's permissions and " +
            "its mandate decide. That is a valid state, not a governed pilot.",
          where: "/policies",
        });
      }
      if (counts.executions === 0) {
        blocking.push({
          step: "Run a first action",
          why: "Nothing has been judged yet. The sandbox lets you try one without writing code.",
          where: "/policies",
        });
      }

      res.json({
        counts,
        governedActions,
        connectors: connectors.map((c) => ({
          id: c.id,
          label: c.label,
          state: c.status.state,
          actions: c.actions,
        })),
        interceptRules,
        /*
         * Nommées, et séparées. Les cacher laisserait un exploitant chercher pourquoi sa
         * règle n'apparaît pas ; les compter avec les utilisables était le défaut.
         */
        interceptRulesUnavailable: unavailableRules,
        blocking,
        /*
         * LA PHRASE QUE CET ÉCRAN NE DOIT PAS POUVOIR PERDRE. Une liste `blocking` vide
         * ne veut pas dire « vous êtes protégé » : la couverture dépend aussi de ce que
         * Oathrion ne voit pas.
         */
        caveat:
          "Oathrion governs only the actions that go through it. An agent that holds " +
          "its own credentials for a service can call it directly, and this " +
          "page will not see it. Going around becomes impossible — not merely " +
          "discouraged — when the service's credential lives only in Oathrion's vault.",
      });
    }),
  );

  /** GET /api/tools — registered tools and their live invocation counters. */
  app.get("/api/tools", requireCapability("read"), (req, res) => {
    /*
     * LE REGISTRE DU LOCATAIRE, PAS CELUI DU PROCESSUS, et c'est une correction qu'un
     * test de la route `/api/coverage` a imposée.
     *
     * Cette route lisait `toolRegistry` — la table intégrée du processus. Elle omettait
     * donc les outils de connecteur et le relais du pare-feu, qui sont montés PAR
     * ORGANISATION : un exploitant ayant connecté GitHub voyait un inventaire où son
     * connecteur n'existait pas, et `/api/coverage` annonçait dix verbes gouvernés quand
     * `/api/tools` en montrait sept. Deux écrans, deux réponses, aucune des deux
     * manifestement fausse — le pire des cas.
     *
     * Les deux lisent désormais le MÊME registre dérivé.
     */
    const scoped = scope(req);
    const registry = toolRegistry.extendedWith(
      [...scoped.connectors.tools.values(), ...wrappedTools().tools],
      { ...scoped.connectors.actionMap, ...wrappedTools().actionMap },
    );
    res.json(
      registry.list().map((tool) => ({
        id: tool.id,
        name: tool.name,
        description: tool.description,
        toolExecutionCount: tool.toolExecutionCount,
        /*
         * Added by the conformance work (C34). This route is the inventory an
         * operator reads over HTTP, and it said nothing about simulation while
         * `docs/COMMERCIAL_READINESS.md` claimed it "expose le drapeau" — an
         * inaccurate claim about honesty, in a repository whose differentiator is
         * `claims-honesty.test.ts`. Derived from the tool, like the MCP catalogue.
         */
        simulated: tool.simulated,
        /*
         * Les verbes que cet outil sert RÉELLEMENT, lus dans la table de routage.
         *
         * Sans ce champ, un exploitant qui déclare un connecteur dans `OATHRION_TOOLS`
         * voyait son outil et l'outil intégré qu'il remplace annoncer tous deux « non
         * simulé », sans rien pour dire lequel une action atteindrait. Un tableau vide
         * est une information : l'outil existe et plus aucun verbe ne lui est câblé.
         */
        actions: registry.actionsFor(tool.id),
      })),
    );
  });

  /* -------------------------------- Agents ------------------------------- */

  app.get(
    "/api/agents",
    requireCapability("read"),
    handle(async (req, res) => res.json(await scope(req).repositories.agents.list())),
  );

  /*
   * Les outils enveloppés (`oathrion wrap`) RETENUS, par agent : inscrits, mais derrière une
   * portée que l'agent n'a pas. La console les montre et propose de les autoriser en un clic,
   * au lieu de laisser la personne chercher l'interrupteur (STRESS-TEST-LOG §5.57).
   */
  app.get(
    "/api/withheld-tools",
    requireCapability("read"),
    handle(async (req, res) => {
      const { repositories, registry } = scope(req);
      const agents = await repositories.agents.list();
      res.json(
        agents.flatMap((agent) => {
          const tools = withheldWrappedTools(registry, agent);
          return tools.length > 0
            ? [{ agentId: agent.id, agentName: agent.name, tools: tools.map(({ name, server, toolClass, scope: needed }) => ({ name, server, toolClass, scope: needed })) }]
            : [];
        }),
      );
    }),
  );

  app.get(
    "/api/agents/:id",
    requireCapability("read"),
    handle(async (req, res) => {
      const agent = await scope(req).repositories.agents.findById(param(req, "id"));
      if (!agent) return fail(res, 404, "Agent not found");
      res.json(agent);
    }),
  );

  app.post(
    "/api/agents",
    requireCapability("manage"),
    writeRateLimit,
    handle(async (req, res) => {
      const parsed = agentCreateSchema.safeParse(req.body ?? {});
      if (!parsed.success) return fail(res, 400, firstIssue(parsed.error));

      const existing = await scope(req).repositories.agents.findById(parsed.data.id);
      if (existing) return fail(res, 409, `Agent "${parsed.data.id}" already exists`);

      res.status(201).json(await scope(req).repositories.agents.create(toAgent(parsed.data)));
    }),
  );

  app.patch(
    "/api/agents/:id",
    requireCapability("manage"),
    writeRateLimit,
    handle(async (req, res) => {
      const parsed = agentPatchSchema.safeParse(req.body);
      /* La raison, pas seulement « Invalid patch » : c'est tout ce que la console peut afficher. */
      if (!parsed.success) return fail(res, 400, `Invalid patch: ${firstIssue(parsed.error)}`);
      const updated = await scope(req).repositories.agents.update(param(req, "id"), parsed.data);
      if (!updated) return fail(res, 404, "Agent not found");
      res.json(updated);
    }),
  );

  /* ------------------------------ Executions ----------------------------- */

  app.get(
    "/api/executions",
    requireCapability("read"),
    handle(async (req, res) =>
      res.json(
        await withRetryabilityMany(
          scope(req).repositories,
          await scope(req).repositories.executions.list(300),
        ),
      ),
    ),
  );

  app.get(
    "/api/executions/:id",
    requireCapability("read"),
    handle(async (req, res) => {
      const execution = await scope(req).repositories.executions.findById(param(req, "id"));
      if (!execution) return fail(res, 404, "Execution not found");
      res.json(await withRetryabilityFetched(scope(req).repositories, execution));
    }),
  );

  /**
   * GET /api/executions/:id/audit/verify — recompute this execution's audit chain (P6).
   *
   * WHAT IT ACTUALLY PROVES
   * -----------------------
   * Each audit entry stores `prevHash` and `hash`, written by the repository inside
   * the append transaction. This route re-derives the whole chain from the genesis
   * hash and reports the FIRST entry that does not verify. So it detects, after the
   * fact and without any external service:
   *
   *   - an entry whose content was edited in place — the recomputed hash no longer
   *     matches the stored one;
   *   - an entry deleted from the middle — the next entry’s `prevHash` points at a
   *     hash the chain never reaches;
   *   - an entry inserted in the middle, for the same reason;
   *   - reordering, likewise.
   *
   * WHAT IT DOES NOT PROVE — read this before quoting it at anyone
   * -------------------------------------------------------------
   * The chain and the verifier live in the same database and the same process. An
   * attacker who can write arbitrary rows can also recompute every subsequent hash
   * and produce a trail that verifies perfectly. There is no external anchor: no
   * notarisation, no append-only log shipped off-box, no signature under a key this
   * process does not hold. This endpoint therefore answers "has this trail been
   * tampered with by something that did not bother to re-link it?", which covers a
   * careless edit, a bad migration and a botched manual UPDATE — and does NOT answer
   * "is this trail authentic?". Saying otherwise would be the kind of claim that
   * gets believed until the day it matters. Anchoring is not implemented and is not
   * scheduled in this phase.
   *
   * Truncation of the trail’s TAIL is also invisible: dropping the last N entries
   * leaves a chain that verifies, because nothing after them exists to point back.
   * `headHash` is returned so that an operator who records it elsewhere can detect
   * exactly that; Oathrion does not record it for them.
   *
   * `read` capability, and the lookup is tenant-scoped, so an execution in another
   * organisation reads as absent — the same 404 a nonexistent id gets, which is what
   * stops this route from confirming another tenant’s ids. A verdict is a 200 even
   * when the chain is broken: "I checked and it is broken" is a successful answer to
   * the question asked, and returning 409 or 422 would make a broken chain
   * indistinguishable from a malformed request to every generic HTTP client.
   */
  app.get(
    "/api/executions/:id/audit/verify",
    requireCapability("read"),
    handle(async (req, res) => {
      const identity = requireIdentity(req);
      const id = param(req, "id");

      const execution = await scope(req).repositories.executions.findById(id);
      if (!execution) return fail(res, 404, "Execution not found");

      const entries = execution.audit ?? [];
      /*
       * Reuses `verifyAuditChain` rather than re-deriving the rule here. Two
       * implementations of one hash chain is how a verifier ends up disagreeing
       * with the writer, and the disagreement would surface as a false alarm on a
       * trail that is fine — or, far worse, as a pass on one that is not.
       */
      const verdict = verifyAuditChain(identity.organizationId, id, entries);

      res.json({
        executionId: id,
        ok: verdict.ok,
        /** Index of the first entry that fails, or `null`. Not a count of failures. */
        brokenAt: verdict.brokenAt,
        reason: verdict.reason,
        entries: entries.length,
        /**
         * The hash the next entry must point at. Returned so an operator can pin
         * the current head somewhere Oathrion cannot reach, which is the only way tail
         * truncation becomes detectable. See the note above.
         */
        headHash: headHash(identity.organizationId, id, entries),
        /**
         * Stated in the response, not only in the docs, because the response is
         * what gets pasted into a ticket. Consumers must not read `ok: true` as
         * proof of authenticity.
         */
        scope:
          "Internal consistency only. The chain is stored in the same database as this " +
          "verifier and is not externally anchored or signed, so a writer able to re-link " +
          "the chain can produce a trail that verifies. Tail truncation is not detectable " +
          "from this response alone; record headHash externally to detect it.",
      });
    }),
  );

  /**
   * POST /api/executions/:id/retry — a controlled second attempt.
   *
   * Retries only ever re-dispatch a run that failed after the engine had
   * already allowed it. The verdict is never re-evaluated and never bypassed.
   */
  app.post(
    "/api/executions/:id/retry",
    requireCapability("execute"),
    decisionRateLimit,
    handle(async (req, res) => {
      const id = param(req, "id");

      /*
       * A retry names an execution, not an agent, so `actingAgent` can never
       * see this path: the agent comes from the stored row. Without the check
       * below, a credential bound to `agt_billing` could re-dispatch
       * `agt_finance`'s failed transfer without ever uttering the word
       * `agt_finance` — the one hole a request-body chokepoint cannot cover.
       *
       * The read is tenant-scoped, so an execution in another organisation is
       * simply absent and the answer is the gateway's own 404. Reading the row
       * here and again inside `retry()` is one extra indexed primary-key lookup
       * on a route that then performs a network call; the alternative was to
       * push identity down into the gateway, which would have put an
       * authorisation decision in the component whose job is dispatch.
       */
      const existing = await scope(req).repositories.executions.findById(id);
      if (existing) {
        const allowed = mayActOnExecution(requireIdentity(req), existing.agentId);
        if (!allowed.ok) return fail(res, statusFor(allowed.refusal), allowed.reason, allowed.refusal);
      }

      /*
       * `confirmNotApplied` : la procédure sûre pour une exécution à l'effet INCONNU. Elle
       * engage la parole de quelqu'un qui a vérifié chez le service, donc elle exige la
       * capacité `approve` — celle qui relâche une action — et pas seulement `execute`.
       */
      const retryBody = z.strictObject({ confirmNotApplied: z.literal(true).optional() }).safeParse(req.body ?? {});
      if (!retryBody.success) return fail(res, 400, "The only accepted field is confirmNotApplied: true.");
      const confirmedNotApplied = retryBody.data.confirmNotApplied === true;
      if (confirmedNotApplied && !can(requireIdentity(req).role, "approve")) {
        return fail(res, 403, "Confirming that an action left no effect requires the approve capability.");
      }

      const outcome = await scope(req).gateway.retry(id, requireIdentity(req).name, { confirmedNotApplied });
      if (!outcome.ok) return fail(res, outcome.status, outcome.reason);
      res.json({
        // `executed` means attempted; `succeeded` and `runState` carry the outcome.
        executed: outcome.executed,
        attempted: outcome.attempted,
        succeeded: outcome.succeeded,
        runState: outcome.runState,
        toolId: outcome.toolId,
        toolResult: outcome.toolResult,
        // Recomputed from the row as it stands AFTER this attempt: the console must
        // not keep offering a retry it has just consumed the last attempt of.
        execution: await withRetryabilityFetched(scope(req).repositories, outcome.execution),
      });
    }),
  );

  /* ------------------------------- Policies ------------------------------ */

  app.get(
    "/api/policies",
    requireCapability("read"),
    handle(async (req, res) => res.json(await scope(req).repositories.policies.list())),
  );

  app.post(
    "/api/policies",
    requireCapability("manage"),
    writeRateLimit,
    handle(async (req, res) => {
      const parsed = policyCreateContract.safeParse(req.body ?? {});
      if (!parsed.success) return fail(res, 400, firstIssue(parsed.error));

      const existing = await scope(req).repositories.policies.findById(parsed.data.id);
      if (existing) return fail(res, 409, `Policy "${parsed.data.id}" already exists`);

      res.status(201).json(await scope(req).repositories.policies.create(toPolicy(parsed.data)));
    }),
  );

  app.patch(
    "/api/policies/:id",
    requireCapability("manage"),
    writeRateLimit,
    handle(async (req, res) => {
      const parsed = policyTogglePatch.safeParse(req.body);
      if (!parsed.success) return fail(res, 400, "Invalid patch");
      const updated = await scope(req).repositories.policies.update(param(req, "id"), parsed.data);
      if (!updated) return fail(res, 404, "Policy not found");
      res.json(updated);
    }),
  );

  /* ------------------------------ Approvals ------------------------------ */

  app.get(
    "/api/approvals",
    requireCapability("read"),
    handle(async (req, res) => res.json(await scope(req).repositories.approvals.list())),
  );

  /*
   * Sweep past-deadline pending requests into `expired`.
   *
   * Registered before `/api/approvals/:id` so the literal path is matched as a
   * path and not captured as an id.
   *
   * WHAT THIS IS NOT: it is not the barrier. An expired approval cannot release
   * its action whether or not this has ever been called — the deadline is a
   * condition inside the resolving UPDATE, and `dispatch()` is reachable from
   * exactly three call sites, all of which refuse an expired authorisation. This
   * endpoint exists so that stored state stops *describing* a closed request as
   * pending, which is a reporting concern, and so the sweep is reachable at all
   * rather than sitting in the service as code nothing calls.
   *
   * `manage`, not `approve`: sweeping is administrative housekeeping, and it must
   * not require the capability that authorises real-world actions.
   */
  app.post(
    "/api/approvals/expire",
    requireCapability("manage"),
    writeRateLimit,
    handle(async (req, res) => {
      const expired = await scope(req).decisionService.expirePendingApprovals();
      res.json({ expired, count: expired.length });
    }),
  );

  app.get(
    "/api/approvals/:id",
    requireCapability("read"),
    handle(async (req, res) => {
      const approval = await scope(req).repositories.approvals.findById(param(req, "id"));
      if (!approval) return fail(res, 404, "Approval not found");
      res.json(approval);
    }),
  );

  /*
   * GET /api/approvals/:id/issue?attendre=<ms> — l'issue d'une approbation, en l'ATTENDANT
   * au plus `attendre` ms (30 s au plus) : rend dès qu'elle est tranchée et que l'exécution
   * qui suit est finie. Le relais d'`oathrion wrap` s'en sert au lieu de relire chaque seconde
   * (`server/approval-events.ts`) : l'agent reçoit sa réponse dès l'approbation.
   */
  app.get(
    "/api/approvals/:id/issue",
    requireCapability("read"),
    handle(async (req, res) => {
      const { repositories } = scope(req);
      const id = param(req, "id");
      const asked = Number(req.query.attendre ?? 0);
      const deadline = Date.now() + (Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 30_000) : 0);
      const organization = requireIdentity(req).organizationId;
      for (;;) {
        const approval = await repositories.approvals.findById(id);
        if (!approval) return fail(res, 404, "Approval not found");
        const execution = approval.executionId ? await repositories.executions.findById(approval.executionId) : undefined;
        const settled =
          approval.status !== "pending" &&
          (approval.status !== "approved" || !execution || ["succeeded", "failed", "skipped"].includes(String(execution.runState)));
        const remaining = deadline - Date.now();
        if (settled || remaining <= 0) {
          return res.json({ approval, execution: execution ? await withRetryabilityFetched(repositories, execution) : null, settled });
        }
        /* Le signal réveille aussitôt ; la relecture chaque seconde couvre les autres instances. */
        await waitForApprovalSignal(organization, id, Math.min(remaining, 1_000));
      }
    }),
  );

  for (const [path, status] of [
    ["approve", "approved"],
    ["reject", "rejected"],
  ] as const) {
    app.post(
      `/api/approvals/:id/${path}`,
      requireCapability("approve"),
      approvalRateLimit,
      handle(async (req, res) => {
        const parsed = approvalResolveSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          return fail(
            res,
            400,
            "The approver identity is derived from the authenticated caller and cannot be supplied in the body.",
          );
        }
        // The audit records who really resolved this, taken from the verified
        // credential — never from a client-supplied `resolvedBy`.
        const resolvedBy = requireIdentity(req).name;
        // Routed through the Gateway: approving releases the held action to
        // its tool exactly once; rejecting never reaches a tool.
        let result: Awaited<ReturnType<AgentGateway["resolveApproval"]>>;
        try {
          result = await scope(req).gateway.resolveApproval(param(req, "id"), status, resolvedBy);
        } catch (error) {
          /* 409 : la demande est dans un état où l'approuver ne servirait à rien — pour l'instant. */
          if (error instanceof ToolUnreachableError) return fail(res, 409, error.message);
          throw error;
        }
        if (!result?.approval) return fail(res, 404, "Approval not found");

        /*
         * 409, not 200. The window closed, so this decision was not applied and no
         * action was released. Answering 200 with a body the caller has to inspect
         * would let a client that only checks the status code report "approved" for
         * a request that expired — the console would show a released action that
         * never ran, which is the most misleading thing this endpoint could do.
         *
         * Deliberately not 403: nothing about the caller was wrong. They hold the
         * capability and the tenant is right; they were late. A 409 says the
         * resource is in a state incompatible with the request, which is exactly
         * what happened.
         */
        if (result.approval.expired) {
          return fail(
            res,
            409,
            "The approval window has closed. No action was released; a fresh request must be raised.",
          );
        }

        res.json({
          approval: result.approval.approval,
          execution: result.execution
            ? await withRetryabilityFetched(scope(req).repositories, result.execution)
            : null,
          // `executed` means attempted. An approver whose approval released the
          // action into a tool that then failed must see `succeeded: false`, not a
          // green tick.
          executed: result.executed,
          attempted: result.attempted,
          succeeded: result.succeeded,
          runState: result.runState,
          toolId: result.toolId,
          toolResult: result.toolResult,
        });
      }),
    );
  }

  /* --------------------- Phase 10: action authorization ------------------- */

  /*
   * The action authorization plane. Registered here, inside `registerRoutes`, so
   * the integration harness boots it exactly as production does — a surface
   * mounted anywhere else would be untested or absent, and this one is the one
   * that stands between an agent and a real refund.
   *
   * The helpers are handed over rather than re-implemented: `actingAgent` is the
   * agent-binding chokepoint and `rejectsClientActor` the attribution one, and a
   * second copy of either is a second place to forget them.
   */
  await initializeActionAuthority();
  registerActionRoutes(app, {
    handle,
    fail,
    param,
    actingAgent,
    rejectsClientActor,
    requireCapability,
    ensureCapability,
    decisionRateLimit,
    writeRateLimit,
  });

  /* ------------------------------- Feedback ------------------------------ */

  /*
   * `productVersion` vient du SERVEUR et jamais du corps de la requête. Un retour dit
   * « cette version m'a déplu » : si la version est annoncée par le client, le tableau
   * de bord ne peut plus relier un problème à une livraison, ce qui est la seule chose
   * qu'on lui demande de faire.
   */
  registerFeedbackRoutes(app, {
    handle,
    fail,
    param,
    requireCapability,
    writeRateLimit,
    productVersion: PRODUCT_VERSION,
  });

  /* ----------------------------- Interception ---------------------------- */

  /*
   * Enregistré AVANT le 404 d'API et avant les routes de configuration, parce que son
   * mode transparent capte `ANY /api/intercept/<destination>/<…>` : une route plus
   * spécifique déclarée après ne serait jamais atteinte.
   */
  registerInterceptRoutes(app, {
    handle,
    fail,
    requireCapability,
    decisionRateLimit,
    rules: INTERCEPT_RULES,
    scopeFor: (req) => {
      const scoped = scope(req);
      return {
        gateway: scoped.gateway,
        pendingStore: scoped.pendingInterceptions,
        currency: scoped.currency,
      };
    },
    actingAgent,
  });

  /* ---------------------------------- SSO --------------------------------- */

  /*
   * Les deux routes du SSO, publiques par nécessité : quelqu'un qui se connecte n'a pas
   * encore de session. Ce qui les protège est ailleurs — un `state` à usage unique lié au
   * navigateur par un cookie, un `nonce` dans le jeton, la vérification complète du jeton
   * d'identité, et le refus par défaut d'une adresse sans utilisateur de console.
   *
   * L'étranglement est celui de la page de connexion — par adresse et partagé entre
   * instances — appliqué dans le module lui-même.
   */
  registerOidcRoutes(app, { handle });

  /* --------------------------------- Slack -------------------------------- */

  /*
   * LE SEUL POINT D'ENTRÉE NON AUTHENTIFIÉ PAR UN CREDENTIAL OATHRION.
   *
   * C'est Slack qui appelle, et Slack ne connaît aucune clé d'Oathrion : la sécurité tient
   * à la signature de l'application, à la fraîcheur de l'horodatage, à une correspondance
   * nominative déclarée, et à la capacité `approve` du rôle de la personne. Voir
   * `server/routes-slack.ts`, qui porte les quatre.
   *
   * `scopeFor` est passé tel quel : la résolution passe par `gateway.resolveApproval`,
   * exactement la méthode que la route de console appelle. Un second chemin vers l'effet
   * aurait été la chose que ce dépôt est construit pour ne pas avoir.
   */
  registerSlackRoutes(app, { handle, approvalRateLimit, scopeFor });

  /* ------------------------------ Connectors ----------------------------- */

  /*
   * Le plan vient de la PORTÉE DU LOCATAIRE, donc du credential. Aucune de ces routes ne
   * lit une organisation dans l'URL, le corps ou un en-tête : `scope(req)` est la seule
   * façon d'obtenir un coffre, et il est déjà cadré.
   */
  /*
   * Le mandat vérifiable (`server/routes-mandates.ts`, `notes/CONCEPTION-MANDAT.md`). Le service
   * est cadré par l'organisation du credential ; seule la liste de révocation publique nomme une
   * organisation dans l'URL, et elle n'existe que pour une organisation qui a des mandats.
   */
  registerMandateRoutes(app, {
    handle,
    fail,
    param,
    requireCapability,
    serviceFor: (req) => new MandateService(repositoryExecutor(), requireIdentity(req).organizationId),
    serviceForOrganization: (organizationId) => (organizationStore.find(organizationId) ? new MandateService(repositoryExecutor(), organizationId) : null),
    identityOf: (req) => requireIdentity(req),
    publicBaseUrl: (req) => process.env.OATHRION_PUBLIC_URL?.trim().replace(/\/+$/, "") || `${req.protocol}://${req.get("host") ?? "localhost"}`,
  });

  registerConnectorRoutes(app, {
    handle,
    fail,
    param,
    requireCapability,
    writeRateLimit,
    planFor: (req) => scope(req).connectors,
    planForOrganization: (organizationId) => scopeFor(organizationId).connectors,
    policiesFor: (req) => scope(req).repositories.policies,
    agentsFor: (req) => scope(req).repositories.agents,
    executionExists: async (req, executionId) => Boolean(await scope(req).repositories.executions.findById(executionId)),
    notify: (input) => {
      notifier.emit(input);
    },
    organizationName: (organizationId) => organizationStore.find(organizationId)?.name ?? String(organizationId),
  });

  /* --------------------------- Scénario guidé ---------------------------- */

  /*
   * `execute`, la capacité de `POST /api/execute` : le scénario n'est rien d'autre qu'une
   * suite de ces appels, au nom de l'agent choisi. L'acteur enregistré nomme la personne
   * ET le fait que la séquence a été jouée par la console — l'audit ne doit pas laisser
   * croire qu'un agent autonome a agi.
   */
  const scenarioBody = z.strictObject({
    agentId: z.string().trim().min(1).max(120),
    executionIds: z.array(z.string().trim().min(1).max(120)).max(10).optional(),
  });

  app.post(
    "/api/scenario/run",
    requireCapability("execute"),
    decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;
      const parsed = scenarioBody.safeParse(req.body ?? {});
      if (!parsed.success) return fail(res, 400, "agentId is required");
      const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
      if (agentId === null) return;
      const tenant = scope(req);
      try {
        const steps = await runScenario(
          {
            gateway: tenant.gateway,
            repositories: tenant.repositories,
            connectors: tenant.connectors,
            actor: `${requireIdentity(req).name} · guided scenario`,
          },
          agentId,
        );
        res.json({ steps });
      } catch (error) {
        if (error instanceof ScenarioError) return fail(res, 409, error.message, "scenario_not_ready");
        throw error;
      }
    }),
  );

  app.post(
    "/api/scenario/notify",
    requireCapability("execute"),
    decisionRateLimit,
    handle(async (req, res) => {
      if (rejectsClientActor(req, res)) return;
      const parsed = scenarioBody.safeParse(req.body ?? {});
      if (!parsed.success) return fail(res, 400, "agentId is required");
      const agentId = actingAgent(req, res, parsed.data.agentId ?? null);
      if (agentId === null) return;
      const tenant = scope(req);
      try {
        const step = await notifyScenario(
          {
            gateway: tenant.gateway,
            repositories: tenant.repositories,
            connectors: tenant.connectors,
            actor: `${requireIdentity(req).name} · guided scenario`,
          },
          agentId,
          parsed.data.executionIds ?? [],
        );
        res.json({ step });
      } catch (error) {
        if (error instanceof ScenarioError) return fail(res, 409, error.message, "scenario_not_ready");
        throw error;
      }
    }),
  );

  /* ----------------------------- Integrations ---------------------------- */

  app.get(
    "/api/integrations",
    requireCapability("read"),
    handle(async (req, res) => res.json(await scope(req).repositories.integrations.list())),
  );

  app.post(
    "/api/integrations/:id/toggle",
    requireCapability("manage"),
    writeRateLimit,
    handle(async (req, res) => {
      const updated = await scope(req).repositories.integrations.toggle(param(req, "id"));
      if (!updated) return fail(res, 404, "Integration not found");
      res.json(updated);
    }),
  );

  /* ------------------------------ API 404 -------------------------------- */

  /*
   * Unknown API paths must answer JSON, not the console and not Express's own
   * HTML error page.
   *
   * Registered here, as the last thing in the API surface, so it is part of what
   * `registerRoutes` guarantees — and therefore part of what the test harness
   * exercises. Without it an unmatched `/api/...` fell through to the SPA
   * catch-all installed after this function and was served `index.html` with a
   * 200; a client library then tried to `JSON.parse` a page of HTML and reported
   * a parse error instead of the plain 404 that actually happened.
   */
  app.use("/api", (_req, res) => {
    /*
     * Now goes through the shared builder, so an unmatched path answers with the same
     * shape as every other refusal instead of being the one place that sent `message`
     * without `error`.
     *
     * Worth recording what this handler does *not* see: the authentication gate is
     * mounted before every route, so an unmatched `/api/...` requested without a valid
     * credential is answered 401 by the gate and never reaches here. This 404 is
     * therefore only ever seen by an authenticated caller. That is the better ordering
     * — an anonymous caller cannot map which paths exist by reading 404-vs-401 — and it
     * is left as it is; but the comment above overstated the guarantee, and the
     * measurement is recorded here rather than corrected silently.
     */
    sendApiError(res, 404, "Not found", ERROR_CODES.notFound);
  });

  /*
   * LA RÉCONCILIATION PÉRIODIQUE — le même passage que le bouton de la console
   * (`reconcileOnce`), pour chaque organisation active et chaque outil connecté qui sait
   * se réconcilier. Une écriture vue hors d'Oathrion n'alerte qu'une fois.
   */
  startReconcileScheduler({
    intervalMs: reconcileIntervalMs(),
    organizations: () => organizationStore.list(),
    isShuttingDown,
    // eslint-disable-next-line no-console -- journal des tâches périodiques, même exemption que [metrics]
    log: (message) => console.log(`[reconcile] ${message}`),
    runOrganization: async (organization) => {
      const tenant = scopeFor(organization.id);
      const plane = tenant.connectors;
      for (const described of await plane.describe()) {
        if (!described.reconcilable || described.status.state !== "connected") continue;
        const connector = lookupConnector(described.id);
        if (!connector) continue;
        const outcome = await reconcileOnce({
          connector,
          plane,
          policies: await tenant.repositories.policies.list(),
          executionExists: async (id) => Boolean(await tenant.repositories.executions.findById(id)),
          trigger: "auto",
        });
        if (!outcome.ok) {
          // eslint-disable-next-line no-console -- journal des tâches périodiques, même exemption que [metrics]
          console.log(`[reconcile] ${organization.id} · ${connector.id}: not checked (${outcome.code})`);
          continue;
        }
        if (outcome.fresh.length > 0) {
          notifier.emit(reconcileAlert(organization.id, organization.name, connector, outcome.fresh));
          // eslint-disable-next-line no-console -- journal des tâches périodiques, même exemption que [metrics]
          console.log(`[reconcile] ${organization.id} · ${connector.id}: ${String(outcome.fresh.length)} write(s) outside Oathrion, alert sent`);
        }
      }
    },
  });

  /*
   * LES ACTIONS SANS REÇU (`server/authority/receipt-gaps.ts`) : des autorisations
   * consommées dont le reçu n'a jamais été écrit, passé le délai de grâce. Une alerte par
   * autorisation, une seule fois.
   */
  startReconcileScheduler({
    intervalMs: receiptGapIntervalMs(),
    organizations: () => organizationStore.list(),
    isShuttingDown,
    label: "search for actions without a receipt",
    variable: "OATHRION_RECEIPT_GAP_INTERVAL_MS",
    // eslint-disable-next-line no-console -- journal des tâches périodiques, même exemption que [metrics]
    log: (message) => console.log(`[receipts] ${message}`),
    runOrganization: async (organization) => {
      const fresh = await findNewReceiptGaps({
        store: authorityFor(organization.id).store,
        findings: scopeFor(organization.id).connectors.reconciliations,
      });
      if (fresh.length > 0) {
        notifier.emit(receiptGapAlert(organization.id, organization.name, fresh));
        // eslint-disable-next-line no-console -- journal des tâches périodiques, même exemption que [metrics]
        console.log(`[receipts] ${organization.id}: ${String(fresh.length)} action(s) without a receipt, alert sent`);
      }
    },
  });

  return httpServer;
}
