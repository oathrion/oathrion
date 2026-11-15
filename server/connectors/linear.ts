/**
 * Le connecteur Linear — RÉEL. Appels HTTPS authentifiés à api.linear.app/graphql.
 *
 * ## Ce qu'il fait réellement
 *
 * `verify` interroge `viewer` et `organization` : la personne et l'espace de travail tels
 * que LINEAR les nomme. Quatre verbes :
 *
 *   · `linear.teams.list`     — les équipes accessibles.
 *   · `linear.issue.search`   — les issues d'UNE équipe, filtrées par un texte.
 *   · `linear.issue.create`   — créer une issue dans UNE équipe.
 *   · `linear.comment.create` — commenter UNE issue.
 *
 * ## Les cibles nomment l'équipe, et c'est ce qui rend le choix gouvernable
 *
 *     linear.app                      la liste des équipes
 *     linear.app/ENG                  une équipe (recherche, création)
 *     linear.app/ENG/ENG-123          une issue de cette équipe (commentaire)
 *
 * La clé d'équipe est dans la cible, donc une politique « seulement l'équipe ENG » se
 * lit sur la cible, comme un dépôt GitHub ou un canal Slack. Et pour un commentaire,
 * le connecteur VÉRIFIE que l'issue appartient bien à l'équipe nommée : sans cela,
 * `linear.app/ENG/OPS-9` passerait une règle écrite pour ENG et écrirait chez OPS.
 *
 * ## Un identifiant fourni — et une garantie NON VÉRIFIÉE
 *
 * `issueCreate` accepte un `id` (UUID) fourni par l'appelant. Oathrion le dérive de
 * l'identifiant d'exécution, donc une même exécution envoie toujours le même UUID. Que
 * Linear REFUSE un second `issueCreate` portant le même identifiant est attendu d'une
 * clé primaire, mais n'a pas été vérifié contre le service réel : la règle de rejeu ne
 * s'y fie donc pas (`replaySafe`). `npm run verify:launch` le vérifie dès qu'une clé de
 * test Linear est fournie.
 *
 * ## Deux formes de credential
 *
 * Une clé d'API personnelle (`lin_api_…`) se passe telle quelle dans `Authorization`.
 * Un jeton OAuth se passe en `Bearer`. Les confondre donne un 400 d'authentification.
 */

import { createHash } from "node:crypto";

import { sendGuarded } from "../notifications/webhook-transport";
import { connectorTimeoutMs } from "./timeouts";
import { transportFailure } from "./transport-failure";
import { freshSecret, readOAuthSecret } from "./oauth-install";
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

export const LINEAR_CONNECTOR_ID = "linear";

/** Les portées OAuth demandées. `admin` n'en fait jamais partie. */
export const LINEAR_OAUTH_SCOPES = ["read", "issues:create", "comments:create"] as const;

export function linearApiOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.OATHRION_LINEAR_API_ORIGIN?.trim();
  return raw && raw !== "" ? raw.replace(/\/+$/, "") : "https://api.linear.app";
}

const SEARCH_MAX = 25;
const TITLE_MAX = 255;
const BODY_MAX = 10_000;

const TEAM_KEY = /^[A-Z][A-Z0-9_]{0,9}$/;
const ISSUE_KEY = /^([A-Z][A-Z0-9_]{0,9})-(\d{1,7})$/;

export class LinearTargetError extends Error {}

export interface LinearTarget {
  team: string | null;
  issue: string | null;
}

/** Découpe une cible Linear. Voir l'en-tête du fichier pour les trois formes. */
export function parseLinearTarget(target: string): LinearTarget {
  const trimmed = target.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts[0]?.toLowerCase() !== "linear.app") {
    throw new LinearTargetError(
      `The target ${JSON.stringify(target)} is not a Linear target. Expected "linear.app/KEY" ` +
        `(the team's key, for example ENG) or "linear.app/KEY/KEY-123" for an issue.`,
    );
  }
  if (parts.length === 1) return { team: null, issue: null };
  const team = parts[1]!.toUpperCase();
  if (!TEAM_KEY.test(team)) {
    throw new LinearTargetError(`"${parts[1]!}" is not a Linear team key (for example ENG).`);
  }
  if (parts.length === 2) return { team, issue: null };
  if (parts.length === 3) {
    const issue = parts[2]!.toUpperCase();
    const match = ISSUE_KEY.exec(issue);
    if (!match) {
      throw new LinearTargetError(`"${parts[2]!}" is not a Linear issue identifier (for example ${team}-123).`);
    }
    if (match[1] !== team) {
      throw new LinearTargetError(
        `Issue ${issue} does not belong to the team ${team} named in the target. ` +
          `A rule written for ${team} must not allow writing in ${match[1]!}.`,
      );
    }
    return { team, issue };
  }
  throw new LinearTargetError(`The target ${JSON.stringify(target)} has too many segments.`);
}

/** L'en-tête d'autorisation : brut pour une clé personnelle, `Bearer` pour OAuth. */
export function linearAuthorization(token: string): string {
  return token.startsWith("lin_api_") ? token : `Bearer ${token}`;
}

interface LinearReply {
  status: number;
  data: Record<string, unknown> | null;
  errors: { message: string; code: string }[];
}

async function callLinear(
  env: NodeJS.ProcessEnv,
  token: string,
  query: string,
  variables: Record<string, unknown> = {},
): Promise<LinearReply> {
  const reply = await sendGuarded({
    url: new URL(`${linearApiOrigin(env)}/graphql`),
    method: "POST",
    headers: {
      authorization: linearAuthorization(token),
      "content-type": "application/json",
      "user-agent": "oathrion-connector/1",
    },
    body: JSON.stringify({ query, variables }),
    timeoutMs: connectorTimeoutMs(env),
    captureBody: true,
    allowPrivate: env.OATHRION_WEBHOOK_ALLOW_PRIVATE === "true",
  });
  let data: Record<string, unknown> | null = null;
  const errors: { message: string; code: string }[] = [];
  try {
    const parsed = JSON.parse(reply.body ?? "") as { data?: unknown; errors?: unknown };
    if (parsed.data && typeof parsed.data === "object") data = parsed.data as Record<string, unknown>;
    if (Array.isArray(parsed.errors)) {
      for (const entry of parsed.errors) {
        if (entry === null || typeof entry !== "object") continue;
        const record = entry as { message?: unknown; extensions?: { code?: unknown } };
        errors.push({
          message: typeof record.message === "string" ? record.message : "",
          code: typeof record.extensions?.code === "string" ? record.extensions.code : "",
        });
      }
    }
  } catch {
    /* Un corps illisible (page d'erreur d'un proxy) : le statut seul parlera. */
  }
  return { status: reply.status, data, errors };
}

/** Exportée pour être éprouvée sans réseau. */
export function linearProbeCode(status: number, errors: { code: string; message: string }[]): ConnectorProbeCode {
  const codes = errors.map((e) => e.code.toUpperCase());
  const text = errors.map((e) => e.message.toLowerCase()).join(" ");
  if (status === 429 || codes.includes("RATELIMITED")) return "rate_limited";
  if (status === 401 || codes.includes("AUTHENTICATION_ERROR") || text.includes("authentication")) return "unauthorized";
  if (status === 403 || codes.includes("FORBIDDEN") || text.includes("forbidden") || text.includes("not authorized")) {
    return "forbidden";
  }
  if (text.includes("not found") || text.includes("entity not found") || codes.includes("NOT_FOUND")) return "not_found";
  if (errors.length === 0 && status >= 200 && status < 300) return "ok";
  return status >= 500 ? "unreachable" : "unexpected";
}

export function linearHumanError(code: ConnectorProbeCode, errors: { message: string }[]): string {
  const raw = errors.map((e) => e.message).filter((m) => m !== "").join(" ; ");
  const suffix = raw ? ` (Linear : ${raw.slice(0, 200)})` : "";
  switch (code) {
    case "unauthorized":
      return "Linear does not recognise this key, or this connection expired. Reconnect Linear." + suffix;
    case "forbidden":
      return "Linear refuses this operation for this account: check the permissions granted to Oathrion." + suffix;
    case "rate_limited":
      return "Linear is rate-limiting calls: try again in a minute." + suffix;
    case "not_found":
      return "Linear cannot find this item, or this account has no access to it." + suffix;
    case "unreachable":
      return "Linear is temporarily unavailable." + suffix;
    default:
      return "Linear refused the call." + suffix;
  }
}

/**
 * Un UUID v4 dérivé de l'identifiant d'exécution. Stable : la même exécution donne le
 * même UUID, ce qui rend un doublon détectable — et, si Linear le refuse comme attendu
 * (non vérifié contre le service réel), impossible.
 */
export function issueIdFor(executionId: string): string {
  const hex = createHash("sha256").update(`placet:${executionId}`).digest("hex");
  const variant = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function readString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function nodesOf(value: unknown): Record<string, unknown>[] {
  if (value === null || typeof value !== "object") return [];
  const nodes = (value as { nodes?: unknown }).nodes;
  return Array.isArray(nodes)
    ? nodes.filter((n): n is Record<string, unknown> => n !== null && typeof n === "object")
    : [];
}

const LABELS: Record<string, string> = {
  "linear.teams.list": "See the teams",
  "linear.issue.search": "Search and read the issues of an allowed team",
  "linear.issue.create": "Create an issue in an allowed team",
  "linear.comment.create": "Comment on an issue of an allowed team",
};

export type TeamListing =
  | { ok: true; teams: { id: string; key: string; name: string }[] }
  | { ok: false; code: ConnectorProbeCode; detail: string };

export class LinearConnector implements Connector {
  readonly id = LINEAR_CONNECTOR_ID;
  readonly label = "Linear";
  readonly description =
    "Sees the teams, searches their issues, creates an issue, comments. " +
    "Real HTTPS calls to api.linear.app.";

  readonly actions = [
    "linear.teams.list",
    "linear.issue.search",
    "linear.issue.create",
    "linear.comment.create",
  ] as const;

  readonly credentialGuide =
    "In Linear: Settings → Security & access (https://linear.app/settings/account/security) → " +
    'Personal API keys → "New API key". ' +
    "Give it a name (Oathrion), limit it to the teams concerned if possible, copy the key " +
    "(it starts with lin_api_) and paste it here. Oathrion seals it and will never show it " +
    "again. To neutralise it, delete it on that same Linear page.";

  /** Le jeton utilisable : clé brute, ou jeton d'accès OAuth lu dans le secret scellé. */
  private tokenOf(secret: string): string {
    return readOAuthSecret(secret)?.accessToken ?? secret.trim();
  }

  /**
   * Réconciliation : les tâches et commentaires créés depuis `since` dans les équipes
   * choisies. Oathrion termine chacun des siens par « exécution exe_… » ; une écriture du
   * MÊME compte sans cette marque a été faite par une autre route.
   */
  async reconcile(context: ConnectorContext, options: { since: string; resources: string[] }): Promise<ReconcileListing> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) return { ok: false, code: "unauthorized", detail: "Linear is not connected for this organisation." };
    const token = this.tokenOf(secret);
    const env = context.env;
    /*
     * `exe_` puis lettres et chiffres SEULEMENT : la marque est écrite en italique Markdown
     * (`_… exécution exe_abc_`), et un `_` admis dans la capture avalait celui qui ferme
     * l'italique — la tâche d'Oathrion passait alors pour une « marque inconnue ».
     */
    const markerOf = (text: unknown) => (typeof text === "string" ? /(?:exécution|execution) (exe_[A-Za-z0-9]+)/.exec(text)?.[1] ?? null : null);
    try {
      const me = await callLinear(env, token, "query { viewer { id name } organization { name urlKey } }");
      const meCode = linearProbeCode(me.status, me.errors);
      const viewer = me.data?.viewer as { id?: unknown; name?: unknown } | undefined;
      if (meCode !== "ok" || typeof viewer?.id !== "string") {
        const code = meCode === "ok" ? "unexpected" : meCode;
        return { ok: false, code, detail: linearHumanError(code, me.errors) };
      }
      const organization = me.data?.organization as { name?: unknown } | undefined;
      const items: ReconcileItem[] = [];
      let truncated = false;
      for (const resource of options.resources) {
        const team = parseLinearTarget(resource).team;
        if (!team) continue;
        const reply = await callLinear(
          env,
          token,
          `query($key: String!, $since: DateTimeOrDuration!) {
             issues(first: 100, filter: { team: { key: { eq: $key } }, createdAt: { gte: $since } }) {
               nodes { identifier title url description createdAt creator { id name } }
               pageInfo { hasNextPage }
             }
             comments(first: 100, filter: { issue: { team: { key: { eq: $key } } }, createdAt: { gte: $since } }) {
               nodes { id body url createdAt user { id name } issue { identifier } }
               pageInfo { hasNextPage }
             }
           }`,
          { key: team, since: options.since },
        );
        const code = linearProbeCode(reply.status, reply.errors);
        if (code !== "ok") return { ok: false, code, detail: linearHumanError(code, reply.errors) };
        const issues = reply.data?.issues as { nodes?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: unknown } } | undefined;
        const comments = reply.data?.comments as { nodes?: Record<string, unknown>[]; pageInfo?: { hasNextPage?: unknown } } | undefined;
        if (issues?.pageInfo?.hasNextPage === true || comments?.pageInfo?.hasNextPage === true) truncated = true;
        for (const issue of issues?.nodes ?? []) {
          const creator = issue.creator as { id?: unknown; name?: unknown } | undefined;
          items.push({
            kind: "task",
            id: String(issue.identifier ?? ""),
            url: typeof issue.url === "string" ? issue.url : null,
            createdAt: String(issue.createdAt ?? ""),
            actor: typeof creator?.name === "string" ? creator.name : null,
            summary: String(issue.title ?? "").slice(0, 140),
            marker: markerOf(issue.description),
            byOathrionIdentity: creator?.id === viewer.id,
          });
        }
        for (const comment of comments?.nodes ?? []) {
          const user = comment.user as { id?: unknown; name?: unknown } | undefined;
          const parent = (comment.issue as { identifier?: unknown } | undefined)?.identifier;
          items.push({
            kind: "comment",
            id: `${String(parent ?? team)}#comment-${String(comment.id ?? "")}`,
            url: typeof comment.url === "string" ? comment.url : null,
            createdAt: String(comment.createdAt ?? ""),
            actor: typeof user?.name === "string" ? user.name : null,
            summary: `Comment on ${String(parent ?? team)}`,
            marker: markerOf(comment.body),
            byOathrionIdentity: user?.id === viewer.id,
          });
        }
      }
      const name = typeof viewer.name === "string" ? viewer.name : viewer.id;
      return {
        ok: true,
        identity: `${name}${typeof organization?.name === "string" ? ` (${organization.name})` : ""}`,
        items,
        truncated,
        limits: [
          "Only the chosen teams are read, and the last 100 tasks and 100 comments of each.",
          `With a personal key, Oathrion acts under the account of ${name}: a task that person creates themselves in Linear shows up as "outside Oathrion". An OAuth connection or an account dedicated to Oathrion avoids this confusion.`,
          'A deleted task is no longer visible. Writes from other accounts are counted as "other author", without being judged.',
        ],
      };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `Linear is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async credentialAlive(secret: string, env: NodeJS.ProcessEnv): Promise<CredentialLiveness> {
    let reply: LinearReply;
    try {
      reply = await callLinear(env, this.tokenOf(secret), "query { viewer { id } }");
    } catch (error) {
      return { state: "unknown", detail: `Linear is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const code = linearProbeCode(reply.status, reply.errors);
    if (code === "ok") return { state: "alive", detail: "Linear still accepts this key." };
    if (code === "forbidden") return { state: "alive", detail: "Linear still recognises this key (limited access, but valid)." };
    if (code === "unauthorized") return { state: "dead", detail: "Linear refuses this key: it is revoked or unknown." };
    return { state: "unknown", detail: linearHumanError(code, reply.errors) };
  }

  async verify(secret: string, _options: { account?: string }, env: NodeJS.ProcessEnv): Promise<ConnectorProbe> {
    const token = this.tokenOf(secret);
    if (token === "") {
      return { ok: false, account: "", scopes: [], code: "unauthorized", detail: "No key given." };
    }
    let reply: LinearReply;
    try {
      reply = await callLinear(env, token, "query { viewer { id name email } organization { name urlKey } }");
    } catch (error) {
      return {
        ok: false,
        account: "",
        scopes: [],
        code: "unreachable",
        detail: `Linear is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const code = linearProbeCode(reply.status, reply.errors);
    const viewer = reply.data?.viewer as { name?: unknown; email?: unknown } | undefined;
    const organization = reply.data?.organization as { name?: unknown } | undefined;
    if (code !== "ok" || !viewer) {
      const failed = code === "ok" ? "unexpected" : code;
      return { ok: false, account: "", scopes: [], code: failed, detail: linearHumanError(failed, reply.errors) };
    }
    const person = typeof viewer.name === "string" ? viewer.name : "";
    const workspace = typeof organization?.name === "string" ? organization.name : "";
    const oauth = readOAuthSecret(secret);
    return {
      ok: true,
      account: workspace ? `${workspace} (${person})` : person,
      scopes: oauth?.scopes ?? [],
      code: "ok",
      detail: oauth
        ? `Connected to the Linear workspace ${workspace} as ${person}.`
        : `Connected to the Linear workspace ${workspace} as ${person}. A personal key acts with ` +
          `that person's rights: Oathrion limits actions through its rules, not through the key.`,
    };
  }

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) {
      return { ok: false, account: "", scopes: [], code: "unauthorized", detail: "Linear is not connected for this organisation." };
    }
    return this.verify(secret, {}, context.env);
  }

  async capabilities(context: ConnectorContext): Promise<ConnectorCapability[]> {
    const probe = await this.test(context);
    const credential = probe.ok ? await context.vault.open(this.id) : null;
    const oauth = credential ? readOAuthSecret(credential.secretEnvelope) : null;
    return this.actions.map((action) => {
      if (!probe.ok) return { action, label: LABELS[action]!, available: false, reason: probe.detail };
      if (oauth) {
        const write = oauth.scopes.includes("write");
        const needed =
          action === "linear.issue.create" ? "issues:create" : action === "linear.comment.create" ? "comments:create" : "read";
        const available = write || oauth.scopes.includes(needed);
        return available
          ? { action, label: LABELS[action]!, available: true }
          : { action, label: LABELS[action]!, available: false, reason: `Linear did not grant "${needed}" to Oathrion.` };
      }
      /* Une clé personnelle a les droits de son auteur : Linear ne les expose pas. */
      return { action, label: LABELS[action]!, available: true };
    });
  }

  async listTeamsFor(env: NodeJS.ProcessEnv, secret: string): Promise<TeamListing> {
    const reply = await callLinear(env, this.tokenOf(secret), "query { teams(first: 100) { nodes { id key name } } }");
    const code = linearProbeCode(reply.status, reply.errors);
    if (code !== "ok") return { ok: false, code, detail: linearHumanError(code, reply.errors) };
    const teams = nodesOf(reply.data?.teams)
      .filter((t) => typeof t.id === "string" && typeof t.key === "string")
      .map((t) => ({ id: t.id as string, key: t.key as string, name: typeof t.name === "string" ? t.name : (t.key as string) }));
    return { ok: true, teams };
  }

  async execute(context: ConnectorContext, request: ConnectorExecuteRequest): Promise<ConnectorExecuteResult> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) {
      return {
        ok: false,
        code: "unauthorized",
        summary: "Linear is not connected: nothing was sent.",
        data: { dispatched: false, reason: "connector_not_connected" },
      };
    }
    let target: LinearTarget;
    try {
      target = parseLinearTarget(request.target);
    } catch (error) {
      return {
        ok: false,
        code: "unexpected",
        summary: error instanceof Error ? error.message : String(error),
        data: { dispatched: false, reason: "invalid_target" },
      };
    }
    try {
      switch (request.action) {
        case "linear.teams.list": {
          const listed = await this.listTeamsFor(context.env, secret);
          if (!listed.ok) return { ok: false, code: listed.code, summary: listed.detail, data: { dispatched: true, reason: listed.code } };
          return {
            ok: true,
            code: "ok",
            summary: `${String(listed.teams.length)} Linear team(s).`,
            data: { dispatched: true, teams: listed.teams.map(({ key, name }) => ({ key, name })) },
          };
        }
        case "linear.issue.search":
          if (!target.team) return missing("a team", "linear.app/ENG");
          return await this.search(context.env, secret, target.team, request);
        case "linear.issue.create":
          if (!target.team || target.issue) return missing("a team (without an issue)", "linear.app/ENG");
          return await this.create(context.env, secret, target.team, request);
        case "linear.comment.create":
          if (!target.team || !target.issue) return missing("an issue", "linear.app/ENG/ENG-123");
          return await this.comment(context.env, secret, target.team, target.issue, request);
        default:
          return {
            ok: false,
            code: "unexpected",
            summary: `The Linear connector does not serve the verb "${request.action}".`,
            data: { dispatched: false, reason: "unsupported_action" },
          };
      }
    } catch (error) {
      return transportFailure("Linear", error);
    }
  }

  private failure(reply: LinearReply, dispatched = true): ConnectorExecuteResult {
    const raw = linearProbeCode(reply.status, reply.errors);
    const code = raw === "ok" ? "unexpected" : raw;
    return { ok: false, code, summary: linearHumanError(code, reply.errors), data: { dispatched, reason: code } };
  }

  private async search(
    env: NodeJS.ProcessEnv,
    secret: string,
    team: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const text = readString(request.metadata, "query");
    const raw = Number(request.metadata.limit ?? 10);
    const first = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), SEARCH_MAX) : 10;
    const filter: Record<string, unknown> = { team: { key: { eq: team } } };
    if (text) filter.title = { containsIgnoreCase: text.slice(0, 200) };
    const reply = await callLinear(
      env,
      this.tokenOf(secret),
      `query($filter: IssueFilter, $first: Int) {
         issues(filter: $filter, first: $first, orderBy: updatedAt) {
           nodes { identifier title url priority state { name } }
         }
       }`,
      { filter, first },
    );
    if (linearProbeCode(reply.status, reply.errors) !== "ok") return this.failure(reply);
    const issues = nodesOf(reply.data?.issues).map((n) => ({
      identifier: typeof n.identifier === "string" ? n.identifier : "",
      title: typeof n.title === "string" ? n.title.slice(0, 300) : "",
      url: typeof n.url === "string" ? n.url : null,
      priority: typeof n.priority === "number" ? n.priority : null,
      state: typeof (n.state as { name?: unknown } | null)?.name === "string" ? (n.state as { name: string }).name : null,
    }));
    return {
      ok: true,
      code: "ok",
      summary: `${String(issues.length)} issue(s) found in the team ${team}.`,
      data: { dispatched: true, team, issues },
    };
  }

  private async teamId(env: NodeJS.ProcessEnv, secret: string, key: string): Promise<string | LinearReply> {
    const reply = await callLinear(
      env,
      this.tokenOf(secret),
      "query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id key } } }",
      { key },
    );
    if (linearProbeCode(reply.status, reply.errors) !== "ok") return reply;
    const node = nodesOf(reply.data?.teams).find((t) => t.key === key);
    return typeof node?.id === "string" ? node.id : { ...reply, errors: [{ message: `Team ${key} not found`, code: "NOT_FOUND" }] };
  }

  private async create(
    env: NodeJS.ProcessEnv,
    secret: string,
    team: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const title = readString(request.metadata, "title");
    if (!title) {
      return { ok: false, code: "unexpected", summary: "No title: nothing was sent to Linear.", data: { dispatched: false, reason: "missing_title" } };
    }
    if (title.length > TITLE_MAX) {
      return { ok: false, code: "unexpected", summary: `Title too long (${String(TITLE_MAX)} characters at most).`, data: { dispatched: false, reason: "title_too_long" } };
    }
    const description = readString(request.metadata, "description") ?? "";
    if (description.length > BODY_MAX) {
      return { ok: false, code: "unexpected", summary: "Description too long.", data: { dispatched: false, reason: "description_too_long" } };
    }
    const priorityRaw = request.metadata.priority;
    let priority: number | undefined;
    if (priorityRaw !== undefined && priorityRaw !== null && priorityRaw !== "") {
      const value = Number(priorityRaw);
      if (!Number.isInteger(value) || value < 0 || value > 4) {
        return { ok: false, code: "unexpected", summary: "Invalid priority: 0 (none) to 4 (low).", data: { dispatched: false, reason: "invalid_priority" } };
      }
      priority = value;
    }

    const teamId = await this.teamId(env, secret, team);
    if (typeof teamId !== "string") return this.failure(teamId);

    const id = issueIdFor(request.executionId);
    const reply = await callLinear(
      env,
      this.tokenOf(secret),
      `mutation($input: IssueCreateInput!) {
         issueCreate(input: $input) { success issue { id identifier title url } }
       }`,
      {
        input: {
          id,
          teamId,
          title,
          description: `${description}${description ? "\n\n" : ""}_Created via Oathrion — execution ${request.executionId}_`,
          ...(priority !== undefined ? { priority } : {}),
        },
      },
    );
    const created = (reply.data?.issueCreate as { success?: unknown; issue?: Record<string, unknown> } | undefined) ?? undefined;
    if (linearProbeCode(reply.status, reply.errors) !== "ok" || created?.success !== true || !created.issue) {
      return this.failure(reply);
    }
    const identifier = typeof created.issue.identifier === "string" ? created.issue.identifier : "";
    return {
      ok: true,
      code: "ok",
      summary: `Issue ${identifier} created in the team ${team}.`,
      data: {
        dispatched: true,
        identifier,
        url: typeof created.issue.url === "string" ? created.issue.url : null,
        linearId: id,
        executionId: request.executionId,
      },
    };
  }

  private async comment(
    env: NodeJS.ProcessEnv,
    secret: string,
    team: string,
    issue: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const body = readString(request.metadata, "body");
    if (!body) {
      return { ok: false, code: "unexpected", summary: "No comment text: nothing was sent.", data: { dispatched: false, reason: "missing_body" } };
    }
    if (body.length > BODY_MAX) {
      return { ok: false, code: "unexpected", summary: "Commentaire trop long.", data: { dispatched: false, reason: "body_too_long" } };
    }
    /*
     * L'équipe RÉELLE de l'issue est relue chez Linear. La cible a déjà vérifié que
     * l'identifiant commence par la clé d'équipe ; une issue DÉPLACÉE garde son ancien
     * identifiant comme alias, donc seule la réponse de Linear fait foi.
     */
    const lookup = await callLinear(
      env,
      this.tokenOf(secret),
      "query($id: String!) { issue(id: $id) { id identifier team { key } } }",
      { id: issue },
    );
    if (linearProbeCode(lookup.status, lookup.errors) !== "ok") return this.failure(lookup, false);
    const found = lookup.data?.issue as { id?: unknown; team?: { key?: unknown } } | null | undefined;
    if (!found || typeof found.id !== "string") {
      return { ok: false, code: "not_found", summary: `Linear cannot find the issue ${issue}.`, data: { dispatched: false, reason: "not_found" } };
    }
    if (found.team?.key !== team) {
      return {
        ok: false,
        code: "forbidden",
        summary: `Issue ${issue} now belongs to the team ${String(found.team?.key)}, not ${team}: nothing was sent.`,
        data: { dispatched: false, reason: "team_mismatch" },
      };
    }
    const reply = await callLinear(
      env,
      this.tokenOf(secret),
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }`,
      { input: { issueId: found.id, body: `${body}\n\n_Via Oathrion — execution ${request.executionId}_` } },
    );
    const created = reply.data?.commentCreate as { success?: unknown; comment?: Record<string, unknown> } | undefined;
    if (linearProbeCode(reply.status, reply.errors) !== "ok" || created?.success !== true) return this.failure(reply);
    return {
      ok: true,
      code: "ok",
      summary: `Comment posted on ${issue}.`,
      data: {
        dispatched: true,
        issue,
        url: typeof created.comment?.url === "string" ? created.comment.url : null,
        executionId: request.executionId,
      },
    };
  }

  async resources(context: ConnectorContext): Promise<ConnectorResourceListing> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) return { ok: false, code: "unauthorized", detail: "Linear is not connected for this organisation." };
    try {
      const listed = await this.listTeamsFor(context.env, secret);
      if (!listed.ok) return listed;
      return {
        ok: true,
        resources: listed.teams.map((t) => ({ target: `linear.app/${t.key}`, label: t.name, detail: t.key })),
      };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `Linear is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async revoke(context: ConnectorContext, by: string): Promise<ConnectorRevocation> {
    const credential = await context.vault.open(this.id);
    const oauth = credential ? readOAuthSecret(credential.secretEnvelope) : null;
    let remoteRevoked = false;
    if (oauth) {
      try {
        const reply = await sendGuarded({
          url: new URL(`${linearApiOrigin(context.env)}/oauth/revoke`),
          method: "POST",
          headers: { authorization: `Bearer ${oauth.accessToken}`, "user-agent": "oathrion-connector/1" },
          body: "",
          timeoutMs: connectorTimeoutMs(context.env),
          captureBody: true,
          allowPrivate: context.env.OATHRION_WEBHOOK_ALLOW_PRIVATE === "true",
        });
        remoteRevoked = reply.ok;
      } catch {
        remoteRevoked = false;
      }
    }
    const forgotten = await context.vault.revoke(this.id, by);
    return {
      ok: forgotten,
      remoteStillValid: !remoteRevoked,
      detail: !forgotten
        ? "Linear was not connected for this organisation."
        : remoteRevoked
          ? "Oathrion revoked the authorisation at Linear, then forgot it."
          : "Oathrion forgot the key. Linear considers it STILL VALID: delete it in Linear → " +
            "Settings → Security & access → Personal API keys.",
    };
  }
}

function missing(what: string, example: string): ConnectorExecuteResult {
  return {
    ok: false,
    code: "unexpected",
    summary: `The target must name ${what}, for example "${example}". Nothing was sent.`,
    data: { dispatched: false, reason: "invalid_target" },
  };
}
