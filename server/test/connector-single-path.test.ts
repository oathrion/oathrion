/**
 * UN CONNECTEUR N'EST ATTEIGNABLE QUE PAR LE POINT DE CONTRÔLE.
 *
 * ## Pourquoi ce fichier relit des sources au lieu d'exécuter du code
 *
 * `connector-control-point.test.ts` prouve qu'une action BLOQUÉE n'atteint pas le
 * connecteur **par le chemin qu'il emprunte**. Il ne peut rien dire d'un SECOND chemin
 * que personne n'a encore écrit — et un connecteur détient un credential d'accès à un
 * service tiers, donc c'est exactement l'endroit où une route « exécute cette opération »
 * finira par paraître locale et raisonnable à quelqu'un. Elle contournerait la politique,
 * le mandat, la file d'approbation, la revendication atomique de l'exécution et la chaîne
 * d'audit.
 *
 * C'est le même raisonnement, et la même forme, que `mcp-single-path.test.ts` pour le
 * client MCP sortant. L'ensemble des appelants autorisés est CLOS et énuméré : une
 * entrée de plus doit faire échouer la suite et obliger à écrire pourquoi.
 */

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONNECTOR_CATALOG, connectorActions } from "../connectors";
import { lookupAction } from "@shared/policy/actions";
import { argumentsFor } from "../mcp/action-arguments";

const SERVER_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Retire les commentaires : la prose sur un symbole n'est pas un usage de ce symbole. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Chaque `.ts` sous `server/`, récursivement, hors tests. */
function serverSources(directory: string = SERVER_DIR): { file: string; source: string }[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "test" || entry.name === "node_modules" ? [] : serverSources(full);
    }
    if (!entry.name.endsWith(".ts")) return [];
    if (!statSync(full).isFile()) return [];
    return [{ file: full.slice(SERVER_DIR.length + 1), source: readFileSync(full, "utf8") }];
  });
}

const SOURCES = serverSources();

describe("la garde sur la garde", () => {
  it("balaye un nombre plausible de fichiers", () => {
    /*
     * Si la marche cassait, toutes les assertions ci-dessous passeraient à vide — le
     * mode d'échec que ce fichier existe pour supprimer.
     */
    expect(SOURCES.length).toBeGreaterThan(40);
    expect(SOURCES.some((s) => s.file === join("connectors", "github.ts"))).toBe(true);
    expect(SOURCES.some((s) => s.file === "routes.ts")).toBe(true);
  });
});

describe("l'exécution d'un connecteur n'a qu'un appelant", () => {
  it("`connector.execute(` n'est appelé que par ConnectorTool", () => {
    /*
     * `Connector.execute` est la méthode qui agit chez le tiers. Son unique appelant doit
     * être `ConnectorTool.run()`, qui n'est atteignable que par `CountingTool.execute()`,
     * lui-même atteignable seulement par `AgentGateway.dispatch()` — donc après un ALLOW.
     */
    const callers = SOURCES.filter(({ source }) => /\bconnector\.execute\(/.test(code(source)))
      .map(({ file }) => file)
      .sort();
    expect(callers).toEqual([join("connectors", "connector-tool.ts")]);
  });

  it("ConnectorTool étend CountingTool, donc son appel est compté et gouverné", () => {
    const source = code(readFileSync(join(SERVER_DIR, "connectors", "connector-tool.ts"), "utf8"));
    expect(source).toMatch(/class ConnectorTool extends CountingTool/);
    /*
     * L'appel est DANS `run()`, pas dans une méthode publique que l'on pourrait
     * atteindre autrement. `run` est `protected` : seul `execute()` de la classe de base
     * y conduit, et c'est lui qui incrémente le compteur sur lequel repose toute preuve
     * d'un négatif (« le BLOCK n'a atteint aucun outil »).
     */
    const run = source.indexOf("protected async run(");
    expect(run).toBeGreaterThan(-1);
    expect(source.indexOf("connector.execute(")).toBeGreaterThan(run);
  });

  it("aucune route n'exécute un connecteur", () => {
    for (const file of ["routes.ts", "routes-connectors.ts", "routes-actions.ts", "routes-feedback.ts"]) {
      const source = code(readFileSync(join(SERVER_DIR, file), "utf8"));
      expect(source, `${file} ne doit pas exécuter un connecteur`).not.toMatch(/\.execute\(\s*context/);
      expect(source, `${file} ne doit pas appeler Connector.execute`).not.toMatch(/connector\.execute\(/);
    }
  });

  it("le routeur MCP n'importe aucun connecteur", () => {
    /*
     * La surface MCP est l'endroit naturel où reconstruire une dispatch « locale et
     * raisonnable ». Elle n'a le droit d'énumérer des verbes, jamais d'en exécuter un.
     */
    for (const file of [join("mcp", "router.ts"), join("mcp", "protocol.ts"), join("mcp", "tool-catalog.ts")]) {
      const source = code(readFileSync(join(SERVER_DIR, file), "utf8"));
      expect(source, `${file}`).not.toContain("connectors/");
      expect(source, `${file}`).not.toContain("GithubConnector");
    }
  });
});

describe("le déchiffrement du credential n'a qu'un appelant", () => {
  it("`vault.open(` n'est appelé que par un connecteur", () => {
    /*
     * `open()` est le seul déchiffrement du dépôt. Tout appelant hors d'un connecteur
     * serait un chemin par lequel un jeton sort du coffre sans qu'une décision ait été
     * prise — y compris une route de lecture écrite de bonne foi.
     */
    const callers = SOURCES.filter(({ source }) => /vault\.open\(/.test(code(source)))
      .map(({ file }) => file)
      .sort();
    /*
     * DEUXIÈME ENTRÉE — `intercept/forward.ts`, le relais du pare-feu.
     *
     * C'est un `Tool` au même titre qu'un connecteur : il étend `CountingTool`, donc son
     * seul chemin d'entrée est `execute()`, atteignable seulement depuis
     * `AgentGateway.dispatch()`, après un ALLOW.
     *
     * Cette entrée a été GAGNÉE par une correction, pas accordée. La route
     * `routes-intercept.ts` ouvrait le coffre avant la décision : une requête BLOQUÉE
     * faisait donc déchiffrer un secret du fournisseur — jamais envoyé, mais en clair en
     * mémoire sans qu'aucune autorisation ne l'ait justifié. Ce test l'a refusé, et il
     * avait raison. L'assertion ci-dessous est ce qui interdit à ce module de reprendre
     * cette habitude.
     */
    /*
     * TROISIÈME À CINQUIÈME ENTRÉES — les connecteurs Slack et Linear, et
     * `connectors/oauth-install.ts`.
     *
     * Les deux premiers sont des connecteurs du catalogue, appelés par `ConnectorTool`
     * comme GitHub. Le troisième est le renouvellement d'un jeton OAuth (`freshSecret`) :
     * il doit relire le secret pour savoir s'il expire et re-sceller le jeton renouvelé.
     * Il n'est légitime QUE parce que ses seuls appelants sont ces deux connecteurs — le
     * test suivant le fixe, sans quoi une route pourrait l'importer et obtenir un jeton
     * en clair par la porte de côté.
     */
    expect(callers).toEqual([
      join("connectors", "github.ts"),
      join("connectors", "linear.ts"),
      join("connectors", "oauth-install.ts"),
      join("connectors", "slack.ts"),
      join("intercept", "forward.ts"),
    ]);
  });

  it("le renouvellement OAuth, qui ouvre le coffre, n'est appelé que par les connecteurs", () => {
    const callers = SOURCES.filter(({ source }) => /freshSecret\(/.test(code(source)))
      .map(({ file }) => file)
      .filter((file) => file !== join("connectors", "oauth-install.ts"))
      .sort();
    expect(callers).toEqual([join("connectors", "linear.ts"), join("connectors", "slack.ts"), join("connectors", "stripe.ts")]);
  });

  it("le relais du pare-feu n'ouvre le coffre qu'APRÈS avoir repris la requête autorisée", () => {
    /*
     * L'ORDRE EST LA PROPRIÉTÉ, comme pour « réclamer puis agir » du point d'application.
     * `takePending` ne rend une requête que si la passerelle a atteint `run()`, donc après
     * un ALLOW. Ouvrir le coffre AVANT cette ligne ferait déchiffrer un secret pour une
     * action dont on ne sait pas encore si elle est autorisée — et tous les tests
     * fonctionnels resteraient verts, parce que la requête ne partirait toujours pas.
     */
    const source = code(readFileSync(join(SERVER_DIR, "intercept", "forward.ts"), "utf8"));
    expect(source).toMatch(/class InterceptTool extends CountingTool/);

    const run = source.indexOf("protected async run(");
    const take = source.indexOf("takePending(", run);
    const open = source.indexOf("this.credentialFor(", run);
    expect(run).toBeGreaterThan(-1);
    expect(take).toBeGreaterThan(run);
    expect(open).toBeGreaterThan(take);

    /* Et la route, elle, n'ouvre plus rien. */
    const route = code(readFileSync(join(SERVER_DIR, "routes-intercept.ts"), "utf8"));
    expect(route).not.toMatch(/vault\.open\(/);
    expect(route).not.toContain("credentialFor");
  });

  it("`openSecret` n'est appelé que par le coffre et par le sas", () => {
    const callers = SOURCES.filter(({ source }) => /\bopenSecret\(/.test(code(source)))
      .map(({ file }) => file)
      .sort();
    /*
     * TROISIÈME ENTRÉE — `intercept/pending-store.ts`, le sas des requêtes qui attendent
     * un humain. Il est le seul autre endroit du produit qui déchiffre, et ce qu'il
     * déchiffre n'est pas un credential : c'est la requête du client lui-même, scellée le
     * temps qu'un opérateur décide.
     *
     * Elle a été gagnée par une correction, pas accordée. La requête vivait dans une
     * `Map` du processus avec un TTL de soixante secondes — mesuré : « après 61 s, la
     * requête est : PERDUE ». Une approbation humaine n'était donc utilisable que si
     * l'humain répondait en moins d'une minute, et le test qui couvrait ce chemin
     * approuvait dans la milliseconde.
     *
     * Les deux assertions suivantes sont ce qui lui vaut sa place.
     */
    expect(callers).toEqual([
      join("connectors", "vault.ts"),
      join("intercept", "pending-store.ts"),
      join("secrets", "envelope.ts"),
    ]);
  });

  it("le sas ne rend une requête qu'après une suppression qui a mordu", () => {
    /*
     * L'ORDRE EST LA PROPRIÉTÉ, comme pour « réclamer puis agir ». Le `SELECT` peut voir
     * la même ligne deux fois sous concurrence ; c'est la SUPPRESSION conditionnelle qui
     * décide. Déchiffrer avant elle rendrait la requête à deux approbations simultanées.
     */
    const source = code(readFileSync(join(SERVER_DIR, "intercept", "pending-store.ts"), "utf8"));
    const take = source.indexOf("async take(");
    const del = source.indexOf("DELETE FROM", take);
    const claimed = source.indexOf("if (claimed < 1) return null;", take);
    const open = source.indexOf("openSecret(", take);
    expect(take).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(take);
    expect(claimed).toBeGreaterThan(del);
    expect(open).toBeGreaterThan(claimed);
  });

  it("… et la destination est re-résolue, jamais relue depuis la ligne", () => {
    /*
     * Entre le dépôt et l'approbation, l'exploitant peut avoir retiré la destination du
     * registre. Croire ce qui a été écrit ferait partir une requête vers une destination
     * qui n'est plus permise — la faille de liaison de destination que le plan d'autorité
     * refuse déjà ailleurs.
     */
    const source = code(readFileSync(join(SERVER_DIR, "intercept", "pending-store.ts"), "utf8"));
    expect(source).toContain("resolveDestination(row.destination_id");
    expect(source).not.toMatch(/destination:\s*JSON\.parse/);
  });
});

describe("ce qui est PERSISTÉ par un outil ne doit pas porter de données métier", () => {
  /*
   * ## Le chemin exact, et pourquoi il mérite un garde textuel
   *
   * `Tool.run()` rend `data` → `AgentGateway` l'écrit dans `toolResult` → la colonne est
   * sérialisée en base. Tout ce qu'un outil met dans `data` est donc conservé, et la
   * trace d'audit est ce que ce produit promet de pouvoir montrer à un auditeur.
   *
   * Le relais du pare-feu y plaçait `responseBody` et `responseHeaders` — la réponse
   * COMPLÈTE du fournisseur. Pour un remboursement Stripe : l'objet client, son adresse
   * e-mail, son nom, la fin de son numéro de carte. Aucun test fonctionnel ne pouvait le
   * voir : la requête partait bien, la réponse revenait bien, et le contrôle de
   * discrétion voisin regardait la REQUÊTE.
   *
   * Un test de comportement ne suffit pas ici, parce que la faute consiste à AJOUTER un
   * champ — et un test ne peut pas énumérer les champs qu'on n'a pas encore inventés.
   * Celui-ci interdit les noms par lesquels elle reviendrait.
   */
  it("le relais ne met ni corps ni en-têtes de réponse dans `data`", () => {
    const source = code(readFileSync(join(SERVER_DIR, "intercept", "forward.ts"), "utf8"));

    /*
     * Les deux NOMS par lesquels la fuite reviendrait, interdits dans tout le fichier.
     *
     * Une première version de cette assertion découpait les blocs `data: { … }` à la
     * regex et se trompait de deux façons : la tranche jusqu'à la fin du fichier
     * attrapait `responseHeadersFor` (la fonction de la ROUTE, pas un champ persisté),
     * puis la version bornée fusionnait deux blocs et attrapait le `reply.body` qui les
     * sépare — légitime, puisqu'il alimente la table en mémoire. Interdire les deux noms
     * dit la même chose sans dépendre d'un découpage.
     */
    expect(source).not.toContain("responseBody");
    expect(source).not.toContain("responseHeaders:");

    /* Ce qu'il doit y avoir : des faits de gouvernance, dont la TAILLE et non le contenu. */
    const persisted = source.slice(source.lastIndexOf("data: {"));
    expect(persisted).toContain("responseBytes");
    expect(persisted).toContain("status: reply.status");
    expect(persisted).toContain("credentialInjected");
  });

  it("la réponse voyage par une table en mémoire, reprise une seule fois", () => {
    const source = code(readFileSync(join(SERVER_DIR, "intercept", "forward.ts"), "utf8"));
    /* `putResponse` est appelé dans `run()`, et `takeResponse` supprime l'entrée. */
    expect(source).toContain("putResponse(");
    expect(source).toMatch(/export function takeResponse[\s\S]*responses\.delete\(ref\)/);
  });

  it("la route rend le corps depuis cette table, et jamais depuis `toolResult`", () => {
    /*
     * La correction a failli être incomplète : une ligne de la route lisait encore
     * `toolResult.responseBody` et a survécu au déplacement. Le harnais l'a dit en voyant
     * un corps VIDE arriver chez l'agent — un contrôle de discrétion ne l'aurait pas vu,
     * puisque la fuite était fermée. C'est cette assertion qui empêche la demi-correction.
     */
    const route = code(readFileSync(join(SERVER_DIR, "routes-intercept.ts"), "utf8"));
    expect(route).toContain("takeResponse(");
    expect(route).not.toContain("toolResult.responseBody");
    expect(route).not.toContain("toolResult.responseHeaders");
  });
});

describe("la sortie réseau d'un connecteur passe par le transport gardé", () => {
  it("le connecteur GitHub n'utilise ni fetch ni http.request", () => {
    /*
     * `fetch` suit les redirections : un hôte validé qui répond 302 vers
     * `169.254.169.254` ferait sortir le JETON vers le service de métadonnées de
     * l'instance. Le transport partagé applique en plus le contrôle d'adresse au niveau
     * de la socket, qui est le seul qu'une réattribution DNS ne peut pas gagner.
     */
    const source = code(readFileSync(join(SERVER_DIR, "connectors", "github.ts"), "utf8"));
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/https?\.request\(/);
    expect(source).not.toMatch(/from "node:https"/);
    expect(source).toContain("sendGuarded");
  });

  it("l'origine de l'API n'est pas réglable par une requête", () => {
    /*
     * `OATHRION_GITHUB_API_ORIGIN` est lu dans l'ENVIRONNEMENT. Une origine qui viendrait
     * du corps d'une requête ou des métadonnées d'une action serait une exfiltration de
     * jeton déguisée en fonctionnalité : un locataire choisirait où part son credential.
     */
    const source = code(readFileSync(join(SERVER_DIR, "connectors", "github.ts"), "utf8"));
    const origin = source.slice(source.indexOf("function apiOrigin"), source.indexOf("const USER_AGENT"));
    expect(origin).toContain("env.OATHRION_GITHUB_API_ORIGIN");
    expect(origin).not.toContain("metadata");
    expect(origin).not.toContain("request");
    /* Et le défaut est l'hôte public, pas une valeur vide qui produirait une URL relative. */
    expect(origin).toContain("https://api.github.com");
  });
});

describe("chaque verbe de connecteur est gouvernable", () => {
  it("tous sont au catalogue d'actions, avec une portée de permission", () => {
    /*
     * Dérivé du CATALOGUE DE CONNECTEURS, pas d'une liste recopiée ici : un connecteur
     * ajouté demain est couvert sans que personne pense à modifier ce test. L'entrée du
     * catalogue d'actions est ce qui fait appliquer la barrière de permission, le plafond
     * de mandat et l'allowlist de domaine.
     */
    const actions = connectorActions();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      const descriptor = lookupAction(action);
      expect(descriptor, `${action} doit être déclaré dans shared/policy/actions.ts`).toBeDefined();
      expect(descriptor!.requiredScope, `${action} doit exiger une portée`).not.toBeNull();
    }
  });

  it("un verbe qui sort de l'organisation est déclaré outbound", () => {
    /*
     * `outbound` est ce qui soumet le verbe à l'allowlist de domaine du mandat. Un verbe
     * de connecteur qui ne l'est pas serait un appel vers un tiers qu'aucun mandat ne
     * peut restreindre.
     */
    for (const action of connectorActions()) {
      expect(lookupAction(action)!.outbound, `${action} doit être outbound`).toBe(true);
    }
  });

  it("aucun connecteur ne porte un identifiant qui casserait le contexte de scellement", () => {
    for (const connector of CONNECTOR_CATALOG) {
      expect(connector.id).toMatch(/^[a-z][a-z0-9_-]{1,40}$/);
    }
  });

  it("chaque verbe de connecteur déclare ses arguments pour la voie MCP", () => {
    /*
     * Sans déclaration, le routeur MCP refuse tout argument autre que `target` : le verbe
     * serait listé et inutilisable (un message Slack sans texte, une issue sans titre).
     * C'est exactement ce qui est arrivé aux trois verbes GitHub jusqu'à ce chantier.
     */
    for (const action of connectorActions()) {
      expect(argumentsFor(action), action).toBeDefined();
    }
  });

  it("chaque connecteur documente la création de son credential", () => {
    /*
     * L'exigence est « un guide permettant à un nouvel utilisateur de connecter le
     * service sans modifier le code source ». Un guide vide rendrait le connecteur
     * inutilisable par quelqu'un d'autre que son auteur.
     */
    for (const connector of CONNECTOR_CATALOG) {
      expect(connector.credentialGuide.length, connector.id).toBeGreaterThan(120);
      expect(connector.credentialGuide, connector.id).toMatch(/https?:\/\//);
    }
  });
});
