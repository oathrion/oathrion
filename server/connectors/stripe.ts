/**
 * Le connecteur Stripe — RÉEL. Appels HTTPS authentifiés à api.stripe.com.
 *
 * ## Ce qu'il fait réellement
 *
 * `verify` lit le compte (`GET /v1/account`) : son identifiant et son nom tels que STRIPE
 * les donne. Quatre verbes :
 *
 *   · `stripe.balance.read`     — le solde du compte, par devise.
 *   · `stripe.payments.list`    — les paiements récents (PaymentIntents).
 *   · `stripe.customers.search` — les clients, éventuellement filtrés par adresse.
 *   · `stripe.refund.create`    — rembourser UN paiement, en tout ou partie.
 *
 * ## Le seul connecteur qui déplace de l'argent
 *
 * `stripe.refund.create` est déclaré FINANCIER au catalogue d'actions : le plafond de
 * dépense de l'agent (`maxTransactionAmount`) et les règles de montant s'y appliquent, sur
 * le montant DÉCLARÉ en unités (12.50 EUR). Le connecteur garantit ensuite que ce qui part
 * chez Stripe est exactement ce qui a été décidé :
 *
 *   - le paiement est relu chez Stripe AVANT le remboursement ; une devise déclarée
 *     différente de celle du paiement est refusée sans rien envoyer — sinon « 50 » EUR
 *     déclarés deviendraient 50 unités d'une autre devise chez Stripe ;
 *   - le montant est converti en unités mineures par `shared/money.ts` (centimes pour
 *     EUR/USD, aucune pour XOF/XAF), jamais par un calcul en virgule flottante ;
 *   - un montant est TOUJOURS exigé : un remboursement total implicite échapperait au
 *     plafond, qui a besoin d'un nombre à comparer.
 *
 * ## Les cibles nomment le compte
 *
 *     stripe.com/acct_123              le compte (solde, paiements, clients)
 *     stripe.com/acct_123/pi_456       un paiement de ce compte (remboursement)
 *
 * Le compte est dans la cible, donc une politique « seulement ce compte Stripe » se lit
 * sur la cible, comme un dépôt GitHub ou une équipe Linear. Le connecteur vérifie que le
 * compte nommé est bien celui de la clé : une cible écrite pour un autre compte n'agit pas
 * sur celui-ci.
 *
 * ## Idempotence : documentée par Stripe, éprouvée par le banc
 *
 * Chaque remboursement porte `Idempotency-Key: placet-<exécution>`. Stripe rend le MÊME
 * remboursement à une requête répétée avec la même clé (24 h). `npm run verify:launch`
 * le vérifie contre le vrai service. La règle de rejeu ne s'y fie pas pour autant : la
 * lever est une décision de produit, comme pour Linear.
 *
 * ## Clés : test par défaut, argent réel seulement si l'exploitant le décide
 *
 * Une clé de test (`sk_test_`, `rk_test_`) est acceptée. Une clé RÉELLE (`sk_live_`,
 * `rk_live_`) est refusée tant que l'exploitant n'a pas posé `OATHRION_STRIPE_ALLOW_LIVE=true`
 * : un agent qui rembourse de l'argent réel est une décision d'exploitation, pas un effet
 * de bord d'une connexion. Une clé publiable (`pk_`) n'agit pas côté serveur : refusée.
 */

import { sendGuarded } from "../notifications/webhook-transport";
import { moneyFromDecimal, moneyFromMinor, parseCurrency, toDecimal } from "@shared/money";
import { connectorTimeoutMs } from "./timeouts";
import { transportFailure } from "./transport-failure";
import { freshSecret } from "./oauth-install";
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

export const STRIPE_CONNECTOR_ID = "stripe";

export function stripeApiOrigin(env: NodeJS.ProcessEnv): string {
  const raw = env.OATHRION_STRIPE_API_ORIGIN?.trim();
  return raw && raw !== "" ? raw.replace(/\/+$/, "") : "https://api.stripe.com";
}

const LIST_MAX = 25;
const ACCOUNT = /^acct_[A-Za-z0-9]{6,40}$/;
const PAYMENT = /^pi_[A-Za-z0-9]{6,60}$/;
const REFUND_REASONS = new Set(["duplicate", "fraudulent", "requested_by_customer"]);

/* ------------------------------------------------------------------ clés */

export type StripeKeyKind = { ok: true; mode: "test" | "live" } | { ok: false; detail: string };

/** Ce que la forme de la clé dit d'elle, AVANT tout appel. Exportée pour être éprouvée. */
export function classifyStripeKey(secret: string, env: NodeJS.ProcessEnv): StripeKeyKind {
  const key = secret.trim();
  if (key === "") return { ok: false, detail: "No key given." };
  if (/^pk_(test|live)_/.test(key)) {
    return {
      ok: false,
      detail:
        "This is a PUBLISHABLE key (pk_…): it only serves the browser and can neither read a " +
        "payment nor refund. Paste a test secret key (sk_test_…) or a restricted key (rk_test_…).",
    };
  }
  const match = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/.exec(key);
  if (!match) {
    return { ok: false, detail: "This is not a Stripe API key (expected: sk_test_…, rk_test_…, or their live version)." };
  }
  const mode = match[2] as "test" | "live";
  if (mode === "live" && env.OATHRION_STRIPE_ALLOW_LIVE?.trim() !== "true") {
    return {
      ok: false,
      detail:
        "This is a LIVE key: an agent could refund real money. Oathrion refuses it " +
        "until the operator explicitly allows it (OATHRION_STRIPE_ALLOW_LIVE=true). " +
        "For a pilot, use a test key.",
    };
  }
  return { ok: true, mode };
}

/* ---------------------------------------------------------------- cibles */

export class StripeTargetError extends Error {}

export interface StripeTarget {
  account: string;
  payment: string | null;
}

/** Découpe une cible Stripe. Voir l'en-tête du fichier pour les deux formes. */
export function parseStripeTarget(target: string): StripeTarget {
  const trimmed = target.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const parts = trimmed.split("/");
  if (parts[0]?.toLowerCase() !== "stripe.com" || parts.length < 2) {
    throw new StripeTargetError(
      `The target ${JSON.stringify(target)} is not a Stripe target. Expected "stripe.com/acct_…" ` +
        `(the account) or "stripe.com/acct_…/pi_…" for a payment.`,
    );
  }
  const account = parts[1]!;
  if (!ACCOUNT.test(account)) throw new StripeTargetError(`"${account}" is not a Stripe account ID (acct_…).`);
  if (parts.length === 2) return { account, payment: null };
  if (parts.length === 3) {
    const payment = parts[2]!;
    if (!PAYMENT.test(payment)) throw new StripeTargetError(`"${payment}" is not a Stripe payment ID (pi_…).`);
    return { account, payment };
  }
  throw new StripeTargetError(`The target ${JSON.stringify(target)} has too many segments.`);
}

/* -------------------------------------------------------------- appels */

interface StripeReply {
  status: number;
  body: Record<string, unknown> | null;
  error: { type: string; code: string; message: string } | null;
}

function formEncode(fields: Record<string, string | number | undefined>): string {
  return Object.entries(fields)
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join("&");
}

async function callStripe(
  env: NodeJS.ProcessEnv,
  key: string,
  method: "GET" | "POST",
  path: string,
  options: { form?: Record<string, string | number | undefined>; idempotencyKey?: string } = {},
): Promise<StripeReply> {
  const reply = await sendGuarded({
    url: new URL(`${stripeApiOrigin(env)}${path}`),
    method,
    headers: {
      authorization: `Bearer ${key}`,
      "user-agent": "oathrion-connector/1",
      ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
    },
    body: method === "POST" ? formEncode(options.form ?? {}) : "",
    timeoutMs: connectorTimeoutMs(env),
    captureBody: true,
    allowPrivate: env.OATHRION_WEBHOOK_ALLOW_PRIVATE === "true",
  });
  let body: Record<string, unknown> | null = null;
  let error: StripeReply["error"] = null;
  try {
    const parsed = JSON.parse(reply.body ?? "") as Record<string, unknown>;
    body = parsed;
    const raw = parsed.error as { type?: unknown; code?: unknown; message?: unknown } | undefined;
    if (raw && typeof raw === "object") {
      error = {
        type: typeof raw.type === "string" ? raw.type : "",
        code: typeof raw.code === "string" ? raw.code : "",
        message: typeof raw.message === "string" ? raw.message : "",
      };
    }
  } catch {
    /* Un corps illisible (page d'erreur d'un proxy) : le statut seul parlera. */
  }
  return { status: reply.status, body, error };
}

/** Exportée pour être éprouvée sans réseau. */
export function stripeProbeCode(status: number, error: StripeReply["error"]): ConnectorProbeCode {
  if (status >= 200 && status < 300 && !error) return "ok";
  if (status === 429 || error?.code === "rate_limit") return "rate_limited";
  if (status === 401) return "unauthorized";
  if (status === 403) return "forbidden";
  if (status === 404 || error?.code === "resource_missing") return "not_found";
  return status >= 500 ? "unreachable" : "unexpected";
}

/**
 * Le message de Stripe peut citer la clé ; il est donc nettoyé avant d'être stocké ou
 * affiché : seul le préfixe d'une clé (`sk_test_`) survit.
 */
export function redactStripeMessage(message: string): string {
  return message.replace(/\b((?:sk|rk|pk)_(?:test|live)_)[A-Za-z0-9*]+/g, "$1***");
}

export function stripeHumanError(code: ConnectorProbeCode, error: StripeReply["error"]): string {
  const raw = error?.message ? redactStripeMessage(error.message).slice(0, 220) : "";
  const suffix = raw ? ` (Stripe : ${raw})` : "";
  switch (code) {
    case "unauthorized":
      return "Stripe does not recognise this key: it is wrong or was deleted. Copy it again in full." + suffix;
    case "forbidden":
      return "Stripe refuses this operation for this key: a restricted key lacks the needed permission." + suffix;
    case "rate_limited":
      return "Stripe is rate-limiting calls: try again in a minute." + suffix;
    case "not_found":
      return "Stripe cannot find this item on this account." + suffix;
    case "unreachable":
      return "Stripe is temporarily unavailable." + suffix;
    default:
      return "Stripe refused the call." + suffix;
  }
}

/** La clé d'idempotence d'un remboursement : stable pour une exécution. */
export function refundIdempotencyKey(executionId: string): string {
  return `placet-${executionId}`;
}

function readString(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function readLimit(metadata: Record<string, unknown>): number {
  const raw = Number(metadata.limit ?? 10);
  return Number.isFinite(raw) ? Math.min(Math.max(Math.trunc(raw), 1), LIST_MAX) : 10;
}

/** Un montant mineur rendu en unités dans une devise connue d'Oathrion, sinon tel quel. */
function decimalOf(minor: unknown, currency: unknown): { amount: number | null; currency: string } {
  const code = parseCurrency(typeof currency === "string" ? currency.toUpperCase() : currency);
  if (typeof minor !== "number") return { amount: null, currency: String(currency ?? "").toUpperCase() };
  if (!code) return { amount: minor, currency: `${String(currency ?? "").toUpperCase()} (minor units)` };
  const money = moneyFromMinor(minor, code);
  return { amount: money.ok ? toDecimal(money.money) : null, currency: code };
}

/* -------------------------------------------------------- réconciliation */

/** Les événements qu'Oathrion ne produit jamais, et qui font perdre de l'argent ou des données. */
const RECONCILED_EVENTS = ["payment_intent.canceled", "customer.deleted", "charge.dispute.closed"] as const;
/** Stripe garde les événements 30 jours. */
const EVENTS_RETENTION_S = 30 * 24 * 3600;

function isoOf(created: unknown): string {
  return typeof created === "number" ? new Date(created * 1000).toISOString() : "";
}

function placetMarker(metadata: unknown): string | null {
  const marker = (metadata as { placet_execution?: unknown } | null | undefined)?.placet_execution;
  return typeof marker === "string" && marker !== "" ? marker : null;
}

/**
 * Un événement du journal en écriture à classer. `request.id` absent : Stripe l'a produit
 * seul (expiration d'un paiement, fin d'un litige) — compté, pas jugé. Un litige clos
 * n'est retenu que PERDU : un litige gagné ne fait rien perdre.
 */
function eventItem(event: Record<string, unknown>, dashboard: string): ReconcileItem | null {
  const object = (event.data as { object?: Record<string, unknown> } | undefined)?.object;
  if (!object || typeof object.id !== "string") return null;
  const request = (event.request as { id?: unknown } | null | undefined)?.id;
  const requested = typeof request === "string" && request !== "";
  const common = {
    id: object.id,
    createdAt: isoOf(event.created),
    actor: requested ? null : "Stripe (automatique)",
    marker: placetMarker(object.metadata),
    byOathrionIdentity: requested,
  };
  switch (event.type) {
    case "payment_intent.canceled": {
      const money = decimalOf(object.amount, object.currency);
      const why = typeof object.cancellation_reason === "string" ? ` (reason: ${object.cancellation_reason})` : "";
      return { ...common, kind: "payment", url: `${dashboard}payments/${object.id}`, summary: `Payment cancelled: ${String(money.amount)} ${money.currency}${why}` };
    }
    case "customer.deleted":
      /* Ni nom ni adresse : l'alerte part vers des canaux d'exploitation. */
      return { ...common, kind: "customer", url: null, summary: `Customer deleted (${object.id})` };
    case "charge.dispute.closed": {
      if (object.status !== "lost") return null;
      const money = decimalOf(object.amount, object.currency);
      const charge = typeof object.charge === "string" ? object.charge : "";
      return {
        ...common,
        kind: "dispute",
        url: `${dashboard}disputes/${object.id}`,
        summary: `Dispute lost: ${String(money.amount)} ${money.currency}${charge ? ` on ${charge}` : ""}`,
      };
    }
    default:
      return null;
  }
}

const LABELS: Record<string, string> = {
  "stripe.balance.read": "Read the account balance",
  "stripe.payments.list": "Read the recent payments",
  "stripe.customers.search": "Search customers",
  "stripe.refund.create": "Refund a payment",
};

export type AccountReading =
  | { ok: true; id: string; name: string; livemode: boolean | null }
  | { ok: false; code: ConnectorProbeCode; detail: string };

export class StripeConnector implements Connector {
  readonly id = STRIPE_CONNECTOR_ID;
  readonly label = "Stripe";
  readonly description =
    "Reads the balance, payments and customers of an account, and refunds a payment. " +
    "Real HTTPS calls to api.stripe.com.";

  readonly actions = ["stripe.balance.read", "stripe.payments.list", "stripe.customers.search", "stripe.refund.create"] as const;

  readonly credentialGuide =
    "In Stripe, in TEST MODE: Developers → API keys (https://dashboard.stripe.com/test/apikeys). " +
    'Safest: "Create restricted key" with Balance, PaymentIntents and Customers read, ' +
    'Refunds write, nothing else. Or the test "Secret key" (sk_test_…). ' +
    "Paste it here: Oathrion checks it with Stripe, seals it and will never show it again. " +
    "A live key is refused until the operator allows it. To " +
    "neutralise it, delete or roll it on that same Stripe page.";

  async readAccount(env: NodeJS.ProcessEnv, key: string): Promise<AccountReading> {
    const reply = await callStripe(env, key, "GET", "/v1/account");
    const code = stripeProbeCode(reply.status, reply.error);
    if (code !== "ok") return { ok: false, code, detail: stripeHumanError(code, reply.error) };
    const id = typeof reply.body?.id === "string" ? reply.body.id : "";
    if (!ACCOUNT.test(id)) return { ok: false, code: "unexpected", detail: "Stripe returned no account identifier." };
    const settings = reply.body?.settings as { dashboard?: { display_name?: unknown } } | undefined;
    const profile = reply.body?.business_profile as { name?: unknown } | undefined;
    const name =
      typeof settings?.dashboard?.display_name === "string" && settings.dashboard.display_name !== ""
        ? settings.dashboard.display_name
        : typeof profile?.name === "string"
          ? profile.name
          : id;
    return { ok: true, id, name, livemode: typeof reply.body?.livemode === "boolean" ? reply.body.livemode : null };
  }

  async credentialAlive(secret: string, env: NodeJS.ProcessEnv): Promise<CredentialLiveness> {
    const key = secret.trim();
    /*
     * Une clé PUBLIABLE (`pk_`) n'agit pas côté serveur : ce n'est pas une porte. Seule
     * exception à « le service décide », et elle est dans le bon sens — une clé réelle
     * (`sk_live_`) est, elle, posée au service, parce qu'elle ouvre la porte la plus grave.
     */
    if (/^pk_(test|live)_/.test(key)) {
      return { state: "dead", detail: "This is a publishable key: it can neither read a payment nor refund." };
    }
    let reply: StripeReply;
    try {
      reply = await callStripe(env, key, "GET", "/v1/account");
    } catch (error) {
      return { state: "unknown", detail: `Stripe is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
    const code = stripeProbeCode(reply.status, reply.error);
    const mode = /_live_/.test(key) ? " — LIVE key (real money)" : "";
    if (code === "ok" || code === "forbidden") return { state: "alive", detail: `Stripe still accepts this key${mode}.` };
    if (code === "unauthorized") return { state: "dead", detail: "Stripe refuses this key: it is deleted or unknown." };
    return { state: "unknown", detail: stripeHumanError(code, reply.error) };
  }

  async verify(secret: string, _options: { account?: string }, env: NodeJS.ProcessEnv): Promise<ConnectorProbe> {
    const kind = classifyStripeKey(secret, env);
    if (!kind.ok) return { ok: false, account: "", scopes: [], code: "unauthorized", detail: kind.detail };
    let account: AccountReading;
    try {
      account = await this.readAccount(env, secret.trim());
    } catch (error) {
      return {
        ok: false,
        account: "",
        scopes: [],
        code: "unreachable",
        detail: `Stripe is unreachable: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!account.ok) {
      const detail =
        account.code === "forbidden"
          ? `${account.detail} Oathrion reads the account to know where it acts: use the test secret key, ` +
            "or a restricted key that can read the account."
          : account.detail;
      return { ok: false, account: "", scopes: [], code: account.code, detail };
    }
    const mode = kind.mode === "test" ? "TEST mode (no real money)" : "LIVE mode (real money)";
    return {
      ok: true,
      account: `${account.name} (${account.id})`,
      scopes: [],
      code: "ok",
      detail:
        `Connected to the Stripe account "${account.name}" (${account.id}), ${mode}. ` +
        "A refund is a spend: it goes through the agent's ceiling and, by default, through an approval.",
    };
  }

  async test(context: ConnectorContext): Promise<ConnectorProbe> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) {
      return { ok: false, account: "", scopes: [], code: "unauthorized", detail: "Stripe is not connected for this organisation." };
    }
    return this.verify(secret, {}, context.env);
  }

  async capabilities(context: ConnectorContext): Promise<ConnectorCapability[]> {
    const probe = await this.test(context);
    return this.actions.map((action) =>
      probe.ok
        ? /*
           * Une clé restreinte ne dit pas ses permissions par l'API : Stripe refuse au
           * moment de l'appel (403), et ce refus est rendu tel quel. Annoncer « disponible »
           * est donc ce qu'Oathrion sait, avec ce qu'il ne sait pas écrit ici.
           */
          { action, label: LABELS[action]!, available: true }
        : { action, label: LABELS[action]!, available: false, reason: probe.detail },
    );
  }

  async execute(context: ConnectorContext, request: ConnectorExecuteRequest): Promise<ConnectorExecuteResult> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) {
      return {
        ok: false,
        code: "unauthorized",
        summary: "Stripe is not connected: nothing was sent.",
        data: { dispatched: false, reason: "connector_not_connected" },
      };
    }
    const key = secret.trim();
    const kind = classifyStripeKey(key, context.env);
    if (!kind.ok) {
      return { ok: false, code: "unauthorized", summary: `${kind.detail} Nothing was sent.`, data: { dispatched: false, reason: "key_refused" } };
    }
    let target: StripeTarget;
    try {
      target = parseStripeTarget(request.target);
    } catch (error) {
      return {
        ok: false,
        code: "unexpected",
        summary: error instanceof Error ? error.message : String(error),
        data: { dispatched: false, reason: "invalid_target" },
      };
    }
    try {
      /*
       * Le compte de la CIBLE doit être celui de la CLÉ. Une politique écrite pour
       * acct_A ne doit pas laisser agir sur acct_B parce que la clé y donne accès.
       */
      const account = await this.readAccount(context.env, key);
      if (!account.ok) return { ok: false, code: account.code, summary: account.detail, data: { dispatched: false, reason: account.code } };
      if (account.id !== target.account) {
        return {
          ok: false,
          code: "forbidden",
          summary: `The target names the account ${target.account}, but the connected key belongs to ${account.id}: nothing was sent.`,
          data: { dispatched: false, reason: "account_mismatch" },
        };
      }

      switch (request.action) {
        case "stripe.balance.read":
          if (target.payment) return missing("the account (without a payment)", "stripe.com/acct_…");
          return await this.balance(context.env, key, target.account);
        case "stripe.payments.list":
          if (target.payment) return missing("the account (without a payment)", "stripe.com/acct_…");
          return await this.payments(context.env, key, target.account, request);
        case "stripe.customers.search":
          if (target.payment) return missing("the account (without a payment)", "stripe.com/acct_…");
          return await this.customers(context.env, key, target.account, request);
        case "stripe.refund.create":
          if (!target.payment) return missing("a payment", "stripe.com/acct_…/pi_…");
          return await this.refund(context.env, key, target.account, target.payment, request);
        default:
          return {
            ok: false,
            code: "unexpected",
            summary: `The Stripe connector does not serve the verb "${request.action}".`,
            data: { dispatched: false, reason: "unsupported_action" },
          };
      }
    } catch (error) {
      return transportFailure("Stripe", error);
    }
  }

  private failure(reply: StripeReply, dispatched = true): ConnectorExecuteResult {
    const raw = stripeProbeCode(reply.status, reply.error);
    const code = raw === "ok" ? "unexpected" : raw;
    return {
      ok: false,
      code,
      summary: stripeHumanError(code, reply.error),
      data: { dispatched, reason: code, ...(reply.error?.code ? { stripeCode: reply.error.code } : {}) },
    };
  }

  private async balance(env: NodeJS.ProcessEnv, key: string, account: string): Promise<ConnectorExecuteResult> {
    const reply = await callStripe(env, key, "GET", "/v1/balance");
    if (stripeProbeCode(reply.status, reply.error) !== "ok") return this.failure(reply);
    const read = (value: unknown) =>
      (Array.isArray(value) ? value : [])
        .filter((b): b is Record<string, unknown> => b !== null && typeof b === "object")
        .map((b) => decimalOf(b.amount, b.currency));
    return {
      ok: true,
      code: "ok",
      summary: `Balance of the Stripe account ${account} read.`,
      data: { dispatched: true, account, available: read(reply.body?.available), pending: read(reply.body?.pending) },
    };
  }

  private async payments(
    env: NodeJS.ProcessEnv,
    key: string,
    account: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const customer = readString(request.metadata, "customer");
    if (customer && !/^cus_[A-Za-z0-9]{6,40}$/.test(customer)) {
      return { ok: false, code: "unexpected", summary: `"${customer}" is not a Stripe customer identifier (cus_…).`, data: { dispatched: false, reason: "invalid_customer" } };
    }
    const query = `limit=${String(readLimit(request.metadata))}${customer ? `&customer=${encodeURIComponent(customer)}` : ""}`;
    const reply = await callStripe(env, key, "GET", `/v1/payment_intents?${query}`);
    if (stripeProbeCode(reply.status, reply.error) !== "ok") return this.failure(reply);
    const payments = (Array.isArray(reply.body?.data) ? (reply.body!.data as unknown[]) : [])
      .filter((p): p is Record<string, unknown> => p !== null && typeof p === "object")
      .map((p) => ({
        id: typeof p.id === "string" ? p.id : "",
        ...decimalOf(p.amount_received ?? p.amount, p.currency),
        status: typeof p.status === "string" ? p.status : null,
        customer: typeof p.customer === "string" ? p.customer : null,
        description: typeof p.description === "string" ? p.description.slice(0, 200) : null,
        created: typeof p.created === "number" ? new Date(p.created * 1000).toISOString() : null,
        target: typeof p.id === "string" ? `stripe.com/${account}/${p.id}` : null,
      }));
    return {
      ok: true,
      code: "ok",
      summary: `${String(payments.length)} Stripe payment(s) read.`,
      data: { dispatched: true, account, payments },
    };
  }

  private async customers(
    env: NodeJS.ProcessEnv,
    key: string,
    account: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const email = readString(request.metadata, "email");
    if (email && (email.length > 200 || !email.includes("@"))) {
      return { ok: false, code: "unexpected", summary: "Invalid address: nothing was sent.", data: { dispatched: false, reason: "invalid_email" } };
    }
    const query = `limit=${String(readLimit(request.metadata))}${email ? `&email=${encodeURIComponent(email)}` : ""}`;
    const reply = await callStripe(env, key, "GET", `/v1/customers?${query}`);
    if (stripeProbeCode(reply.status, reply.error) !== "ok") return this.failure(reply);
    const customers = (Array.isArray(reply.body?.data) ? (reply.body!.data as unknown[]) : [])
      .filter((c): c is Record<string, unknown> => c !== null && typeof c === "object")
      .map((c) => ({
        id: typeof c.id === "string" ? c.id : "",
        name: typeof c.name === "string" ? c.name : null,
        email: typeof c.email === "string" ? c.email : null,
        created: typeof c.created === "number" ? new Date(c.created * 1000).toISOString() : null,
      }));
    return {
      ok: true,
      code: "ok",
      summary: `${String(customers.length)} Stripe customer(s) found.`,
      data: { dispatched: true, account, customers },
    };
  }

  private async refund(
    env: NodeJS.ProcessEnv,
    key: string,
    account: string,
    payment: string,
    request: ConnectorExecuteRequest,
  ): Promise<ConnectorExecuteResult> {
    const currency = parseCurrency(request.metadata.currency);
    if (!currency) {
      return {
        ok: false,
        code: "unexpected",
        summary: "A refund must declare its currency (EUR, USD, XOF, XAF): nothing was sent.",
        data: { dispatched: false, reason: "missing_currency" },
      };
    }
    const declared = moneyFromDecimal(request.metadata.amount, currency);
    if (!declared.ok || declared.money.minor <= 0) {
      return {
        ok: false,
        code: "unexpected",
        summary:
          "A refund must declare a positive amount, expressible in its currency (for example 12.50 EUR): " +
          "nothing was sent. An implicit full refund would escape the agent's ceiling.",
        data: { dispatched: false, reason: "invalid_amount" },
      };
    }
    /*
     * `refund_reason` et non `reason` : `reason` est, pour TOUS les verbes, la justification
     * de l'agent (texte libre, journalisée). La confondre avec l'énumération de Stripe
     * ferait refuser chaque remboursement justifié en français.
     */
    const reason = readString(request.metadata, "refund_reason");
    if (reason !== null && !REFUND_REASONS.has(reason)) {
      return {
        ok: false,
        code: "unexpected",
        summary: "Invalid refund reason: duplicate, fraudulent or requested_by_customer. Nothing was sent.",
        data: { dispatched: false, reason: "invalid_refund_reason" },
      };
    }

    /* Le paiement relu chez Stripe : il existe, il a abouti, et dans la devise déclarée. */
    const lookup = await callStripe(env, key, "GET", `/v1/payment_intents/${encodeURIComponent(payment)}`);
    if (stripeProbeCode(lookup.status, lookup.error) !== "ok") return this.failure(lookup, false);
    const paymentCurrency = typeof lookup.body?.currency === "string" ? lookup.body.currency.toUpperCase() : "";
    if (paymentCurrency !== currency) {
      return {
        ok: false,
        code: "unexpected",
        summary:
          `Payment ${payment} is in ${paymentCurrency || "an unknown currency"}, the refund declares ${currency}: ` +
          "nothing was sent. The amount would be read in another currency.",
        data: { dispatched: false, reason: "currency_mismatch" },
      };
    }
    if (lookup.body?.status !== "succeeded") {
      return {
        ok: false,
        code: "unexpected",
        summary: `Payment ${payment} did not complete (state "${String(lookup.body?.status)}"): there is nothing to refund. Nothing was sent.`,
        data: { dispatched: false, reason: "payment_not_succeeded" },
      };
    }

    const reply = await callStripe(env, key, "POST", "/v1/refunds", {
      form: {
        payment_intent: payment,
        amount: declared.money.minor,
        ...(reason ? { reason } : {}),
        "metadata[placet_execution]": request.executionId,
      },
      idempotencyKey: refundIdempotencyKey(request.executionId),
    });
    if (stripeProbeCode(reply.status, reply.error) !== "ok") return this.failure(reply);
    const refund = reply.body ?? {};
    const refunded = decimalOf(refund.amount, refund.currency);
    const id = typeof refund.id === "string" ? refund.id : "";
    return {
      ok: true,
      code: "ok",
      summary: `Refund ${id} of ${String(refunded.amount)} ${refunded.currency} on ${payment} (${String(refund.status)}).`,
      data: {
        dispatched: true,
        account,
        refund: id,
        payment,
        amount: refunded.amount,
        currency: refunded.currency,
        status: typeof refund.status === "string" ? refund.status : null,
        url: id ? `https://dashboard.stripe.com/${key.includes("_test_") ? "test/" : ""}payments/${payment}` : null,
        executionId: request.executionId,
      },
    };
  }

  /**
   * Réconciliation : ce qui a fait sortir de l'argent du compte, ou l'a perdu, depuis
   * `since` — sur le compte de la clé.
   *
   *   · les REMBOURSEMENTS : Oathrion pose `metadata[placet_execution]` sur chacun des siens ;
   *     un remboursement sans marque est hors Oathrion ;
   *   · les VIREMENTS vers la banque : Oathrion n'a aucun verbe de virement, donc un virement
   *     MANUEL vient forcément d'ailleurs ; un virement automatique (le calendrier du
   *     compte) est compté, pas jugé ;
   *   · les PAIEMENTS ANNULÉS, les CLIENTS SUPPRIMÉS et les LITIGES ACCEPTÉS, lus dans le
   *     journal d'événements de Stripe : Oathrion n'en fait aucun ; un événement déclenché
   *     par une requête (clé ou tableau de bord) est hors Oathrion, un événement que Stripe a
   *     produit seul (`request.id` absent : expiration, calendrier) est compté.
   *
   * Une clé restreinte qui ne permet pas de lire l'une de ces listes ne fait pas échouer
   * le passage : la liste manquante est dite, et le résultat est partiel.
   */
  async reconcile(context: ConnectorContext, options: { since: string; resources: string[] }): Promise<ReconcileListing> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) return { ok: false, code: "unauthorized", detail: "Stripe is not connected for this organisation." };
    const key = secret.trim();
    try {
      const account = await this.readAccount(context.env, key);
      if (!account.ok) return { ok: false, code: account.code, detail: account.detail };
      const since = Math.floor(Date.parse(options.since) / 1000);
      const window = `limit=100&created[gte]=${String(since)}`;
      const dashboard = `https://dashboard.stripe.com/${key.includes("_test_") ? "test/" : ""}`;
      const items: ReconcileItem[] = [];
      const unread: string[] = [];
      let truncated = false;

      const read = async (what: string, path: string): Promise<Record<string, unknown>[] | ReconcileListing> => {
        const reply = await callStripe(context.env, key, "GET", path);
        const code = stripeProbeCode(reply.status, reply.error);
        if (code === "forbidden") {
          unread.push(what);
          return [];
        }
        if (code !== "ok") return { ok: false, code, detail: stripeHumanError(code, reply.error) };
        if (reply.body?.has_more === true) truncated = true;
        return (Array.isArray(reply.body?.data) ? (reply.body!.data as unknown[]) : []).filter(
          (o): o is Record<string, unknown> => o !== null && typeof o === "object",
        );
      };

      const refunds = await read("the refunds", `/v1/refunds?${window}`);
      if (!Array.isArray(refunds)) return refunds;
      for (const refund of refunds) {
        const money = decimalOf(refund.amount, refund.currency);
        const payment = typeof refund.payment_intent === "string" ? refund.payment_intent : "";
        items.push({
          kind: "refund",
          id: typeof refund.id === "string" ? refund.id : "",
          url: payment ? `${dashboard}payments/${payment}` : null,
          createdAt: isoOf(refund.created),
          actor: null,
          summary: `${String(money.amount)} ${money.currency}${payment ? ` on ${payment}` : ""}`,
          marker: placetMarker(refund.metadata),
          byOathrionIdentity: true,
        });
      }

      const payouts = await read("the payouts", `/v1/payouts?${window}`);
      if (!Array.isArray(payouts)) return payouts;
      for (const payout of payouts) {
        const money = decimalOf(payout.amount, payout.currency);
        const automatic = payout.automatic === true;
        const id = typeof payout.id === "string" ? payout.id : "";
        items.push({
          kind: "payout",
          id,
          url: id ? `${dashboard}payouts/${id}` : null,
          createdAt: isoOf(payout.created),
          actor: automatic ? "Stripe (virement automatique)" : null,
          summary: `${automatic ? "Automatic" : "Manual"} payout of ${String(money.amount)} ${money.currency} to the bank`,
          marker: placetMarker(payout.metadata),
          byOathrionIdentity: !automatic,
        });
      }

      const types = RECONCILED_EVENTS.map((type) => `&types[]=${encodeURIComponent(type)}`).join("");
      const events = await read("the event log (cancellations, deletions, disputes)", `/v1/events?${window}${types}`);
      if (!Array.isArray(events)) return events;
      for (const event of events) {
        const item = eventItem(event, dashboard);
        if (item) items.push(item);
      }

      const limits = [
        'Stripe does not say WHO made a write: without a marker, it may come from the dashboard (a person) or another key. It is "outside Oathrion", not necessarily "made by the agent".',
        'New payments and new customers are not judged: a charge made by an agent with a direct key looks exactly like one from the site. The protection against that is to take the key away from the agent ("Direct access to tools").',
        "At most 100 refunds, 100 payouts and 100 events are read per pass.",
      ];
      if (Date.now() / 1000 - since > EVENTS_RETENTION_S) {
        limits.push("Stripe keeps its event log for 30 days only: older cancellations, deletions and disputes can no longer be read.");
      }
      if (unread.length > 0) {
        truncated = true;
        limits.unshift(`The connected key cannot read ${unread.join(", ")}: what is there was not checked.`);
      }
      return { ok: true, identity: `${account.name} (${account.id})`, items, truncated, limits };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `Stripe is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async resources(context: ConnectorContext): Promise<ConnectorResourceListing> {
    const secret = await freshSecret(context, this.id);
    if (secret === null) return { ok: false, code: "unauthorized", detail: "Stripe is not connected for this organisation." };
    try {
      const account = await this.readAccount(context.env, secret.trim());
      if (!account.ok) return account;
      return {
        ok: true,
        resources: [{ target: `stripe.com/${account.id}`, label: account.name, detail: account.id }],
      };
    } catch (error) {
      return { ok: false, code: "unreachable", detail: `Stripe is unreachable: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  async revoke(context: ConnectorContext, by: string): Promise<ConnectorRevocation> {
    const forgotten = await context.vault.revoke(this.id, by);
    return {
      ok: forgotten,
      /* Stripe n'offre pas d'API pour qu'un tiers supprime une clé : seul le compte le peut. */
      remoteStillValid: true,
      detail: forgotten
        ? "Oathrion forgot the key. Stripe considers it STILL VALID: delete or roll it in " +
          "Stripe → Developers → API keys."
        : "Stripe was not connected for this organisation.",
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
