/**
 * Oathrion data access layer.
 *
 * Every call now hits the real control plane over HTTP. The Policy Engine lives
 * server-side (`shared/policy` + `server/services/decision-service.ts`); the UI
 * never evaluates a policy itself.
 *
 *   GET    /api/agents                    → listAgents()
 *   GET    /api/agents/:id                → getAgent(id)
 *   POST   /api/agents                    → createAgent(agent)
 *   PATCH  /api/agents/:id                → updateAgent(id, patch)
 *   GET    /api/executions                → listExecutions()
 *   GET    /api/executions/:id            → getExecution(id)
 *   GET    /api/policies                  → listPolicies()
 *   POST   /api/policies                  → createPolicy(policy)
 *   PATCH  /api/policies/:id              → updatePolicy(id, patch)
 *   GET    /api/approvals                 → listApprovals()
 *   POST   /api/approvals/:id/approve     → resolveApproval(id, "approved")
 *   POST   /api/approvals/:id/reject      → resolveApproval(id, "rejected")
 *   GET    /api/integrations              → listIntegrations()
 *   POST   /api/integrations/:id/toggle   → toggleIntegration(id)
 *   POST   /api/decision                  → evaluateDecision(request)
 *   POST   /api/execute                   → execute(request)      (Gateway)
 *   POST   /api/evaluate                  → evaluate(request)     (dry run)
 *   POST   /api/executions/:id/retry      → retryExecution(id)
 *   POST   /api/auth/login                → login(email, password)
 *   POST   /api/auth/password             → changePassword(current, next)
 *   GET    /api/tools                     → listTools()
 *
 * Every call carries the session token held in `queryClient.ts`. No credential
 * is hard-coded here, and the approver identity is never sent by the client —
 * the server derives it from the authenticated caller.
 */

import { apiRequest, apiRequestAllowingFailure } from "@/lib/queryClient";
import type { AgentMandate } from "@shared/policy/mandate";
import type { Capability, Role } from "@shared/roles";
import type { RunState } from "@shared/types";
import type {
  Agent,
  AgentStatus,
  Approval,
  Execution,
  Integration,
  Permission,
  Policy,
  PolicyStatus,
  RiskLevel,
} from "@/types";

async function get<T>(url: string): Promise<T> {
  const res = await apiRequest("GET", url);
  return (await res.json()) as T;
}

async function send<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await apiRequest(method, url, body);
  return (await res.json()) as T;
}

/* ------------------------------- Decision -------------------------------- */

export type EngineDecision = "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
export type EngineRisk = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

/** Body of POST /api/decision — what an agent sends before acting. */
export interface DecisionRequest {
  agentId: string;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
  /** `false` runs a dry evaluation without recording an execution. */
  persist?: boolean;
}

export interface DecisionMatch {
  policyId: string;
  policyName: string;
  decision: EngineDecision;
  reason: string;
  risk: EngineRisk;
}

/**
 * Whether an execution may be dispatched again — decided by the server.
 *
 * §8. The console used to gate its "Retry tool run" button on `runState === "failed"`
 * alone, while the backend refuses a retry for three separate reasons (non-`allow`
 * decision, run not failed, attempt ceiling spent). An operator was shown an enabled
 * button on an execution the server was always going to refuse.
 *
 * Re-deriving the rule here would be worse, not better: `maxAttempts` is configurable
 * per deployment, so a hard-coded copy is wrong on any install that changes it. This
 * type carries the server's conclusion; the console renders it and decides nothing.
 *
 * It describes the EXECUTION, not the caller. `retryable: true` on a viewer's screen
 * is correct — the capability check for pressing the button is separate.
 */
export interface Retryability {
  retryable: boolean;
  attempts: number;
  maxAttempts: number;
  attemptsRemaining: number;
  /** Operator-facing explanation when `retryable` is false; `null` when it is true. */
  reason: string | null;
  /**
   * Refused ONLY because the effect is unknown: someone with `approve` who has checked the
   * service may confirm that nothing happened, and the run goes again.
   */
  requiresConfirmation?: boolean;
}

/** An Execution as the API returns it: the stored row plus the server's verdict on retrying it. */
export type ExecutionDto = Execution & { retry: Retryability };

export interface DecisionResponse {
  decision: EngineDecision;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: EngineRisk;
  matched: DecisionMatch[];
  executionId: string | null;
  approvalId: string | null;
  execution: ExecutionDto | null;
  approval: Approval | null;
}

export interface ApprovalResolution extends DispatchOutcomeFields {
  approval: Approval;
  execution: ExecutionDto | null;
  /** Legacy alias of `attempted`; see DispatchOutcomeFields. */
  executed: boolean;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
}

/**
 * The three fields that answer "what actually happened", shared by every response
 * that can reach a tool.
 *
 * `executed` is retained on those responses for compatibility and means
 * ATTEMPTED — it is true for a tool that ran and threw. Anything rendering a
 * success state must read `succeeded`, or `runState`, which is the persisted state
 * rather than a property of one call. See `GatewayResult` on the server.
 */
export interface DispatchOutcomeFields {
  /** A tool was invoked during THIS call. Says nothing about the result. */
  attempted: boolean;
  /** The tool was invoked during this call AND reported success. */
  succeeded: boolean;
  /** The persisted run state — the field to branch on. */
  runState: RunState | null;
}

/* -------------------------------- Gateway -------------------------------- */

/** Body of POST /api/execute — evaluate, then reach the tool if ALLOWed. */
export interface ExecuteRequest {
  agentId: string;
  action: string;
  target: string;
  metadata?: Record<string, unknown>;
}

export interface ExecuteResponse extends DispatchOutcomeFields {
  decision: EngineDecision;
  /** Legacy alias of `attempted`; see DispatchOutcomeFields. */
  executed: boolean;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  riskLevel: EngineRisk;
  matched: DecisionResponse["matched"];
  executionId: string | null;
  approvalId: string | null;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
  execution: ExecutionDto | null;
}

export interface ToolSummary {
  id: string;
  name: string;
  description: string;
  toolExecutionCount: number;
}


export const api = {
  listAgents: () => get<Agent[]>("/api/agents"),
  getAgent: (id: string) => get<Agent>(`/api/agents/${id}`),
  createAgent: (agent: Agent) => send<Agent>("POST", "/api/agents", agent),
  updateAgent: (
    id: string,
    patch: {
      status?: AgentStatus;
      currentTask?: string | null;
      mandate?: AgentMandate;
      permissions?: Permission[];
    },
  ) =>
    send<Agent>("PATCH", `/api/agents/${id}`, patch),


  listExecutions: () => get<ExecutionDto[]>("/api/executions"),
  getExecution: (id: string) => get<ExecutionDto>(`/api/executions/${id}`),

  listPolicies: () => get<Policy[]>("/api/policies"),
  createPolicy: (policy: Policy) => send<Policy>("POST", "/api/policies", policy),
  updatePolicy: (id: string, patch: { status: PolicyStatus }) =>
    send<Policy>("PATCH", `/api/policies/${id}`, patch),

  listApprovals: () => get<Approval[]>("/api/approvals"),
  /**
   * The body is intentionally empty: sending `resolvedBy` is rejected with a
   * 400. The audit records the authenticated identity instead.
   */
  resolveApproval: (id: string, status: "approved" | "rejected") =>
    send<ApprovalResolution>(
      "POST",
      `/api/approvals/${id}/${status === "approved" ? "approve" : "reject"}`,
      {},
    ),

  listIntegrations: () => get<Integration[]>("/api/integrations"),
  toggleIntegration: (id: string) =>
    send<Integration>("POST", `/api/integrations/${id}/toggle`),

  evaluateDecision: (request: DecisionRequest) =>
    send<DecisionResponse>("POST", "/api/decision", request),

  execute: (request: ExecuteRequest) => send<ExecuteResponse>("POST", "/api/execute", request),

  /**
   * Dry run by default: the server writes no Execution, no Approval, no audit
   * entry and touches no policy counter unless `persist` is true.
   */
  evaluate: (request: EvaluateRequest) =>
    send<EvaluateResponse>("POST", "/api/evaluate", { persist: false, ...request }),

  retryExecution: (id: string, confirmNotApplied = false) =>
    send<RetryResponse>("POST", `/api/executions/${id}/retry`, confirmNotApplied ? { confirmNotApplied: true } : {}),

  listTools: () => get<ToolSummary[]>("/api/tools"),
};

/* --------------------------------- Auth ---------------------------------- */

export interface Identity {
  id: string;
  name: string;
  kind: "service" | "user";
  /** Assigned server-side from the credential; the client only displays it. */
  role: Role;
  sessionId?: string;
}

/** Ce que la session dit d'elle-même ; `localMode` vaut vrai sous `oathrion wrap`. */
export async function sessionInfo(): Promise<{ localMode?: boolean }> {
  return get<{ localMode?: boolean }>("/api/auth/session");
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  identity: Identity;
  capabilities: Capability[];
}

/**
 * Exchanges an e-mail address and password for a short-lived session token.
 *
 * `organization` is only needed by a user who belongs to more than one; the server
 * refuses to guess, because guessing would place someone in the wrong tenant.
 */
export async function login(
  email: string,
  password: string,
  organization?: string,
): Promise<LoginResponse> {
  return send<LoginResponse>("POST", "/api/auth/login", {
    email,
    password,
    ...(organization ? { organization } : {}),
  });
}

/* ------------------------------ connexion par SSO ------------------------------ */

/**
 * Is single sign-on configured on this deployment?
 *
 * Answers one bit and nothing else — not the issuer, not the client id. Naming the
 * directory a company uses would only help whoever is preparing a phishing page, and
 * the sign-in screen does not need it to decide whether to draw a button.
 */
export async function ssoStatus(): Promise<{ configured: boolean }> {
  return get<{ configured: boolean }>("/api/auth/sso/status");
}

/**
 * Exchanges the one-time SSO ticket for a session token.
 *
 * The identity provider returns the browser by a NAVIGATION, which destroys this
 * app's in-memory token. What travels in the URL is therefore a ticket — opaque,
 * single-use, valid for 60 seconds — and never a session token: a URL ends up in
 * browser history, in proxy logs and in the next navigation's `Referer`. This is the
 * same reason an OAuth authorization code is single-use.
 */
/** La console est-elle locale (`oathrion wrap`) ? `null` quand elle ne l'est pas, ou ne répond pas. */
export async function localConsoleInfo(): Promise<{ name: string | null } | null> {
  try {
    const res = await fetch("/api/local/login", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const body = (await res.json()) as { local?: unknown; name?: unknown };
    return body.local === true ? { name: typeof body.name === "string" ? body.name : null } : null;
  } catch {
    return null;
  }
}

/** La console locale : un ticket d'`oathrion console` contre une session (`/api/local/login`). */
export async function claimLocalLogin(ticket: string): Promise<LoginResponse> {
  return send<LoginResponse>("POST", "/api/local/login", { ticket });
}

export async function claimSso(handoff: string): Promise<LoginResponse & { returnTo: string }> {
  return send<LoginResponse & { returnTo: string }>("POST", "/api/auth/sso/claim", { handoff });
}

/**
 * Changes the signed-in user's own password. Every other session that account holds
 * is revoked server-side; this one survives.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; otherSessionsRevoked: boolean }> {
  return send<{ ok: boolean; otherSessionsRevoked: boolean }>("POST", "/api/auth/password", {
    currentPassword,
    newPassword,
  });
}

export async function fetchSession(): Promise<{ identity: Identity; capabilities: Capability[] }> {
  return get<{ identity: Identity; capabilities: Capability[] }>("/api/auth/session");
}

/** Revokes this session server-side; the token is dead everywhere, not just here. */
export async function logout(): Promise<{ revoked: boolean }> {
  return send<{ revoked: boolean }>("POST", "/api/auth/logout");
}

export interface SessionSummary {
  id: string;
  name: string;
  role: Role;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  current: boolean;
  active: boolean;
}

export async function listSessions(): Promise<{ total: number; sessions: SessionSummary[] }> {
  return get<{ total: number; sessions: SessionSummary[] }>("/api/auth/sessions");
}

export async function revokeSession(id: string): Promise<{ revoked: boolean }> {
  const res = await apiRequest("DELETE", `/api/auth/sessions/${id}`);
  return (await res.json()) as { revoked: boolean };
}

/* --------------------------- Organization ------------------------------- */

export interface OrganizationSummary {
  id: string;
  name: string;
  createdAt: string;
  active: boolean;
  memberCount: number;
  adminCount: number;
}

export interface MemberSummary {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: "active" | "suspended";
  createdAt: string;
  lastLoginAt: string | null;
  passwordSource: "config" | "user";
}

export async function getOrganization(): Promise<OrganizationSummary> {
  return get<OrganizationSummary>("/api/organization");
}

export async function listMembers(): Promise<{ total: number; members: MemberSummary[] }> {
  return get<{ total: number; members: MemberSummary[] }>("/api/members");
}

/* ------------------------------- Dry run --------------------------------- */

export interface EvaluateRequest {
  agentId: string;
  action: string;
  target: string;
  amount?: number;
  category?: string;
  context?: string;
  metadata?: Record<string, unknown>;
  /** Defaults to false — evaluating leaves no trace. */
  persist?: boolean;
}

export interface EvaluateResponse {
  decision: EngineDecision;
  reason: string;
  policyId: string | null;
  policyName: string | null;
  risk: RiskLevel;
  /** False means nothing was written to the registry. */
  persisted: boolean;
  executionId: string | null;
  approvalId: string | null;
  matched: DecisionMatch[];
}

export interface RetryResponse extends DispatchOutcomeFields {
  /** Legacy alias of `attempted`; see DispatchOutcomeFields. */
  executed: boolean;
  toolId: string | null;
  toolResult: Record<string, unknown> | null;
  execution: ExecutionDto;
}

/** Engine risk (uppercase) → UI risk vocabulary. */
export function toUiRisk(risk: EngineRisk): RiskLevel {
  return risk.toLowerCase() as RiskLevel;
}

export const QUERY_KEYS = {
  agents: ["/api/agents"] as const,
  agent: (id: string) => ["/api/agents", id] as const,
  executions: ["/api/executions"] as const,
  execution: (id: string) => ["/api/executions", id] as const,
  policies: ["/api/policies"] as const,
  approvals: ["/api/approvals"] as const,
  integrations: ["/api/integrations"] as const,
  tools: ["/api/tools"] as const,
};

/* -------------------------------- API keys -------------------------------- */

export interface ApiKeySummary {
  id: string;
  name: string;
  role: Role;
  /** `aria_ab12cd` for an issued key, `env:` for one managed in the environment. */
  prefix: string;
  source: "config" | "user";
  createdAt: string;
  createdBy: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokedReason: string | null;
  status: "active" | "revoked" | "expired";
}

export async function listApiKeys(): Promise<{ total: number; keys: ApiKeySummary[] }> {
  return get<{ total: number; keys: ApiKeySummary[] }>("/api/keys");
}

/**
 * Issues a key. `secret` in the response is the only copy that will ever exist — the
 * server stores a SHA-256 digest, so nothing can recover it afterwards.
 */
export async function createApiKey(input: {
  name: string;
  role: Role;
  expiresInDays?: number;
  /** Une clé liée à un agent ne peut agir QU'au nom de cet agent. */
  agentId?: string;
}): Promise<{ key: ApiKeySummary; secret: string; notice: string }> {
  return send<{ key: ApiKeySummary; secret: string; notice: string }>("POST", "/api/keys", input);
}

export async function revokeApiKey(
  id: string,
  reason?: string,
): Promise<{ revoked: boolean; keyId: string; alreadyRevoked: boolean }> {
  return send<{ revoked: boolean; keyId: string; alreadyRevoked: boolean }>(
    "DELETE",
    `/api/keys/${encodeURIComponent(id)}`,
    reason ? { reason } : undefined,
  );
}

/* ------------------------------- Feedback -------------------------------- */

/**
 * Les catégories et statuts sont répétés ici plutôt qu'importés du serveur.
 *
 * `shared/` est le seul endroit que les deux côtés partagent, et y mettre ces listes
 * ferait entrer une notion purement produit dans le module partagé par le plan de
 * contrôle. Le coût de la duplication est réel mais borné : le serveur REFUSE une valeur
 * inconnue par un `CHECK` en base et par un `z.enum` en entrée, donc une divergence se
 * manifeste par un 400 nommé au premier essai, pas par une donnée fausse enregistrée.
 */
export const FEEDBACK_CATEGORY_LABELS = {
  experience: "User experience",
  bug: "Technical bug",
  missing_feature: "Missing feature",
  wrong_result: "Wrong result",
  performance: "Performance",
  security: "Security",
  suggestion: "Suggestion",
} as const;
export type FeedbackCategory = keyof typeof FEEDBACK_CATEGORY_LABELS;

export const FEEDBACK_STATUS_LABELS = {
  received: "Received",
  triaging: "Being triaged",
  planned: "Planned",
  in_progress: "In progress",
  resolved: "Resolved",
  declined: "Not planned",
} as const;
export type FeedbackStatus = keyof typeof FEEDBACK_STATUS_LABELS;

export interface FeedbackItem {
  id: string;
  vote: -1 | 0 | 1;
  category: FeedbackCategory;
  comment: string | null;
  feature: string;
  productVersion: string;
  contextRef: string | null;
  status: FeedbackStatus;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  /** Le serveur ne rend jamais l'auteur, seulement si c'est le lecteur. */
  mine: boolean;
}

export async function listFeedback(): Promise<{ feedback: FeedbackItem[] }> {
  return get<{ feedback: FeedbackItem[] }>("/api/feedback");
}

export async function submitFeedback(input: {
  vote: -1 | 0 | 1;
  category: FeedbackCategory;
  comment?: string;
  feature: string;
  contextRef?: string;
}): Promise<{ feedback: FeedbackItem }> {
  return send<{ feedback: FeedbackItem }>("POST", "/api/feedback", input);
}

export async function setFeedbackStatus(
  id: string,
  status: FeedbackStatus,
  resolutionNote?: string,
): Promise<{ feedback: FeedbackItem }> {
  return send<{ feedback: FeedbackItem }>("PATCH", `/api/feedback/${id}`, {
    status,
    ...(resolutionNote ? { resolutionNote } : {}),
  });
}

/* ------------------------------ Connectors ------------------------------- */

/**
 * L'état RÉEL d'un connecteur, tel que le serveur le connaît.
 *
 * Cinq valeurs et pas un booléen, parce que les cinq situations demandent des gestes
 * différents de l'exploitant : rien n'est configuré · le service a refusé le jeton · tout
 * va bien · le dernier appel a échoué · quelqu'un a déconnecté. L'écran `integrations`
 * que ces connecteurs remplacent avait un booléen `connected` qu'un clic faisait
 * basculer, sans qu'aucun appel ne soit passé.
 */
export type ConnectorState = "not_configured" | "connected" | "error" | "revoked";

export interface ConnectorStatus {
  connectorId: string;
  state: ConnectorState;
  /** Le compte tel que LE SERVICE l'a nommé, pas ce que l'exploitant a saisi. */
  account?: string;
  /** Les portées que le service a confirmées. Vide quand il n'en annonce aucune. */
  scopes?: string[];
  /** Six caractères de SHA-256 du jeton : reconnaissable, jamais un fragment du secret. */
  fingerprint?: string;
  detail?: string;
  connectedBy?: string;
  connectedAt?: string | null;
  lastCheckedAt?: string | null;
}

export interface ConnectorDescription {
  id: string;
  label: string;
  description: string;
  actions: string[];
  /** La procédure de création du credential. Affichée, jamais devinée par l'écran. */
  credentialGuide: string;
  /** La réconciliation (« ce qui s'est passé sans Oathrion ») existe pour ce connecteur. */
  reconcilable?: boolean;
  status: ConnectorStatus;
  /**
   * Le clic « Connecter » en un geste est-il offert par CE déploiement ? Sinon la
   * console propose la connexion par jeton, présentée comme telle.
   */
  oauth?: { available: boolean; permissions: { scope: string; why: string }[] };
}

export interface ConnectorCapability {
  action: string;
  label: string;
  available: boolean;
  /** Pourquoi elle ne l'est pas. Présent exactement quand `available` est faux. */
  reason?: string;
}

/** Un code machine du fournisseur. L'écran branche sur lui, pas sur la prose. */
export type ConnectorProbeCode =
  | "ok"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "rate_limited"
  | "unreachable"
  | "unexpected";

export const CONNECTOR_STATE_LABELS: Record<ConnectorState, string> = {
  not_configured: "Not configured",
  connected: "Connected",
  error: "Error",
  revoked: "Revoked",
};

export async function listConnectors(): Promise<ConnectorDescription[]> {
  return get<ConnectorDescription[]>("/api/connectors");
}

/**
 * Connecte un service. Le serveur VÉRIFIE le credential avant de le stocker : un jeton
 * refusé renvoie 422 et ne laisse aucune trace.
 */
export async function connectConnector(
  id: string,
  secret: string,
): Promise<{ connected: boolean; code: ConnectorProbeCode; detail: string; status?: ConnectorStatus }> {
  /*
   * `send` lèverait sur le 422 que le serveur rend quand LE SERVICE a refusé le jeton —
   * et ce corps est précisément ce que l'écran doit montrer : le code du fournisseur et
   * son message. L'appel est donc fait à la main, et la réponse lue dans les deux cas.
   *
   * Le secret part en corps JSON, jamais en paramètre d'URL : une URL finit dans les
   * journaux d'accès du proxy.
   */
  const res = await apiRequestAllowingFailure("POST", `/api/connectors/${id}/connect`, { secret });
  const body = (await res.json()) as {
    connected?: boolean;
    code?: ConnectorProbeCode;
    detail?: string;
    message?: string;
    status?: ConnectorStatus;
  };
  return {
    connected: body.connected === true,
    code: body.code ?? (res.ok ? "ok" : "unexpected"),
    detail: body.detail ?? body.message ?? `The server answered ${String(res.status)}.`,
    status: body.status,
  };
}

/**
 * « L'ancienne clé de mon agent fonctionne-t-elle encore ? » — demandé AU SERVICE, sans
 * rien stocker. `placet` : c'est la clé du coffre, à ne pas révoquer.
 */
export type CredentialCheck = { state: "alive" | "dead" | "unknown" | "placet"; detail: string };

export async function checkOldCredential(id: string, secret: string, agentId?: string): Promise<CredentialCheck> {
  const res = await apiRequestAllowingFailure("POST", `/api/connectors/${id}/check-credential`, agentId ? { secret, agentId } : { secret });
  const body = (await res.json()) as Partial<CredentialCheck> & { message?: string };
  if (res.ok && body.state) return { state: body.state, detail: body.detail ?? "" };
  return { state: "unknown", detail: body.message ?? `The server answered ${String(res.status)}.` };
}

/** Les portes d'un agent telles que le SERVEUR les garde, avec son verdict. */
export interface AgentDoorsPayload {
  agentId: string;
  tools: { id: string; label: string }[];
  doors: {
    connectorId: string;
    declared: "none" | "revoked";
    declaredBy: string;
    declaredAt: string;
    check: { state: CredentialCheck["state"]; detail: string; checkedBy: string; checkedAt: string } | null;
  }[];
  verdict: "locked" | "declared" | "open" | "incomplete";
}

/** Les outils d'un serveur enveloppé que l'agent ne voit pas, faute d'une permission. */
export interface WithheldToolsEntry {
  agentId: string;
  agentName: string;
  tools: { name: string; server: string; toolClass: "read" | "write" | "destructive"; scope: string | null }[];
}

export async function listWithheldTools(): Promise<WithheldToolsEntry[]> {
  return get<WithheldToolsEntry[]>("/api/withheld-tools");
}

/** Un programme qui a lancé un relais : confirmé, en attente, ou bloqué (`server/local-programs.ts`). */
export interface KnownProgram {
  id: string;
  name: string;
  identity: { exe: string; script: string | null; sha256: string; platform: string } | null;
  status: "pending" | "trusted" | "blocked";
  firstSeen: string;
  lastSeen: string;
  decidedAt: string | null;
  decidedBy: string | null;
  previousSha256: string[];
  description: string;
}

export async function listPrograms(): Promise<KnownProgram[]> {
  return get<KnownProgram[]>("/api/local/programs");
}

export async function decideProgram(id: string, decision: "trust" | "block"): Promise<KnownProgram> {
  return send<KnownProgram>("POST", `/api/local/programs/${encodeURIComponent(id)}/${decision}`, {});
}

/** Un agent qui tourne sur la machine, vu par la veille du pivot (`server/local-agent-watch.ts`). */
export interface RunningAgent {
  pid: number;
  agent: string;
  exe: string;
  script: string | null;
  jailed: boolean;
  launch: string;
  allowedOutside: boolean;
  /** Qui l'a autorisé hors de la prison, et quand ; `null` s'il ne l'est pas. */
  allowance: { agent: string; by: string; at: string } | null;
  /** Sa mascotte (`/mascots/<id>.png`). */
  mascot?: { id: string; name: string };
  /** Repris « pour cette fois » depuis la notification : ce lancement-là seulement. */
  allowedOnce?: boolean;
  /** Mis en pause par Oathrion (gelé, ou arrêté par signal) ; `null` sinon. */
  paused: "frozen" | "stopped" | null;
}

export async function listRunningAgents(): Promise<RunningAgent[]> {
  return get<RunningAgent[]>("/api/local/agents/running");
}

export async function actOnRunningAgent(pid: number, action: "stop" | "allow"): Promise<unknown> {
  return send<unknown>("POST", `/api/local/agents/running/${String(pid)}/${action}`, {});
}

export async function getTripwire(): Promise<{ decoys: number; events: { path: string; at: string }[] }> {
  return get<{ decoys: number; events: { path: string; at: string }[] }>("/api/local/tripwire");
}

/** Un élément du fil d'actualité (`server/local-feed.ts`) : `share` ne porte rien de privé. */
export interface FeedItem {
  id: string;
  at: string;
  agent: string;
  mascot: { id: string; name: string };
  tone: "good" | "warn" | "bad" | "info";
  title: string;
  detail?: string;
  share: string;
}

export async function getFeed(): Promise<FeedItem[]> {
  return get<FeedItem[]>("/api/local/feed");
}

/** L'état des protections de la machine (`/api/local/settings`). */
/** Une carte à partager, ouverte depuis la notification. */
export interface ShareCard {
  sentence: string;
  mascot: { id: string; name: string };
  at: string;
  tone: FeedItem["tone"];
}

export async function getShareCard(token: string): Promise<ShareCard> {
  return get<ShareCard>(`/api/local/share-cards/${encodeURIComponent(token)}`);
}

/** Une décision ouverte par « Decide » depuis une notification (macOS, Windows : `server/local-decisions.ts`). */
export interface LocalDecision {
  id: string;
  title: string;
  body: string;
  mascot: { id: string; name: string } | null;
  danger: boolean;
  actions: { id: string; label: string }[];
  done: { text: string; share?: string } | null;
  judged: boolean;
  share: string | null;
}

export async function getDecision(id: string): Promise<LocalDecision> {
  return get<LocalDecision>(`/api/local/decisions/${encodeURIComponent(id)}`);
}

export async function makeDecision(id: string, body: { action: string } | { right: boolean }): Promise<LocalDecision> {
  return send<LocalDecision>("POST", `/api/local/decisions/${encodeURIComponent(id)}`, body);
}

export async function shareDecision(id: string, network: string): Promise<{ token: string }> {
  return send<{ token: string }>("POST", `/api/local/decisions/${encodeURIComponent(id)}`, { share: network });
}

/** « Prêt à X/5 » : ce que la personne a déjà fait pour être bien protégée (`/api/local/readiness`). */
export interface Readiness {
  steps: { id: "protected" | "demo" | "phone" | "named" | "decision"; done: boolean; count?: number; connected?: number; bot?: string | null; optional?: boolean }[];
}

export async function getReadiness(): Promise<Readiness> {
  return get<Readiness>("/api/local/readiness");
}

/** La démo, depuis la console (comme `oathrion demo`). */
export async function showDemo(): Promise<{ shown: boolean; detail: string }> {
  return send<{ shown: boolean; detail: string }>("POST", "/api/local/demo");
}

/** Les mascottes des agents : le catalogue, et ce que la personne a choisi pour chacun (par famille). */
export interface MascotCatalog {
  catalog: { id: string; name: string }[];
  choices: Record<string, { mascot: string; nickname?: string; at: string }>;
}

export async function getMascots(): Promise<MascotCatalog> {
  return get<MascotCatalog>("/api/local/mascots");
}

export async function chooseMascot(agent: string, mascot: string, nickname: string): Promise<{ face: { id: string; name: string } }> {
  return send<{ face: { id: string; name: string } }>("POST", "/api/local/mascots", { agent, mascot, nickname });
}

export interface LocalSettings {
  notifications: { desktop: boolean; slack: boolean };
  phone?: { paired: boolean; bot: string | null };
  platform?: string;
  watch: { on: boolean };
  jail: { agents: string[] };
  decoys: { count: number };
}

export async function getLocalSettings(): Promise<LocalSettings> {
  return get<LocalSettings>("/api/local/settings");
}

export async function setDesktopNotifications(desktop: boolean): Promise<unknown> {
  return send<unknown>("POST", "/api/local/settings/notifications", { desktop });
}

export async function revokeOutsideAllowance(exe: string): Promise<unknown> {
  return send<unknown>("POST", "/api/local/agents/allowed/revoke", { exe });
}

export async function getAgentDoors(agentId: string): Promise<AgentDoorsPayload> {
  return get<AgentDoorsPayload>(`/api/agents/${agentId}/doors`);
}

export async function declareAgentDoor(agentId: string, connectorId: string, declared: "none" | "revoked"): Promise<AgentDoorsPayload> {
  return send<AgentDoorsPayload>("PUT", `/api/agents/${agentId}/doors/${connectorId}`, { declared });
}

/** Une écriture vue chez le service, telle que la réconciliation la rapporte. */
export interface ReconcileFinding {
  kind: "issue" | "pull_request" | "comment" | "refund" | "payout" | "payment" | "customer" | "dispute" | "message" | "task" | "missing_receipt";
  id: string;
  url: string | null;
  createdAt: string;
  actor: string | null;
  summary: string;
  marker: string | null;
}

export type ReconcileReport =
  | {
      ok: true;
      since: string;
      until: string;
      identity: string;
      scanned: number;
      viaOathrion: number;
      outside: ReconcileFinding[];
      unknownMarker: ReconcileFinding[];
      others: number;
      truncated: boolean;
      verdict: "clean" | "alert" | "partial";
      limits: string[];
    }
  | { ok: false; detail: string };

/** Ce que la réconciliation a déjà établi : dernier passage (bouton ou tâche), écritures vues. */
export interface ReconcileState {
  lastRun: {
    ranAt: string;
    trigger: "manual" | "auto";
    ok: boolean;
    verdict: "clean" | "alert" | "partial" | "failed";
    since: string;
    identity: string;
    scanned: number;
    viaOathrion: number;
    outsideCount: number;
    unknownCount: number;
    others: number;
    truncated: boolean;
    detail: string;
  } | null;
  findings: (ReconcileFinding & { category: "outside" | "unknown_marker" | "receipt_gap"; firstSeenAt: string })[];
}

export async function getReconcileState(id: string): Promise<ReconcileState> {
  return get<ReconcileState>(`/api/connectors/${id}/reconcile`);
}

/** « Qu'est-ce qui s'est passé chez ce service SANS Oathrion, depuis la connexion ? » */
export async function reconcileConnector(id: string): Promise<ReconcileReport> {
  const res = await apiRequestAllowingFailure("POST", `/api/connectors/${id}/reconcile`, {});
  const body = (await res.json()) as Record<string, unknown>;
  if (res.ok && body.ok === true) return body as unknown as ReconcileReport;
  const detail = typeof body.detail === "string" ? body.detail : typeof body.message === "string" ? body.message : `The server answered ${String(res.status)}.`;
  return { ok: false, detail };
}

export async function testConnector(
  id: string,
): Promise<{ ok: boolean; code: ConnectorProbeCode; detail: string; status: ConnectorStatus | null }> {
  return send<{ ok: boolean; code: ConnectorProbeCode; detail: string; status: ConnectorStatus | null }>(
    "POST",
    `/api/connectors/${id}/test`,
  );
}

export async function connectorCapabilities(
  id: string,
): Promise<{ connector: string; capabilities: ConnectorCapability[] }> {
  return get<{ connector: string; capabilities: ConnectorCapability[] }>(
    `/api/connectors/${id}/capabilities`,
  );
}

/**
 * Déconnecte. `remoteStillValid` dit si le jeton reste valide chez le fournisseur — pour
 * un jeton personnel GitHub, c'est toujours `true`, et l'écran doit le dire.
 */
export async function disconnectConnector(
  id: string,
): Promise<{ revoked: boolean; remoteStillValid: boolean; detail: string }> {
  return send<{ revoked: boolean; remoteStillValid: boolean; detail: string }>(
    "DELETE",
    `/api/connectors/${id}`,
  );
}

/* -------------------------------- Coverage -------------------------------- */

/**
 * Ce qui est RÉELLEMENT gouverné, tel que le serveur le compte.
 *
 * Aucun de ces nombres n'est calculé côté client : recomposer la couverture ici
 * dédoublerait les règles, et une des deux copies prendrait du retard. La console
 * affiche ce que le serveur a compté, y compris `caveat`.
 */
export interface CoverageReport {
  counts: {
    agents: number;
    policies: number;
    connectorsConnected: number;
    /** Les règles UTILISABLES par ce locataire, pas les règles déclarées. */
    interceptRules: number;
    /** Déclarées, mais dont la destination n'est pas ouverte à ce locataire. */
    interceptRulesUnavailable: number;
    executions: number;
    allowed: number;
    blocked: number;
    pendingApprovals: number;
    failed: number;
  };
  /** Les verbes qui atteindraient un outil, lus dans la table de routage. */
  governedActions: string[];
  connectors: { id: string; label: string; state: ConnectorState; actions: string[] }[];
  interceptRules: { id: string; method: string; path: string; destination: string; action: string }[];
  /**
   * Les règles du déploiement que CE locataire ne peut pas employer : leur destination
   * n'est pas dans sa portée, et la route d'interception les refuserait. Nommées plutôt
   * que cachées — sinon un exploitant cherche pourquoi la règle qu'il vient d'écrire
   * n'apparaît nulle part.
   */
  interceptRulesUnavailable: { id: string; destination: string }[];
  /** Ce qui empêche une première action gouvernée, dans l'ordre où s'en occuper. */
  blocking: { step: string; why: string; where: string }[];
  /** La limite que cet écran ne doit pas pouvoir perdre. Affichée telle quelle. */
  caveat: string;
}

export async function getCoverage(): Promise<CoverageReport> {
  return get<CoverageReport>("/api/coverage");
}

/* ------------------------------- Démarrage -------------------------------- */

/** Ce qu'un lien d'invitation propose, lu AVANT de l'accepter. */
export interface InvitationPreview {
  purpose: "invite" | "reset";
  organizationName: string;
  email: string;
  role: Role;
  expiresAt: string;
}

export async function inspectInvitation(token: string): Promise<InvitationPreview | null> {
  const res = await apiRequestAllowingFailure("POST", "/api/invitations/inspect", { token });
  if (!res.ok) return null;
  return (await res.json()) as InvitationPreview;
}

/** Accepte une invitation. Le message d'erreur du serveur est rendu tel quel. */
export async function acceptInvitation(
  token: string,
  name: string,
  password: string,
): Promise<{ ok: true; email: string } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", "/api/invitations/accept", { token, name, password });
  const body = (await res.json().catch(() => ({}))) as { email?: string; message?: string; error?: string };
  if (res.ok && body.email) return { ok: true, email: body.email };
  return { ok: false, message: body.message ?? body.error ?? "This invitation could not be accepted." };
}

/** Invite un membre. Le jeton n'est rendu qu'UNE fois : l'écran en fait un lien. */
export async function createInvitation(
  email: string,
  role: Role,
): Promise<{ ok: true; token: string } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", "/api/invitations", { email, role });
  const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string; error?: string };
  if (res.ok && body.token) return { ok: true, token: body.token };
  return { ok: false, message: body.message ?? body.error ?? `The server answered ${String(res.status)}.` };
}

/** Le lien d'invitation à remettre. Le jeton dans le fragment : jamais envoyé à un serveur. */
export function invitationLink(token: string): string {
  return `${window.location.origin}/console#/bienvenue?invitation=${encodeURIComponent(token)}`;
}

export async function startConnectorOAuth(id: string): Promise<{ ok: true; url: string } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", `/api/connectors/${id}/oauth/start`, {});
  const body = (await res.json().catch(() => ({}))) as { url?: string; message?: string };
  if (res.ok && body.url) return { ok: true, url: body.url };
  return { ok: false, message: body.message ?? `The server answered ${String(res.status)}.` };
}

export interface ConnectorResource {
  target: string;
  label: string;
  detail?: string;
}

export async function connectorResources(
  id: string,
): Promise<{ ok: true; resources: ConnectorResource[]; note?: string } | { ok: false; detail: string }> {
  const res = await apiRequestAllowingFailure("GET", `/api/connectors/${id}/resources`);
  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean;
    resources?: ConnectorResource[];
    note?: string;
    detail?: string;
    message?: string;
  };
  if (res.ok && body.resources) return { ok: true, resources: body.resources, note: body.note };
  return { ok: false, detail: body.detail ?? body.message ?? `The server answered ${String(res.status)}.` };
}

export type WriteMode = "approval" | "block" | "allow";

export interface ConnectorSelection {
  resources: string[] | null;
  writes: WriteMode | null;
}

export async function getSelection(id: string): Promise<ConnectorSelection> {
  return get<ConnectorSelection>(`/api/connectors/${id}/selection`);
}

export async function saveSelection(
  id: string,
  resources: string[],
  writes: WriteMode,
): Promise<{ ok: true; selection: ConnectorSelection } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("PUT", `/api/connectors/${id}/selection`, { resources, writes });
  const body = (await res.json().catch(() => ({}))) as { selection?: ConnectorSelection; message?: string };
  if (res.ok && body.selection) return { ok: true, selection: body.selection };
  return { ok: false, message: body.message ?? `The server answered ${String(res.status)}.` };
}

export interface ScenarioStep {
  key: "read" | "payments" | "task" | "issue" | "outside" | "notify";
  title: string;
  explanation: string;
  action: string;
  target: string;
  decision: "ALLOW" | "BLOCK" | "APPROVAL_REQUIRED";
  reason: string;
  policyName: string | null;
  executionId: string | null;
  approvalId: string | null;
  attempted: boolean;
  succeeded: boolean;
  url: string | null;
  /** La requête est partie sans réponse : l'action a PEUT-ÊTRE eu lieu. */
  effectUnknown?: boolean;
  summary: string | null;
}

export async function runScenario(agentId: string): Promise<{ ok: true; steps: ScenarioStep[] } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", "/api/scenario/run", { agentId });
  const body = (await res.json().catch(() => ({}))) as { steps?: ScenarioStep[]; message?: string };
  if (res.ok && body.steps) return { ok: true, steps: body.steps };
  return { ok: false, message: body.message ?? `The server answered ${String(res.status)}.` };
}

export async function notifyScenario(
  agentId: string,
  executionIds: string[],
): Promise<{ ok: true; step: ScenarioStep } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", "/api/scenario/notify", { agentId, executionIds });
  const body = (await res.json().catch(() => ({}))) as { step?: ScenarioStep; message?: string };
  if (res.ok && body.step) return { ok: true, step: body.step };
  return { ok: false, message: body.message ?? `The server answered ${String(res.status)}.` };
}

/** Approuve ou refuse une demande, et rend ce que l'outil a réellement fait. */
export async function resolveApproval(
  id: string,
  decision: "approve" | "reject",
): Promise<
  { ok: true; succeeded: boolean; effectUnknown: boolean; url: string | null; summary: string | null } | { ok: false; message: string }
> {
  const res = await apiRequestAllowingFailure("POST", `/api/approvals/${id}/${decision}`, {});
  const body = (await res.json().catch(() => ({}))) as {
    succeeded?: boolean;
    toolResult?: { url?: unknown; dispatched?: unknown } | null;
    execution?: { result?: unknown } | null;
    message?: string;
  };
  if (!res.ok) return { ok: false, message: body.message ?? `The server answered ${String(res.status)}.` };
  const url = typeof body.toolResult?.url === "string" ? body.toolResult.url : null;
  const summary = typeof body.execution?.result === "string" ? body.execution.result : null;
  return { ok: true, succeeded: body.succeeded === true, effectUnknown: body.toolResult?.dispatched === "unknown", url, summary };
}

/** Choisit un nouveau mot de passe à partir d'un lien de réinitialisation. */
export async function resetPassword(token: string, password: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", "/api/auth/password/reset", { token, password });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
  return { ok: false, message: body.message ?? body.error ?? "This link could not be used." };
}

/* ------------------------------ Serveurs (local) ------------------------------ */

/** Un serveur sous Oathrion, sur la machine de la personne (`oathrion wrap`). */
export interface LocalServer {
  name: string;
  server: { name?: string; version?: string };
  classes: { read: number; write: number; destructive: number };
  /** Les clients (agents) qui le portent en ce moment. */
  clients: string[];
  actions: number;
  lastAction: { at: string; tool: string; decision: string; agentName: string } | null;
}

/** Un serveur de Claude Code ou de Cursor qui ne passe PAS par Oathrion. */
export interface UnprotectedServer {
  client: string;
  where: string;
  name: string;
  /** `npx oathrion` sait le protéger ; sinon, un serveur distant dont le client gère la connexion (OAuth). */
  protectable: boolean;
}

/** « Décider une fois », depuis la console : ne plus demander pour l'outil de cette demande. */
export async function grantAlways(approvalId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  const res = await apiRequestAllowingFailure("POST", "/api/local/accords", { approvalId });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  return { ok: false, message: body.error ?? body.message ?? `The server answered ${String(res.status)}.` };
}

/** Une ligne de la chronologie unique (`server/local-activity.ts`). */
export type ActivityOutcome =
  | "done"
  | "failed"
  | "refused"
  | "waiting"
  | "asked-done"
  | "asked-failed"
  | "asked-not-run"
  | "approved-done"
  | "approved-failed"
  | "refused-by-person"
  | "approved-not-run"
  | "not-run"
  | "running";

export interface ActivityEntry {
  at: string;
  source: "oathrion" | "claude-code";
  agent: string;
  action: string;
  target: string;
  outcome: ActivityOutcome;
  detail: string | null;
  ref: string;
  /** Une suppression refusée : ce qu'elle aurait effacé. */
  impact?: string;
}

export interface LocalActivity {
  entries: ActivityEntry[];
  agents: string[];
  journal: { ok: boolean; entries: number; reason: string | null };
}

export async function getLocalActivity(agent?: string): Promise<LocalActivity> {
  return get<LocalActivity>(`/api/local/activity${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`);
}

/* ── Le mandat vérifiable (`server/routes-mandates.ts`) ─────────────────────────────── */

export interface MandateView {
  id: string;
  state: "pending" | "active" | "revoked" | "expired";
  signed: import("@shared/mandate").SignedMandate;
  signedBy: string[];
  required: number;
  createdBy: string;
  createdAt: string;
  revokedBy: string | null;
  revokedAt: string | null;
}

export interface CreateMandateInput {
  agent: { id: string; name: string; publicKey: string };
  grants: import("@shared/mandate").MandateGrant[];
  notBefore: string;
  notAfter: string;
  required: number;
  signers: { userId: string; role?: string }[];
}

export async function listMandates(): Promise<{ me: string; signingKey: string | null; mandates: MandateView[] }> {
  return get<{ me: string; signingKey: string | null; mandates: MandateView[] }>("/api/mandates");
}

export async function registerSigningKey(publicKey: string): Promise<{ signingKey: string }> {
  return send<{ signingKey: string }>("PUT", "/api/mandates/signing-key", { publicKey });
}

export async function createMandate(input: CreateMandateInput): Promise<MandateView> {
  return send<MandateView>("POST", "/api/mandates", input);
}

export async function signMandate(id: string, signature: string): Promise<MandateView> {
  return send<MandateView>("POST", `/api/mandates/${encodeURIComponent(id)}/sign`, { signature });
}

export interface MandateReceipts {
  receipts: { grant: import("@shared/mandate").SignedGrant; countersigned: import("@shared/mandate").Countersigned; seq: number; recordedAt: string }[];
  chain: { ok: boolean; entries: number; brokenAt: number | null; reason: string | null };
}

export async function getMandateReceipts(id: string): Promise<MandateReceipts> {
  return get<MandateReceipts>(`/api/mandates/${encodeURIComponent(id)}/receipts`);
}

export async function revokeMandate(id: string): Promise<MandateView> {
  return send<MandateView>("POST", `/api/mandates/${encodeURIComponent(id)}/revoke`, {});
}

/** `GET /api/local/summary` — le bilan, voir `server/local-summary.ts`. */
export interface ChainVerdict {
  ok: boolean;
  entries: number;
  reason: string | null;
}
export interface LocalSummary {
  period: "today" | "7d";
  since: string;
  until: string;
  total: number;
  passed: number;
  asked: number;
  refusedByPerson: number;
  waiting: number;
  blocked: number;
  saves: ActivityEntry[];
  agents: { agent: string; total: number }[];
  proof: { receipts: ChainVerdict; journal: ChainVerdict; intact: boolean };
}

export async function getLocalSummary(period: "today" | "7d"): Promise<LocalSummary> {
  return get<LocalSummary>(`/api/local/summary?period=${period}`);
}

/** Le reçu partageable d'une action : le fichier HTML signé, qui se vérifie lui-même. */
export async function getSharedReceipt(ref: string): Promise<string> {
  const res = await apiRequest("GET", `/api/local/receipts/${encodeURIComponent(ref)}/share`);
  return res.text();
}

/** `GET /api/local/protection` — voir `server/local-protection.ts`. */
export type Coverage = "protected" | "checked" | "bypasses" | "blind";
export interface ProtectionItem {
  what: string;
  kind: "mcp-server" | "built-in";
  coverage: Coverage;
  where: string | null;
  why: string;
  fix: string | null;
}
export interface LocalProtection {
  agents: { client: string; items: ProtectionItem[] }[];
  counts: Record<Coverage, number>;
}

export async function getLocalProtection(): Promise<LocalProtection> {
  return get<LocalProtection>("/api/local/protection");
}

export async function getLocalServers(): Promise<{ servers: LocalServer[]; unprotected: UnprotectedServer[] }> {
  return get<{ servers: LocalServer[]; unprotected: UnprotectedServer[] }>("/api/local/servers");
}
