/**
 * Tool abstraction.
 *
 * A Tool is the side-effecting edge of the control plane — the thing that
 * actually spends money, sends mail or touches a database. It is deliberately
 * dumb: a Tool NEVER decides whether an action is permitted. That is the
 * Gateway's job, and the Policy Engine is the source of truth.
 *
 * Every tool counts its invocations (`toolExecutionCount`) so a test can prove
 * a negative: that a blocked action never reached the tool.
 */

import type { CurrencyCode } from "@shared/money";

export interface ToolContext {
  /**
   * Le locataire pour le compte de qui cet appel part.
   *
   * Absent jusqu'ici parce qu'aucun outil intégré n'en avait besoin : les cinq simulés
   * ne joignent rien, et le relais de remboursement lisait sa destination dans
   * l'environnement. Un connecteur DÉCLARÉ, lui, doit résoudre sa destination dans le
   * registre — et ce registre est cadré au locataire par construction
   * (`destinationVisibleTo`). Sans ce champ, un connecteur ne pourrait pas poser la
   * question « cette destination est-elle permise à CE client ? », et la seule façon
   * d'avancer serait de ne pas la poser.
   */
  organizationId: string;
  /** Idempotence key — the Execution this call belongs to. */
  executionId: string;
  agentId: string;
  agentName: string;
  action: string;
  target: string;
  metadata: Record<string, unknown>;
  /**
   * The tenant's unit of account.
   *
   * Present so a connector transmits the currency it was given instead of assuming one.
   * `simulated-tools.ts` used to send `currency: "EUR"` as a literal to the downstream
   * MCP tool, so a refund authorised in francs CFA would have been requested from the
   * provider in euros — a 655-fold error on the one field that must not be guessed.
   */
  currency: CurrencyCode;
}

export interface ToolResult {
  ok: boolean;
  /** One-line, human-readable outcome stored on the Execution. */
  summary: string;
  data: Record<string, unknown>;
}

export interface Tool {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** How many times this tool has actually run since the process started. */
  readonly toolExecutionCount: number;
  /**
   * Whether a run RIGHT NOW would stay inside Oathrion instead of reaching a real
   * system.
   *
   * Read per access, never cached, because it is a property of the DEPLOYMENT and
   * not of the build: the refund tool dispatches for real as soon as a downstream
   * MCP server is configured, and stays simulated otherwise. A constant here would
   * be the same false statement that `mcp-e2e-downstream.test.ts` already removed
   * from the run payload — "which became a false statement the moment a tool could
   * dispatch for real".
   *
   * This is the single source for every surface that reports simulation: the MCP
   * catalogue and `GET /api/tools`. Neither may hold its own literal.
   */
  readonly simulated: boolean;
  /**
   * `false` quand l'outil SAIT qu'il ne peut pas être joint maintenant (le serveur MCP
   * enveloppé s'est arrêté). Absent : rien à en dire. Une approbation n'est pas enregistrée
   * pour un outil injoignable (`ToolUnreachableError`).
   */
  readonly reachable?: boolean;
  execute(context: ToolContext): Promise<ToolResult>;
  /** Test-only helper; resets the invocation counter. */
  resetCount(): void;
}

/**
 * Base class holding the invocation counter so the three simulated tools cannot
 * forget to increment it. Subclasses implement `run`, never `execute`.
 */
export abstract class CountingTool implements Tool {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly description: string;

  private count = 0;

  get toolExecutionCount(): number {
    return this.count;
  }

  /**
   * Simulated unless a subclass says otherwise. Four of the five tools have no
   * downstream path at all, so `true` is the truth for them, and a subclass that
   * gains one has to override this deliberately rather than inherit a lie.
   */
  get simulated(): boolean {
    return true;
  }

  resetCount(): void {
    this.count = 0;
  }

  async execute(context: ToolContext): Promise<ToolResult> {
    this.count += 1;
    return this.run(context);
  }

  protected abstract run(context: ToolContext): Promise<ToolResult>;
}
