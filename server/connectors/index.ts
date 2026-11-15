/**
 * Le catalogue des connecteurs, et la construction de leur plan par locataire.
 *
 * ## Le catalogue est écrit en dur, et c'est la différence avec `OATHRION_TOOLS`
 *
 * Un outil DÉCLARÉ (`server/gateway/tools/declared-tool.ts`) est une configuration : un
 * exploitant nomme une destination MCP et projette des arguments, sans écrire de code.
 * Un CONNECTEUR est du code : il connaît la forme de l'API d'un service, sa façon de
 * signaler un refus, la différence entre ses 403. Cela ne se déclare pas en JSON.
 *
 * Les deux coexistent par conception. `OATHRION_TOOLS` branche n'importe quel serveur MCP
 * sans attendre que quiconque écrive un connecteur ; un connecteur fait ce qu'un MCP
 * générique ne peut pas — distinguer un quota dépassé d'une permission manquante, lire
 * les portées réelles d'un jeton, dire quelles capacités sont indisponibles et pourquoi.
 *
 * ## Un connecteur par locataire, pas par processus
 *
 * Les credentials sont par organisation, donc le plan des connecteurs l'est aussi. Un
 * singleton de processus porterait le coffre d'un locataire et le servirait à tous.
 */

import type { OrganizationId } from "@shared/tenancy";

import { GithubConnector } from "./github";
import { LinearConnector } from "./linear";
import { SlackConnector } from "./slack";
import { StripeConnector } from "./stripe";
import { ConnectorTool } from "./connector-tool";
import type { Connector, ConnectorContext } from "./types";
import { ConnectorVault, type ConnectorStatus } from "./vault";
import { AgentDoors } from "./doors";
import { ReconcileStore } from "./reconcile-store";
import { connectorStatusTtlMs } from "./timeouts";
import type { SqlExecutor } from "../sql/executor";

/**
 * Tous les connecteurs que ce build sait parler.
 *
 * Quatre : le périmètre de lancement (GitHub, Slack, Linear) et Stripe, le seul qui
 * déplace de l'argent. `docs/connectors.md` énonce la règle du chantier — un connecteur
 * réellement joint et éprouvé vaut mieux que cinq déclarés — et dit, pour chacun, ce qui a
 * été éprouvé contre le vrai service.
 */
export const CONNECTOR_CATALOG: readonly Connector[] = [
  new GithubConnector(),
  new SlackConnector(),
  new LinearConnector(),
  new StripeConnector(),
];

export function lookupConnector(id: string): Connector | undefined {
  return CONNECTOR_CATALOG.find((connector) => connector.id === id);
}

/** Tous les verbes servis par un connecteur du catalogue. */
export function connectorActions(): string[] {
  return CONNECTOR_CATALOG.flatMap((connector) => [...connector.actions]);
}

/** Le plan des connecteurs d'un locataire : le coffre, les contextes, les outils. */
export interface ConnectorPlane {
  vault: ConnectorVault;
  /** Les portes de chaque agent : a-t-il encore une route qui contourne Oathrion ? */
  doors: AgentDoors;
  /** La mémoire de la réconciliation : dernier passage, écritures vues hors d'Oathrion. */
  reconciliations: ReconcileStore;
  /** `{ connectorId: outil }`, prêt à être fusionné dans le registre d'outils. */
  tools: Map<string, ConnectorTool>;
  /** `{ verbe: identifiant d'outil }`, pour la table de routage du registre. */
  actionMap: Record<string, string>;
  contextFor(connectorId: string): ConnectorContext | null;
  /** Relit le coffre pour chaque outil, après une connexion ou une révocation. */
  refresh(): Promise<void>;
  /**
   * Relit le coffre si la dernière lecture date de plus que le délai de fraîcheur
   * (`connectorStatusTtlMs`). Appelé avant chaque `tools/list` MCP : l'état exposé à un
   * agent ne reste jamais figé, sans appeler le service à chaque découverte d'outils.
   */
  refreshIfStale(): Promise<void>;
  /** L'état réel de chaque connecteur du catalogue, configuré ou non. */
  describe(): Promise<ConnectorDescription[]>;
}

/**
 * Ce que la console affiche.
 *
 * `state` vient du coffre quand une ligne existe, et vaut `not_configured` sinon. Il n'y
 * a pas de sixième état « connecté sans avoir été vérifié » : une ligne n'est écrite
 * qu'après un appel réussi au service.
 */
export interface ConnectorDescription {
  id: string;
  label: string;
  description: string;
  actions: readonly string[];
  credentialGuide: string;
  /** La réconciliation existe pour ce connecteur (`Connector.reconcile`). */
  reconcilable: boolean;
  status: ConnectorStatus | { connectorId: string; state: "not_configured" };
}

export function connectorPlaneFor(
  sql: SqlExecutor,
  organizationId: OrganizationId,
  env: NodeJS.ProcessEnv = process.env,
): ConnectorPlane {
  const vault = new ConnectorVault(sql, organizationId, env);
  const tools = new Map<string, ConnectorTool>();
  const actionMap: Record<string, string> = {};

  for (const connector of CONNECTOR_CATALOG) {
    const context: ConnectorContext = { organizationId, vault, env };
    const tool = new ConnectorTool(connector, context);
    tools.set(connector.id, tool);
    for (const action of connector.actions) actionMap[action] = tool.id;
  }

  let refreshedAt = 0;
  const refresh = async () => {
    await Promise.all([...tools.values()].map((tool) => tool.refreshSimulated()));
    refreshedAt = Date.now();
  };

  return {
    vault,
    doors: new AgentDoors(sql, organizationId),
    reconciliations: new ReconcileStore(sql, organizationId),
    tools,
    actionMap,
    contextFor(connectorId) {
      return lookupConnector(connectorId) ? { organizationId, vault, env } : null;
    },
    refresh,
    async refreshIfStale() {
      if (Date.now() - refreshedAt >= connectorStatusTtlMs(env)) await refresh();
    },
    async describe() {
      const stored = await vault.describeAll();
      const byId = new Map(stored.map((entry) => [entry.connectorId, entry]));
      return CONNECTOR_CATALOG.map((connector) => ({
        id: connector.id,
        label: connector.label,
        description: connector.description,
        actions: connector.actions,
        credentialGuide: connector.credentialGuide,
        reconcilable: typeof connector.reconcile === "function",
        status:
          byId.get(connector.id) ??
          ({ connectorId: connector.id, state: "not_configured" } as const),
      }));
    },
  };
}

export { ConnectorVault, VaultUnavailableError, fingerprintOf } from "./vault";
export type { ConnectorStatus, ConnectorState } from "./vault";
export { ConnectorTool } from "./connector-tool";
export { GithubConnector, GITHUB_CONNECTOR_ID, parseRepository, RepositoryTargetError } from "./github";
export { SlackConnector, SLACK_CONNECTOR_ID, parseSlackTarget } from "./slack";
export { LinearConnector, LINEAR_CONNECTOR_ID, parseLinearTarget } from "./linear";
export { StripeConnector, STRIPE_CONNECTOR_ID, parseStripeTarget, classifyStripeKey } from "./stripe";
export type * from "./types";
