import type { AgentMandate } from "./policy/mandate";

/**
 * Oathrion domain model.
 * Single source of truth shared by mock data, UI components and (later) the API layer.
 */

import type { PolicyAction, PolicyCondition, PolicyType } from "./policy/types";

export type { PolicyAction, PolicyCondition, PolicyType };

export type ProviderId = "openai" | "anthropic" | "google" | "custom";

export type AgentStatus = "active" | "paused" | "draft" | "review";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export type PermissionScope =
  | "read:crm"
  | "write:crm"
  | "read:email"
  | "send:email"
  | "read:database"
  | "write:database"
  | "read:files"
  | "write:files"
  | "execute:payments"
  | "call:external-api"
  | "read:analytics"
  | "manage:tickets"
  /*
   * Added alongside `shared/policy/actions.ts`. The catalog declares `publish`,
   * `post`, `execute` and `deploy` as dangerous verbs requiring a scope; without
   * these three entries no agent could ever hold that scope, so those verbs
   * would be permanently unreachable rather than governed. They are opt-in like
   * every other scope and default to not granted.
   */
  | "publish:content"
  | "execute:code"
  | "deploy:infrastructure"
  /*
   * Les deux portées des connecteurs d'hébergement de code. Séparées en lecture et
   * écriture parce que le cas d'usage le plus fréquent — un agent qui lit une issue pour
   * la résumer — ne doit pas emporter le droit d'en ouvrir une.
   */
  | "read:repository"
  | "write:repository"
  /*
   * Messagerie d'équipe (Slack) et suivi de tâches (Linear). Lecture et écriture
   * séparées pour la même raison que le dépôt : un agent qui résume un canal ne doit
   * pas emporter le droit d'y publier.
   */
  | "read:chat"
  | "write:chat"
  | "read:tasks"
  | "write:tasks"
  /*
   * Lire les paiements et les clients d'un compte Stripe. L'écriture qui correspond — un
   * remboursement — reste sous `execute:payments`, comme tout mouvement d'argent : lire un
   * paiement pour répondre à un client ne doit pas emporter le droit de le rembourser.
   */
  | "read:payments"
  /*
   * `oathrion wrap` : les outils d'un serveur MCP enveloppé, par classe
   * (`server/gateway/tools/stdio-mcp-tool.ts`). `mcp:destructive` n'est accordé à aucun
   * agent par défaut : c'est ce qui bloque une destruction sans règle à écrire.
   */
  | "mcp:read"
  | "mcp:write"
  | "mcp:destructive";

export interface Permission {
  scope: PermissionScope;
  label: string;
  description: string;
  granted: boolean;
  risk: RiskLevel;
}

/** Re-exported so the product model has a single import surface. */
export type { AgentMandate };

export interface Agent {
  id: string;
  name: string;
  description: string;
  provider: ProviderId;
  model: string;
  status: AgentStatus;
  currentTask: string | null;
  owner: string;
  createdAt: string;
  executions24h: number;
  successRate: number;
  cost24h: number;
  costMonth: number;
  riskLevel: RiskLevel;
  permissions: Permission[];
  /** What the agent may do on its own authority, before org policies apply. */
  mandate: AgentMandate;
  policyIds: string[];
  tags: string[];
}

export type ExecutionStatus = "allowed" | "blocked" | "pending" | "failed";

/**
 * Lifecycle of the *tool run* attached to an execution — deliberately separate
 * from `status`, which describes the policy verdict.
 *
 *   pending   → cleared (or not yet cleared) and never dispatched
 *   running   → claimed by a worker, tool call in flight
 *   succeeded → the tool returned; terminal
 *   failed    → the tool threw; retryable
 *   skipped   → will never dispatch (blocked, rejected, or no tool registered)
 *
 * A `running` row whose claim is older than the staleness window is considered
 * abandoned (server crash) and may be reclaimed exactly once by a new worker.
 */
export type RunState = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type DecisionOutcome = "allow" | "block" | "require_approval";

export interface AuditEntry {
  at: string;
  actor: string;
  event: string;
  detail?: string;
  /**
   * Hash of the preceding entry in this execution's trail; the genesis hash, derived
   * from (organization, execution), for the first one. Set by the repository inside the
   * append transaction — never by a caller, or continuity could be forged.
   */
  prevHash?: string;
  /** `sha256(prevHash | at | actor | event | detail)`. See `server/audit-chain.ts`. */
  hash?: string;
}

export interface Execution {
  id: string;
  agentId: string;
  agentName: string;
  action: string;
  target: string;
  status: ExecutionStatus;
  risk: RiskLevel;
  durationMs: number;
  cost: number;
  timestamp: string;
  input: Record<string, string | number>;
  decision: DecisionOutcome;
  decisionReason: string;
  policyEvaluated: string | null;
  policyId: string | null;
  result: string;
  audit: AuditEntry[];
  /** Set when the decision was APPROVAL_REQUIRED. */
  approvalId?: string | null;
  /** Tool the Gateway dispatched to, once the action cleared policy. */
  toolId?: string | null;
  /** ISO timestamp of the single tool invocation. Doubles as the idempotence flag. */
  toolExecutedAt?: string | null;
  /** Payload returned by the tool. */
  toolResult?: Record<string, unknown> | null;
  /** Tool-run lifecycle. Defaults to `pending` for rows written before it existed. */
  runState?: RunState;
  /** How many times a worker has claimed this execution. */
  attempts?: number;
  /** Message of the last failed tool call, kept for the retry UI and the audit. */
  lastError?: string | null;
  /** When the current (or last) claim was taken. Drives stale-claim recovery. */
  toolStartedAt?: string | null;
}

export type PolicyStatus = "enabled" | "disabled" | "draft";

export type PolicyScope = "organization" | "agent" | "integration";

export type PolicyEffect = "block" | "require_approval" | "warn";

export interface Policy {
  id: string;
  name: string;
  description: string;
  /** Human-readable summary of the rule, shown in the UI. */
  rule: string;
  scope: PolicyScope;
  appliesTo: string;
  effect: PolicyEffect;
  status: PolicyStatus;
  triggeredCount: number;
  updatedAt: string;

  /* ---- Executable definition consumed by the Policy Engine. ---------------
   * Optional: advisory policies (effect `warn`) carry no machine-evaluable
   * condition and are ignored by `evaluateAction`. */
  type?: PolicyType;
  condition?: PolicyCondition;
  action?: PolicyAction;
  /** `null` / omitted = applies to every agent in the organization. */
  appliesToAgentIds?: string[] | null;
  risk?: RiskLevel;
  /** Higher wins when two policies reach the same decision. */
  priority?: number;
}

/**
 * `expired` is terminal and is reached without a human: the request outlived its
 * window (see `shared/approvals/ttl.ts`) and can no longer release its action.
 * It is deliberately a distinct value rather than a reuse of `rejected`, because
 * the audit trail must not claim a person refused something nobody looked at.
 */
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface Approval {
  id: string;
  /** Execution that triggered this approval. Null for legacy/seeded records. */
  executionId?: string | null;
  agentId: string;
  agentName: string;
  title: string;
  summary: string;
  requestedValue: string;
  policyId: string;
  policyName: string;
  policyLimit: string;
  risk: RiskLevel;
  status: ApprovalStatus;
  requestedAt: string;
  /**
   * Instant this request stops being releasable.
   *
   * Optional on the domain object only so that a caller constructing an approval
   * need not compute it; the repository stamps one on write when it is absent,
   * so a stored row always carries a deadline. Absent or unreadable at the point
   * of decision is treated as **expired**, never as "no deadline".
   */
  expiresAt?: string | null;
  resolvedBy?: string;
  /** When the request reached a terminal state — by a human, or by expiry. */
  resolvedAt?: string | null;
  context: { label: string; value: string }[];
}

export type IntegrationCategory = "model-provider" | "workspace" | "business";

export interface Integration {
  id: string;
  name: string;
  category: IntegrationCategory;
  description: string;
  connected: boolean;
  scopes: string[];
  connectedAt?: string;
  agentsUsing: number;
}


export interface ActivityEvent {
  id: string;
  actor: string;
  message: string;
  kind: "success" | "pending" | "blocked" | "info";
  at: string;
}

export interface KpiPoint {
  label: string;
  value: number;
}

export interface TimeSeriesPoint {
  label: string;
  allowed: number;
  blocked: number;
  pending: number;
}

/*
 * `ApiKey` used to be declared here, shaped for the fabricated demo rows: a `lastUsed`
 * of `"2 min ago"` and a `scope` of `"read" | "write" | "admin"` that corresponded to no
 * role in the product. Removed in P0-5 — the real shape is `PublicApiKey` in
 * `server/repositories/api-keys.ts`, mirrored by `ApiKeySummary` on the client. Noted
 * rather than deleted silently, because the two types looked interchangeable and were not.
 */
