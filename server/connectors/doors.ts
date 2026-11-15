/**
 * Les portes de chaque agent, gardées par le serveur (migration 25).
 *
 * Deux écritures, et elles ne se valent pas :
 *
 *   · `declare` — ce que la PERSONNE dit : « l'agent n'avait pas de clé » ou « je l'ai
 *     révoquée ». Une déclaration ne pose jamais de résultat de vérification ; dire
 *     « aucune clé » efface un résultat devenu sans objet.
 *   · `recordCheck` — ce que le SERVICE a répondu quand l'ancienne clé lui a été
 *     présentée. Appelée seulement par la route de vérification, après
 *     `Connector.credentialAlive`. Présenter une clé, c'est dire qu'elle existait : la
 *     ligne passe à « révoquée ».
 *
 * Aucune des deux ne reçoit ni ne garde la clé.
 */
import type { OrganizationId } from "@shared/tenancy";
import type { DoorCheckState } from "@shared/agent-doors";
import { AGENT_DOORS_TABLE } from "../migrations";
import type { SqlExecutor } from "../sql/executor";

export interface AgentDoorRecord {
  connectorId: string;
  declared: "none" | "revoked";
  declaredBy: string;
  declaredAt: string;
  check: { state: DoorCheckState; detail: string; checkedBy: string; checkedAt: string } | null;
}

interface Row {
  connector_id: string;
  declared: string;
  declared_by: string;
  declared_at: unknown;
  check_state: string | null;
  check_detail: string;
  checked_by: string | null;
  checked_at: unknown;
}

const instant = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value ?? ""));
const CHECK_STATES = new Set<DoorCheckState>(["alive", "dead", "unknown", "placet"]);

export class AgentDoors {
  constructor(
    private readonly sql: SqlExecutor,
    private readonly org: OrganizationId,
  ) {}

  async list(agentId: string): Promise<AgentDoorRecord[]> {
    const rows = await this.sql.all<Row>(
      `SELECT connector_id, declared, declared_by, declared_at, check_state, check_detail, checked_by, checked_at
         FROM ${AGENT_DOORS_TABLE}
        WHERE organization_id = ? AND agent_id = ?
        ORDER BY connector_id`,
      [this.org, agentId],
    );
    return rows.map((row) => ({
      connectorId: row.connector_id,
      declared: row.declared === "none" ? "none" : "revoked",
      declaredBy: row.declared_by,
      declaredAt: instant(row.declared_at),
      check:
        row.check_state && CHECK_STATES.has(row.check_state as DoorCheckState) && row.declared !== "none"
          ? {
              state: row.check_state as DoorCheckState,
              detail: row.check_detail,
              checkedBy: row.checked_by ?? "",
              checkedAt: instant(row.checked_at),
            }
          : null,
    }));
  }

  async declare(agentId: string, connectorId: string, declared: "none" | "revoked", by: string, now = new Date()): Promise<void> {
    const at = now.toISOString();
    await this.sql.run(
      `INSERT INTO ${AGENT_DOORS_TABLE}
         (organization_id, agent_id, connector_id, declared, declared_by, declared_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, agent_id, connector_id) DO UPDATE SET
         declared = excluded.declared,
         declared_by = excluded.declared_by,
         declared_at = excluded.declared_at,
         check_state = CASE WHEN excluded.declared = 'none' THEN NULL ELSE ${AGENT_DOORS_TABLE}.check_state END,
         check_detail = CASE WHEN excluded.declared = 'none' THEN '' ELSE ${AGENT_DOORS_TABLE}.check_detail END`,
      [this.org, agentId, connectorId, declared, by, at],
    );
  }

  async recordCheck(
    agentId: string,
    connectorId: string,
    check: { state: DoorCheckState; detail: string },
    by: string,
    now = new Date(),
  ): Promise<void> {
    const at = now.toISOString();
    await this.sql.run(
      `INSERT INTO ${AGENT_DOORS_TABLE}
         (organization_id, agent_id, connector_id, declared, declared_by, declared_at,
          check_state, check_detail, checked_by, checked_at)
       VALUES (?, ?, ?, 'revoked', ?, ?, ?, ?, ?, ?)
       ON CONFLICT (organization_id, agent_id, connector_id) DO UPDATE SET
         declared = 'revoked',
         check_state = excluded.check_state,
         check_detail = excluded.check_detail,
         checked_by = excluded.checked_by,
         checked_at = excluded.checked_at`,
      [this.org, agentId, connectorId, by, at, check.state, check.detail.slice(0, 500), by, at],
    );
  }
}
