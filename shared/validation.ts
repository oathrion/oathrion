/**
 * Write-path validation contracts.
 *
 * `POST /api/agents` and `POST /api/policies` used to accept whatever JSON the
 * caller sent — two `if (!body.id)` guards and straight into SQLite. These
 * schemas close that hole: every field of the domain model is described here,
 * unknown keys are rejected, and the parsed output is a fully-formed `Agent` /
 * `Policy`, not a partially-trusted blob.
 *
 * Pure Zod, no I/O — usable from the server routes and from the client forms.
 */

import { DEFAULT_CURRENCY, SUPPORTED_CURRENCIES, type CurrencyCode } from "./money";
import { z } from "zod";
import type { Agent, Policy } from "./types";

/* --------------------------------- Shared --------------------------------- */

const ID = z
  .string()
  .trim()
  .min(3, "id must be at least 3 characters")
  .max(64, "id must be at most 64 characters")
  .regex(/^[a-zA-Z0-9._-]+$/, "id may only contain letters, digits, dot, underscore and hyphen");

/**
 * The identifier grammar, exported so the authorization contract can apply the
 * SAME one rather than its own approximation.
 *
 * `shared/api/evaluate-contract.ts` previously validated `agentId` as any
 * non-empty string. Two spellings of "what is a valid agent id" in one codebase
 * is the kind of drift that ends with an id accepted at one door and refused at
 * the next, so there is deliberately one definition and this is it.
 */
export const agentIdSchema = ID;

const NAME = z.string().trim().min(3, "name must be at least 3 characters").max(120);
const DESCRIPTION = z.string().trim().max(600);
const TAG = z.string().trim().min(1).max(40);

const RISK = z.enum(["low", "medium", "high", "critical"]);
const today = () => new Date().toISOString().slice(0, 10);

/* --------------------------------- Agents --------------------------------- */

/**
 * Les portées accordables par l'API.
 *
 * ## UN ÉCART TROUVÉ EN BRANCHANT LE PREMIER CONNECTEUR RÉEL
 *
 * Cette liste avait DOUZE entrées quand `shared/types.ts` en déclarait quinze. Les trois
 * manquantes — `publish:content`, `execute:code`, `deploy:infrastructure` — ont été
 * ajoutées au type avec ce commentaire : « without these three entries no agent could
 * ever hold that scope, so those verbs would be permanently unreachable rather than
 * governed ». Le type a été étendu ; ce schéma-ci, qui est la barrière que traverse
 * réellement `POST /api/agents`, ne l'a pas été.
 *
 * Conséquence exacte : un exploitant ne POUVAIT PAS accorder `publish:content` par
 * l'API — la requête était refusée en 400. Les verbes `publish` et `post` du catalogue
 * étaient donc inatteignables par tout agent créé normalement, c'est-à-dire protégés par
 * accident et non gouvernés. Le commentaire de `shared/types.ts` affirmait le contraire.
 *
 * Les deux listes sont désormais tenues identiques par
 * `shared/permission-scope-parity.test.ts`, qui compare le type et ce schéma : un ajout
 * d'un seul côté fait échouer la suite.
 */
export const permissionScopeSchema = z.enum([
  "read:crm",
  "write:crm",
  "read:email",
  "send:email",
  "read:database",
  "write:database",
  "read:files",
  "write:files",
  "execute:payments",
  "call:external-api",
  "read:analytics",
  "manage:tickets",
  "publish:content",
  "execute:code",
  "deploy:infrastructure",
  "read:repository",
  "write:repository",
  "read:chat",
  "write:chat",
  "read:tasks",
  "write:tasks",
  "read:payments",
  /* `oathrion wrap` : les trois classes d'un outil de serveur MCP enveloppé (`stdio-mcp-tool.ts`). */
  "mcp:read",
  "mcp:write",
  "mcp:destructive",
]);

/*
 * Une liste de permissions en porte au plus une par portée connue. La borne était écrite à
 * la main (24) ; l'ajout des trois portées `mcp:*` a porté le catalogue à 25, et la console,
 * qui envoie le catalogue entier, ne pouvait plus enregistrer les permissions d'AUCUN agent
 * (« Invalid patch »). Trouvé le 28 octobre 2026, dans l'essai réel d'`oathrion wrap`.
 */
export const MAX_PERMISSIONS = permissionScopeSchema.options.length;

export const permissionSchema = z.strictObject({
  scope: permissionScopeSchema,
  label: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).default(""),
  granted: z.boolean(),
  risk: RISK,
});

/**
 * Derived from the currency registry, never written out again.
 *
 * This was `z.enum(["EUR", "USD"])` — a third hard-coded list beside the policy engine's
 * type union and the formatter's table. It is the one that faces the network, so it was
 * also the one that silently made XOF and XAF unusable: a franc-zone tenant could not
 * even POST a mandate in its own currency, whatever the engine supported.
 *
 * `z.enum` needs a non-empty tuple, which a `readonly` array is not, so the assertion
 * narrows the shape. It deliberately asserts to `CurrencyCode` rather than `string`: with
 * `string` the parsed output widens, and every policy condition built from it stops being
 * assignable to `PolicyCondition` — the compiler would have accepted the schema and
 * rejected every caller.
 */
export const currencySchema = z.enum(
  SUPPORTED_CURRENCIES as unknown as [CurrencyCode, ...CurrencyCode[]],
);

export const mandateSchema = z.strictObject({
  maxTransactionAmount: z.number().nonnegative().nullable(),
  /** Denomination of the ceiling. Defaults to the organisation currency. */
  currency: currencySchema.default(DEFAULT_CURRENCY),
  allowedCategories: z.array(z.string().trim().min(1).max(60)).max(50),
  blockedCategories: z.array(z.string().trim().min(1).max(60)).max(50),
  allowedDomains: z.array(z.string().trim().min(1).max(120)).max(50),
});

/** Full body contract for `POST /api/agents`. */
export const agentCreateSchema = z.strictObject({
  id: ID,
  name: NAME,
  description: DESCRIPTION,
  provider: z.enum(["openai", "anthropic", "google", "custom"]),
  model: z.string().trim().min(1).max(80),
  status: z.enum(["active", "paused", "draft", "review"]),
  owner: z.string().trim().min(1).max(120),
  mandate: mandateSchema,
  permissions: z.array(permissionSchema).max(MAX_PERMISSIONS),
  policyIds: z.array(ID).max(50),
  tags: z.array(TAG).max(20),

  // Derived / bookkeeping fields. Accepted, but never required from a caller.
  currentTask: z.string().trim().max(200).nullable().default(null),
  createdAt: z.string().trim().max(40).default(today),
  executions24h: z.number().int().nonnegative().default(0),
  successRate: z.number().min(0).max(100).default(0),
  cost24h: z.number().nonnegative().default(0),
  costMonth: z.number().nonnegative().default(0),
  riskLevel: RISK.default("low"),
});

export type AgentCreateInput = z.infer<typeof agentCreateSchema>;

/** Narrows a validated body to the domain model the repository expects. */
export function toAgent(input: AgentCreateInput): Agent {
  return input satisfies Agent;
}

/* -------------------------------- Policies -------------------------------- */

const targetList = z.array(z.string().trim().min(1).max(120)).min(1).max(50);
const actionList = z.array(z.string().trim().min(1).max(60)).max(50).default([]);

export const policyConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("amountAtMost"),
    field: z.string().trim().min(1).max(40).optional(),
    max: z.number().nonnegative(),
    currency: currencySchema.optional(),
    actions: actionList.optional(),
  }),
  z.strictObject({
    kind: z.literal("targetMatches"),
    targets: targetList,
    actions: actionList.optional(),
    /* Exceptions to a deny-side rule. See `PolicyCondition` in `shared/policy/types.ts`. */
    exceptTargets: targetList.optional(),
  }),
  z.strictObject({
    kind: z.literal("dailySpendAtMost"),
    field: z.string().trim().min(1).max(40).optional(),
    max: z.number().nonnegative(),
    currency: currencySchema.optional(),
  }),
]);

/** Full body contract for `POST /api/policies`. */
export const policyCreateSchema = z.strictObject({
  id: ID,
  name: NAME,
  description: DESCRIPTION,
  type: z.enum([
    "MAX_TRANSACTION_AMOUNT",
    "REQUIRE_HUMAN_APPROVAL",
    "BLOCK_TOOL",
    "ALLOW_TOOL",
    "MAX_DAILY_SPEND",
  ]),
  condition: policyConditionSchema,
  scope: z.enum(["organization", "agent", "integration"]),
  appliesTo: z.string().trim().min(1).max(120),
  effect: z.enum(["block", "require_approval", "warn"]),
  status: z.enum(["enabled", "disabled", "draft"]),
  action: z.enum(["ALLOW", "BLOCK", "APPROVAL_REQUIRED"]),
  risk: RISK,
  priority: z.number().int().min(0).max(100),

  // Display + bookkeeping fields with sane defaults.
  rule: z.string().trim().max(240).default(""),
  appliesToAgentIds: z.array(ID).max(200).nullable().default(null),
  triggeredCount: z.number().int().nonnegative().default(0),
  updatedAt: z.string().trim().max(40).default(today),
});

/**
 * A policy's `type` selects the rule evaluator; its `condition` supplies that
 * evaluator's parameters. The two must agree, and until now nothing checked it.
 *
 * WHAT WAS BROKEN
 * ---------------
 * `POST /api/policies` accepted any of the 5 types with any of the 3 condition kinds
 * — 15 combinations, of which only 5 can ever fire. The other 10 were created with a
 * 201, listed in the console as `status: "enabled"`, counted in "policies enabled" on
 * the dashboard, and evaluated as `null` by their rule evaluator on every single
 * decision, because each evaluator begins by checking the condition kind it needs and
 * returns `null` when it is absent.
 *
 * A customer writing "payments above EUR 100 need a human" as
 * `REQUIRE_HUMAN_APPROVAL` + `amountAtMost` — the natural reading of the two field
 * names — got a policy that governs nothing, with no error and no warning anywhere.
 * That is §15 exactly: a feature that is displayed as available and does not work.
 *
 * The fix is at the contract boundary, not in the engine: the engine's `null` is
 * correct (an evaluator cannot apply a condition it cannot read). What was wrong was
 * accepting the combination in the first place, so it is now a 400 that names the
 * condition the chosen type requires.
 */
const CONDITION_FOR_TYPE = {
  MAX_TRANSACTION_AMOUNT: "amountAtMost",
  REQUIRE_HUMAN_APPROVAL: "targetMatches",
  BLOCK_TOOL: "targetMatches",
  ALLOW_TOOL: "targetMatches",
  MAX_DAILY_SPEND: "dailySpendAtMost",
} as const satisfies Record<PolicyCreateShape["type"], PolicyCreateShape["condition"]["kind"]>;

type PolicyCreateShape = z.infer<typeof policyCreateSchema>;

/** Human-readable hint per type, so the 400 tells the operator what to write instead. */
const CONDITION_HINT: Record<keyof typeof CONDITION_FOR_TYPE, string> = {
  MAX_TRANSACTION_AMOUNT: 'condition: { kind: "amountAtMost", max: <number> }',
  REQUIRE_HUMAN_APPROVAL: 'condition: { kind: "targetMatches", targets: [...] }',
  BLOCK_TOOL: 'condition: { kind: "targetMatches", targets: [...] }',
  ALLOW_TOOL: 'condition: { kind: "targetMatches", targets: [...] }',
  MAX_DAILY_SPEND: 'condition: { kind: "dailySpendAtMost", max: <number> }',
};

/**
 * The schema routes use. Same fields as `policyCreateSchema`, plus the pairing check.
 * Kept as a separate export so the raw shape stays available to the seed data and to
 * the tests that build a policy object directly.
 */
export const policyCreateContract = policyCreateSchema.superRefine((policy, ctx) => {
  /*
   * An exception only means something on a rule that denies or holds. On ALLOW_TOOL it
   * would read as "allow X except Y" — and ALLOW never overrides anything, so Y would be
   * neither allowed nor blocked by it. Refused rather than silently ignored.
   */
  if (policy.type === "ALLOW_TOOL" && policy.condition.kind === "targetMatches" && policy.condition.exceptTargets) {
    ctx.addIssue({
      code: "custom",
      path: ["condition", "exceptTargets"],
      message: "exceptTargets only applies to BLOCK_TOOL and REQUIRE_HUMAN_APPROVAL.",
    });
    return;
  }
  const required = CONDITION_FOR_TYPE[policy.type];
  if (policy.condition.kind === required) return;
  ctx.addIssue({
    code: "custom",
    path: ["condition", "kind"],
    message:
      `a ${policy.type} policy is evaluated against a "${required}" condition, but this one ` +
      `carries "${policy.condition.kind}". As written the policy would be stored as enabled ` +
      `and never apply to any action. Use ${CONDITION_HINT[policy.type]}.`,
  });
});

export type PolicyCreateInput = z.infer<typeof policyCreateSchema>;

export function toPolicy(input: PolicyCreateInput): Policy {
  return input satisfies Policy;
}

/* -------------------------------- Reporting ------------------------------- */

/** Renders the first Zod issue as a single readable, path-qualified message. */
export function firstIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "Invalid body";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
