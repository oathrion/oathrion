/**
 * Deterministic constraint language (Phase 10, §10).
 *
 * WHY IT IS THIS SMALL
 * --------------------
 * A policy is evidence. It has to produce the same verdict for the same action
 * on every instance, in every process, a year later, and an auditor has to be
 * able to read it. That rules out the two designs everyone reaches for first:
 * an embedded expression language (`eval`, `new Function`, a JS/Python snippet),
 * and a rules engine with user-supplied code. Both make the verdict depend on a
 * runtime rather than on the rule, and both turn the policy store into a remote
 * code execution surface — in the one component whose entire job is to stop an
 * agent from doing something it should not.
 *
 * So: eight comparison operators over one field path, plus two string checks. No
 * arithmetic, no function calls, no regular expressions supplied by the user
 * (`matches` accepts a bounded glob, not a regex, because a user-supplied regex
 * is a denial-of-service primitive).
 *
 * EVERY CONSTRAINT MUST HOLD
 * --------------------------
 * A rule's constraint list is an AND. There is no OR, and that is a deliberate
 * refusal rather than an omission: OR inside a rule makes the reason a decision
 * was reached ambiguous ("which branch matched?"), and the same expressiveness is
 * available by writing two rules — which are individually auditable and
 * individually reportable.
 *
 * MISSING FIELDS FAIL THE CONSTRAINT
 * ----------------------------------
 * A constraint on an absent field is NOT satisfied, ever, including for `neq` and
 * `not_in`. This is the fail-closed direction: if `amount` is missing, "amount <=
 * 100" is not something we know to be true, and treating an unknown as a pass is
 * how an argument omitted from a request becomes a way past a ceiling.
 */

export const CONSTRAINT_OPERATORS = [
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  "not_in",
  "len_lte",
  "matches",
] as const;

export type ConstraintOperator = (typeof CONSTRAINT_OPERATORS)[number];

/** A comparison value. Same primitive set the canonical form admits. */
export type ConstraintLiteral = string | number | boolean | null;

export interface ActionConstraint {
  /**
   * Dotted path into the canonical action. `amount`, `arguments.amount` and
   * `customer.id` all work; `action` and `destination_id` address the envelope's
   * own fields so a rule can pin them.
   */
  field: string;
  op: ConstraintOperator;
  value: ConstraintLiteral | ConstraintLiteral[];
}

export interface ConstraintSubject {
  action: string;
  destinationId: string;
  agentId: string;
  arguments: Record<string, unknown>;
}

export interface ConstraintOutcome {
  satisfied: boolean;
  /** The first failing constraint, rendered for the audit trail. */
  failed: string | null;
}

export class ConstraintError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConstraintError";
  }
}

const MISSING = Symbol("missing");

/** Envelope fields addressable directly, so a rule can pin the verb or destination. */
function envelopeField(subject: ConstraintSubject, field: string): unknown | typeof MISSING {
  if (field === "action") return subject.action;
  if (field === "destination_id" || field === "destinationId") return subject.destinationId;
  if (field === "agent_id" || field === "agentId") return subject.agentId;
  return MISSING;
}

/** Resolves a dotted path, returning MISSING rather than undefined. */
export function readField(subject: ConstraintSubject, field: string): unknown | typeof MISSING {
  const direct = envelopeField(subject, field);
  if (direct !== MISSING) return direct;

  const path = field.startsWith("arguments.") ? field.slice("arguments.".length) : field;
  let cursor: unknown = subject.arguments;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) return MISSING;
    if (!Object.prototype.hasOwnProperty.call(cursor, segment)) return MISSING;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function isLiteral(value: unknown): value is ConstraintLiteral {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Ordered comparison, and it refuses to compare across types.
 *
 * `"200" > 100` is `true` in JavaScript and it is the single most dangerous
 * coercion that could exist in this file: a caller sending an amount as a string
 * would be compared as a string, so `"1000" <= "750"` (lexicographic) passes a
 * ceiling of 750. Types must match, or the constraint fails closed.
 */
function ordered(
  op: "lt" | "lte" | "gt" | "gte",
  actual: unknown,
  expected: ConstraintLiteral,
): boolean {
  if (typeof actual !== "number" || typeof expected !== "number") return false;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  switch (op) {
    case "lt":
      return actual < expected;
    case "lte":
      return actual <= expected;
    case "gt":
      return actual > expected;
    case "gte":
      return actual >= expected;
  }
}

/** Strict equality with no coercion. `1` is not `"1"`. */
function equals(actual: unknown, expected: ConstraintLiteral): boolean {
  return actual === expected;
}

/**
 * Bounded glob: `*` matches any run of characters, everything else is literal.
 *
 * Not a regular expression, on purpose. A user-supplied regex in a policy store
 * is a catastrophic-backtracking denial of service against the authorization
 * path itself, and the authorization path is the one component that must answer
 * under load.
 */
function globMatches(actual: unknown, pattern: ConstraintLiteral): boolean {
  if (typeof actual !== "string" || typeof pattern !== "string") return false;
  if (pattern.length > 200) return false;
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, (ch) => (ch === "*" ? "\u0000" : `\\${ch}`));
  const expression = new RegExp(`^${escaped.split("\u0000").join(".*")}$`, "u");
  return expression.test(actual);
}

function render(constraint: ActionConstraint): string {
  const value = Array.isArray(constraint.value)
    ? `[${constraint.value.map((item) => JSON.stringify(item)).join(", ")}]`
    : JSON.stringify(constraint.value);
  return `${constraint.field} ${constraint.op} ${value}`;
}

/** Validates one constraint's shape. Called when a rule is stored AND when it is read. */
export function assertConstraint(constraint: unknown): ActionConstraint {
  if (typeof constraint !== "object" || constraint === null) {
    throw new ConstraintError("A constraint must be an object.");
  }
  const record = constraint as Record<string, unknown>;
  if (typeof record.field !== "string" || record.field.length === 0 || record.field.length > 120) {
    throw new ConstraintError("A constraint needs a non-empty `field` path of at most 120 characters.");
  }
  if (!/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/.test(record.field)) {
    throw new ConstraintError(
      `"${record.field}" is not a valid field path. Use dotted identifiers, e.g. "amount" or "customer.id".`,
    );
  }
  if (!CONSTRAINT_OPERATORS.includes(record.op as ConstraintOperator)) {
    throw new ConstraintError(
      `"${String(record.op)}" is not a supported operator. Supported: ${CONSTRAINT_OPERATORS.join(", ")}.`,
    );
  }
  const op = record.op as ConstraintOperator;
  const value = record.value;
  if (op === "in" || op === "not_in") {
    if (!Array.isArray(value) || value.length === 0 || value.length > 200) {
      throw new ConstraintError(`"${op}" needs a non-empty array of at most 200 literals.`);
    }
    for (const item of value) {
      if (!isLiteral(item)) throw new ConstraintError(`"${op}" accepts only primitive literals.`);
    }
  } else if (!isLiteral(value)) {
    throw new ConstraintError(`"${op}" accepts only a primitive literal.`);
  }
  if (op === "len_lte" && typeof value !== "number") {
    throw new ConstraintError('"len_lte" needs a numeric maximum length.');
  }
  return { field: record.field, op, value: value as ActionConstraint["value"] };
}

export function parseConstraints(raw: unknown): ActionConstraint[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw)) throw new ConstraintError("`constraints` must be an array.");
  if (raw.length > 50) throw new ConstraintError("A rule may carry at most 50 constraints.");
  return raw.map(assertConstraint);
}

/** Evaluates one constraint. Deterministic, total, side-effect free. */
export function evaluateConstraint(subject: ConstraintSubject, constraint: ActionConstraint): boolean {
  const actual = readField(subject, constraint.field);
  // Fail-closed on an absent field, for EVERY operator including the negative
  // ones. See the module header.
  if (actual === MISSING) return false;

  switch (constraint.op) {
    case "eq":
      return equals(actual, constraint.value as ConstraintLiteral);
    case "neq":
      return !equals(actual, constraint.value as ConstraintLiteral);
    case "lt":
    case "lte":
    case "gt":
    case "gte":
      return ordered(constraint.op, actual, constraint.value as ConstraintLiteral);
    case "in":
      return (constraint.value as ConstraintLiteral[]).some((item) => equals(actual, item));
    case "not_in":
      return (
        isLiteral(actual) && !(constraint.value as ConstraintLiteral[]).some((item) => equals(actual, item))
      );
    case "len_lte":
      return typeof actual === "string" && actual.length <= (constraint.value as number);
    case "matches":
      return globMatches(actual, constraint.value as ConstraintLiteral);
  }
}

/** Every constraint must hold. Reports the first failure for the audit trail. */
export function evaluateConstraints(
  subject: ConstraintSubject,
  constraints: readonly ActionConstraint[],
): ConstraintOutcome {
  for (const constraint of constraints) {
    if (!evaluateConstraint(subject, constraint)) {
      return { satisfied: false, failed: render(constraint) };
    }
  }
  return { satisfied: true, failed: null };
}

export { render as renderConstraint };
