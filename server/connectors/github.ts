/**
 * Le connecteur GitHub — RÉEL. Appels HTTPS authentifiés à api.github.com.
 *
 * ## Ce qu'il fait réellement
 *
 * `verify` appelle `GET /user` avec le jeton et lit le login que GitHub rend. `test`
 * refait l'appel plus tard. `capabilities` dérive les capacités des portées que GitHub
 * annonce lui-même dans l'en-tête `x-oauth-scopes`. `execute` appelle
 * `POST /repos/{owner}/{repo}/issues` ou `.../issues/{n}/comments`, ou lit en `GET`.
 *
 * Aucune de ces réponses n'est fabriquée. Un échec d'authentification est le 401 de
 * GitHub ; une permission insuffisante est son 403 ; un dépôt absent est son 404.
 *
 * ## Ce qu'il NE fait pas, et il faut le lire avant de vendre quoi que ce soit
 *
 * **Pas d'OAuth.** Le credential est un jeton que l'exploitant crée lui-même et colle.
 * Un flot OAuth suppose une application GitHub enregistrée, un secret client et une URL
 * de retour publique — trois choses qui appartiennent au déploiement et non au dépôt.
 * Un jeton collé est moins élégant et parfaitement réel.
 *
 * **Pas de révocation distante.** Oathrion oublie le jeton ; GitHub le considère valide
 * jusqu'à ce que son propriétaire le supprime. `revoke()` le dit dans sa réponse
 * (`remoteStillValid: true`) pour que la console l'affiche, au lieu d'écrire
 * « déconnecté » et de laisser croire que le jeton est mort.
 *
 * **Pas d'écriture destructive.** Trois verbes : lire, ouvrir une issue, commenter.
 * Ni fermeture, ni suppression, ni push, ni fusion. Ce n'est pas un oubli : le premier
 * connecteur réel d'un plan de contrôle doit être celui dont une erreur se répare en
 * cliquant « close », et élargir se fait après que le chemin gouverné est prouvé.
 *
 * ## Pourquoi `sendGuarded` et pas `fetch`
 *
 * `fetch` suit les redirections. Un hôte validé qui répond `302` vers `169.254.169.254`
 * ferait sortir le jeton vers le service de métadonnées de l'instance — c'est l'argument
 * que `server/notifications/webhook-transport.ts` développe déjà, et il s'applique
 * d'autant plus ici que la requête PORTE un credential. Le transport partagé applique en
 * plus le contrôle d'adresse au niveau de la socket, qui est le seul qu'une réattribution
 * DNS ne peut pas gagner.
 *
 * L'hôte est épinglé à `api.github.com` par `GITHUB_API_ORIGIN`, et ce n'est pas
 * configurable par un locataire : une URL d'API réglable par requête serait une
 * exfiltration de jeton déguisée en fonctionnalité.
 */

import type { OrganizationId } from "@shared/tenancy";

import { sendGuarded } from "../notifications/webhook-transport";
import type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ConnectorExecuteRequest,
  ConnectorExecuteResult,
  ConnectorProbe,
  CredentialLiveness,
  ReconcileItem,
  ReconcileListing,
  ConnectorProbeCode,
  ConnectorResourceListing,
  ConnectorRevocation,
} from "./types";
import { connectorTimeoutMs } from "./timeouts";
import { transportFailure } from "./transport-failure";

export const GITHUB_CONNECTOR_ID = "github";

/**
 * L'origine de l'API, épinglée.
 *
 * `OATHRION_GITHUB_API_ORIGIN` existe pour une seule raison : viser une instance GitHub
 * Enterprise. C'est une variable de DÉPLOIEMENT, lue au démarrage, jamais un champ de
 * requête — un locataire ne choisit pas où part son jeton. La valeur est validée par le
 * même résolveur d'URL que les webhooks, donc une adresse privée est refusée hors
 * autorisation explicite de l'exploitant.
 */
function apiOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.OATHRION_GITHUB_API_ORIGIN?.trim();
  return raw && raw !== "" ? raw.replace(/\/+$/, "") : "https://api.github.com";
}

const USER_AGENT = "oathrion-connector/1";

/** La version d'API que GitHub demande d'épingler. Pas un défaut implicite. */
const GITHUB_API_VERSION = "2022-11-28";

interface GithubReply {
  status: number;
  ok: boolean;
  body: string;
  headers: Record<string, string>;
}

/**
 * Un appel à l'API, avec le jeton.
 *
 * `allowPrivate` suit `OATHRION_WEBHOOK_ALLOW_PRIVATE` plutôt qu'un réglage propre : un
 * exploitant qui a déjà autorisé les adresses privées pour ses webhooks a fait ce choix
 * une fois, et une seconde variable qui dit la même chose finit par en contredire une.
 */
async function callGithub(
  env: NodeJS.ProcessEnv,
  token: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<GithubReply> {
  const url = new URL(`${apiOrigin(env)}${path}`);
  const payload = body === undefined ? "" : JSON.stringify(body);

  const reply = await sendGuarded({
    url,
    method,
    headers: {
      /*
       * `Bearer`, la forme que GitHub documente aujourd'hui. `token <…>` fonctionne
       * encore et n'est plus celle de la documentation ; écrire les deux « au cas où »
       * enverrait deux en-têtes d'autorisation contradictoires.
       */
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": GITHUB_API_VERSION,
      "user-agent": USER_AGENT,
      ...(payload === "" ? {} : { "content-type": "application/json" }),
    },
    body: payload,
    timeoutMs: connectorTimeoutMs(env),
    captureBody: true,
    allowPrivate: env.OATHRION_WEBHOOK_ALLOW_PRIVATE === "true",
  });

  return {
    status: reply.status,
    ok: reply.ok,
    body: reply.body ?? "",
    headers: reply.headers ?? {},
  };
}

/** Le message que GitHub a donné, ou une description du statut. Jamais inventé. */
function githubMessage(reply: GithubReply): string {
  try {
    const parsed: unknown = JSON.parse(reply.body);
    if (parsed !== null && typeof parsed === "object" && "message" in parsed) {
      const message = (parsed as { message?: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") return message;
    }
  } catch {
    /* Un corps non-JSON est possible (page d'erreur d'un proxy) : on tombe plus bas. */
  }
  return `GitHub answered ${reply.status} without a usable message.`;
}

/**
 * Le statut HTTP traduit en code machine stable.
 *
 * `403` mérite un mot : GitHub l'emploie pour « permission insuffisante » ET pour
 * « quota dépassé ». Les deux se distinguent par `x-ratelimit-remaining: 0`, et les
 * confondre ferait dire à la console « jeton sans droits » là où il suffit d'attendre.
 *
 * Exportée pour être éprouvée sans réseau (`server/test/connector-github-errors.test.ts`) :
 * la distinction entre les deux 403 est la seule règle de ce fichier qu'un appel réel ne
 * montre pas — il faudrait épuiser le quota de GitHub pour l'observer.
 */
export function githubProbeCode(
  status: number,
  headers: Record<string, string> = {},
): ConnectorProbeCode {
  if (status >= 200 && status < 300) return "ok";
  /*
   * 401 couvre DEUX situations que GitHub ne distingue pas : un jeton faux et un jeton
   * EXPIRÉ. Les deux rendent « Bad credentials ». Oathrion ne peut donc pas annoncer
   * « votre jeton a expiré » — il rendrait une cause qu'il n'a pas observée. Le code est
   * `unauthorized` et le message est celui de GitHub ; `docs/connectors.md` dit pourquoi.
   */
  if (status === 401) return "unauthorized";
  if (status === 403) {
    return headers["x-ratelimit-remaining"] === "0" ? "rate_limited" : "forbidden";
  }
  if (status === 429) return "rate_limited";
  if (status === 404) return "not_found";
  return "unexpected";
}

/**
 * Ce qu'une personne doit FAIRE, selon le code. Le message de GitHub suit entre
 * parenthèses : il est exact et en anglais (« Bad credentials »), donc utile au support
 * et inutilisable seul par quelqu'un qui découvre l'écran.
 */
export function githubHumanError(code: ConnectorProbeCode, raw: string): string {
  const advice: Partial<Record<ConnectorProbeCode, string>> = {
    unauthorized:
      "GitHub refuses this token: it is wrong, expired or deleted. Create a new one and paste it whole.",
    forbidden:
      'GitHub refuses this operation for this token: check that it has "Issues: Read and write" on this repository.',
    not_found: "GitHub cannot find this repository, or the token has no access to it.",
    rate_limited: "GitHub is rate-limiting calls: try again in a few minutes.",
    unreachable: "GitHub is temporarily unreachable: try again in a moment.",
  };
  return `${advice[code] ?? "GitHub refused the call."} (GitHub: ${raw})`;
}

function codeFor(reply: GithubReply): ConnectorProbeCode {
  return githubProbeCode(reply.status, reply.headers);
}

/** Les portées que GITHUB annonce pour ce jeton, pas celles qu'on espérait. */
function scopesFrom(reply: GithubReply): string[] {
  const raw = reply.headers["x-oauth-scopes"] ?? "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function loginFrom(reply: GithubReply): string {
  try {
    const parsed: unknown = JSON.parse(reply.body);
    if (parsed !== null && typeof parsed === "object" && "login" in parsed) {
      const login = (parsed as { login?: unknown }).login;
      if (typeof login === "string") return login;
    }
  } catch {
    /* Pas de login lisible : l'appelant verra un compte vide, ce qui est la vérité. */
  }
  return "";
}

/** Un segment de chemin GitHub : propriétaire ou nom de dépôt. */
const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

export class RepositoryTargetError extends Error {}

/**
 * Découpe la cible d'une action GitHub. La forme est `<hôte>/<propriétaire>/<dépôt>`.
 *
 * ## POURQUOI L'HÔTE EST OBLIGATOIRE, ET CE N'EST PAS UNE PRÉFÉRENCE DE STYLE
 *
 * `owner/repo` paraissait la forme évidente. Elle a été écrite, puis
 * `server/test/connector-control-point.test.ts` a rendu BLOCK sur une action censée
 * passer, avec ce motif : « "placet-labs/pilote" does not resolve to a destination that
 * can be checked against the agent's approved domains ».
 *
 * Le moteur avait raison. Les trois verbes GitHub sont déclarés `outbound` dans
 * `shared/policy/actions.ts`, donc l'allowlist de domaine du mandat les gouverne — et
 * `extractHost` ne peut lire aucun hôte dans `placet-labs/pilote`. Un mandat ne pouvait
 * donc jamais autoriser une action GitHub, et la seule façon d'en faire passer une aurait
 * été de vider l'allowlist de l'agent ou de retirer `outbound` du catalogue : dans les
 * deux cas, rendre l'action ingouvernable pour qu'elle marche.
 *
 * L'hôte dans la cible est l'inverse : un exploitant écrit `github.com` dans le mandat de
 * son agent, et ce mandat devient la barrière qui décide. C'est exactement la
 * gouvernance demandée, et elle était déjà là — il manquait une cible que le moteur
 * puisse lire.
 *
 * ## Et la validation des segments n'est pas cosmétique
 *
 * La cible est interpolée dans un chemin d'API. Une valeur comme `a/b/../../user`, ou
 * contenant un `?`, atteindrait un autre point de terminaison que celui que la politique
 * a autorisé : le verbe permis était « commenter une issue », la requête partie serait
 * autre chose.
 */
export function parseRepository(target: string): { host: string; owner: string; repo: string } {
  const trimmed = target.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");

  if (parts.length === 2 && SEGMENT.test(parts[0]!) && SEGMENT.test(parts[1]!)) {
    /*
     * La forme courte est refusée EXPLICITEMENT plutôt que tolérée. Tolérée, elle
     * produirait un BLOCK du mandat dont le motif parle d'une destination illisible —
     * un message exact et incompréhensible pour qui a simplement écrit la cible trop
     * court. Ici l'erreur dit quoi écrire.
     */
    throw new RepositoryTargetError(
      `The target ${JSON.stringify(target)} names no host. Write ` +
        `"github.com/${parts[0]!}/${parts[1]!}". The host is required because GitHub verbs ` +
        `are declared "outbound": the domain allowlist of the agent's mandate authorises ` +
        `the destination, and it cannot check a target where no host is readable.`,
    );
  }

  if (parts.length !== 3 || !SEGMENT.test(parts[1]!) || !SEGMENT.test(parts[2]!)) {
    throw new RepositoryTargetError(
      `The target ${JSON.stringify(target)} is not a GitHub repository. Expected ` +
        `"github.com/owner/repo". The target is interpolated into an API path: a free ` +
        `value would reach another endpoint than the one authorised.`,
    );
  }

  const host = parts[0]!.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) || !/\.[a-z]{2,}$/.test(host)) {
    throw new RepositoryTargetError(
      `The target ${JSON.stringify(target)} does not start with a readable host. ` +
        `Expected "github.com/owner/repo".`,
    );
  }

  return { host, owner: parts[1]!, repo: parts[2]! };
}

function readString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

export class GithubConnector implements Connector {
  readonly id = GITHUB_CONNECTOR_ID;
  readonly label = "GitHub";
  readonly description =
    "Lists repositories, reads a repository, searches its issues and pull requests, opens an " +
    "issue, comments. " +
    "Real HTTPS calls to api.github.com.";

  readonly actions = [
    "github.repos.list",
    "github.repo.read",
    "github.issue.search",
    "github.issue.create",
    "github.issue.comment",
  ] as const;

  readonly credentialGuide =
    "Create a fine-grained token at https://github.com/settings/personal-access-tokens/new: " +
    'choose the repository concerned under "Repository access", then under "Repository permissions" ' +
    'set "Issues" to "Read and write" and "Metadata" to "Read-only" (GitHub requires it). ' +
    "Grant nothing else. Copy the token (it starts with github_pat_) and paste it here: " +
    "Oathrion seals it with AES-256-GCM and will never show it again. " +
    'To really revoke it, delete the token on that same GitHub page — "Disconnect" ' +
    "in Oathrion forgets it but does not invalidate it at GitHub. " +
    'On the Oathrion side: an action\'s target is written "github.com/owner/repo" (the host is required, ' +
    "it is what the domain allowlist of the agent's mandate authorises), so the agent's " +
    'mandate must list "github.com".';

  /** `GET /user` — le seul appel qui dit si un jeton est vivant ET à qui il appartient. */
  async credentialAlive(secret: string, env: NodeJS.ProcessEnv): Promise<CredentialLiveness> {
    let reply: GithubReply;
    try {
      reply = await callGithub(env, secret.trim(), "GET", "/user");
    } catch (error) {
      return { state: "unknown", detail: `The GitHub API is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const code = codeFor(reply);
    if (code === "ok") return { state: "alive", detail: `GitHub still accepts this key (account ${loginFrom(reply)}).` };
    /* 403 : GitHub RECONNAÎT la clé et refuse l'opération — elle ouvre encore d'autres portes. */
    if (code === "forbidden") return { state: "alive", detail: "GitHub still recognises this key (limited access, but valid)." };
    if (code === "unauthorized") return { state: "dead", detail: "GitHub refuses this key: it is revoked, expired or unknown." };
    return { state: "unknown", detail: githubHumanError(code, githubMessage(reply)) };
  }

  async verify(
    secret: string,
    _options: { account?: string },
    env: NodeJS.ProcessEnv,
  ): Promise<ConnectorProbe> {
    if (secret.trim() === "") {
      return {
        ok: false,
        account: "",
        scopes: [],
        code: "unauthorized",
        detail: "No token given. Oathrion does not test a connection without a credential.",
      };
    }

    let reply: GithubReply;
    try {
      reply = await callGithub(env, secret, "GET", "/user");
    } catch (error) {
      /*
       * Une panne de transport n'est PAS un jeton invalide. Les confondre ferait
       * afficher « jeton refusé » lors d'une coupure réseau, et un exploitant
       * régénérerait un jeton qui n'avait rien.
       */
      return {
        ok: false,
        account: "",
        scopes: [],
        code: "unreachable",
        detail: `The GitHub API is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (!reply.ok) {
      return {
        ok: false,
        account: "",
        scopes: scopesFrom(reply),
        code: codeFor(reply),
        detail: githubHumanError(codeFor(reply), githubMessage(reply)),
      };
    }

    const login = loginFrom(reply);
    const scopes = scopesFrom(reply);
    return {
      ok: true,
      account: login,
      scopes,
      code: "ok",
      /*
       * Un jeton à portée fine n'envoie PAS `x-oauth-scopes` — l'en-tête n'existe que
       * pour les jetons classiques. Le dire explicitement évite qu'un exploitant lise
       * « aucune portée » comme « jeton sans droits » alors que ses permissions sont
       * déclarées par dépôt et invisibles ici.
       */
      detail:
        scopes.length > 0
          ? `Connected as ${login}. Announced scopes: ${scopes.join(", ")}.`
          : `Connected as ${login}. GitHub announces no scope for this token, which ` +
            `is normal for a fine-grained token: its permissions are declared per repository ` +
            `and cannot be read through the API. A missing permission will show at the first call.`,
    };
  }

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const credential = await context.vault.open(this.id);
    if (!credential) {
      return {
        ok: false,
        account: "",
        scopes: [],
        code: "unauthorized",
        detail: "No GitHub credential is stored for this organisation.",
      };
    }
    return this.verify(credential.secretEnvelope, {}, context.env);
  }

  /**
   * Ce que CE jeton peut faire.
   *
   * Deux régimes, et ils ne se devinent pas l'un l'autre :
   *
   * Un jeton CLASSIQUE annonce ses portées dans `x-oauth-scopes` : la réponse est alors
   * déduite de ce que GitHub a dit.
   *
   * Un jeton à PORTÉE FINE n'annonce rien. Prétendre alors que l'écriture est disponible
   * serait une affirmation sans fondement — et prétendre qu'elle ne l'est pas serait
   * faux la plupart du temps. `available: false` avec un motif qui nomme l'inconnue est
   * la seule réponse honnête : la permission se confirme au premier appel réel.
   */
  async capabilities(context: ConnectorContext): Promise<ConnectorCapability[]> {
    const probe = await this.test(context);
    const label: Record<string, string> = {
      "github.repos.list": "See the accessible repositories",
      "github.issue.search": "Search a repository's issues and pull requests",
      "github.repo.read": "Read a repository, its issues and its pull requests",
      "github.issue.create": "Open an issue",
      "github.issue.comment": "Comment on an issue or a pull request",
    };

    if (!probe.ok) {
      return this.actions.map((action) => ({
        action,
        label: label[action] ?? action,
        available: false,
        reason: probe.detail,
      }));
    }

    const classic = probe.scopes.length > 0;
    const canWrite = probe.scopes.includes("repo") || probe.scopes.includes("public_repo");

    return this.actions.map((action) => {
      if (action === "github.repo.read" || action === "github.repos.list" || action === "github.issue.search") {
        return { action, label: label[action]!, available: true };
      }
      if (classic) {
        return {
          action,
          label: label[action]!,
          available: canWrite,
          ...(canWrite ? {} : { reason: `The token has neither "repo" nor "public_repo": ${probe.scopes.join(", ") || "no scope"}.` }),
        };
      }
      return {
        action,
        label: label[action]!,
        available: false,
        reason:
          "Fine-grained token: GitHub does not expose its permissions through the API, so Oathrion " +
          'cannot assert it before a first call. Check "Issues: Read and write" ' +
          "on the token's page.",
      };
    });
  }

  /**
   * Agit. Atteindre cette méthode signifie qu'un ALLOW a déjà été rendu.
   *
   * Aucune vérification de politique ici, et c'est délibéré : ce serait une seconde
   * autorité, donc une seconde chance de dire oui là où la passerelle dit non.
   */
  async execute(
    context: ConnectorContext,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const credential = await context.vault.open(this.id);
    if (!credential) {
      /*
       * Un échec NOMMÉ. L'action a été autorisée, donc l'appelant doit apprendre que
       * rien n'est parti et pourquoi — jamais un succès silencieux.
       */
      return {
        ok: false,
        code: "unauthorized",
        summary: "No GitHub credential is connected: nothing was sent.",
        data: { dispatched: false, reason: "connector_not_connected" },
      };
    }

    if (request.action === "github.repos.list") {
      const listed = await this.listRepositories(context.env, credential.secretEnvelope).catch((error: unknown) => ({
        ok: false as const,
        code: "unreachable" as const,
        detail: `The call to GitHub failed before any answer: ${error instanceof Error ? error.message : String(error)}`,
      }));
      if (!listed.ok) {
        return { ok: false, code: listed.code, summary: listed.detail, data: { dispatched: true, reason: listed.code } };
      }
      return {
        ok: true,
        code: "ok",
        summary: `${String(listed.resources.length)} accessible repository(ies).`,
        data: { dispatched: true, repositories: listed.resources.map((r) => r.target) },
      };
    }

    let repository: { owner: string; repo: string };
    try {
      repository = parseRepository(request.target);
    } catch (error) {
      return {
        ok: false,
        code: "unexpected",
        summary: error instanceof Error ? error.message : String(error),
        data: { dispatched: false, reason: "invalid_target" },
      };
    }

    const { owner, repo } = repository;
    const token = credential.secretEnvelope;

    /*
     * `return await`, et non `return` : une promesse RENDUE depuis un `try` sans être
     * attendue sort du bloc avant d'échouer, et son rejet passe à côté du `catch`. C'était
     * le cas ici jusqu'au 27 octobre 2026 (audit de l'interface, STRESS-TEST-LOG §5.39) :
     * un délai dépassé chez GitHub remontait comme une exception brute, sans
     * `dispatched: "unknown"`, et une issue peut-être créée restait REJOUABLE — donc
     * doublable. Slack, Linear et Stripe attendaient déjà leurs appels.
     */
    try {
      switch (request.action) {
        case "github.repo.read":
          return await this.readRepository(context.env, token, owner, repo);
        case "github.issue.search":
          return await this.searchIssues(context.env, token, owner, repo, request);
        case "github.issue.create":
          return await this.createIssue(context.env, token, owner, repo, request);
        case "github.issue.comment":
          return await this.commentIssue(context.env, token, owner, repo, request);
        default:
          return {
            ok: false,
            code: "unexpected",
            summary: `The GitHub connector does not serve the verb "${request.action}".`,
            data: { dispatched: false, reason: "unsupported_action" },
          };
      }
    } catch (error) {
      return transportFailure("GitHub", error);
    }
  }

  private async readRepository(
    env: NodeJS.ProcessEnv,
    token: string,
    owner: string,
    repo: string,
  ): Promise<ConnectorExecuteResult> {
    const reply = await callGithub(env, token, "GET", `/repos/${owner}/${repo}`);
    if (!reply.ok) {
      return {
        ok: false,
        code: codeFor(reply),
        summary: `GitHub refused the read of ${owner}/${repo}: ${githubMessage(reply)}`,
        data: { dispatched: true, status: reply.status, reason: codeFor(reply) },
      };
    }
    const parsed = JSON.parse(reply.body) as {
      full_name?: string;
      private?: boolean;
      open_issues_count?: number;
      default_branch?: string;
    };
    return {
      ok: true,
      code: "ok",
      summary: `Repository ${parsed.full_name ?? `${owner}/${repo}`} read.`,
      data: {
        dispatched: true,
        repository: parsed.full_name ?? `${owner}/${repo}`,
        private: parsed.private ?? null,
        openIssues: parsed.open_issues_count ?? null,
        defaultBranch: parsed.default_branch ?? null,
      },
    };
  }

  /**
   * Les issues et pull requests d'UN dépôt. `GET /repos/{o}/{r}/issues` et non l'API de
   * recherche globale : celle-ci accepte une requête libre (`repo:autre/depot`), donc une
   * cible autorisée pourrait lire un autre dépôt. Ici, le dépôt est dans le chemin.
   */
  private async searchIssues(
    env: NodeJS.ProcessEnv,
    token: string,
    owner: string,
    repo: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const state = request.metadata.state === "closed" || request.metadata.state === "all" ? request.metadata.state : "open";
    const raw = Number(request.metadata.limit ?? 20);
    const perPage = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), 50) : 20;
    const query = readString(request.metadata, "query")?.toLowerCase() ?? null;
    const reply = await callGithub(
      env,
      token,
      "GET",
      `/repos/${owner}/${repo}/issues?state=${state}&per_page=${String(perPage)}&sort=updated`,
    );
    if (!reply.ok) {
      return {
        ok: false,
        code: codeFor(reply),
        summary: `GitHub refused the read of the issues of ${owner}/${repo}: ${githubMessage(reply)}`,
        data: { dispatched: true, status: reply.status, reason: codeFor(reply) },
      };
    }
    const parsed = JSON.parse(reply.body) as unknown;
    const items = (Array.isArray(parsed) ? parsed : [])
      .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
      .map((i) => ({
        number: typeof i.number === "number" ? i.number : null,
        title: typeof i.title === "string" ? i.title.slice(0, 300) : "",
        kind: i.pull_request ? "pull_request" : "issue",
        state: typeof i.state === "string" ? i.state : null,
        url: typeof i.html_url === "string" ? i.html_url : null,
      }))
      .filter((i) => query === null || i.title.toLowerCase().includes(query));
    return {
      ok: true,
      code: "ok",
      summary: `${String(items.length)} issue(s) or pull request(s) in ${owner}/${repo}.`,
      data: { dispatched: true, repository: `${owner}/${repo}`, items },
    };
  }

  /** Les dépôts que CE jeton atteint. Cinq pages de cent au plus. */
  private async listRepositories(env: NodeJS.ProcessEnv, token: string): Promise<ConnectorResourceListing> {
    const resources: { target: string; label: string; detail?: string }[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const reply = await callGithub(env, token, "GET", `/user/repos?per_page=100&sort=updated&page=${String(page)}`);
      if (!reply.ok) return { ok: false, code: codeFor(reply), detail: githubMessage(reply) };
      const list = JSON.parse(reply.body) as unknown;
      const rows = Array.isArray(list) ? list : [];
      for (const row of rows) {
        if (row === null || typeof row !== "object") continue;
        const record = row as { full_name?: unknown; private?: unknown };
        if (typeof record.full_name !== "string") continue;
        resources.push({
          target: `github.com/${record.full_name}`,
          label: record.full_name,
          detail: record.private === true ? "private" : "public",
        });
      }
      if (rows.length < 100) break;
    }
    return { ok: true, resources };
  }

  /**
   * Réconciliation : les issues, pull requests et commentaires créés depuis `since` sur
   * les dépôts choisis, avec leur auteur et la marque `placet-execution` qu'Oathrion pose
   * dans chaque corps qu'il écrit.
   */
  async reconcile(context: ConnectorContext, options: { since: string; resources: string[] }): Promise<ReconcileListing> {
    const credential = await context.vault.open(this.id);
    if (!credential) return { ok: false, code: "unauthorized", detail: "GitHub is not connected for this organisation." };
    const token = credential.secretEnvelope;
    const env = context.env;
    const since = Date.parse(options.since);
    const markerOf = (body: unknown) => (typeof body === "string" ? /<!-- placet-execution: ([A-Za-z0-9_-]+) -->/.exec(body)?.[1] ?? null : null);
    try {
      const me = await callGithub(env, token, "GET", "/user");
      if (!me.ok) return { ok: false, code: codeFor(me), detail: githubHumanError(codeFor(me), githubMessage(me)) };
      const identity = loginFrom(me);
      const items: ReconcileItem[] = [];
      let truncated = false;
      const query = `since=${encodeURIComponent(options.since)}&per_page=100`;
      for (const resource of options.resources) {
        const { owner, repo } = parseRepository(resource);
        for (const [path, kind] of [
          [`/repos/${owner}/${repo}/issues?state=all&${query}`, "issue"],
          [`/repos/${owner}/${repo}/issues/comments?${query}`, "comment"],
        ] as const) {
          const reply = await callGithub(env, token, "GET", path);
          if (!reply.ok) return { ok: false, code: codeFor(reply), detail: githubHumanError(codeFor(reply), githubMessage(reply)) };
          const list = JSON.parse(reply.body || "[]") as Record<string, unknown>[];
          if (list.length >= 100) truncated = true;
          for (const entry of Array.isArray(list) ? list : []) {
            const createdAt = typeof entry.created_at === "string" ? entry.created_at : "";
            /* `since` filtre sur la MISE À JOUR : on ne garde que ce qui a été CRÉÉ dans la fenêtre. */
            if (!createdAt || Date.parse(createdAt) < since) continue;
            const author = (entry.user as { login?: unknown } | undefined)?.login;
            const login = typeof author === "string" ? author : null;
            const number = typeof entry.number === "number" ? entry.number : null;
            const issueOf = typeof entry.issue_url === "string" ? entry.issue_url.split("/").pop() : null;
            items.push({
              kind: kind === "comment" ? "comment" : entry.pull_request ? "pull_request" : "issue",
              id: kind === "comment" ? `${owner}/${repo}#comment-${String(entry.id)}` : `${owner}/${repo}#${String(number)}`,
              url: typeof entry.html_url === "string" ? entry.html_url : null,
              createdAt,
              actor: login,
              summary:
                kind === "comment"
                  ? `Comment on ${owner}/${repo}#${String(issueOf)}`
                  : String(entry.title ?? "").slice(0, 140),
              marker: markerOf(entry.body),
              byOathrionIdentity: login !== null && login.toLowerCase() === identity.toLowerCase(),
            });
          }
        }
      }
      return {
        ok: true,
        identity,
        items,
        truncated,
        limits: [
          "Only the chosen repositories are read, and the last 100 issues and 100 comments of each.",
          "A deleted issue or comment is no longer visible.",
          `A write made under ANOTHER GitHub account than ${identity} is counted as "other author", without being judged: it may be a colleague.`,
          `With a personal token, Oathrion acts under the account ${identity}: an issue that person opens themselves shows up as "outside Oathrion". An account dedicated to Oathrion avoids this confusion.`,
        ],
      };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `GitHub is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async resources(context: ConnectorContext): Promise<ConnectorResourceListing> {
    const credential = await context.vault.open(this.id);
    if (!credential) return { ok: false, code: "unauthorized", detail: "GitHub is not connected for this organisation." };
    try {
      return await this.listRepositories(context.env, credential.secretEnvelope);
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `GitHub is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  private async createIssue(
    env: NodeJS.ProcessEnv,
    token: string,
    owner: string,
    repo: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const title = readString(request.metadata, "title");
    if (!title) {
      return {
        ok: false,
        code: "unexpected",
        summary: "No title: nothing was sent to GitHub.",
        data: { dispatched: false, reason: "missing_title" },
      };
    }

    /*
     * LA CLÉ D'IDEMPOTENCE DANS LE CORPS, ET POURQUOI C'EST LA SEULE OPTION.
     *
     * L'API GitHub n'a pas d'en-tête d'idempotence : rejouer `POST /issues` crée une
     * seconde issue. Oathrion garantit qu'un grant n'est consommé qu'une fois, donc il ne
     * rejoue pas lui-même — mais si la réponse se perd sur le réseau, Oathrion voit un
     * échec là où l'issue existe. Inscrire l'identifiant d'exécution dans le corps rend
     * le doublon RECONNAISSABLE par un humain et par une recherche. C'est tout ce que
     * Oathrion peut honnêtement offrir ici, et `docs/connectors.md` le dit.
     */
    const body =
      (readString(request.metadata, "body") ?? "") +
      `\n\n<!-- placet-execution: ${request.executionId} -->`;

    const reply = await callGithub(env, token, "POST", `/repos/${owner}/${repo}/issues`, {
      title,
      body,
    });

    if (!reply.ok) {
      return {
        ok: false,
        code: codeFor(reply),
        summary: `GitHub refused to open the issue: ${githubMessage(reply)}`,
        data: { dispatched: true, status: reply.status, reason: codeFor(reply) },
      };
    }

    const parsed = JSON.parse(reply.body) as { number?: number; html_url?: string };
    return {
      ok: true,
      code: "ok",
      summary: `Issue #${String(parsed.number ?? "?")} opened on ${owner}/${repo}.`,
      data: {
        dispatched: true,
        issueNumber: parsed.number ?? null,
        url: parsed.html_url ?? null,
        executionId: request.executionId,
      },
    };
  }

  private async commentIssue(
    env: NodeJS.ProcessEnv,
    token: string,
    owner: string,
    repo: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const raw = request.metadata.issue;
    const issue = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
    if (!Number.isSafeInteger(issue) || issue <= 0) {
      return {
        ok: false,
        code: "unexpected",
        summary: `Invalid issue number (${String(raw)}): nothing was sent.`,
        data: { dispatched: false, reason: "missing_issue_number" },
      };
    }
    const comment = readString(request.metadata, "body");
    if (!comment) {
      return {
        ok: false,
        code: "unexpected",
        summary: "No comment body: nothing was sent.",
        data: { dispatched: false, reason: "missing_body" },
      };
    }

    const reply = await callGithub(
      env,
      token,
      "POST",
      `/repos/${owner}/${repo}/issues/${String(issue)}/comments`,
      { body: `${comment}\n\n<!-- placet-execution: ${request.executionId} -->` },
    );

    if (!reply.ok) {
      return {
        ok: false,
        code: codeFor(reply),
        summary: `GitHub refused the comment: ${githubMessage(reply)}`,
        data: { dispatched: true, status: reply.status, reason: codeFor(reply) },
      };
    }

    const parsed = JSON.parse(reply.body) as { id?: number; html_url?: string };
    return {
      ok: true,
      code: "ok",
      summary: `Comment posted on ${owner}/${repo}#${String(issue)}.`,
      data: {
        dispatched: true,
        commentId: parsed.id ?? null,
        url: parsed.html_url ?? null,
        executionId: request.executionId,
      },
    };
  }

  async revoke(context: ConnectorContext, by: string): Promise<ConnectorRevocation> {
    const forgotten = await context.vault.revoke(this.id, by);
    return {
      ok: forgotten,
      /*
       * `true`, et c'est la vérité la plus importante de ce fichier. GitHub n'offre
       * aucune API permettant à un tiers d'invalider un jeton d'accès personnel : seul
       * son créateur peut le supprimer. Écrire `false` serait confortable et faux.
       */
      remoteStillValid: true,
      detail: forgotten
        ? "Oathrion forgot the token. GitHub considers it STILL VALID: delete it at " +
          "https://github.com/settings/tokens to really neutralise it."
        : "No GitHub credential was stored for this organisation.",
    };
  }
}

/** Le contexte d'un connecteur, construit pour un locataire. */
export function connectorContextFor(
  organizationId: OrganizationId,
  vault: ConnectorContext["vault"],
  env: NodeJS.ProcessEnv = process.env,
): ConnectorContext {
  return { organizationId, vault, env };
}
