/**
 * « Connecter Slack », « Connecter Linear » : le flot d'autorisation OAuth, côté serveur.
 *
 * ## Ce que ce fichier ferme
 *
 * Jusqu'ici, connecter un service demandait au client de créer un jeton chez le
 * fournisseur et de le coller. C'est réel, et c'est hors de portée d'une personne non
 * technique. Ici, le client clique, autorise chez le fournisseur, et revient : Oathrion
 * échange le code contre un jeton, le VÉRIFIE contre le service, puis le scelle.
 *
 * ## LE PARTAGE ENTRE DÉPLOIEMENT ET CLIENT
 *
 * L'APPLICATION OAuth (identifiant et secret client) appartient au déploiement : elle est
 * enregistrée une fois chez Slack et chez Linear par l'exploitant et vit dans
 * l'environnement (`OATHRION_SLACK_CLIENT_ID`, …). Le client ne crée jamais d'application.
 * Le CONSENTEMENT et le jeton qui en résulte appartiennent au locataire : ils vont dans
 * son coffre, scellés. Sans configuration d'application, le bouton n'est pas proposé et
 * la console offre la connexion par jeton — explicitement présentée comme un repli.
 *
 * ## LES QUATRE CONTRÔLES DU RETOUR, DANS CET ORDRE
 *
 *   1. Le `state` existe, n'a pas expiré (10 minutes) et n'a JAMAIS servi : il est
 *      retiré de la table au premier passage, réussi ou non.
 *   2. Le cookie `HttpOnly` du navigateur porte le même `state`. Sans ce contrôle, un
 *      attaquant qui lance `/start` dans SA organisation peut envoyer le lien
 *      d'autorisation à une victime : la victime autoriserait SON espace Slack, et le
 *      jeton atterrirait chez l'attaquant. C'est le même raisonnement que le SSO
 *      (`routes-oidc.ts`).
 *   3. L'organisation et le connecteur viennent du `state` émis par une session
 *      authentifiée de rôle `manage`, jamais de la requête de retour.
 *   4. Le jeton obtenu est VÉRIFIÉ contre le service (`connector.verify`) avant d'être
 *      scellé. Un échange réussi n'est pas une connexion qui fonctionne.
 *
 * ## Limite connue
 *
 * La table des `state` est en mémoire, comme celle du SSO : derrière plusieurs instances
 * sans affinité de session, un retour peut tomber sur une instance qui ne connaît pas la
 * tentative. Le refus est alors explicite (« tentative inconnue ou expirée ») et un
 * nouveau clic suffit.
 */

import { randomBytes } from "node:crypto";

import { sendGuarded } from "../notifications/webhook-transport";
import { connectorTimeoutMs } from "./timeouts";
import type { OrganizationId } from "@shared/tenancy";
import type { ConnectorContext } from "./types";

/** Le chemin de retour, unique pour tous les fournisseurs : le `state` dit lequel. */
export const CONNECTOR_OAUTH_CALLBACK_PATH = "/api/connectors/oauth/callback";

/* --------------------------------------------------------------------------------
 * Le secret OAuth tel qu'il est scellé
 * ------------------------------------------------------------------------------ */

/**
 * Un jeton OAuth est scellé sous cette forme JSON, et non comme une chaîne nue : il
 * porte son jeton de renouvellement et son échéance. Une clé collée reste une chaîne
 * nue, et `readOAuthSecret` rend alors `null` — les deux formes coexistent.
 */
export interface OAuthSecret {
  placetOAuth: 1;
  accessToken: string;
  refreshToken?: string;
  /** ISO 8601. Absent : le jeton n'expire pas (Slack sans rotation). */
  expiresAt?: string;
  scopes: string[];
}

export function readOAuthSecret(secret: string): OAuthSecret | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as Partial<OAuthSecret>;
    if (parsed.placetOAuth !== 1 || typeof parsed.accessToken !== "string" || parsed.accessToken === "") return null;
    return {
      placetOAuth: 1,
      accessToken: parsed.accessToken,
      ...(typeof parsed.refreshToken === "string" && parsed.refreshToken !== "" ? { refreshToken: parsed.refreshToken } : {}),
      ...(typeof parsed.expiresAt === "string" ? { expiresAt: parsed.expiresAt } : {}),
      scopes: Array.isArray(parsed.scopes) ? parsed.scopes.filter((s): s is string => typeof s === "string") : [],
    };
  } catch {
    return null;
  }
}

export function writeOAuthSecret(secret: Omit<OAuthSecret, "placetOAuth">): string {
  return JSON.stringify({ placetOAuth: 1, ...secret });
}

/* --------------------------------------------------------------------------------
 * Les fournisseurs
 * ------------------------------------------------------------------------------ */

export interface OAuthProvider {
  connectorId: string;
  label: string;
  /** Les variables du déploiement qui activent le bouton. */
  clientIdVariable: string;
  clientSecretVariable: string;
  authorizeUrl(env: NodeJS.ProcessEnv): string;
  tokenUrl(env: NodeJS.ProcessEnv): string;
  /** Les paramètres d'autorisation propres au fournisseur (portées, invite…). */
  authorizeParams(): Record<string, string>;
  /** Lit la réponse d'échange. Rend le jeton à sceller, ou le motif d'échec. */
  readToken(body: Record<string, unknown>, now: Date): OAuthSecret | { error: string };
  /** Les portées accordées, dites en clair à l'écran de connexion. */
  permissions: { scope: string; why: string }[];
}

function expiry(body: Record<string, unknown>, now: Date): string | undefined {
  const seconds = Number(body.expires_in);
  return Number.isFinite(seconds) && seconds > 0 ? new Date(now.getTime() + seconds * 1000).toISOString() : undefined;
}

function scopeList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  if (typeof raw === "string") return raw.split(/[\s,]+/).filter((s) => s !== "");
  return [];
}

const SLACK_PROVIDER: OAuthProvider = {
  connectorId: "slack",
  label: "Slack",
  clientIdVariable: "OATHRION_SLACK_CLIENT_ID",
  clientSecretVariable: "OATHRION_SLACK_CLIENT_SECRET",
  authorizeUrl: (env) => `${slackOrigin(env)}/oauth/v2/authorize`,
  tokenUrl: (env) => `${slackOrigin(env)}/api/oauth.v2.access`,
  authorizeParams: () => ({
    scope: "chat:write,channels:read,channels:history,groups:read,groups:history",
    /* Aucune portée UTILISATEUR : Oathrion agit comme un bot, jamais au nom d'une personne. */
    user_scope: "",
  }),
  readToken(body, now) {
    if (body.ok !== true) return { error: typeof body.error === "string" ? body.error : "oauth_failed" };
    if (body.token_type !== "bot" || typeof body.access_token !== "string") {
      return { error: "Slack did not return a bot token." };
    }
    const refresh = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
    return {
      placetOAuth: 1,
      accessToken: body.access_token,
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(expiry(body, now) ? { expiresAt: expiry(body, now)! } : {}),
      scopes: scopeList(body.scope),
    };
  },
  permissions: [
    { scope: "chat:write", why: "post a message in the channels you invite the bot to" },
    { scope: "channels:read, groups:read", why: "see the list of channels the bot is invited to" },
    { scope: "channels:history, groups:history", why: "read recent messages from those channels only" },
  ],
};

const LINEAR_PROVIDER: OAuthProvider = {
  connectorId: "linear",
  label: "Linear",
  clientIdVariable: "OATHRION_LINEAR_CLIENT_ID",
  clientSecretVariable: "OATHRION_LINEAR_CLIENT_SECRET",
  authorizeUrl: (env) => `${(env.OATHRION_LINEAR_AUTHORIZE_ORIGIN?.trim() || "https://linear.app").replace(/\/+$/, "")}/oauth/authorize`,
  tokenUrl: (env) => `${(env.OATHRION_LINEAR_API_ORIGIN?.trim() || "https://api.linear.app").replace(/\/+$/, "")}/oauth/token`,
  authorizeParams: () => ({
    response_type: "code",
    scope: "read,issues:create,comments:create",
    /* Toujours l'écran de consentement : le client doit voir ce qu'il accorde. */
    prompt: "consent",
    actor: "user",
  }),
  readToken(body, now) {
    if (typeof body.access_token !== "string" || body.access_token === "") {
      return { error: typeof body.error === "string" ? body.error : "oauth_failed" };
    }
    const refresh = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
    return {
      placetOAuth: 1,
      accessToken: body.access_token,
      ...(refresh ? { refreshToken: refresh } : {}),
      ...(expiry(body, now) ? { expiresAt: expiry(body, now)! } : {}),
      scopes: scopeList(body.scope),
    };
  },
  permissions: [
    { scope: "read", why: "see your teams and read their issues" },
    { scope: "issues:create", why: "create an issue — every creation goes through your Oathrion rules" },
    { scope: "comments:create", why: "comment on an issue — same" },
  ],
};

function slackOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.OATHRION_SLACK_API_ORIGIN?.trim();
  return raw && raw !== "" ? raw.replace(/\/+$/, "") : "https://slack.com";
}

export const OAUTH_PROVIDERS: readonly OAuthProvider[] = [SLACK_PROVIDER, LINEAR_PROVIDER];

export function oauthProviderFor(connectorId: string): OAuthProvider | undefined {
  return OAUTH_PROVIDERS.find((p) => p.connectorId === connectorId);
}

/** L'URL publique d'Oathrion, sans barre finale. `null` si le déploiement ne l'a pas dite. */
export function publicUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env.OATHRION_PUBLIC_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return null;
    return url.toString().replace(/\/+$/, "");
  } catch {
    return null;
  }
}

/**
 * Ce qui manque au déploiement pour proposer le bouton. Vide : le bouton est offert.
 * Dit à l'EXPLOITANT, jamais affiché au client sous forme de variables.
 */
export function oauthConfigProblems(provider: OAuthProvider, env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  if (!env[provider.clientIdVariable]?.trim()) problems.push(provider.clientIdVariable);
  if (!env[provider.clientSecretVariable]?.trim()) problems.push(provider.clientSecretVariable);
  if (publicUrl(env) === null) problems.push("OATHRION_PUBLIC_URL");
  return problems;
}

export function redirectUri(env: NodeJS.ProcessEnv): string {
  return `${publicUrl(env)!}${CONNECTOR_OAUTH_CALLBACK_PATH}`;
}

/* --------------------------------------------------------------------------------
 * Les tentatives
 * ------------------------------------------------------------------------------ */

export interface PendingInstall {
  state: string;
  connectorId: string;
  organizationId: OrganizationId;
  by: string;
  expiresAt: number;
}

const ATTEMPT_MS = 10 * 60 * 1000;
const pending = new Map<string, PendingInstall>();

export function startInstall(
  provider: OAuthProvider,
  organizationId: OrganizationId,
  by: string,
  env: NodeJS.ProcessEnv,
  now = Date.now(),
): { state: string; url: string } {
  for (const [key, entry] of pending) if (entry.expiresAt <= now) pending.delete(key);
  const state = randomBytes(24).toString("base64url");
  pending.set(state, { state, connectorId: provider.connectorId, organizationId, by, expiresAt: now + ATTEMPT_MS });
  const url = new URL(provider.authorizeUrl(env));
  url.searchParams.set("client_id", env[provider.clientIdVariable]!.trim());
  url.searchParams.set("redirect_uri", redirectUri(env));
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(provider.authorizeParams())) url.searchParams.set(key, value);
  return { state, url: url.toString() };
}

/** Retire la tentative — au premier passage, réussi ou non. */
export function takeInstall(state: string, now = Date.now()): PendingInstall | null {
  const entry = pending.get(state);
  if (!entry) return null;
  pending.delete(state);
  return entry.expiresAt > now ? entry : null;
}

/** Test-only. */
export function resetInstalls(): void {
  pending.clear();
}

/* --------------------------------------------------------------------------------
 * Les échanges
 * ------------------------------------------------------------------------------ */

async function postForm(env: NodeJS.ProcessEnv, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const reply = await sendGuarded({
    url: new URL(url),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", "user-agent": "oathrion-connector/1" },
    body: new URLSearchParams(form).toString(),
    timeoutMs: connectorTimeoutMs(env),
    captureBody: true,
    allowPrivate: env.OATHRION_WEBHOOK_ALLOW_PRIVATE === "true",
  });
  try {
    const parsed: unknown = JSON.parse(reply.body ?? "");
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* tombe plus bas */
  }
  return { error: `http_${String(reply.status)}` };
}

export async function exchangeCode(
  provider: OAuthProvider,
  code: string,
  env: NodeJS.ProcessEnv,
  now = new Date(),
): Promise<OAuthSecret | { error: string }> {
  const body = await postForm(env, provider.tokenUrl(env), {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri(env),
    client_id: env[provider.clientIdVariable]!.trim(),
    client_secret: env[provider.clientSecretVariable]!.trim(),
  });
  return provider.readToken(body, now);
}

/** Marge avant l'échéance : on renouvelle une minute avant, pas une seconde après. */
const REFRESH_MARGIN_MS = 60_000;

/**
 * Le secret utilisable MAINTENANT. Une clé collée est rendue telle quelle ; un jeton OAuth
 * proche de l'échéance est renouvelé puis RE-SCELLÉ, pour que le jeton de renouvellement
 * — que certains fournisseurs font tourner à chaque usage — ne soit pas perdu.
 *
 * Un renouvellement impossible rend le secret périmé : l'appel échouera chez le
 * fournisseur avec son propre motif (`unauthorized`), et la console dira « reconnectez ».
 */
export async function freshSecret(context: ConnectorContext, connectorId: string, now = new Date()): Promise<string | null> {
  const credential = await context.vault.open(connectorId);
  if (!credential) return null;
  const oauth = readOAuthSecret(credential.secretEnvelope);
  if (!oauth?.expiresAt || !oauth.refreshToken) return credential.secretEnvelope;
  if (Date.parse(oauth.expiresAt) - REFRESH_MARGIN_MS > now.getTime()) return credential.secretEnvelope;

  const provider = oauthProviderFor(connectorId);
  const env = context.env;
  if (!provider || oauthConfigProblems(provider, env).filter((p) => p !== "OATHRION_PUBLIC_URL").length > 0) {
    return credential.secretEnvelope;
  }
  const body = await postForm(env, provider.tokenUrl(env), {
    grant_type: "refresh_token",
    refresh_token: oauth.refreshToken,
    client_id: env[provider.clientIdVariable]!.trim(),
    client_secret: env[provider.clientSecretVariable]!.trim(),
  }).catch(() => ({ error: "unreachable" }) as Record<string, unknown>);
  const renewed = provider.readToken(body, now);
  if ("error" in renewed) return credential.secretEnvelope;

  const merged = writeOAuthSecret({
    accessToken: renewed.accessToken,
    refreshToken: renewed.refreshToken ?? oauth.refreshToken,
    ...(renewed.expiresAt ? { expiresAt: renewed.expiresAt } : {}),
    scopes: renewed.scopes.length > 0 ? renewed.scopes : oauth.scopes,
  });
  const status = await context.vault.describe(connectorId);
  await context.vault.store({
    connectorId,
    secret: merged,
    account: credential.account,
    scopes: credential.scopes,
    connectedBy: status?.connectedBy ?? "renouvellement OAuth",
    verified: true,
  });
  return merged;
}
