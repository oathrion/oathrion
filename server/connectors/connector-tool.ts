/**
 * Le pont entre un connecteur et le point de contrôle obligatoire.
 *
 * ## Pourquoi ce fichier existe plutôt qu'un appel direct
 *
 * Un connecteur sait parler à un service. Il ne sait pas — et ne doit pas savoir — qu'une
 * décision a été prise. `ConnectorTool` est ce qui fait qu'un verbe de connecteur est un
 * `Tool` comme les autres : il étend `CountingTool`, donc son unique entrée publique est
 * `execute()`, donc son unique appelant est `AgentGateway.dispatch()`, qui ne l'appelle
 * qu'après un ALLOW.
 *
 * Il n'y a aucun second chemin. Aucune route n'importe un connecteur pour l'exécuter ;
 * les routes ne font que connecter, tester, décrire et révoquer — c'est-à-dire de la
 * CONFIGURATION, jamais une action d'agent. `server/test/connector-single-path.test.ts`
 * assied cette clôture en relisant les sources, comme
 * `server/test/mcp-single-path.test.ts` le fait pour le client MCP.
 *
 * ## Le compteur n'est pas une métrique
 *
 * `CountingTool` compte les invocations, et c'est ce qui permet de prouver un négatif :
 * « l'action BLOQUÉE n'a atteint aucun outil ». Un connecteur appelé en dehors de cette
 * classe serait un appel que personne ne compte, donc une affirmation qu'on ne peut plus
 * faire.
 *
 * ## Ce que `simulated` répond, et pourquoi c'est par locataire
 *
 * `false` dès qu'un credential est stocké pour CE locataire, `true` sinon. C'est la seule
 * lecture honnête : le même build, le même déploiement, et deux organisations dont l'une
 * a connecté GitHub et l'autre pas. Contrairement à `DeclaredTool`, dont la destination
 * est une propriété du déploiement, un connecteur est configuré par le client.
 *
 * `Tool.simulated` est pourtant un getter synchrone sans locataire — l'interface a été
 * dessinée quand aucun outil n'avait d'état par client. La réponse est donc un drapeau
 * mis à jour par `refreshSimulated()`, appelé à la construction de la portée du locataire
 * et après chaque connexion ou révocation. Le défaut est `true` : un outil qui ne sait pas
 * encore s'il est branché se déclare simulé, jamais l'inverse.
 */

import { CountingTool, type ToolContext, type ToolResult } from "../gateway/tools/types";
import type { Connector, ConnectorContext } from "./types";

export class ConnectorTool extends CountingTool {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  /*
   * Défaut fermé. Un outil dont on ne sait pas encore si un credential existe se
   * déclare SIMULÉ : l'inventaire peut être en retard d'un rafraîchissement, il ne doit
   * jamais annoncer un branchement qui n'existe pas.
   */
  private connected = false;

  constructor(
    private readonly connector: Connector,
    private readonly context: ConnectorContext,
  ) {
    super();
    this.id = `connector_${connector.id}`;
    this.name = connector.label;
    this.description = connector.description;
  }

  override get simulated(): boolean {
    return !this.connected;
  }

  /** Relit le coffre. Appelé à la construction de la portée et après connexion/révocation. */
  async refreshSimulated(): Promise<void> {
    const status = await this.context.vault.describe(this.connector.id);
    this.connected = status?.state === "connected";
  }

  protected async run(toolContext: ToolContext): Promise<ToolResult> {
    /*
     * LE LOCATAIRE DE L'APPEL EST COMPARÉ À CELUI DU CONNECTEUR.
     *
     * La portée du locataire construit un `ConnectorTool` par organisation, donc les deux
     * coïncident par construction. La vérification est là parce que « par construction »
     * est exactement le genre d'affirmation qu'un cache mal invalidé transforme en fuite :
     * si une portée était jamais partagée entre deux organisations, l'action de l'une
     * partirait avec le jeton de l'autre. Un refus bruyant plutôt qu'un appel silencieux.
     */
    if (toolContext.organizationId !== this.context.organizationId) {
      return {
        ok: false,
        summary:
          `Refused: this call belongs to ${toolContext.organizationId} and the connector is ` +
          `mounted for ${this.context.organizationId}. Nothing was sent.`,
        data: { dispatched: false, reason: "tenant_mismatch" },
      };
    }

    const result = await this.connector.execute(this.context, {
      action: toolContext.action,
      target: toolContext.target,
      metadata: toolContext.metadata,
      executionId: toolContext.executionId,
    });

    await this.recordHealth(result);

    return {
      ok: result.ok,
      summary: result.summary,
      data: { ...result.data, connector: this.connector.id, code: result.code },
    };
  }

  /**
   * L'ÉTAT SUIT CE QUE LE SERVICE VIENT DE DIRE.
   *
   * Un appel réel qui reçoit un refus d'authentification du SERVICE (jeton révoqué,
   * expiré) passe le connecteur en `error` : ses actions disparaissent de `tools/list`
   * au lieu de rester annoncées jusqu'au prochain test manuel. Un appel réussi sur un
   * connecteur en `error` le remet à `connected`. Seul `unauthorized` venu du service
   * dégrade l'état : une panne réseau, un quota ou une ressource introuvable ne disent
   * rien de la validité du jeton. Et rien n'est écrit quand aucun credential n'existe
   * (`dispatched: false` sans réponse du service).
   */
  private async recordHealth(result: { ok: boolean; code: string; summary: string; data: Record<string, unknown> }): Promise<void> {
    const providerAnswered = result.data.dispatched === true;
    try {
      if (!result.ok && result.code === "unauthorized" && providerAnswered) {
        await this.context.vault.recordCheck(this.connector.id, { ok: false, detail: result.summary });
        this.connected = false;
      } else if (result.ok && !this.connected) {
        await this.context.vault.recordCheck(this.connector.id, { ok: true, detail: "A real call just succeeded." });
        this.connected = true;
      }
    } catch {
      /* L'état est une information pour l'affichage ; son écriture ne doit pas changer le résultat. */
    }
  }
}
