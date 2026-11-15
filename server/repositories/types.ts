/**
 * Persistence contracts.
 *
 * The Policy Engine and the decision service depend on these interfaces only —
 * never on Drizzle, SQLite or any concrete driver. Swapping the SQLite
 * implementation for PostgreSQL means writing new classes here and nothing else.
 */

import type {
  Agent,
  Approval,
  ApprovalStatus,
  AuditEntry,
  Execution,
  Integration,
  Policy,
} from "@shared/types";

export interface AgentRepository {
  list(): Promise<Agent[]>;
  findById(id: string): Promise<Agent | undefined>;
  create(agent: Agent): Promise<Agent>;
  update(id: string, patch: Partial<Agent>): Promise<Agent | undefined>;
}

export interface PolicyRepository {
  list(): Promise<Policy[]>;
  findById(id: string): Promise<Policy | undefined>;
  create(policy: Policy): Promise<Policy>;
  update(id: string, patch: Partial<Policy>): Promise<Policy | undefined>;
  incrementTriggered(id: string): Promise<void>;
}

/**
 * Les comptages d'exécutions, AGRÉGÉS PAR LA BASE.
 *
 * Ce type existe à cause d'un défaut précis de `GET /api/coverage` : il appelait
 * `list(500)` puis comptait les éléments du tableau rendu. Tous les nombres étaient donc
 * plafonnés à 500 — et silencieusement. Un exploitant avec dix mille exécutions lisait
 * « 500 exécutions, 480 autorisées » : des nombres qui ont l'air précis et qui sont faux,
 * sur l'écran dont il se sert pour décider s'il peut passer en pilote.
 *
 * Un `GROUP BY` rend la vérité pour le coût d'une seule requête, et il la rend quelle que
 * soit la taille de la table.
 */
export interface ExecutionStatusCounts {
  total: number;
  allowed: number;
  blocked: number;
  pending: number;
  failed: number;
}

export interface ExecutionRepository {
  list(limit?: number): Promise<Execution[]>;
  /** Comptages par statut, dans la portée du locataire. Agrégés en base, non tronqués. */
  statusCounts(): Promise<ExecutionStatusCounts>;
  /**
   * Les exécutions dont l'action commence par `prefix` (`mcp.<serveur>.`) : combien, agrégé
   * en base et non tronqué, et la plus récente. Comparaison exacte du début, sans `LIKE` :
   * un `_` dans un nom de serveur n'est pas un joker.
   */
  actionActivity(prefix: string): Promise<{ count: number; latest: Execution | undefined }>;
  findById(id: string): Promise<Execution | undefined>;
  create(execution: Execution): Promise<Execution>;
  update(id: string, patch: Partial<Execution>): Promise<Execution | undefined>;
  /** Sum of `cost` for one agent since the given ISO timestamp. */
  dailySpend(agentId: string, since: string): Promise<number>;
  /**
   * Atomically reserve the single tool invocation allowed for this execution.
   * Returns true for the first caller only — this is the idempotence guard that
   * stops a double-approve from charging a purchase twice.
   */
  /**
   * Append to the audit trail atomically, reading the base list from storage
   * rather than from the caller's snapshot. Appending via `update` loses entries
   * under concurrency; see the implementation for why.
   */
  appendAudit(id: string, entries: AuditEntry[]): Promise<Execution | undefined>;

  /**
   * Take the run lock. `maxAttempts` bounds how many times this execution's tool
   * may EVER be invoked; it defaults to `MAX_TOOL_ATTEMPTS` rather than to
   * unbounded, so an implementation or caller that omits it inherits the ceiling
   * instead of losing it.
   */
  claimToolRun(
    id: string,
    toolId: string,
    at: string,
    staleBefore?: string,
    maxAttempts?: number,
  ): Promise<boolean>;
  /**
   * Close a claimed run. Returns false when the row was not `running`, which
   * means another worker already finished it.
   */
  completeToolRun(
    id: string,
    outcome:
      | { ok: true; at: string; result: Record<string, unknown> | null }
      | { ok: false; at: string; error: string },
  ): Promise<boolean>;
  /**
   * Clôt un run réclamé **en une seule transaction** : l'état terminal, les entrées
   * d'audit chaînées, et les colonnes scalaires.
   *
   * ## Pourquoi cette méthode existe
   *
   * La passerelle faisait trois appels à la suite — `completeToolRun`, `appendAudit`,
   * puis `update` — et les trois décrivent LE MÊME événement : l'outil a tourné. Trois
   * appels, c'est trois allers-retours de base et trois validations durables là où un
   * seul suffit. Mesuré sur la voie du pare-feu : **9,5 ms des 37,8 ms de surcoût**.
   *
   * Le découpage n'était pas arbitraire, il payait un ordre : l'état terminal d'abord,
   * pour que la ligne soit `failed` — donc rejouable — même si l'écriture d'audit
   * suivante n'arrivait jamais. **L'atomicité rend cet ordre inutile** : ou les trois
   * atterrissent, ou aucune. Un processus qui meurt au milieu laisse la réclamation
   * périmée, et la reprise par ancienneté (`staleBefore`) la récupère — exactement le
   * mécanisme qui existait déjà pour une réclamation abandonnée.
   *
   * ## Ce qui ne change pas
   *
   * `run_state = 'running'` reste dans la clause de sélection, et c'est elle qui décide :
   * `undefined` signifie « cette ligne n'était pas à nous », donc la propriété
   * exactement-une-fois est portée par la même condition qu'avant.
   *
   * La chaîne d'audit est calculée **depuis la trace STOCKÉE, à l'intérieur du verrou**,
   * jamais depuis l'instantané de l'appelant. C'était déjà la propriété de
   * `appendAudit` ; la fusionner ici ne l'affaiblit pas, elle la met dans la même
   * transaction que l'état qu'elle décrit.
   */
  settleToolRun(
    id: string,
    outcome:
      | { ok: true; at: string; result: Record<string, unknown> | null }
      | { ok: false; at: string; error: string },
    entries: AuditEntry[],
    patch: Partial<Execution>,
  ): Promise<Execution | undefined>;
  /** Terminal state for an execution that will never reach a tool. */
  markSkipped(id: string, reason: string): Promise<void>;
}

export interface ApprovalRepository {
  /**
   * Newest-first, with **every pending approval always included** and only the
   * resolved history capped at `resolvedLimit`.
   *
   * The asymmetry is deliberate and load-bearing. `script/pilot-sim.ts` measured
   * this response at 2.1 MB / 5 760 rows on ninety days of one company's traffic,
   * so an unbounded list was not sustainable. But a plain "newest N" cap could not
   * be used either: `client/src/components/layout/Sidebar.tsx` and
   * `shared/metrics.ts` both derive the pending count by filtering this array, so
   * dropping a pending row makes the console display a number that is wrong with
   * nothing to indicate it. Pending is bounded by how fast humans work and is the
   * only part anything counts; resolved history is the part that grows without
   * bound and that nobody counts. See `server/test/approval-list-scale.test.ts`.
   */
  list(resolvedLimit?: number): Promise<Approval[]>;
  findById(id: string): Promise<Approval | undefined>;
  /** The approval that gated `executionId`, newest first, or undefined if none did. */
  findByExecutionId(executionId: string): Promise<Approval | undefined>;
  /**
   * The gating deadline for many executions at once: execution id → the newest
   * approval's `expiresAt` (which may itself be `null`).
   *
   * Exists to keep `GET /api/executions` at two queries instead of 301. That
   * endpoint returns up to 300 rows and each one now carries a `retry` block
   * whose answer can depend on whether the approval that released it has
   * lapsed; calling `findByExecutionId` per row would have made a list read
   * scale with its own page size.
   *
   * An execution with no approval is ABSENT from the map rather than present
   * with `null`, because those are different facts — "never gated" versus
   * "gated by an approval with no deadline" — and the second is treated as
   * expired by `isExpired`. Collapsing them would make an ungated execution
   * un-retryable.
   */
  findGatingExpiries(executionIds: string[]): Promise<Map<string, string | null>>;
  create(approval: Approval): Promise<Approval>;
  /**
   * Resolves a pending approval atomically.
   *
   * `claimed` reports whether *this* call performed the write. Two concurrent
   * approvals both find the row pending, but only one conditional UPDATE can
   * match, so only one caller gets `claimed: true` — the other must not append
   * a second audit entry, emit a second notification, or dispatch again.
   *
   * The same statement also refuses an approval whose deadline has passed, so an
   * expired request cannot release its action however it is reached. `claimed`
   * is `false` in that case, exactly as for a lost race — callers must therefore
   * consult the returned `status` to tell "somebody else won" from "too late",
   * and `server/services/decision-service.ts` does.
   */
  resolve(
    id: string,
    status: Exclude<ApprovalStatus, "pending" | "expired">,
    resolvedBy: string,
    now?: string,
  ): Promise<{ approval: Approval; claimed: boolean } | undefined>;

  /**
   * Move one pending request to `expired`, only if its deadline has actually
   * passed. `claimed` reports whether this call performed the transition.
   */
  expire(id: string, now?: string): Promise<{ approval: Approval; claimed: boolean } | undefined>;

  /** Expire every pending request of this tenant that is past its deadline; returns the ids transitioned. */
  expirePending(now?: string): Promise<string[]>;
}

export interface IntegrationRepository {
  list(): Promise<Integration[]>;
  toggle(id: string): Promise<Integration | undefined>;
}

export interface Repositories {
  /**
   * Writes an Execution and its Approval inside a single transaction.
   * Neither row can survive on its own if the other insert fails.
   */
  createExecutionWithApproval(
    execution: Execution,
    approval: Approval | null,
  ): Promise<{ execution: Execution; approval: Approval | null }>;
  /**
   * Reads this agent's rolling daily spend and persists the resulting
   * Execution (+ Approval) as one atomic unit.
   *
   * `build` is invoked *from inside* the transaction with the freshly-read
   * total — never with a value read before the transaction started. Two
   * concurrent decisions for the same agent can no longer both observe the
   * total as it stood before either one wrote: the database serialises the
   * two transactions, so the second caller's `build` sees the first
   * caller's spend already included.
   *
   * `since` is `null` when no rule reads the daily spend: the sum is skipped and
   * `build` receives 0.
   */
  decideAndPersist(
    agentId: string,
    since: string | null,
    build: (dailySpend: number) => { execution: Execution; approval: Approval | null },
  ): Promise<{ execution: Execution; approval: Approval | null }>;
  /**
   * Cheap liveness probe for the underlying store, for `/api/health`.
   *
   * Returns `false` instead of throwing: a health check that raises turns a
   * degraded dependency into a 500 with a stack trace, when the whole point is to
   * report the degradation calmly. The concrete implementation logs the real error
   * server-side and never returns it, because it carries the database path.
   */
  ping(): Promise<boolean>;
  agents: AgentRepository;
  policies: PolicyRepository;
  executions: ExecutionRepository;
  approvals: ApprovalRepository;
  integrations: IntegrationRepository;
}
