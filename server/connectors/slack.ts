/**
 * Le connecteur Slack — RÉEL. Appels HTTPS authentifiés à slack.com/api.
 *
 * ## Ce qu'il fait réellement
 *
 * `verify` appelle `auth.test` avec le jeton du BOT et lit l'espace de travail et le bot
 * que Slack nomme. Les portées viennent de l'en-tête `x-oauth-scopes` que Slack renvoie
 * sur chaque appel — ce que le jeton a VRAIMENT, pas ce que l'exploitant a coché.
 *
 * Trois verbes :
 *
 *   · `slack.channels.list`  — les canaux dont le bot est MEMBRE (`users.conversations`).
 *     Pas tout l'espace : un bot ne voit et ne poste que là où on l'a invité, et c'est
 *     exactement la frontière que le client choisit dans Slack lui-même.
 *   · `slack.history.read`   — les derniers messages d'UN canal (`conversations.history`).
 *   · `slack.message.post`   — publier dans UN canal (`chat.postMessage`).
 *
 * ## Le piège propre à Slack : 200 n'est pas un succès
 *
 * Slack répond `200 {"ok": false, "error": "channel_not_found"}`. Le statut HTTP ne dit
 * rien ; seul `ok` compte. `slack-ok.test.ts` et `verify:slack` l'ont montré sur la voie
 * pare-feu (le reçu disait « envoyé » pour un message refusé) — ce connecteur lit `ok`
 * à chaque réponse et traduit `error` en code machine.
 *
 * ## Ce qu'il refuse
 *
 * Un jeton UTILISATEUR (`xoxp-`) : il agit au nom d'une personne, avec tous ses droits,
 * y compris ses messages privés. Le brief de lancement l'exclut et ce connecteur aussi.
 * Seul un jeton de bot (`xoxb-`, ou `xoxe.xoxb-` quand la rotation est activée) entre.
 *
 * ## Révocation : la seule réellement distante du catalogue
 *
 * Slack expose `auth.revoke`. « Déconnecter » l'appelle, puis oublie le jeton. Si l'appel
 * échoue (réseau, jeton déjà mort), la réponse le dit : `remoteStillValid` n'est `false`
 * que lorsque Slack a CONFIRMÉ la révocation.
 */

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

export const SLACK_CONNECTOR_ID = "slack";

/** Les portées que les trois verbes exigent. Rien de plus n'est demandé à l'installation. */
export const SLACK_BOT_SCOPES = [
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
] as const;

/**
 * L'origine de l'API. `OATHRION_SLACK_API_ORIGIN` est une variable de DÉPLOIEMENT (tests,
 * proxy d'entreprise), jamais un champ de requête : un locataire ne choisit pas où part
 * son jeton.
 */
export function slackApiOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.OATHRION_SLACK_API_ORIGIN?.trim();
  return raw && raw !== "" ? raw.replace(/\/+$/, "") : "https://slack.com";
}

const HISTORY_LIMIT_MAX = 50;
const MESSAGE_MAX = 4_000;

/** Un identifiant de canal : C (public), G (privé historique). Pas de D : pas de DM. */
const CHANNEL_ID = /^[CG][A-Z0-9]{8,}$/;

export class SlackTargetError extends Error {}

/**
 * La cible d'une action Slack : `slack.com/<ID_DU_CANAL>`, ou `slack.com` pour la liste.
 *
 * L'hôte est requis pour la même raison que GitHub (`parseRepository`) : les verbes sont
 * `outbound`, donc l'allowlist de domaine du mandat les gouverne, et elle ne lit un hôte
 * que s'il est écrit. L'identifiant — et non le nom `#général` — parce qu'un nom se
 * renomme : une règle qui autorise `#annonces` autoriserait le canal qui portera ce nom
 * demain.
 */
export function parseSlackTarget(target: string): { channel: string | null } {
  const trimmed = target.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts[0]?.toLowerCase() !== "slack.com") {
    throw new SlackTargetError(
      `The target ${JSON.stringify(target)} is not a Slack target. Expected ` +
        `"slack.com/C0…" (the channel's identifier, not its name).`,
    );
  }
  if (parts.length === 1) return { channel: null };
  if (parts.length === 2 && CHANNEL_ID.test(parts[1]!)) return { channel: parts[1]! };
  throw new SlackTargetError(
    `The target ${JSON.stringify(target)} does not name a channel. Expected "slack.com/C0…": ` +
      `the identifier is in the channel's address, after /client/T…/. A name (#general) ` +
      `is refused because a channel can be renamed.`,
  );
}

/** Un jeton de bot, rien d'autre. Rend le motif du refus, ou `null`. */
export function slackTokenProblem(token: string): string | null {
  let value = token.trim();
  if (value.startsWith("xoxe-")) {
    return 'This is a REFRESH token, it cannot act. Paste the "Bot User OAuth Token".';
  }
  if (value.startsWith("xoxe.")) value = value.slice("xoxe.".length);
  if (value.startsWith("xoxp-")) {
    return (
      "This is a USER token (User OAuth Token): it acts in your name, with all your rights. " +
      'Oathrion only accepts the bot token — "Bot User OAuth Token", which starts with xoxb-.'
    );
  }
  if (value.startsWith("xapp-")) {
    return 'This is an APP token; it cannot act. Paste the "Bot User OAuth Token" (xoxb-…).';
  }
  if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(value)) {
    return 'This is not a Slack bot token. The "Bot User OAuth Token" starts with xoxb-.';
  }
  return null;
}

interface SlackReply {
  status: number;
  /** Le corps JSON, ou `null` s'il n'est pas lisible. */
  body: Record<string, unknown> | null;
  headers: Record<string, string>;
}

async function callSlack(
  env: NodeJS.ProcessEnv,
  token: string,
  method: string,
  params: Record<string, unknown>,
  verb: "GET" | "POST" = "GET",
): Promise<SlackReply> {
  const url = new URL(`${slackApiOrigin(env)}/api/${method}`);
  let payload = "";
  if (verb === "GET") {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  } else {
    payload = JSON.stringify(params);
  }
  const reply = await sendGuarded({
    url,
    method: verb,
    headers: {
      authorization: `Bearer ${token}`,
      "user-agent": "oathrion-connector/1",
      ...(verb === "POST" ? { "content-type": "application/json; charset=utf-8" } : {}),
    },
    body: payload,
    timeoutMs: connectorTimeoutMs(env),
    captureBody: true,
    allowPrivate: env.OATHRION_WEBHOOK_ALLOW_PRIVATE === "true",
  });
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(reply.body ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }
  return { status: reply.status, body, headers: reply.headers ?? {} };
}

/** `ok: true` dans le corps ET un statut 2xx. L'un sans l'autre n'est pas un succès. */
function succeeded(reply: SlackReply): boolean {
  return reply.status >= 200 && reply.status < 300 && reply.body?.ok === true;
}

function errorOf(reply: SlackReply): string {
  const error = reply.body?.error;
  return typeof error === "string" && error !== "" ? error : `http_${String(reply.status)}`;
}

/**
 * Le code d'erreur de Slack traduit en code machine stable.
 *
 * Exportée pour être éprouvée sans réseau : `slack-connector.test.ts`.
 */
export function slackProbeCode(status: number, error: string | null): ConnectorProbeCode {
  if (status === 429 || error === "ratelimited") return "rate_limited";
  if (error === null && status >= 200 && status < 300) return "ok";
  switch (error) {
    case "not_authed":
    case "invalid_auth":
    case "account_inactive":
    case "token_revoked":
    case "token_expired":
    case "no_permission":
      return "unauthorized";
    case "missing_scope":
    case "not_in_channel":
    case "restricted_action":
    case "is_archived":
    case "ekm_access_denied":
      return "forbidden";
    case "channel_not_found":
      return "not_found";
    default:
      return status >= 500 ? "unreachable" : "unexpected";
  }
}

/**
 * Une phrase qu'une personne non technique peut suivre. Le code brut de Slack reste
 * entre parenthèses : c'est lui qu'un support cherchera.
 */
export function slackHumanError(error: string, reply?: SlackReply): string {
  switch (error) {
    case "not_authed":
    case "invalid_auth":
      return 'Slack does not recognise this token. Copy the "Bot User OAuth Token" again from the OAuth & Permissions page of your Slack app. (invalid_auth)';
    case "token_revoked":
    case "token_expired":
      return "The Slack connection expired or was revoked. Reconnect Slack. (" + error + ")";
    case "account_inactive":
      return "The Slack bot or workspace is deactivated. (account_inactive)";
    case "missing_scope": {
      const needed = typeof reply?.body?.needed === "string" ? reply.body.needed : "";
      return (
        "The Slack app is missing a permission" +
        (needed ? `: add "${needed}" in Bot Token Scopes` : "") +
        ", then reinstall the app in the workspace. (missing_scope)"
      );
    }
    case "not_in_channel":
      return "The bot is not a member of this channel. In Slack, type /invite @<bot name> in the channel. (not_in_channel)";
    case "channel_not_found":
      return "Slack cannot find this channel, or the bot has no access to it. Invite the bot into the channel. (channel_not_found)";
    case "is_archived":
      return "This channel is archived: Slack refuses to write there. (is_archived)";
    case "ratelimited":
      return "Slack is rate-limiting calls: try again in a minute. (ratelimited)";
    case "msg_too_long":
      return "The message is too long for Slack. (msg_too_long)";
    default:
      return `Slack refused the call (${error}).`;
  }
}

function scopesFrom(reply: SlackReply): string[] {
  return (reply.headers["x-oauth-scopes"] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function readString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

const LABELS: Record<string, string> = {
  "slack.channels.list": "See the channels the bot is invited to",
  "slack.history.read": "Read the recent messages of an allowed channel",
  "slack.message.post": "Post a message in an allowed channel",
};

/** La portée Slack qu'il faut pour chaque verbe (au moins une des listes). */
const NEEDS: Record<string, string[][]> = {
  "slack.channels.list": [["channels:read"], ["groups:read"]],
  "slack.history.read": [["channels:history"], ["groups:history"]],
  "slack.message.post": [["chat:write"]],
};

export class SlackConnector implements Connector {
  readonly id = SLACK_CONNECTOR_ID;
  readonly label = "Slack";
  readonly description =
    "Sees the channels the bot is invited to, reads their recent messages, posts a message. " +
    "Real HTTPS calls to slack.com.";

  readonly actions = ["slack.channels.list", "slack.history.read", "slack.message.post"] as const;

  readonly credentialGuide =
    "At https://api.slack.com/apps: Create New App → From scratch, choose your workspace. " +
    "In OAuth & Permissions → Bot Token Scopes, add chat:write, channels:read, " +
    'channels:history (and groups:read, groups:history for private channels). Click "Install ' +
    'to Workspace", copy the "Bot User OAuth Token" (xoxb-…) and paste it here. Then invite ' +
    "the bot into every channel it may use (/invite @bot-name): it sees " +
    "nothing else.";

  /** Le jeton utilisable : collé tel quel, ou lu dans le secret OAuth scellé. */
  private tokenOf(secret: string): string {
    return readOAuthSecret(secret)?.accessToken ?? secret.trim();
  }

  async credentialAlive(secret: string, env: NodeJS.ProcessEnv): Promise<CredentialLiveness> {
    /*
     * SANS `slackTokenProblem` : un jeton UTILISATEUR (`xoxp-`) est refusé à la connexion,
     * mais un agent qui en détient un garde une porte ouverte. C'est au service de dire.
     */
    let reply: SlackReply;
    try {
      reply = await callSlack(env, secret.trim(), "auth.test", {}, "POST");
    } catch (error) {
      return { state: "unknown", detail: `Slack is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (succeeded(reply)) {
      const team = typeof reply.body?.team === "string" ? reply.body.team : "";
      return { state: "alive", detail: `Slack still accepts this token${team ? ` (workspace ${team})` : ""}.` };
    }
    const error = errorOf(reply);
    if (["invalid_auth", "token_revoked", "token_expired", "account_inactive", "not_authed"].includes(error)) {
      return { state: "dead", detail: `Slack refuses this token (${error}): it no longer works.` };
    }
    return { state: "unknown", detail: slackHumanError(error, reply) };
  }

  async verify(secret: string, _options: { account?: string }, env: NodeJS.ProcessEnv): Promise<ConnectorProbe> {
    secret = this.tokenOf(secret);
    const problem = slackTokenProblem(secret);
    if (problem !== null) {
      return { ok: false, account: "", scopes: [], code: "unauthorized", detail: problem };
    }
    let reply: SlackReply;
    try {
      reply = await callSlack(env, secret.trim(), "auth.test", {}, "POST");
    } catch (error) {
      return {
        ok: false,
        account: "",
        scopes: [],
        code: "unreachable",
        detail: `Slack is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!succeeded(reply)) {
      const error = errorOf(reply);
      return {
        ok: false,
        account: "",
        scopes: scopesFrom(reply),
        code: slackProbeCode(reply.status, error),
        detail: slackHumanError(error, reply),
      };
    }
    const team = typeof reply.body?.team === "string" ? reply.body.team : "";
    const user = typeof reply.body?.user === "string" ? reply.body.user : "";
    const scopes = scopesFrom(reply);
    const missing = SLACK_BOT_SCOPES.filter(
      (scope) => !scope.startsWith("groups:") && !scopes.includes(scope),
    );
    return {
      ok: true,
      account: team && user ? `${team} (bot ${user})` : team || user,
      scopes,
      code: "ok",
      detail:
        missing.length === 0
          ? `Connected to the ${team} workspace as bot ${user}.`
          : `Connected to the ${team} workspace, but permissions are missing: ${missing.join(", ")}. ` +
            `The actions that depend on them will be unavailable.`,
    };
  }

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) {
      return { ok: false, account: "", scopes: [], code: "unauthorized", detail: "Slack is not connected for this organisation." };
    }
    return this.verify(secret, {}, context.env);
  }

  async capabilities(context: ConnectorContext): Promise<ConnectorCapability[]> {
    const probe = await this.test(context);
    return this.actions.map((action) => {
      if (!probe.ok) return { action, label: LABELS[action]!, available: false, reason: probe.detail };
      const options = NEEDS[action]!;
      const available = options.some((set) => set.every((scope) => probe.scopes.includes(scope)));
      return available
        ? { action, label: LABELS[action]!, available: true }
        : {
            action,
            label: LABELS[action]!,
            available: false,
            reason: `The Slack permission "${options[0]!.join(", ")}" is missing. Add it in Bot Token Scopes, then reinstall the app.`,
          };
    });
  }

  async execute(context: ConnectorContext, request: ConnectorExecuteRequest): Promise<ConnectorExecuteResult> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) {
      return {
        ok: false,
        code: "unauthorized",
        summary: "Slack is not connected: nothing was sent.",
        data: { dispatched: false, reason: "connector_not_connected" },
      };
    }
    let channel: string | null;
    try {
      channel = parseSlackTarget(request.target).channel;
    } catch (error) {
      return {
        ok: false,
        code: "unexpected",
        summary: error instanceof Error ? error.message : String(error),
        data: { dispatched: false, reason: "invalid_target" },
      };
    }
    const token = this.tokenOf(secret);
    try {
      switch (request.action) {
        case "slack.channels.list":
          return await this.listChannels(context.env, token);
        case "slack.history.read":
          if (!channel) return missingChannel();
          return await this.readHistory(context.env, token, channel, request);
        case "slack.message.post":
          if (!channel) return missingChannel();
          return await this.post(context.env, token, channel, request);
        default:
          return {
            ok: false,
            code: "unexpected",
            summary: `The Slack connector does not serve the verb "${request.action}".`,
            data: { dispatched: false, reason: "unsupported_action" },
          };
      }
    } catch (error) {
      return transportFailure("Slack", error);
    }
  }

  /** Les canaux du bot. Lecture de configuration autant qu'action d'agent : même appel. */
  async listChannelsFor(env: NodeJS.ProcessEnv, secret: string): Promise<
    | { ok: true; channels: { id: string; name: string; private: boolean }[] }
    | { ok: false; code: ConnectorProbeCode; detail: string }
  > {
    const token = this.tokenOf(secret);
    const channels: { id: string; name: string; private: boolean }[] = [];
    let cursor = "";
    /* Cinq pages de 200 : au-delà, un bot invité dans mille canaux n'est plus « choisi ». */
    for (let page = 0; page < 5; page += 1) {
      const reply = await callSlack(env, token, "users.conversations", {
        types: "public_channel,private_channel",
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      if (!succeeded(reply)) {
        const error = errorOf(reply);
        return { ok: false, code: slackProbeCode(reply.status, error), detail: slackHumanError(error, reply) };
      }
      const list = Array.isArray(reply.body?.channels) ? (reply.body.channels as unknown[]) : [];
      for (const entry of list) {
        if (entry === null || typeof entry !== "object") continue;
        const record = entry as Record<string, unknown>;
        if (typeof record.id !== "string" || typeof record.name !== "string") continue;
        channels.push({ id: record.id, name: record.name, private: record.is_private === true });
      }
      const meta = reply.body?.response_metadata as { next_cursor?: unknown } | undefined;
      cursor = typeof meta?.next_cursor === "string" ? meta.next_cursor : "";
      if (cursor === "") break;
    }
    return { ok: true, channels };
  }

  private async listChannels(env: NodeJS.ProcessEnv, token: string): Promise<ConnectorExecuteResult> {
    const listed = await this.listChannelsFor(env, token);
    if (!listed.ok) {
      return { ok: false, code: listed.code, summary: listed.detail, data: { dispatched: true, reason: listed.code } };
    }
    return {
      ok: true,
      code: "ok",
      summary: `${String(listed.channels.length)} channel(s) the bot is invited to.`,
      data: { dispatched: true, channels: listed.channels },
    };
  }

  private async readHistory(
    env: NodeJS.ProcessEnv,
    token: string,
    channel: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const raw = Number(request.metadata.limit ?? 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), HISTORY_LIMIT_MAX) : 10;
    const reply = await callSlack(env, token, "conversations.history", { channel, limit });
    if (!succeeded(reply)) {
      const error = errorOf(reply);
      return {
        ok: false,
        code: slackProbeCode(reply.status, error),
        summary: slackHumanError(error, reply),
        data: { dispatched: true, reason: error },
      };
    }
    const list = Array.isArray(reply.body?.messages) ? (reply.body.messages as unknown[]) : [];
    const messages = list
      .filter((m): m is Record<string, unknown> => m !== null && typeof m === "object")
      .map((m) => ({
        ts: typeof m.ts === "string" ? m.ts : "",
        user: typeof m.user === "string" ? m.user : typeof m.bot_id === "string" ? `bot:${m.bot_id}` : "",
        /* Le texte est borné : un résultat d'outil n'est pas une archive de canal. */
        text: typeof m.text === "string" ? m.text.slice(0, 1_000) : "",
      }));
    return {
      ok: true,
      code: "ok",
      summary: `${String(messages.length)} message(s) read in ${channel}.`,
      data: { dispatched: true, channel, messages },
    };
  }

  private async post(
    env: NodeJS.ProcessEnv,
    token: string,
    channel: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const text = readString(request.metadata, "text");
    if (!text) {
      return {
        ok: false,
        code: "unexpected",
        summary: "No text: nothing was sent to Slack.",
        data: { dispatched: false, reason: "missing_text" },
      };
    }
    if (text.length > MESSAGE_MAX) {
      return {
        ok: false,
        code: "unexpected",
        summary: `The message exceeds ${String(MESSAGE_MAX)} characters: nothing was sent.`,
        data: { dispatched: false, reason: "text_too_long" },
      };
    }
    /*
     * Slack n'a pas de clé d'idempotence. L'identifiant d'exécution part dans les
     * métadonnées du message : un doublon (réponse perdue, puis nouvel essai humain) est
     * reconnaissable, comme le commentaire HTML de l'issue GitHub.
     */
    const reply = await callSlack(
      env,
      token,
      "chat.postMessage",
      {
        channel,
        text,
        unfurl_links: false,
        metadata: {
          event_type: "placet_execution",
          event_payload: { execution_id: request.executionId },
        },
      },
      "POST",
    );
    if (!succeeded(reply)) {
      const error = errorOf(reply);
      return {
        ok: false,
        code: slackProbeCode(reply.status, error),
        summary: slackHumanError(error, reply),
        data: { dispatched: true, reason: error },
      };
    }
    const ts = typeof reply.body?.ts === "string" ? reply.body.ts : "";
    const permalink = await this.permalink(env, token, channel, ts);
    return {
      ok: true,
      code: "ok",
      summary: `Message posted in ${channel}.`,
      data: { dispatched: true, channel, ts, url: permalink, executionId: request.executionId },
    };
  }

  /** Le lien du message, pour que le reçu pointe vers ce que Slack a réellement. */
  private async permalink(env: NodeJS.ProcessEnv, token: string, channel: string, ts: string): Promise<string | null> {
    if (ts === "") return null;
    try {
      const reply = await callSlack(env, token, "chat.getPermalink", { channel, message_ts: ts });
      return succeeded(reply) && typeof reply.body?.permalink === "string" ? reply.body.permalink : null;
    } catch {
      return null;
    }
  }

  /** Les canaux où le bot est invité : le client choisit parmi eux, et seulement eux. */
  /**
   * Réconciliation : les messages postés depuis `since` dans les canaux choisis. Oathrion
   * marque chacun des siens par des métadonnées (`event_type: placet_execution`) ; un
   * message du BOT sans cette marque a été posté par une autre route.
   */
  async reconcile(context: ConnectorContext, options: { since: string; resources: string[] }): Promise<ReconcileListing> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) return { ok: false, code: "unauthorized", detail: "Slack is not connected for this organisation." };
    const token = this.tokenOf(secret);
    const env = context.env;
    try {
      const me = await callSlack(env, token, "auth.test", {}, "POST");
      if (!succeeded(me)) {
        const error = errorOf(me);
        return { ok: false, code: slackProbeCode(me.status, error), detail: slackHumanError(error, me) };
      }
      const botUser = typeof me.body?.user_id === "string" ? me.body.user_id : "";
      const botId = typeof me.body?.bot_id === "string" ? me.body.bot_id : "";
      const team = typeof me.body?.team === "string" ? me.body.team : "";
      const oldest = (Date.parse(options.since) / 1000).toFixed(6);
      const items: ReconcileItem[] = [];
      let truncated = false;
      for (const resource of options.resources) {
        const channel = parseSlackTarget(resource).channel;
        if (!channel) continue;
        const reply = await callSlack(env, token, "conversations.history", { channel, oldest, limit: 200, include_all_metadata: true });
        if (!succeeded(reply)) {
          const error = errorOf(reply);
          return { ok: false, code: slackProbeCode(reply.status, error), detail: slackHumanError(error, reply) };
        }
        if (reply.body?.has_more === true) truncated = true;
        const messages = Array.isArray(reply.body?.messages) ? (reply.body!.messages as Record<string, unknown>[]) : [];
        for (const m of messages) {
          /* Les messages système (arrivée dans le canal…) ne sont l'écriture de personne. */
          if (typeof m.subtype === "string" && m.subtype !== "bot_message") continue;
          const ts = typeof m.ts === "string" ? m.ts : "";
          const meta = m.metadata as { event_type?: unknown; event_payload?: { execution_id?: unknown } } | undefined;
          const marker =
            meta?.event_type === "placet_execution" && typeof meta.event_payload?.execution_id === "string" ? meta.event_payload.execution_id : null;
          const user = typeof m.user === "string" ? m.user : null;
          const fromBot = (botId !== "" && m.bot_id === botId) || (botUser !== "" && user === botUser);
          items.push({
            kind: "message",
            id: `${channel}/${ts}`,
            url: null,
            createdAt: ts ? new Date(Number(ts) * 1000).toISOString() : "",
            actor: fromBot ? "bot Oathrion" : user,
            summary: String(m.text ?? "").slice(0, 140),
            marker,
            byOathrionIdentity: fromBot,
          });
        }
      }
      return {
        ok: true,
        identity: `bot ${String(me.body?.user ?? botUser)}${team ? ` (${team})` : ""}`,
        items,
        truncated,
        limits: [
          "Only the chosen channels are read, and the last 200 messages of each.",
          'A deleted message is no longer visible. Messages from people are counted as "other author", without being judged.',
          "A message posted by an app other than Oathrion's is not attributed to the bot.",
        ],
      };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `Slack is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async resources(context: ConnectorContext): Promise<ConnectorResourceListing> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) return { ok: false, code: "unauthorized", detail: "Slack is not connected for this organisation." };
    try {
      const listed = await this.listChannelsFor(context.env, secret);
      if (!listed.ok) return listed;
      return {
        ok: true,
        resources: listed.channels.map((c) => ({
          target: `slack.com/${c.id}`,
          label: `#${c.name}`,
          detail: c.private ? "private" : "public",
        })),
        note:
          "Only the channels the bot is invited to appear. To add one, type " +
          "/invite @<bot name> in that channel, then refresh.",
      };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `Slack is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async revoke(context: ConnectorContext, by: string): Promise<ConnectorRevocation> {
    const credential = await context.vault.open(this.id);
    let remoteRevoked = false;
    let remoteDetail = "";
    if (credential) {
      try {
        const reply = await callSlack(context.env, this.tokenOf(credential.secretEnvelope), "auth.revoke", {}, "POST");
        remoteRevoked = succeeded(reply) && reply.body?.revoked === true;
        if (!remoteRevoked) remoteDetail = ` Slack did not confirm the revocation (${errorOf(reply)}).`;
      } catch (error) {
        remoteDetail = ` Slack was unreachable (${error instanceof Error ? error.message : String(error)}).`;
      }
    }
    const forgotten = await context.vault.revoke(this.id, by);
    return {
      ok: forgotten,
      remoteStillValid: !remoteRevoked,
      detail: !forgotten
        ? "Slack was not connected for this organisation."
        : remoteRevoked
          ? "Oathrion revoked the token at Slack, then forgot it. The bot can no longer act."
          : "Oathrion forgot the token." + remoteDetail +
            ' To neutralise it, open your app at https://api.slack.com/apps → OAuth & Permissions → "Revoke tokens".',
    };
  }
}

function missingChannel(): ConnectorExecuteResult {
  return {
    ok: false,
    code: "unexpected",
    summary: "No channel in the target: expected \"slack.com/C0…\". Nothing was sent.",
    data: { dispatched: false, reason: "missing_channel" },
  };
}
