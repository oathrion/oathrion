/**
 * `withOathrion` — mettre un contrôle d'autorisation devant un outil, **n'importe quel
 * framework**.
 *
 * CHANGEZ L'ENDPOINT, PAS VOTRE AGENT. Ceci enrobe une fonction que vous avez déjà.
 * Votre agent garde ses outils, ses prompts et son flot de contrôle ; la seule
 * différence est que l'outil demande à Oathrion avant de s'exécuter.
 *
 * ## POURQUOI UN SEUL ADAPTATEUR, ET PAS UN PAR FRAMEWORK
 *
 * Tout framework d'agents a la même forme au fond : un nom, et une fonction qui prend
 * des arguments et fait quelque chose. LangChain, LangGraph, le function calling
 * d'OpenAI, LlamaIndex, le SDK ai de Vercel, CrewAI, n8n, une boucle `while` écrite à la
 * main — ils diffèrent par la façon dont un outil est **décrit**, pas par ce qu'un outil
 * **est**.
 *
 * Un dossier de greffons propriétaires serait un dossier de choses à maintenir, et chacun
 * serait un endroit où le contrôle d'autorisation peut dériver.
 *
 * ## OÙ ILS DIFFÈRENT VRAIMENT : LE NOM DE LA MÉTHODE
 *
 * Le premier jet de ce fichier exigeait `execute(args)` et se déclarait agnostique. Ce
 * n'était vrai que du SDK ai de Vercel — les autres n'appellent pas leur méthode ainsi :
 *
 *   | framework                   | la méthode qui exécute |
 *   |-----------------------------|------------------------|
 *   | SDK ai (Vercel)             | `execute`              |
 *   | LangChain / LangGraph       | `invoke`, et `func`    |
 *   | LlamaIndex                  | `call`                 |
 *   | CrewAI (Python)             | `_run`                 |
 *   | function calling, n8n, à la main | une fonction nue  |
 *
 * `withOathrion` accepte donc **l'une quelconque** de ces formes, et aussi une fonction
 * nue. Il enrobe la méthode qu'il trouve, dans cet ordre, et **conserve tout le reste de
 * l'objet** — description, schéma, `parameters`, métadonnées — pour que l'outil enrobé
 * se glisse là où l'autre était sans que le framework voie la différence.
 *
 * ## CE QU'IL GARANTIT, ET CE QU'IL NE GARANTIT PAS
 *
 * Il garantit que la fonction n'est pas appelée sans un ALLOW d'Oathrion. Si Oathrion est
 * injoignable, le SDK lève et l'outil ne tourne pas : **injoignable n'est pas une
 * permission**. APPROVAL_REQUIRED ne tourne pas non plus — une action retenue attend un
 * humain, et traiter une attente comme un oui est la chose la plus dangereuse qu'une
 * intégration puisse faire.
 *
 * Il **n'arrête pas** un appelant qui choisit de ne pas s'en servir. C'est la limite
 * honnête de tout motif en-processus : `withOathrion(outil)` protège l'outil qu'il a
 * enrobé, et rien ne vous protège d'appeler celui qui ne l'est pas. Si vous avez besoin
 * qu'Oathrion soit physiquement inévitable, mettez-le sur le chemin — voir la passerelle
 * MCP (MOTIF A), où la seule route de l'agent vers l'outil passe par Oathrion.
 */

import type { OathrionClient } from "../../sdk/typescript/src";

/**
 * Une fonction d'outil : un premier argument qui décrit l'action, puis **ce que le
 * framework veut bien ajouter**.
 *
 * Le `...rest` n'est pas une précaution de style. LangChain appelle
 * `invoke(input, config)` — le second argument porte les callbacks, l'identifiant de
 * run et le signal d'annulation. Le premier jet de cet adaptateur ne transmettait que
 * `args` : un outil enrobé aurait perdu sa configuration à chaque appel, silencieusement.
 * Le typecheck l'a signalé en refusant la signature de LangChain, et c'était un vrai
 * défaut derrière.
 */
export type ToolFn = (...args: never[]) => unknown;

/**
 * Les noms de méthode qu'un framework peut donner à « exécuter », dans l'ordre où on
 * les cherche.
 *
 * L'ordre compte, et il est délibéré. LangChain expose `invoke` **et** `func` sur le
 * même objet : `invoke` est l'entrée publique — elle valide les arguments contre le
 * schéma — et `func` est l'implémentation nue. On enrobe donc `invoke`, parce qu'un outil
 * enrobé doit se comporter comme l'outil d'origine, validation comprise.
 *
 * `_run` vient en dernier : c'est la convention de CrewAI côté Python, présente ici pour
 * les portages, et un nom préfixé d'un souligné n'est jamais ce qu'on choisit quand une
 * entrée publique existe.
 */
export const EXECUTE_METHODS = ["execute", "invoke", "call", "func", "run", "_run"] as const;

/**
 * Ce qu'un outil doit au minimum être : un objet portant un nom et l'une des méthodes
 * ci-dessus — ou simplement une fonction.
 *
 * ## POURQUOI LA VÉRIFICATION EST À L'EXÉCUTION ET NON AU TYPAGE
 *
 * Ce type n'est pas une contrainte sur le paramètre de `withOathrion`, et c'est un arbitrage
 * assumé. Une contrainte assez stricte pour vouloir dire quelque chose **refuse les vrais
 * outils de framework** : `DynamicStructuredTool.invoke` de LangChain est générique,
 * contraint par son propre schéma, et n'est pas assignable à une signature concrète. Le
 * typecheck l'a refusé noir sur blanc.
 *
 * Et une contrainte assez lâche pour les accepter ne vérifie plus rien.
 *
 * Entre les deux, la pire issue serait d'obliger l'appelant à écrire `as never` — ce que
 * l'ancien test faisait, et ce que cette version existe pour supprimer. Un transtypage au
 * point d'appel déplace le problème chez le client et lui fait croire qu'il a tort.
 *
 * Le contrôle est donc fait **à l'exécution, immédiatement**, et il lève un `TypeError`
 * qui nomme les six candidats. `withOathrion` est appelé à la construction de l'agent : le
 * développeur lit encore sa pile d'appel, et c'est le seul moment où ce message sert.
 */
export type ToolLike = ToolFn | ({ readonly name?: string } & Partial<Record<ExecuteMethod, ToolFn>>);

/** L'un des noms de méthode reconnus. */
export type ExecuteMethod = (typeof EXECUTE_METHODS)[number];

/** La méthode exécutante trouvée sur un outil, ou `null`. */
export function executeMethodOf(tool: object): ExecuteMethod | null {
  for (const method of EXECUTE_METHODS) {
    if (typeof (tool as Record<string, unknown>)[method] === "function") return method;
  }
  return null;
}

export interface WithOathrionOptions<A> {
  /** The Oathrion client to ask. */
  readonly client: OathrionClient;
  /**
   * Which agent is acting. Not optional in spirit even where the client carries
   * a default: an audit trail that cannot say WHO asked is a log, not an audit.
   */
  readonly agentId?: string;
  /**
   * The action name Oathrion should evaluate. Defaults to the tool's own name.
   *
   * Worth setting explicitly. Oathrion blocks verbs it has never heard of, so the
   * name here has to be the one your policies actually mention — renaming a
   * function in your codebase should not silently change what gets authorized.
   */
  readonly action?: string;
  /**
   * What is being acted upon, derived from the call's arguments.
   *
   * Required, and there is no default. A missing target silently matches no
   * `targetMatches` rule, so a policy scoped to "production database" would
   * simply not apply — a fail-open produced by an omission, which is the worst
   * kind, because nothing in the output looks wrong.
   */
  readonly target: (args: A) => string;
  /** Extra fields for the policy engine — amount, currency, category. */
  readonly input?: (args: A) => Record<string, unknown>;
  /**
   * Whether the decision is recorded. Defaults to TRUE here, unlike the raw
   * API, because a real tool call is about to happen: this is not a "what would
   * you say if" question. A dry run also files no approval, so an
   * APPROVAL_REQUIRED nobody can approve would leave the agent waiting forever.
   */
  readonly persist?: boolean;
}

/** Thrown when Oathrion did not allow the call. Carries the decision. */
export class ToolNotAuthorizedError extends Error {
  readonly decision: string;
  readonly reason: string;
  readonly policyName: string | null;
  readonly approvalId: string | null;

  constructor(toolName: string, decision: { decision: string; reason: string; policyName?: string | null; approvalId?: string | null }) {
    super(`"${toolName}" was not authorized: ${decision.decision} — ${decision.reason}`);
    this.name = "ToolNotAuthorizedError";
    this.decision = decision.decision;
    this.reason = decision.reason;
    this.policyName = decision.policyName ?? null;
    this.approvalId = decision.approvalId ?? null;
  }
}

/**
 * Rend le même outil, avec un contrôle d'autorisation devant lui.
 *
 * Le type de retour est **exactement** le type d'entrée — c'est à cela que sert le
 * paramètre générique `T`. Un outil enrobé se glisse donc là où l'autre était, et son
 * type ne change pas : adopter Oathrion ne doit pas être une réécriture.
 *
 * `ToolLike` étant une union (une fonction, ou un objet portant l'une des six méthodes),
 * rendre `ToolLike<A, R>` aurait forcé chaque appelant à rétrécir le type pour appeler
 * son propre outil — une ergonomie pire qu'avant le changement, et contraire à la
 * promesse ci-dessus. `T extends ToolLike<A, R>` garde la forme concrète que l'appelant
 * a passée. C'est le typecheck qui l'a signalé, en refusant `.execute()` sur le résultat.
 *
 * ## Ce que la mise en œuvre préserve, et pourquoi chaque point a coûté une réflexion
 *
 * **Tout le reste de l'objet.** `description`, `schema`, `parameters`, `returnDirect`,
 * les métadonnées : un framework lit ces champs pour construire le prompt et valider les
 * arguments. Le premier jet reconstruisait `{ name, execute }` et jetait le reste —
 * un outil LangChain enrobé perdait donc son schéma, et LangChain refusait de l'appeler.
 * On copie désormais l'objet et on ne remplace que la méthode exécutante.
 *
 * **Le prototype.** `Object.create(Object.getPrototypeOf(tool))` plutôt qu'un objet nu :
 * un outil de framework est souvent une instance de classe, et ses méthodes vivent sur
 * le prototype. Un spread les aurait perdues.
 *
 * **`this`.** La méthode est appelée sur l'outil D'ORIGINE, pas sur la copie. Une méthode
 * de classe qui lit `this.schema` doit trouver l'objet qu'elle attend ; l'appeler sur la
 * copie marcherait par accident aujourd'hui et casserait le jour où un framework garde un
 * état privé.
 */
export function withOathrion<A, T>(tool: T, options: WithOathrionOptions<A>): T {
  const { client, agentId, target, input, persist = true } = options;

  /** Demande à Oathrion, et lève si la réponse n'est pas ALLOW. */
  async function authorize(action: string, args: A, toolName: string): Promise<void> {
    const decision = await client.evaluate({
      action,
      target: target(args),
      ...(agentId === undefined ? {} : { agentId }),
      ...(input === undefined ? {} : { input: input(args) }),
      persist,
    });

    /*
     * `allowed` est vrai pour ALLOW et pour rien d'autre. Écrit comme un test POSITIF à
     * dessein : `if (decision.blocked) throw` aurait laissé passer APPROVAL_REQUIRED, et
     * `if (!decision.allowed)` aussi si `allowed` avait un jour été défini comme « pas
     * bloqué ». Le SDK dérive les trois drapeaux exhaustivement de la chaîne de décision
     * pour cette raison.
     */
    if (!decision.allowed) {
      throw new ToolNotAuthorizedError(toolName, decision);
    }
  }

  /* --------------------------- une fonction nue --------------------------- */
  if (typeof tool === "function") {
    const fn = tool as unknown as (...args: unknown[]) => unknown;
    const action = options.action ?? (fn.name === "" ? "anonymous" : fn.name);
    // TOUS les arguments sont transmis ; seul le premier décide de l'autorisation.
    const wrapped = async (...args: unknown[]): Promise<unknown> => {
      await authorize(action, args[0] as A, action);
      return await fn(...args);
    };
    /*
     * Le `name` de la fonction est recopié. Une fonction anonyme là où il y avait un nom
     * casse les frameworks qui construisent le schéma d'outil depuis `fn.name` — et le
     * nom d'une fonction n'est pas assignable autrement que par `defineProperty`.
     */
    Object.defineProperty(wrapped, "name", { value: fn.name, configurable: true });
    return wrapped as unknown as T;
  }

  /* ------------------------------ un objet outil -------------------------- */
  const method = executeMethodOf(tool as object);
  if (method === null) {
    /*
     * Un refus immédiat et nommé, plutôt qu'un outil enrobé qui lèvera plus tard.
     * `withOathrion` est appelé à la construction de l'agent : c'est le moment où un
     * développeur lit encore la pile d'appel, et le seul où ce message sert.
     */
    throw new TypeError(
      `withOathrion : cet outil n'expose aucune méthode exécutable. Une parmi ` +
        `${EXECUTE_METHODS.join(", ")} est attendue, ou bien une fonction. ` +
        `Si votre framework en nomme une autrement, enrobez directement sa fonction : ` +
        `withOathrion(args => outil.saMethode(args), { … }).`,
    );
  }

  const named = tool as { name?: unknown };
  const name = typeof named.name === "string" && named.name !== "" ? named.name : method;
  const action = options.action ?? name;
  const original = (tool as Record<string, unknown>)[method] as (...args: unknown[]) => unknown;

  const governed = Object.assign(
    Object.create(Object.getPrototypeOf(tool) as object) as Record<string, unknown>,
    tool,
    {
      [method]: async (...args: unknown[]): Promise<unknown> => {
        await authorize(action, args[0] as A, name);
        // Appelée sur l'outil D'ORIGINE : `this` doit être ce que la méthode attend,
        // et TOUS les arguments sont transmis — LangChain passe `(input, config)`.
        return await original.call(tool, ...args);
      },
    },
  );

  return governed as unknown as T;
}

/**
 * @deprecated Renommé en `withOathrion`. Cet alias disparaîtra à la 2.0.
 *
 * Même raison que les alias du SDK : cet adaptateur est un **exemple que le client
 * copie dans son dépôt**, et une ligne `withPlacet(tool, …)` vit chez lui.
 */
export const withPlacet = withOathrion;
