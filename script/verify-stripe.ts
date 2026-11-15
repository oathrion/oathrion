/**
 * Preuve du paquet Stripe — APPELS RÉELS à api.stripe.com, à travers le bundle livré.
 *
 *   DATABASE_URL=postgres://… npm run verify:stripe                 # sans clé
 *   OATHRION_STRIPE_TEST_KEY=sk_test_… DATABASE_URL=… npm run verify:stripe
 *
 * ## Ce que ce banc prouve que `intercept-packs.test.ts` ne prouve pas
 *
 * Les tests du paquet vérifient qu'Oathrion LIT correctement une requête écrite comme la
 * documentation de Stripe la décrit. Ils ne disent rien de Stripe lui-même. Ici, chaque
 * requête autorisée part réellement chez Stripe, et c'est Stripe qui répond.
 *
 * ## Deux sections, et la première tourne toujours
 *
 * SANS CLÉ VALIDE, Oathrion injecte une clé de test volontairement invalide. Stripe répond
 * 401 et cite les quatre derniers caractères de la clé qu'il a REÇUE. S'ils sont ceux de
 * la clé injectée, c'est la preuve, contre le vrai service, qu'Oathrion a remplacé le
 * credential de l'agent — l'agent, lui, n'a envoyé que sa clé Oathrion. Et puisque chaque
 * requête relayée rend 401, un refus de politique (403 venu d'Oathrion) prouve à lui seul
 * que la requête n'est jamais partie.
 *
 * AVEC UNE CLÉ DE TEST (`sk_test_…`), le parcours complet : un vrai paiement en mode test,
 * un vrai remboursement, et, pour chaque refus de politique, la liste lue DIRECTEMENT chez
 * Stripe qui montre que rien n'y est arrivé.
 *
 * ## Ce que ce banc refuse de faire
 *
 * **Il refuse toute clé qui n'est pas une clé de test.** `sk_live_` et `rk_live_` déplacent
 * de l'argent réel ; une erreur dans ce banc ne doit jamais pouvoir le faire. Le refus est
 * le premier contrôle, avant le moindre appel réseau.
 *
 * La clé n'apparaît dans aucune sortie, et le banc le vérifie sur sa propre sortie et sur
 * le journal du processus.
 *
 * Sortie 0 : tout est prouvé. Sortie 2 : réseau injoignable ou clé absente — « je n'ai pas
 * pu tester » ne doit pas pouvoir se lire « j'ai testé ». Sortie 1 : un contrôle a échoué.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";

import { createThrowawayDatabase, productionPostgresEnv } from "./lib/throwaway-postgres";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5321;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const STRIPE = "https://api.stripe.com";
const RUN = randomBytes(4).toString("hex");

const EMAIL = "stripe@placet.test";
const PASSWORD = `stripe-${randomBytes(9).toString("hex")}`;
const AGENT_ID = "agt_stripe";

/*
 * La clé INVALIDE de la première section. Elle commence par `sk_test_` pour que Stripe la
 * traite comme une clé de test, et finit par quatre caractères reconnaissables : ce sont
 * eux que Stripe cite dans son message d'erreur.
 */
const FAKE_KEY = `sk_test_placetCleVolontairementInvalide${RUN}Q7Z9`;
const FAKE_LAST4 = FAKE_KEY.slice(-4);

type Child = ChildProcessByStdio<null, Readable, Readable>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
/** Toutes les chaînes affichées, pour vérifier à la fin que la clé n'y est jamais. */
const printed: string[] = [];

function say(line: string): void {
  printed.push(line);
  console.log(line);
}
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  say(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  say(`\n── ${label} ${"─".repeat(Math.max(0, 70 - label.length))}`);
}

/* ------------------------------------------------------------------ outils */

/** Le premier contrôle du banc : rien d'autre qu'une clé de TEST n'est accepté. */
export function testKeyProblem(key: string): string | null {
  if (/^(sk|rk)_live_/.test(key)) {
    return "c'est une clé de PRODUCTION. Ce banc crée des paiements : il n'accepte que sk_test_ / rk_test_.";
  }
  if (/^pk_/.test(key)) return "c'est une clé PUBLIQUE ; il faut une clé secrète de test (sk_test_…).";
  if (!/^(sk|rk)_test_[A-Za-z0-9]+$/.test(key)) return "ce n'est pas une clé de test Stripe (sk_test_…).";
  return null;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  text: string;
}

async function http(url: string, init: RequestInit = {}): Promise<Reply> {
  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body, headers: res.headers, text };
  } catch (error) {
    return { status: 0, body: { error: String(error) }, headers: new Headers(), text: "" };
  }
}

/** Un appel à l'API d'Oathrion (console). */
const api = (p: string, o: { token?: string; json?: unknown; method?: string } = {}) =>
  http(`${BASE}${p}`, {
    method: o.method ?? (o.json === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.json === undefined ? undefined : JSON.stringify(o.json),
  });

/**
 * L'appel de l'AGENT, à travers le pare-feu. Il ne porte que sa clé Oathrion : la clé Stripe
 * n'est jamais entre ses mains.
 */
const agent = (key: string, stripePath: string, fields: Record<string, string>) =>
  http(`${BASE}/api/v1/intercept/stripe${stripePath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `placet-verify-${RUN}-${randomBytes(4).toString("hex")}`,
    },
    body: form(fields),
  });

/** Un appel DIRECT à Stripe, par le banc lui-même — l'exploitant, pas l'agent. */
const direct = (key: string, stripePath: string, init: { method?: string; fields?: Record<string, string> } = {}) =>
  http(`${STRIPE}${stripePath}`, {
    method: init.method ?? (init.fields ? "POST" : "GET"),
    headers: {
      authorization: `Bearer ${key}`,
      ...(init.fields ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: init.fields ? form(init.fields) : undefined,
  });

/* ---------------------------------------------------- Oathrion, en production */

interface Oathrion {
  child: Child;
  log: () => string;
  agentKey: string;
  admin: string;
}

async function bootOathrion(dbUrl: string, stripeKey: string): Promise<Oathrion | null> {
  let log = "";
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(dbUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: `stripe-${randomBytes(16).toString("hex")}`,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: `${EMAIL}:admin:${PASSWORD}`,
      OATHRION_SEED: "",
      /* Le paquet, tel qu'un exploitant l'active — et la destination qu'il doit déclarer. */
      OATHRION_INTERCEPT_PACKS: "stripe",
      OATHRION_DESTINATIONS: JSON.stringify([{ id: "stripe", url: STRIPE, organizations: "*" }]),
      OATHRION_MCP_ALLOWED_DESTINATIONS: STRIPE,
      OATHRION_INTERCEPT_KEY_STRIPE: stripeKey,
      OATHRION_KEK: randomBytes(32).toString("base64"),
      /* La clé du banc n'est pas une variable qu'Oathrion doit voir. */
      OATHRION_STRIPE_TEST_KEY: undefined,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }) as Child;
  child.stdout.on("data", (c: Buffer) => (log += c.toString()));
  child.stderr.on("data", (c: Buffer) => (log += c.toString()));

  let ready = false;
  for (let i = 0; i < 160 && !ready; i += 1) {
    if (child.exitCode !== null) break;
    ready = (await api("/api/ready")).status === 200;
    if (!ready) await sleep(400);
  }
  if (!ready) {
    say(log.slice(-1500).split(stripeKey).join("‹clé›"));
    child.kill("SIGTERM");
    return null;
  }

  const admin = String((await api("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
  const created = await api("/api/agents", {
    token: admin,
    json: {
      id: AGENT_ID,
      name: "Agent de facturation",
      description: "Rembourse et encaisse à travers Oathrion.",
      provider: "openai",
      model: "gpt-4o",
      status: "active",
      owner: "finance",
      mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
      permissions: [{ scope: "execute:payments", label: "Paiements", description: "Sous mandat.", granted: true, risk: "high" }],
      policyIds: [],
      tags: ["stripe"],
    },
  });
  /*
   * LA SEULE POLITIQUE : au-dessus de 100 €, refusé. Écrite en EUROS par un exploitant
   * qui pense en euros — c'est `amountScale: 100` du paquet qui doit rendre ce plafond
   * juste face à une API qui compte en centimes.
   */
  const policy = await api("/api/policies", {
    token: admin,
    json: {
      id: "pol_stripe_plafond",
      name: "Au-dessus de 100 €, refusé",
      description: "Plafond du banc Stripe.",
      type: "MAX_TRANSACTION_AMOUNT",
      condition: { kind: "amountAtMost", max: 100, currency: "EUR" },
      scope: "organization",
      appliesTo: "all agents",
      effect: "block",
      status: "enabled",
      action: "BLOCK",
      risk: "high",
      priority: 10,
    },
  });
  const key = await api("/api/keys", { token: admin, json: { name: "clé agent", role: "operator", agentId: AGENT_ID } });
  const agentKey = String(key.body.secret ?? "");
  if (created.status >= 300 || policy.status >= 300 || agentKey === "") {
    say(`  mise en place impossible : agent ${String(created.status)}, politique ${String(policy.status)}, clé ${agentKey ? "ok" : "absente"}`);
    child.kill("SIGTERM");
    return null;
  }
  return { child, log: () => log, agentKey, admin };
}

async function stop(placet: Oathrion | null): Promise<void> {
  if (!placet) return;
  placet.child.kill("SIGTERM");
  for (let i = 0; i < 40 && placet.child.exitCode === null; i += 1) await sleep(250);
}

/** Le message d'erreur de Stripe, s'il y en a un. */
const stripeMessage = (r: Reply) =>
  String(((r.body.error ?? {}) as Record<string, unknown>).message ?? "");

/* --------------------------------------------------------------------- main */

async function main(): Promise<number> {
  say("\n" + "=".repeat(78));
  say("Oathrion — PREUVE DU PAQUET STRIPE (appels réels à api.stripe.com)");
  say("=".repeat(78));

  const realKey = process.env.OATHRION_STRIPE_TEST_KEY?.trim() ?? "";

  /* ------------------------------------------- 1. LES REFUS DU BANC LUI-MÊME */
  section("LA CLÉ — rien d'autre qu'une clé de test n'est accepté");
  record("une clé de production sk_live_ est refusée", testKeyProblem("sk_live_abc123") !== null);
  record("une clé restreinte de production rk_live_ est refusée", testKeyProblem("rk_live_abc123") !== null);
  record("une clé publique pk_test_ est refusée", testKeyProblem("pk_test_abc123") !== null);
  record("une clé de test sk_test_ est acceptée", testKeyProblem("sk_test_abc123") === null);
  if (realKey !== "") {
    const problem = testKeyProblem(realKey);
    record("OATHRION_STRIPE_TEST_KEY est une clé de test", problem === null, problem ?? "sk_test_…");
    if (problem !== null) {
      say("\nArrêt : aucun appel n'a été fait avec cette clé.");
      return 1;
    }
  }

  if (!existsSync(BUNDLE)) {
    say("\nBundle absent : lancez `npm run build` d'abord.");
    return 2;
  }
  if (!process.env.DATABASE_URL) {
    say("\nDATABASE_URL manquante : le bundle de production ne tourne que sur PostgreSQL.");
    return 2;
  }

  /* --------------------------------------------- 2. STRIPE EST-IL JOIGNABLE */
  section("STRIPE RÉPOND — sans aucune clé");
  const probe = await http(`${STRIPE}/v1/charges`, { signal: AbortSignal.timeout(15_000) });
  if (probe.status === 0) {
    say(`L'API Stripe est injoignable depuis cette machine : ${String(probe.body.error).slice(0, 120)}`);
    say("Ce banc prouve un chemin RÉSEAU ; il refuse de passer sans réseau.");
    return 2;
  }
  record("api.stripe.com répond, et refuse un appel sans clé", probe.status === 401, `statut ${String(probe.status)}`);

  /* ---------------------- 3. A TRAVERS OATHRION, AVEC UNE CLÉ VOLONTAIREMENT FAUSSE */
  section("À TRAVERS OATHRION — clé injectée volontairement invalide");
  const db1 = await createThrowawayDatabase("oathrion_stripe");
  let placet: Oathrion | null = null;
  try {
    placet = await bootOathrion(db1.url, FAKE_KEY);
    record("le bundle de production démarre avec OATHRION_INTERCEPT_PACKS=stripe", placet !== null);
    if (!placet) return 1;

    /* 10,00 € : sous le plafond. Oathrion autorise, relaie, et Stripe refuse la clé. */
    const allowed = await agent(placet.agentKey, "/v1/refunds", {
      charge: "ch_inexistant_placet",
      amount: "1000",
    });
    record(
      "10,00 € (1000 centimes) est AUTORISÉ — la conversion des centimes tient",
      allowed.headers.get("x-oathrion-decision") === "ALLOW",
      `décision ${String(allowed.headers.get("x-oathrion-decision"))}`,
    );
    record(
      "la requête est PARTIE chez Stripe, qui répond 401 — statut relayé, pas fabriqué",
      allowed.status === 401,
      /*
       * Le motif d'Oathrion quand ce n'est pas 401 : un 502 dit « autorisé, et rien n'est
       * parti », et sans son `code` on ne sait pas si c'est le réseau, le coffre ou la règle.
       */
      `statut ${String(allowed.status)}` +
        (allowed.status === 401 ? "" : ` — ${String(allowed.body.code ?? "")} ${String(allowed.body.detail ?? "")}`.slice(0, 140)),
    );
    const message = stripeMessage(allowed);
    /*
     * LA PREUVE CENTRALE DE CETTE SECTION. L'agent n'a envoyé que sa clé OATHRION. Si Oathrion
     * avait relayé son en-tête, Stripe citerait les derniers caractères de la clé Oathrion.
     * Il cite ceux de la clé qu'Oathrion a INJECTÉE.
     */
    record(
      "Stripe cite la clé que OATHRION a injectée, pas celle de l'agent",
      message.includes(FAKE_LAST4) && !message.includes(placet.agentKey.slice(-4)),
      message.slice(0, 90),
    );
    record(
      "x-oathrion-credential-injected: true",
      allowed.headers.get("x-oathrion-credential-injected") === "true",
    );
    record("la clé injectée n'apparaît pas en entier dans la réponse", !allowed.text.includes(FAKE_KEY));

    /* 200,00 € : au-dessus du plafond. */
    const blocked = await agent(placet.agentKey, "/v1/refunds", {
      charge: "ch_inexistant_placet",
      amount: "20000",
    });
    record(
      "200,00 € (20000 centimes) est REFUSÉ par la politique",
      blocked.status === 403 && blocked.headers.get("x-oathrion-decision") === "BLOCK",
      `statut ${String(blocked.status)}, décision ${String(blocked.headers.get("x-oathrion-decision"))}`,
    );
    /*
     * Toute requête relayée rend 401 avec cette clé. Un 403 `blocked_by_policy` venu de
     * Oathrion prouve donc que celle-ci n'a jamais atteint Stripe.
     */
    record(
      "… et elle n'a jamais atteint Stripe (refus d'Oathrion, pas de Stripe)",
      blocked.body.code === "blocked_by_policy" && stripeMessage(blocked) === "",
      String(blocked.body.code),
    );

    const noRule = await agent(placet.agentKey, "/v1/customers", { email: "x@example.com" });
    record(
      "un chemin que le paquet ne couvre pas est REFUSÉ, pas transmis",
      noRule.status === 403 && stripeMessage(noRule) === "",
      `statut ${String(noRule.status)}, ${String(noRule.body.code ?? noRule.body.error ?? "")}`.slice(0, 80),
    );

    const noTarget = await agent(placet.agentKey, "/v1/refunds", { amount: "1000" });
    record(
      "un remboursement sans `charge` est refusé avant tout envoi",
      noTarget.status === 422 && stripeMessage(noTarget) === "",
      `statut ${String(noTarget.status)}`,
    );
  } finally {
    await stop(placet);
    await db1.dispose().catch(() => undefined);
  }

  /* -------------------------------------------- 4. LE PARCOURS AVEC UNE VRAIE CLÉ */
  if (realKey === "") {
    section("LE PARCOURS COMPLET N'A PAS ÉTÉ EXÉCUTÉ");
    say("  Il exige une clé SECRÈTE DE TEST (sk_test_…), jamais une clé de production :");
    say("    OATHRION_STRIPE_TEST_KEY=sk_test_… DATABASE_URL=… npm run verify:stripe");
    say("");
    say("  Ce qu'il ajoutera : un vrai paiement en mode test, un vrai remboursement, et pour");
    say("  chaque refus, la liste lue DIRECTEMENT chez Stripe qui montre que rien n'est arrivé.");
    return finish(2);
  }

  section("PARCOURS COMPLET — clé de test réelle, mode test Stripe");
  const db2 = await createThrowawayDatabase("oathrion_stripe_full");
  let full: Oathrion | null = null;
  let customerId = "";
  try {
    /* L'exploitant prépare un client, directement chez Stripe : ce n'est pas l'agent. */
    const customer = await direct(realKey, "/v1/customers", {
      fields: {
        email: `verify-${RUN}@placet.test`,
        description: `Créé par npm run verify:stripe (${RUN}) — supprimé en fin de banc`,
        "metadata[oathrion_verify]": RUN,
      },
    });
    customerId = String(customer.body.id ?? "");
    record("un client de test est créé directement chez Stripe", customerId.startsWith("cus_"), customerId);
    if (!customerId) return finish(1);

    full = await bootOathrion(db2.url, realKey);
    record("le bundle démarre avec la clé de test réelle", full !== null);
    if (!full) return finish(1);

    /* ---- un paiement de 50 € : autorisé, et il a lieu */
    /*
     * LA FORME ACTUELLE D'UN PAIEMENT CONFIRMÉ CÔTÉ SERVEUR.
     *
     * Ce banc envoyait d'abord `payment_method_types[]=card`, d'après la documentation
     * que j'avais en tête. Le vrai Stripe a répondu 400 : « The `payment_method_types`
     * parameter is no longer supported. » — les versions récentes de l'API passent par
     * `automatic_payment_methods`. C'est la raison d'être de ce banc : une requête écrite
     * d'après la documentation n'est pas une requête que le service accepte.
     *
     * `allow_redirects=never` parce qu'un paiement confirmé par un agent, côté serveur, n'a
     * pas de navigateur vers lequel rediriger.
     */
    const paymentFields = (amount: string) => ({
      amount,
      currency: "eur",
      customer: customerId,
      payment_method: "pm_card_visa",
      "automatic_payment_methods[enabled]": "true",
      "automatic_payment_methods[allow_redirects]": "never",
      confirm: "true",
      "metadata[oathrion_verify]": RUN,
    });
    const paid = await agent(full.agentKey, "/v1/payment_intents", paymentFields("5000"));
    const chargeId = String(paid.body.latest_charge ?? "");
    record(
      "un paiement de 50,00 € est AUTORISÉ et ABOUTIT chez Stripe",
      paid.status === 200 && paid.body.status === "succeeded",
      `statut ${String(paid.status)}, ${String(paid.body.status ?? stripeMessage(paid)).slice(0, 60)}`,
    );
    record("… avec la clé injectée par Oathrion", paid.headers.get("x-oathrion-credential-injected") === "true");
    const clientSecret = String(paid.body.client_secret ?? "");

    /* ---- un paiement de 500 € : refusé, et Stripe n'en voit rien */
    const tooBig = await agent(full.agentKey, "/v1/payment_intents", paymentFields("50000"));
    record(
      "un paiement de 500,00 € est REFUSÉ par la politique",
      tooBig.status === 403 && tooBig.headers.get("x-oathrion-decision") === "BLOCK",
      `statut ${String(tooBig.status)}`,
    );
    const intents = await direct(realKey, `/v1/payment_intents?customer=${customerId}&limit=10`);
    const intentCount = Array.isArray(intents.body.data) ? intents.body.data.length : -1;
    record(
      "LU CHEZ STRIPE : un seul paiement existe pour ce client — le refusé n'est jamais arrivé",
      intentCount === 1,
      `${String(intentCount)} paiement(s)`,
    );

    /*
     * SANS CHARGE, LE RESTE N'A PAS DE SENS — et il ne doit pas produire d'échecs qui
     * accusent la mauvaise chose.
     *
     * Au premier passage réel, le paiement a échoué chez Stripe ; les remboursements sont
     * alors partis avec une `charge` vide, Oathrion les a refusés en 422 (à raison : une
     * cible absente n'est pas jugée), et le banc a rapporté « le remboursement de 200 €
     * n'est PAS refusé par la politique » — un faux échec, puisque la politique n'avait
     * jamais été consultée. Un seul échec, nommé, vaut mieux que cinq qui se trompent de
     * cause.
     */
    if (!chargeId.startsWith("ch_") && !chargeId.startsWith("py_")) {
      record(
        "le parcours de remboursement n'a pas pu être exécuté : aucune charge n'a été créée",
        false,
        "voir l'échec du paiement ci-dessus",
      );
      return finish(1, realKey);
    }

    /* ---- un remboursement de 10 € : autorisé, et il a lieu */
    /*
     * SANS `currency` : le vrai Stripe la refuse sur cet endpoint (`Received unknown
     * parameter: currency`). C'est ce banc, avec une vraie clé, qui l'a montré — le paquet
     * la lisait, et ses limites conseillaient même de l'envoyer.
     */
    const refund = await agent(full.agentKey, "/v1/refunds", {
      charge: chargeId,
      amount: "1000",
    });
    record(
      "un remboursement de 10,00 € est AUTORISÉ et créé chez Stripe",
      refund.status === 200 && String(refund.body.id ?? "").startsWith("re_"),
      `statut ${String(refund.status)}, ${String(refund.body.status ?? stripeMessage(refund)).slice(0, 60)}`,
    );

    /* ---- un remboursement de 200 € : au-dessus du plafond, refusé, et Stripe n'en voit rien */
    const refundBlocked = await agent(full.agentKey, "/v1/refunds", {
      charge: chargeId,
      amount: "20000",
    });
    record(
      "un remboursement de 200,00 € est REFUSÉ par la politique",
      refundBlocked.status === 403 && refundBlocked.headers.get("x-oathrion-decision") === "BLOCK",
      `statut ${String(refundBlocked.status)}`,
    );
    /*
     * LA FORME ACTUELLE : le paiement désigné par `payment_intent`, comme le font les
     * bibliothèques Stripe d'aujourd'hui. Le paquet ne lisait que `charge` et refusait
     * celle-ci en 422.
     */
    const paymentIntentId = String(paid.body.id ?? "");
    const refundByIntent = await agent(full.agentKey, "/v1/refunds", {
      payment_intent: paymentIntentId,
      amount: "500",
    });
    record(
      "un remboursement de 5,00 € désigné par `payment_intent` est AUTORISÉ et créé",
      refundByIntent.status === 200 && String(refundByIntent.body.id ?? "").startsWith("re_"),
      `statut ${String(refundByIntent.status)}, ${String(refundByIntent.body.status ?? stripeMessage(refundByIntent)).slice(0, 60)}`,
    );

    const refunds = await direct(realKey, `/v1/refunds?charge=${chargeId}&limit=10`);
    const refundCount = Array.isArray(refunds.body.data) ? refunds.body.data.length : -1;
    record(
      "LU CHEZ STRIPE : exactement les deux remboursements autorisés — le refusé n'est jamais arrivé",
      refundCount === 2,
      `${String(refundCount)} remboursement(s)`,
    );

    /* ---- ce qu'Oathrion garde, et ce qu'il ne garde pas */
    const executions = await api("/api/executions", { token: full.admin });
    const stored = executions.text;
    /*
     * `client_secret` d'un PaymentIntent permet de finaliser un paiement côté navigateur.
     * Stripe le rend dans la réponse ; Oathrion la relaie à l'agent et ne doit PAS l'écrire
     * en base — c'est la propriété « la réponse du fournisseur ne survit pas en base »,
     * éprouvée ici sur une vraie valeur sensible plutôt que sur une sentinelle.
     */
    record(
      "le client_secret rendu par Stripe n'est PAS écrit dans la base d'Oathrion",
      clientSecret !== "" && !stored.includes(clientSecret),
      clientSecret ? "absent des exécutions" : "client_secret non reçu",
    );
    record(
      "les deux refus et les trois succès sont tracés",
      (stored.match(/"blocked"/g) ?? []).length >= 2 && (stored.match(/"allowed"/g) ?? []).length >= 3,
    );
    record(
      "la clé de test n'apparaît ni dans la base, ni dans le journal du processus",
      !stored.includes(realKey) && !full.log().includes(realKey),
    );
  } finally {
    await stop(full);
    await db2.dispose().catch(() => undefined);
    /*
     * Le client de test créé par le banc est retiré. Les paiements de test restent : Stripe ne les supprime pas.
     * Cette suppression passe par la clé, PAS par Oathrion : une instance où cette même clé est connectée la
     * verra, à juste titre, « hors Oathrion » à sa prochaine réconciliation (client supprimé par une requête).
     */
    if (customerId) {
      const removed = await direct(realKey, `/v1/customers/${customerId}`, { method: "DELETE" });
      say(`  ${removed.body.deleted === true ? "·" : "!"} client de test ${customerId} ${removed.body.deleted === true ? "supprimé" : "NON supprimé"}`);
    }
  }

  section("CE QUI RESTE NON PROUVÉ ICI");
  say("  · /v1/payouts : un virement de test exige un solde disponible. Non exercé.");
  say("  · /v1/charges/{charge}/capture : non exercé.");
  say("  · le mode production de Stripe : jamais, et ce banc le refuse.");
  return finish(0, realKey);
}

/** Le verdict, et la dernière vérification : la clé n'a jamais été affichée. */
function finish(code: number, realKey = ""): number {
  if (realKey !== "") {
    record("la clé de test n'apparaît dans AUCUNE ligne affichée par ce banc", !printed.join("\n").includes(realKey));
  }
  const failed = checks.filter((c) => !c.ok).length;
  say("\n" + "=".repeat(72));
  say(`${String(checks.length - failed)}/${String(checks.length)} contrôles passés`);
  if (code === 2 && failed === 0) {
    say("Sortie 2 : le parcours avec une vraie clé n'a pas été exécuté.");
    say("« Je n'ai pas pu tester » ne doit pas pouvoir se lire « j'ai testé ».");
  }
  say("=".repeat(72) + "\n");
  if (failed > 0) return 1;
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const key = process.env.OATHRION_STRIPE_TEST_KEY ?? "";
    const text = String(error instanceof Error ? error.stack : error);
    console.error(key ? text.split(key).join("‹clé›") : text);
    process.exit(1);
  });
