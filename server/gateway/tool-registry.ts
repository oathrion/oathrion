/**
 * Tool registry — maps an agent action onto the tool that performs it.
 *
 * Resolution is by action verb, not by target, so a policy can restrict the
 * target while the same tool stays responsible for the call.
 */

import { lookupAction, normalizeActionName } from "@shared/policy/actions";
import {
  CustomerTool,
  DatabaseTool,
  PurchaseTool,
  RefundTool,
  SendEmailTool,
} from "./tools/simulated-tools";
import { DeclaredTool, DeclaredToolError, parseDeclaredTools } from "./tools/declared-tool";
import type { Tool } from "./tools/types";

export class ToolRegistry {
  private readonly byId = new Map<string, Tool>();
  private readonly byAction = new Map<string, Tool>();

  constructor(tools: Tool[], actionMap: Record<string, string>) {
    for (const tool of tools) this.byId.set(tool.id, tool);
    for (const [action, toolId] of Object.entries(actionMap)) {
      const tool = this.byId.get(toolId);
      if (!tool) throw new Error(`Unknown tool "${toolId}" mapped to action "${action}".`);

      /*
       * The structural guarantee behind the whole action-catalog change.
       *
       * Wiring a tool to a verb is what turns a decision into a side effect, so
       * this is the one place that can force the verb to have been risk-assessed.
       * Refusing an uncatalogued verb here means a developer adding, say, a
       * `refund_tool` CANNOT ship it without adding a `refund` entry to
       * `shared/policy/actions.ts` — and adding that entry is what makes the
       * permission barrier, the mandate spending ceiling and the domain allowlist
       * apply. Previously the four lists were independent and this was the gap
       * that made a silent bypass possible.
       *
       * It throws at construction time, not at dispatch time, so the mistake is a
       * boot failure and a red test rather than an unnoticed hole in production.
       */
      const normalized = normalizeActionName(action);
      const descriptor = lookupAction(normalized);
      if (!descriptor) {
        throw new Error(
          `Action "${action}" is wired to tool "${toolId}" but is not declared in ` +
            `shared/policy/actions.ts. Declare it there (with its required permission scope and ` +
            `whether it is financial/outbound) so the policy, mandate and permission layers apply to it.`,
        );
      }
      if (!descriptor.requiredScope) {
        throw new Error(
          `Action "${action}" is wired to tool "${toolId}" but declares no required permission ` +
            `scope in shared/policy/actions.ts. A dispatchable action with no scope is reachable by ` +
            `every agent. Give it a scope.`,
        );
      }

      this.byAction.set(normalized, tool);
    }
  }

  /** Every action verb wired to a tool. Used by the coverage regression tests. */
  actions(): string[] {
    return Array.from(this.byAction.keys());
  }

  /**
   * Les verbes que CET outil sert, s'il en sert.
   *
   * Ajouté avec le registre déclaré, et pour une raison qu'un passage de
   * `npm run verify:tools` a rendue visible : une déclaration qui revendique `refund`
   * remplace `refund_tool`, et l'inventaire montrait alors DEUX outils annonçant
   * « non simulé » sans dire lequel sert le verbe. Un pilote n'avait aucun moyen, par
   * l'API, de confirmer que sa déclaration avait pris effet.
   *
   * Dérivé de la table de routage, jamais d'un champ que l'outil porterait lui-même :
   * un outil qui déclarerait ses propres verbes pourrait en annoncer un qu'il ne sert
   * pas.
   */
  actionsFor(toolId: string): string[] {
    return Array.from(this.byAction.entries())
      .filter(([, tool]) => tool.id === toolId)
      .map(([action]) => action)
      .sort();
  }

  /** The tool that handles this action, or undefined when nothing is wired up. */
  resolve(action: string): Tool | undefined {
    return this.byAction.get(normalizeActionName(action));
  }

  get(id: string): Tool | undefined {
    return this.byId.get(id);
  }

  list(): Tool[] {
    return Array.from(this.byId.values());
  }

  /**
   * Un registre DÉRIVÉ : les mêmes outils, plus ceux d'un locataire.
   *
   * ## Pourquoi dériver au lieu de reconstruire
   *
   * Les connecteurs portent des credentials par organisation, donc leurs outils sont par
   * organisation — alors que les cinq intégrés et les outils déclarés sont des propriétés
   * du processus. Reconstruire un registre complet par locataire rendrait les compteurs
   * d'invocation des intégrés eux-mêmes par locataire, ce qui changerait silencieusement
   * ce que `GET /api/tools` compte depuis toujours.
   *
   * Ici les INSTANCES des outils existants sont réutilisées — donc leurs compteurs sont
   * partagés, comme avant — et seules les entrées du locataire s'ajoutent.
   *
   * ## Ce que cette méthode ne relâche pas
   *
   * Elle passe par le constructeur, donc un verbe absent de `shared/policy/actions.ts`
   * est refusé ici exactement comme au démarrage. Un connecteur ne peut pas introduire un
   * verbe qui échapperait à la portée de permission, au plafond de mandat ou à
   * l'allowlist de domaine.
   *
   * Les entrées du locataire sont appliquées EN DERNIER, donc un connecteur remplace
   * l'outil intégré d'un verbe qu'il revendique — même règle que pour une déclaration.
   */
  extendedWith(extraTools: readonly Tool[], extraActions: Record<string, string>): ToolRegistry {
    const actionMap: Record<string, string> = {};
    for (const [action, tool] of this.byAction.entries()) actionMap[action] = tool.id;
    return new ToolRegistry(
      [...this.byId.values(), ...extraTools],
      { ...actionMap, ...extraActions },
    );
  }

  /** Test-only: zero every invocation counter. */
  resetCounts(): void {
    Array.from(this.byId.values()).forEach((tool) => tool.resetCount());
  }
}

/**
 * Les outils intégrés, plus ceux que l'exploitant a DÉCLARÉS.
 *
 * Un outil déclaré qui revendique un verbe déjà câblé le REMPLACE : c'est tout l'intérêt
 * d'un pilote, qui veut que son `refund` parte chez son fournisseur et non dans le
 * simulateur. Le remplacement est l'effet voulu de la déclaration, pas un accident --
 * les déclarations sont appliquées après la table intégrée, donc elles gagnent.
 *
 * Ce qu'une déclaration ne peut PAS faire : câbler un verbe absent de
 * `shared/policy/actions.ts`. Le constructeur de `ToolRegistry` refuse, au démarrage,
 * exactement comme pour un outil intégré. Un connecteur ne contourne donc jamais la
 * barrière de permission, le plafond de mandat ni l'allowlist de domaine.
 */
export function createDefaultRegistry(env: NodeJS.ProcessEnv = process.env): ToolRegistry {
  const builtIns = [
    new PurchaseTool(),
    new SendEmailTool(),
    new DatabaseTool(),
    new RefundTool(),
    new CustomerTool(),
  ];

  const declared = parseDeclaredTools(env);

  /*
   * UN IDENTIFIANT DÉCLARÉ NE PEUT PAS RECOUVRIR CELUI D'UN OUTIL INTÉGRÉ.
   *
   * Le remplacement légitime se fait par le VERBE : une déclaration qui revendique
   * `refund` prend la place de `refund_tool` sur ce verbe, et l'inventaire le montre.
   * Reprendre l'IDENTIFIANT serait un remplacement d'une autre nature, et invisible :
   * la table de routage intégrée garderait la ligne `refund: "refund_tool"`, qui
   * résoudrait alors vers l'outil déclaré. Une déclaration ne revendiquant que
   * `delete_customer` capturerait ainsi `refund` au passage, sans que rien ne le dise.
   *
   * Refusé au démarrage plutôt que documenté : la capture serait silencieuse, et un
   * exploitant n'a aucune raison de nommer son connecteur comme un outil interne.
   */
  const builtInIds = new Set<string>(builtIns.map((tool) => tool.id));
  for (const spec of declared) {
    if (builtInIds.has(spec.id)) {
      throw new DeclaredToolError(
        `OATHRION_TOOLS: tool "${spec.id}" reuses the id of a built-in tool. A declared tool ` +
          `replaces a built-in by claiming its ACTION, not by taking its id — reusing the id ` +
          `would also capture every other verb wired to it. Give the declaration its own id.`,
      );
    }
  }

  const declaredTools = declared.map((spec) => new DeclaredTool(spec, env));
  const declaredActions: Record<string, string> = {};
  for (const spec of declared) {
    for (const action of spec.actions) declaredActions[action] = spec.id;
  }

  return new ToolRegistry(
    [...builtIns, ...declaredTools],
    {
      purchase: "purchase_tool",
      send_email: "send_email_tool",
      access: "database_tool",
      query: "database_tool",
      write: "database_tool",
      /*
       * `refund` and `delete_customer` are wired deliberately, and they are the
       * point of the exercise rather than an afterthought.
       *
       * Until now an ALLOWed refund produced `runState: "skipped"` because no
       * tool claimed the verb, and a BLOCKed customer deletion "never reached a
       * tool" only because no tool existed to reach. Both facts were true and
       * neither was evidence of anything. Wiring them means the ALLOW path has
       * to really execute, and the BLOCK path has to really hold something back.
       *
       * Both handlers are SIMULATED (see `tools/simulated-tools.ts`): no money
       * moves and no record is destroyed.
       */
      refund: "refund_tool",
      delete_customer: "customer_tool",
      // Les déclarations en dernier : elles remplacent, c'est leur raison d'être.
      ...declaredActions,
    },
  );
}

/** Process-wide registry used by the API layer. */
export const toolRegistry = createDefaultRegistry();
