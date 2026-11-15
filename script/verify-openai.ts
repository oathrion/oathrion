/**
 * Preuve du paquet OpenAI — APPELS RÉELS à api.openai.com, à travers le bundle livré.
 *
 *   DATABASE_URL=postgres://… npm run verify:openai                    # sans clé
 *   OATHRION_OPENAI_TEST_KEY=sk-… DATABASE_URL=… npm run verify:openai
 *
 * ## La différence avec Stripe, et pourquoi elle change la conception
 *
 * **OpenAI n'a pas de mode test.** Chaque appel autorisé avec une vraie clé est FACTURÉ.
 * Ce banc plafonne donc chaque réponse à quelques jetons, choisit le modèle le moins cher
 * disponible sur le compte, et imprime son coût maximal AVANT le premier appel payant.
 *
 * ## Deux sections, et la première tourne toujours
 *
 * SANS CLÉ VALIDE, Oathrion injecte une clé volontairement invalide. OpenAI répond 401 et
 * cite les quatre derniers caractères de la clé REÇUE. S'ils sont ceux de la clé
 * injectée, c'est la preuve, contre le vrai service, qu'Oathrion a remplacé le credential
 * de l'agent — qui n'a envoyé que sa clé Oathrion. Et puisque toute requête relayée rend
 * 401, un refus de politique (403 venu d'Oathrion) prouve à lui seul qu'elle n'est jamais
 * partie.
 *
 * AVEC UNE CLÉ, le parcours complet : une complétion, la même EN FLUX, des embeddings,
 * l'API Responses, et un modèle refusé par la politique.
 *
 * ## Ce que ce banc ne peut PAS prouver, et le dit
 *
 * Qu'un modèle refusé n'a pas été facturé. Stripe permet de relire ses objets ; OpenAI
 * n'expose aucune liste des requêtes reçues à une clé de projet. La preuve qu'un refus
 * n'atteint pas OpenAI vient donc de la PREMIÈRE section, et pas d'une relecture.
 *
 * ## Ce que ce banc refuse
 *
 * Une clé d'administration (`sk-admin-`) : elle gère toute l'organisation, et un banc n'a
 * besoin que de faire des appels. Toute clé qui ne commence pas par `sk-`. La clé
 * n'apparaît dans aucune sortie, et le banc le vérifie.
 *
 * Sortie 0 : tout est prouvé. Sortie 2 : réseau injoignable ou clé absente. Sortie 1 : un
 * contrôle a échoué.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import https from "node:https";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import type { Readable } from "node:stream";

import { createThrowawayDatabase, productionPostgresEnv } from "./lib/throwaway-postgres";
import { CONNECT_ATTEMPT_MS } from "../server/notifications/webhook-transport";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5322;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const OPENAI = "https://api.openai.com";
const RUN = randomBytes(4).toString("hex");

const EMAIL = "openai@placet.test";
const PASSWORD = `openai-${randomBytes(9).toString("hex")}`;
const AGENT_ID = "agt_openai";

/** Le modèle que la politique de ce banc REFUSE. Il n'est jamais appelé. */
const FORBIDDEN_MODEL = "gpt-4o";

/*
 * Les modèles autorisés, du moins cher au plus cher. Le banc prend le premier que le
 * compte expose : un nom figé ici aurait cassé le jour où OpenAI le retire, et c'est
 * précisément le genre de dérive que la vérification contre le vrai service révèle.
 */
const CHEAP_MODELS = ["gpt-4.1-nano", "gpt-4o-mini", "gpt-5-nano", "gpt-4.1-mini", "gpt-5-mini"];
const EMBEDDING_MODEL = "text-embedding-3-small";
/** Le plafond de sortie de CHAQUE appel. 16 est le minimum de l'API Responses. */
const MAX_OUTPUT_TOKENS = 16;

const FAKE_KEY = `sk-placetCleVolontairementInvalide${RUN}Q7Z9`;
const FAKE_LAST4 = FAKE_KEY.slice(-4);

type Child = ChildProcessByStdio<null, Readable, Readable>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
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

/** Le premier contrôle du banc : une clé d'API ordinaire, jamais une clé d'administration. */
export function openaiKeyProblem(key: string): string | null {
  if (key.startsWith("sk-admin-")) {
    return "c'est une clé d'ADMINISTRATION : elle gère l'organisation entière. Ce banc ne fait que des appels — fournissez une clé de projet (sk-proj-…).";
  }
  if (/^(sk|rk|pk)_(test|live)_/.test(key)) return "c'est une clé Stripe, pas une clé OpenAI.";
  if (!/^sk-[A-Za-z0-9_-]{20,}$/.test(key)) return "ce n'est pas une clé d'API OpenAI (sk-… ou sk-proj-…).";
  return null;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
  headers: Headers;
  text: string;
}

async function http(url: string, init: RequestInit = {}): Promise<Reply> {
  try {
    const res = await fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(60_000) });
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

const api = (p: string, o: { token?: string; json?: unknown; method?: string } = {}) =>
  http(`${BASE}${p}`, {
    method: o.method ?? (o.json === undefined ? "GET" : "POST"),
    headers: {
      "content-type": "application/json",
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.json === undefined ? undefined : JSON.stringify(o.json),
  });

/** L'appel de l'AGENT : la base_url d'un SDK OpenAI pointée sur Oathrion, sa clé Oathrion. */
const agent = (key: string, openaiPath: string, json: unknown) =>
  http(`${BASE}/api/v1/intercept/openai${openaiPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(json),
  });

/**
 * Un appel DIRECT à OpenAI, par le banc — jamais pour une requête payante.
 *
 * PAR `node:https`, ET PAS PAR `fetch` — c'est une correction, et elle ne concerne que le
 * banc.
 *
 * Sur la machine où ce banc a été écrit, la route IPv6 vers api.openai.com tombait par
 * intermittence pendant que l'IPv4 répondait. `curl -6` échouait, `curl -4` passait. Le
 * `fetch` de Node restait accroché à l'adresse IPv6 jusqu'à `ETIMEDOUT`, alors que
 * `node:https` basculait vers IPv4 (« Happy Eyeballs », `autoSelectFamily`, actif par
 * défaut sous Node 22). Le banc se déclarait donc « sans réseau » sur sa propre sonde,
 * avant d'avoir rien éprouvé d'Oathrion.
 *
 * Le transport d'Oathrion passe par `https.request`, avec un `lookup` qui rend TOUTES les
 * adresses : il a la même bascule. Le banc emploie désormais le même chemin réseau que ce
 * qu'il éprouve — une sonde plus fragile que le système testé ne mesure que sa fragilité.
 */
function direct(key: string | null, openaiPath: string): Promise<Reply> {
  return new Promise((resolve) => {
    const req = https.get(
      `${OPENAI}${openaiPath}`,
      {
        headers: key ? { authorization: `Bearer ${key}` } : {},
        timeout: 15_000,
        /*
         * Le MÊME délai par tentative que le transport d'Oathrion. Avec celui de Node
         * (250 ms), cette sonde échouait en ETIMEDOUT sur la liaison lente qu'elle était
         * censée éprouver — voir `CONNECT_ATTEMPT_MS`.
         */
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: Record<string, unknown> = {};
          try {
            body = JSON.parse(text) as Record<string, unknown>;
          } catch {
            body = { raw: text.slice(0, 300) };
          }
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === "string") headers.set(name, value);
          }
          resolve({ status: res.statusCode ?? 0, body, headers, text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé (15 s)")));
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ status: 0, body: { error: `${error.code ?? ""} ${error.message}`.trim() }, headers: new Headers(), text: "" }),
    );
  });
}

/** Le message d'erreur d'OpenAI, s'il y en a un. */
const openaiMessage = (r: Reply) =>
  String(((r.body.error ?? {}) as Record<string, unknown>).message ?? "");

interface Oathrion {
  child: Child;
  log: () => string;
  agentKey: string;
  admin: string;
}

async function bootOathrion(dbUrl: string, openaiKey: string): Promise<Oathrion | null> {
  let log = "";
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(dbUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: `openai-${randomBytes(16).toString("hex")}`,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: `${EMAIL}:admin:${PASSWORD}`,
      OATHRION_SEED: "",
      OATHRION_INTERCEPT_PACKS: "openai",
      OATHRION_DESTINATIONS: JSON.stringify([{ id: "openai", url: OPENAI, organizations: "*" }]),
      OATHRION_MCP_ALLOWED_DESTINATIONS: OPENAI,
      OATHRION_INTERCEPT_KEY_OPENAI: openaiKey,
      OATHRION_KEK: randomBytes(32).toString("base64"),
      OATHRION_OPENAI_TEST_KEY: undefined,
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
    say(log.slice(-1500).split(openaiKey).join("‹clé›"));
    child.kill("SIGTERM");
    return null;
  }

  const admin = String((await api("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
  const created = await api("/api/agents", {
    token: admin,
    json: {
      id: AGENT_ID,
      name: "Agent d'assistance",
      description: "Appelle un modèle à travers Oathrion.",
      provider: "openai",
      model: "gpt-4o-mini",
      status: "active",
      owner: "support",
      mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
      permissions: [{ scope: "call:external-api", label: "Appeler une API", description: "Sous mandat.", granted: true, risk: "medium" }],
      policyIds: [],
      tags: ["openai"],
    },
  });
  /*
   * LA POLITIQUE : ce modèle-là est interdit. C'est la décision la plus courante qu'une
   * équipe prend sur une API de modèle — réserver un modèle coûteux, ou en exclure un qui
   * n'est pas hébergé dans la bonne région.
   */
  const policy = await api("/api/policies", {
    token: admin,
    json: {
      id: "pol_openai_modele",
      name: `Le modèle ${FORBIDDEN_MODEL} est réservé`,
      description: "Refus sec sur un modèle nommé.",
      type: "BLOCK_TOOL",
      condition: { kind: "targetMatches", targets: [FORBIDDEN_MODEL] },
      scope: "organization",
      appliesTo: "all agents",
      effect: "block",
      status: "enabled",
      action: "BLOCK",
      risk: "high",
      priority: 5,
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

const chat = (model: string, stream: boolean) => ({
  model,
  messages: [{ role: "user", content: "Réponds uniquement : OK" }],
  max_completion_tokens: MAX_OUTPUT_TOKENS,
  stream,
});

async function main(): Promise<number> {
  say("\n" + "=".repeat(78));
  say("Oathrion — PREUVE DU PAQUET OPENAI (appels réels à api.openai.com)");
  say("=".repeat(78));

  const realKey = process.env.OATHRION_OPENAI_TEST_KEY?.trim() ?? "";

  /* ------------------------------------------------------------- 1. LA CLÉ */
  section("LA CLÉ — une clé d'appel, jamais une clé d'administration");
  record("une clé d'administration sk-admin- est refusée", openaiKeyProblem(`sk-admin-${"a".repeat(30)}`) !== null);
  record("une clé Stripe est refusée", openaiKeyProblem("sk_test_abcdefghijklmnopqrstuvwxyz") !== null);
  record("une clé de projet sk-proj- est acceptée", openaiKeyProblem(`sk-proj-${"a".repeat(40)}`) === null);
  if (realKey !== "") {
    const problem = openaiKeyProblem(realKey);
    record("OATHRION_OPENAI_TEST_KEY est une clé d'appel OpenAI", problem === null, problem ?? "sk-…");
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

  /* ---------------------------------------------------- 2. OPENAI JOIGNABLE */
  section("OPENAI RÉPOND — sans aucune clé");
  const probe = await direct(null, "/v1/models");
  if (probe.status === 0) {
    say(`L'API OpenAI est injoignable depuis cette machine : ${String(probe.body.error).slice(0, 120)}`);
    say("Ce banc prouve un chemin RÉSEAU ; il refuse de passer sans réseau.");
    return 2;
  }
  record("api.openai.com répond, et refuse un appel sans clé", probe.status === 401, `statut ${String(probe.status)}`);

  /* ------------------------------ 3. À TRAVERS OATHRION, CLÉ VOLONTAIREMENT FAUSSE */
  section("À TRAVERS OATHRION — clé injectée volontairement invalide");
  const db1 = await createThrowawayDatabase("oathrion_openai");
  let placet: Oathrion | null = null;
  try {
    placet = await bootOathrion(db1.url, FAKE_KEY);
    record("le bundle de production démarre avec OATHRION_INTERCEPT_PACKS=openai", placet !== null);
    if (!placet) return 1;

    const allowed = await agent(placet.agentKey, "/v1/chat/completions", chat("gpt-4o-mini", false));
    record(
      "un modèle autorisé : la requête est AUTORISÉE",
      allowed.headers.get("x-oathrion-decision") === "ALLOW",
      `décision ${String(allowed.headers.get("x-oathrion-decision"))}`,
    );
    record(
      "… et PARTIE chez OpenAI, qui répond 401 — statut relayé, pas fabriqué",
      allowed.status === 401,
      `statut ${String(allowed.status)}` +
        (allowed.status === 401 ? "" : ` — ${String(allowed.body.code ?? "")} ${String(allowed.body.detail ?? "")}`.slice(0, 140)),
    );
    const message = openaiMessage(allowed);
    record(
      "OpenAI cite la clé que OATHRION a injectée, pas celle de l'agent",
      message.includes(FAKE_LAST4) && !message.includes(placet.agentKey.slice(-4)),
      message.slice(0, 90),
    );
    record("x-oathrion-credential-injected: true", allowed.headers.get("x-oathrion-credential-injected") === "true");
    record("la clé injectée n'apparaît pas en entier dans la réponse", !allowed.text.includes(FAKE_KEY));

    const blocked = await agent(placet.agentKey, "/v1/chat/completions", chat(FORBIDDEN_MODEL, false));
    record(
      `le modèle ${FORBIDDEN_MODEL} est REFUSÉ par la politique`,
      blocked.status === 403 && blocked.headers.get("x-oathrion-decision") === "BLOCK",
      `statut ${String(blocked.status)}, décision ${String(blocked.headers.get("x-oathrion-decision"))}`,
    );
    /* Toute requête relayée rend 401 avec cette clé : un 403 d'Oathrion prouve qu'elle n'est pas partie. */
    record(
      "… et il n'a jamais atteint OpenAI (refus d'Oathrion, pas d'OpenAI)",
      blocked.body.code === "blocked_by_policy" && openaiMessage(blocked) === "",
      String(blocked.body.code),
    );

    const noRule = await agent(placet.agentKey, "/v1/images/generations", { model: "gpt-image-1", prompt: "x" });
    record(
      "un chemin que le paquet ne couvre pas (génération d'images) est REFUSÉ, pas transmis",
      noRule.status === 403 && openaiMessage(noRule) === "",
      `statut ${String(noRule.status)}, ${String(noRule.body.code ?? noRule.body.error ?? "")}`.slice(0, 80),
    );

    const noModel = await agent(placet.agentKey, "/v1/chat/completions", { messages: [{ role: "user", content: "x" }] });
    record(
      "une requête sans `model` est refusée avant tout envoi",
      noModel.status === 422 && openaiMessage(noModel) === "",
      `statut ${String(noModel.status)}`,
    );
  } finally {
    await stop(placet);
    await db1.dispose().catch(() => undefined);
  }

  /* -------------------------------------------- 4. LE PARCOURS AVEC UNE VRAIE CLÉ */
  if (realKey === "") {
    section("LE PARCOURS COMPLET N'A PAS ÉTÉ EXÉCUTÉ");
    say("  Il exige une clé d'API OpenAI (sk-proj-…), de préférence celle d'un projet dédié");
    say("  avec un plafond de dépense bas :");
    say("    OATHRION_OPENAI_TEST_KEY=sk-proj-… DATABASE_URL=… npm run verify:openai");
    say("");
    say("  ATTENTION : OpenAI n'a pas de mode test. Ce parcours est FACTURÉ — quatre appels");
    say(`  plafonnés à ${String(MAX_OUTPUT_TOKENS)} jetons de sortie, soit moins d'un dixième de centime.`);
    return finish(2);
  }

  section("PARCOURS COMPLET — clé réelle, appels FACTURÉS");
  const listed = await direct(realKey, "/v1/models");
  const available = new Set(
    Array.isArray(listed.body.data) ? (listed.body.data as { id?: string }[]).map((m) => String(m.id)) : [],
  );
  record("la clé est acceptée par OpenAI (liste des modèles, gratuite)", listed.status === 200, `statut ${String(listed.status)}`);
  if (listed.status !== 200) return finish(1, realKey);
  const model = CHEAP_MODELS.find((m) => available.has(m)) ?? "";
  record("un modèle peu coûteux est disponible sur ce compte", model !== "", model || `aucun parmi ${CHEAP_MODELS.join(", ")}`);
  if (!model) return finish(1, realKey);
  say(`  · coût maximal de ce parcours : 4 appels × ${String(MAX_OUTPUT_TOKENS)} jetons de sortie sur ${model} — moins de 0,001 $`);

  const db2 = await createThrowawayDatabase("oathrion_openai_full");
  let full: Oathrion | null = null;
  try {
    full = await bootOathrion(db2.url, realKey);
    record("le bundle démarre avec la clé réelle", full !== null);
    if (!full) return finish(1, realKey);

    /* ---- une complétion, sans flux */
    const completion = await agent(full.agentKey, "/v1/chat/completions", chat(model, false));
    const choices = Array.isArray(completion.body.choices) ? completion.body.choices : [];
    const completionId = String(completion.body.id ?? "");
    record(
      "une complétion est AUTORISÉE et RÉPONDUE par OpenAI",
      completion.status === 200 && choices.length > 0,
      `statut ${String(completion.status)}${completion.status === 200 ? `, ${model}` : ` — ${openaiMessage(completion).slice(0, 80)}`}`,
    );
    record("… avec la clé injectée par Oathrion", completion.headers.get("x-oathrion-credential-injected") === "true");

    /* ---- la même, EN FLUX */
    const streamed = await agent(full.agentKey, "/v1/chat/completions", chat(model, true));
    const events = streamed.text.split("\n").filter((line) => line.startsWith("data: "));
    record(
      "en flux : la réponse arrive en événements text/event-stream",
      streamed.status === 200 && (streamed.headers.get("content-type") ?? "").includes("text/event-stream") && events.length >= 2,
      `statut ${String(streamed.status)}, ${String(events.length)} événement(s)`,
    );
    record("… et se termine par [DONE], donc rien n'a été tronqué", streamed.text.includes("data: [DONE]"));

    /* ---- des embeddings */
    const embeddings = await agent(full.agentKey, "/v1/embeddings", { model: EMBEDDING_MODEL, input: "placet" });
    const vector = Array.isArray(embeddings.body.data)
      ? ((embeddings.body.data as { embedding?: unknown[] }[])[0]?.embedding ?? [])
      : [];
    record(
      "des embeddings sont AUTORISÉS et calculés",
      embeddings.status === 200 && vector.length > 0,
      `statut ${String(embeddings.status)}, ${String(vector.length)} dimensions`,
    );

    /* ---- l'API Responses */
    const responses = await agent(full.agentKey, "/v1/responses", {
      model,
      input: "Réponds uniquement : OK",
      max_output_tokens: MAX_OUTPUT_TOKENS,
    });
    record(
      "l'API Responses est AUTORISÉE et répond",
      responses.status === 200 && responses.body.object === "response",
      `statut ${String(responses.status)}${responses.status === 200 ? "" : ` — ${openaiMessage(responses).slice(0, 80)}`}`,
    );

    /* ---- le modèle réservé : refusé, jamais facturé */
    const forbidden = await agent(full.agentKey, "/v1/chat/completions", chat(FORBIDDEN_MODEL, false));
    record(
      `le modèle ${FORBIDDEN_MODEL} est REFUSÉ par la politique, avec la vraie clé aussi`,
      forbidden.status === 403 && forbidden.body.code === "blocked_by_policy",
      `statut ${String(forbidden.status)}`,
    );

    /* ---- ce qu'Oathrion garde, et ce qu'il ne garde pas */
    const stored = (await api("/api/executions", { token: full.admin })).text;
    /*
     * L'identifiant de la complétion (`chatcmpl-…`) est unique et n'existe que dans la
     * réponse d'OpenAI : s'il sort d'une lecture de la base, c'est qu'Oathrion y a écrit
     * la réponse du fournisseur — le contenu généré avec.
     */
    record(
      "la réponse d'OpenAI n'est PAS écrite dans la base d'Oathrion",
      completionId !== "" && !stored.includes(completionId),
      completionId ? "identifiant de complétion absent des exécutions" : "aucun identifiant reçu",
    );
    record(
      "le refus et les quatre succès sont tracés",
      (stored.match(/"blocked"/g) ?? []).length >= 1 && (stored.match(/"allowed"/g) ?? []).length >= 4,
    );
    record("la clé n'apparaît ni dans la base, ni dans le journal du processus", !stored.includes(realKey) && !full.log().includes(realKey));
  } finally {
    await stop(full);
    await db2.dispose().catch(() => undefined);
  }

  section("CE QUI RESTE NON PROUVÉ ICI");
  say("  · qu'un modèle refusé n'a pas été facturé : OpenAI n'expose pas les requêtes reçues");
  say("    à une clé de projet. La preuve qu'un refus ne part pas vient de la section sans clé.");
  say("  · le streaming de l'API Responses : seule une réponse tamponnée est exercée.");
  return finish(0, realKey);
}

function finish(code: number, realKey = ""): number {
  if (realKey !== "") {
    record("la clé n'apparaît dans AUCUNE ligne affichée par ce banc", !printed.join("\n").includes(realKey));
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
    const key = process.env.OATHRION_OPENAI_TEST_KEY ?? "";
    const text = String(error instanceof Error ? error.stack : error);
    console.error(key ? text.split(key).join("‹clé›") : text);
    process.exit(1);
  });
