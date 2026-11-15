/**
 * Preuve du paquet Slack — APPELS RÉELS à slack.com, à travers le bundle livré.
 *
 *   DATABASE_URL=postgres://… npm run verify:slack                          # sans jeton
 *   OATHRION_SLACK_TEST_TOKEN=xoxb-… OATHRION_SLACK_TEST_CHANNEL=C0… \
 *     DATABASE_URL=… npm run verify:slack
 *
 * ## Ce qui distingue Slack, et ce que cela change à la preuve
 *
 * **L'API Web de Slack répond HTTP 200 même quand elle refuse**, avec `{"ok": false,
 * "error": "…"}` dans le corps. Et contrairement à Stripe ou OpenAI, elle ne cite pas le
 * jeton reçu dans son message d'erreur.
 *
 * La preuve d'injection passe donc par la NATURE de l'erreur :
 *
 *   `not_authed`    → Slack n'a reçu AUCUN jeton
 *   `invalid_auth`  → Slack a reçu un jeton, et il est faux
 *
 * Oathrion injecte un jeton volontairement invalide. Si Slack répond `invalid_auth`, un jeton
 * est arrivé — et ce ne peut pas être celui de l'agent, puisque `authorization` fait partie
 * des en-têtes qu'Oathrion ne relaie jamais (`NEVER_FORWARDED`). Un mutant qui coupe
 * l'injection fait répondre `not_authed`.
 *
 * Et puisque Slack répond 200 à TOUT, un 403 reçu par l'agent ne peut venir que d'Oathrion :
 * un refus de politique est la preuve qu'aucune requête n'est partie.
 *
 * ## Ce que ce banc a corrigé
 *
 * Parce que Slack répond 200 en cas d'échec, Oathrion — qui jugeait la réussite d'un relais
 * sur le statut HTTP — enregistrait un appel refusé par Slack comme RÉUSSI. La première
 * version de ce banc l'affichait comme une limite. Le paquet déclare désormais
 * `successField: "ok"`, et le banc EXIGE que le refus soit enregistré comme un échec.
 *
 * ## Ce que ce banc refuse
 *
 * Tout jeton qui n'est pas un jeton de BOT (`xoxb-`, ou `xoxe.xoxb-` quand la rotation est
 * activée). Un jeton utilisateur (`xoxp-`, `xoxe.xoxp-`) agit
 * au nom d'une personne, avec tous ses droits ; un jeton d'application (`xapp-`) ne sert
 * pas à poster. Le message envoyé est supprimé à la fin du banc.
 *
 * Sortie 0 : tout est prouvé. Sortie 2 : réseau injoignable ou jeton absent. Sortie 1 : un
 * contrôle a échoué.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import https from "node:https";
import path from "node:path";
import type { Readable } from "node:stream";

import { createThrowawayDatabase, productionPostgresEnv } from "./lib/throwaway-postgres";
import { CONNECT_ATTEMPT_MS } from "../server/notifications/webhook-transport";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5323;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const SLACK = "https://slack.com";
const RUN = randomBytes(4).toString("hex");

const EMAIL = "slack@placet.test";
const PASSWORD = `slack-${randomBytes(9).toString("hex")}`;
const AGENT_ID = "agt_slack";

/** Le canal que la politique de ce banc REFUSE. Aucun message n'y est jamais envoyé. */
const FORBIDDEN_CHANNEL = "C0PLACETBLOQUE";

const FAKE_TOKEN = `xoxb-0000000000-0000000000000-placetJetonVolontairementInvalide${RUN}`;

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

/** Le premier contrôle : un jeton de BOT, rien d'autre. */
export function slackTokenProblem(token: string): string | null {
  /*
   * Quand l'application active la rotation des jetons, Slack préfixe chaque jeton d'accès
   * par `xoxe.` (`xoxe.xoxb-…` pour le bot, `xoxe.xoxp-…` pour la personne) et délivre
   * aussi un jeton de RENOUVELLEMENT `xoxe-…`. Le préfixe retiré, la règle est la même.
   */
  if (token.startsWith("xoxe-")) {
    return "c'est un jeton de RENOUVELLEMENT (rotation activée) ; il ne sert pas à poster. Fournissez le jeton du bot (xoxb-… ou xoxe.xoxb-…).";
  }
  if (token.startsWith("xoxe.")) token = token.slice("xoxe.".length);
  if (token.startsWith("xoxp-")) {
    return "c'est un jeton UTILISATEUR : il agit au nom d'une personne, avec tous ses droits. Fournissez le jeton du bot (xoxb-…).";
  }
  if (token.startsWith("xapp-")) return "c'est un jeton d'APPLICATION ; il ne sert pas à poster. Fournissez le jeton du bot (xoxb-…).";
  if (!/^xoxb-[A-Za-z0-9-]{20,}$/.test(token)) return "ce n'est pas un jeton de bot Slack (xoxb-…).";
  return null;
}

/** Un identifiant de canal Slack : C (public), G (privé) ou D (message direct). */
export function slackChannelProblem(channel: string): string | null {
  if (!/^[CGD][A-Z0-9]{8,}$/.test(channel)) {
    return "ce n'est pas un identifiant de canal Slack (C0…) — un nom d'espace ou de canal ne convient pas. Il se lit dans l'adresse du canal, après /client/T…/.";
  }
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

/** L'appel de l'AGENT : un client Slack dont l'adresse de l'API pointe sur Oathrion. */
const agent = (key: string, slackPath: string, json: unknown) =>
  http(`${BASE}/api/v1/intercept/slack${slackPath}`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(json),
  });

/**
 * Un appel DIRECT à Slack, par le banc — par `node:https`, avec le même délai par
 * tentative que le transport d'Oathrion (voir `CONNECT_ATTEMPT_MS`).
 */
function direct(token: string | null, slackPath: string, json?: unknown): Promise<Reply> {
  const body = json === undefined ? "" : JSON.stringify(json);
  return new Promise((resolve) => {
    const req = https.request(
      `${SLACK}${slackPath}`,
      {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body ? { "content-type": "application/json; charset=utf-8" } : {}),
        },
        timeout: 15_000,
        autoSelectFamily: true,
        autoSelectFamilyAttemptTimeout: CONNECT_ATTEMPT_MS,
      } as https.RequestOptions,
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(text) as Record<string, unknown>;
          } catch {
            parsed = { raw: text.slice(0, 300) };
          }
          resolve({ status: res.statusCode ?? 0, body: parsed, headers: new Headers(), text });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé (15 s)")));
    req.on("error", (error: NodeJS.ErrnoException) =>
      resolve({ status: 0, body: { error: `${error.code ?? ""} ${error.message}`.trim() }, headers: new Headers(), text: "" }),
    );
    req.end(body);
  });
}

/** L'erreur que Slack rend dans le corps, si `ok` vaut false. */
const slackError = (r: Reply) => (r.body.ok === false ? String(r.body.error ?? "") : "");

interface Oathrion {
  child: Child;
  log: () => string;
  agentKey: string;
  admin: string;
}

async function bootOathrion(dbUrl: string, slackToken: string): Promise<Oathrion | null> {
  let log = "";
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(dbUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: `slack-${randomBytes(16).toString("hex")}`,
      OATHRION_API_KEYS: "",
      OATHRION_CONSOLE_USERS: `${EMAIL}:admin:${PASSWORD}`,
      OATHRION_SEED: "",
      OATHRION_INTERCEPT_PACKS: "slack",
      OATHRION_DESTINATIONS: JSON.stringify([{ id: "slack", url: SLACK, organizations: "*" }]),
      OATHRION_MCP_ALLOWED_DESTINATIONS: SLACK,
      OATHRION_INTERCEPT_KEY_SLACK: slackToken,
      OATHRION_KEK: randomBytes(32).toString("base64"),
      OATHRION_SLACK_TEST_TOKEN: undefined,
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
    say(log.slice(-1500).split(slackToken).join("‹jeton›"));
    child.kill("SIGTERM");
    return null;
  }

  const admin = String((await api("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } })).body.token ?? "");
  const created = await api("/api/agents", {
    token: admin,
    json: {
      id: AGENT_ID,
      name: "Agent de communication",
      description: "Poste dans Slack à travers Oathrion.",
      provider: "openai",
      model: "gpt-4o-mini",
      status: "active",
      owner: "communication",
      mandate: { maxTransactionAmount: 10_000, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: [] },
      permissions: [{ scope: "send:email", label: "Envoyer des messages", description: "Sous mandat.", granted: true, risk: "medium" }],
      policyIds: [],
      tags: ["slack"],
    },
  });
  /* LA POLITIQUE : ce canal-là est interdit. */
  const policy = await api("/api/policies", {
    token: admin,
    json: {
      id: "pol_slack_canal",
      name: "Canal réservé",
      description: "Refus sec sur un canal nommé.",
      type: "BLOCK_TOOL",
      condition: { kind: "targetMatches", targets: [FORBIDDEN_CHANNEL] },
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
    say(
      `  mise en place impossible : agent ${String(created.status)} ${JSON.stringify(created.body).slice(0, 160)}, ` +
        `politique ${String(policy.status)}, clé ${agentKey ? "ok" : "absente"}`,
    );
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

async function main(): Promise<number> {
  say("\n" + "=".repeat(78));
  say("Oathrion — PREUVE DU PAQUET SLACK (appels réels à slack.com)");
  say("=".repeat(78));

  const realToken = process.env.OATHRION_SLACK_TEST_TOKEN?.trim() ?? "";
  const channel = process.env.OATHRION_SLACK_TEST_CHANNEL?.trim() ?? "";

  /* ---------------------------------------------------------- 1. LE JETON */
  section("LE JETON — un jeton de bot, rien d'autre");
  record("un jeton utilisateur xoxp- est refusé", slackTokenProblem(`xoxp-${"1".repeat(30)}`) !== null);
  record("un jeton d'application xapp- est refusé", slackTokenProblem(`xapp-${"1".repeat(30)}`) !== null);
  record("un jeton de bot xoxb- est accepté", slackTokenProblem(`xoxb-${"1".repeat(30)}`) === null);
  record("un jeton utilisateur à rotation xoxe.xoxp- est refusé", slackTokenProblem(`xoxe.xoxp-1-${"1".repeat(30)}`) !== null);
  record("un jeton de renouvellement xoxe- est refusé", slackTokenProblem(`xoxe-1-${"1".repeat(30)}`) !== null);
  record("un jeton de bot à rotation xoxe.xoxb- est accepté", slackTokenProblem(`xoxe.xoxb-1-${"1".repeat(30)}`) === null);
  if (realToken !== "") {
    const problem = slackTokenProblem(realToken);
    record("OATHRION_SLACK_TEST_TOKEN est un jeton de bot", problem === null, problem ?? "xoxb-…");
    const channelProblem = slackChannelProblem(channel);
    record("OATHRION_SLACK_TEST_CHANNEL est un identifiant de canal", channelProblem === null, channelProblem ?? channel);
    if (problem !== null || channelProblem !== null) {
      say("\nArrêt : aucun appel n'a été fait avec ce jeton.");
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

  /* --------------------------------------------------- 2. SLACK JOIGNABLE */
  section("SLACK RÉPOND — sans aucun jeton");
  const probe = await direct(null, "/api/auth.test");
  if (probe.status === 0) {
    say(`L'API Slack est injoignable depuis cette machine : ${String(probe.body.error).slice(0, 120)}`);
    say("Ce banc prouve un chemin RÉSEAU ; il refuse de passer sans réseau.");
    return 2;
  }
  record(
    "slack.com répond HTTP 200… et refuse dans le corps : `not_authed`",
    probe.status === 200 && slackError(probe) === "not_authed",
    `statut ${String(probe.status)}, ${slackError(probe) || "ok"}`,
  );

  /* ---------------------------- 3. À TRAVERS OATHRION, JETON VOLONTAIREMENT FAUX */
  section("À TRAVERS OATHRION — jeton injecté volontairement invalide");
  const db1 = await createThrowawayDatabase("oathrion_slack");
  let placet: Oathrion | null = null;
  try {
    placet = await bootOathrion(db1.url, FAKE_TOKEN);
    record("le bundle de production démarre avec OATHRION_INTERCEPT_PACKS=slack", placet !== null);
    if (!placet) return 1;

    const allowed = await agent(placet.agentKey, "/api/chat.postMessage", {
      channel: "C0PLACETAUTORISE",
      text: "jamais affiché",
    });
    record(
      "un canal autorisé : la requête est AUTORISÉE",
      allowed.headers.get("x-oathrion-decision") === "ALLOW",
      `décision ${String(allowed.headers.get("x-oathrion-decision"))}`,
    );
    record(
      "… et PARTIE chez Slack, qui la refuse dans le corps",
      allowed.status === 200 && slackError(allowed) !== "",
      `statut ${String(allowed.status)}, ${slackError(allowed) || String(allowed.body.code ?? "")}`,
    );
    /*
     * LA PREUVE CENTRALE : `invalid_auth` et non `not_authed`. Un jeton est arrivé chez
     * Slack, et l'agent n'en a envoyé aucun qu'Oathrion relaierait.
     */
    record(
      "Slack a reçu UN jeton (`invalid_auth`, pas `not_authed`) — celui qu'Oathrion injecte",
      slackError(allowed) === "invalid_auth",
      slackError(allowed),
    );
    record("x-oathrion-credential-injected: true", allowed.headers.get("x-oathrion-credential-injected") === "true");
    record("le jeton injecté n'apparaît pas dans la réponse", !allowed.text.includes(FAKE_TOKEN));

    const blocked = await agent(placet.agentKey, "/api/chat.postMessage", { channel: FORBIDDEN_CHANNEL, text: "x" });
    record(
      "le canal réservé est REFUSÉ par la politique",
      blocked.status === 403 && blocked.headers.get("x-oathrion-decision") === "BLOCK",
      `statut ${String(blocked.status)}, décision ${String(blocked.headers.get("x-oathrion-decision"))}`,
    );
    /* Slack répond 200 à tout : un 403 ne peut venir que d'Oathrion. */
    record(
      "… et rien n'est parti : Slack ne répond jamais 403",
      blocked.body.code === "blocked_by_policy" && blocked.body.ok === undefined,
      String(blocked.body.code),
    );

    const noRule = await agent(placet.agentKey, "/api/conversations.create", { name: "canal-pirate" });
    record(
      "un chemin que le paquet ne couvre pas (créer un canal) est REFUSÉ, pas transmis",
      noRule.status === 403 && noRule.body.ok === undefined,
      `statut ${String(noRule.status)}, ${String(noRule.body.code ?? noRule.body.error ?? "")}`.slice(0, 80),
    );

    const noChannel = await agent(placet.agentKey, "/api/chat.postMessage", { text: "x" });
    record("un message sans `channel` est refusé avant tout envoi", noChannel.status === 422, `statut ${String(noChannel.status)}`);

    /*
     * LE REÇU DIT LA VÉRITÉ. Slack a refusé l'appel autorisé tout en répondant 200. La
     * première version de ce banc affichait ici une LIMITE : Oathrion enregistrait l'appel
     * comme RÉUSSI, parce qu'il jugeait sur le statut HTTP. Le paquet Slack déclare
     * désormais `successField: "ok"`, et ce contrôle exige que le refus soit un échec.
     */
    const executions = await api("/api/executions", { token: placet.admin });
    const allowedId = allowed.headers.get("x-oathrion-execution-id") ?? "";
    const recorded = (executions.body as unknown as Record<string, unknown>[] | undefined) ?? [];
    const mine = Array.isArray(recorded) ? recorded.find((entry) => entry.id === allowedId) : undefined;
    record(
      "l'appel refusé par Slack (200 + ok:false) est enregistré comme ÉCHOUÉ, pas comme envoyé",
      String(mine?.status ?? "") === "failed",
      `statut enregistré : ${String(mine?.status ?? "introuvable")}`,
    );
  } finally {
    await stop(placet);
    await db1.dispose().catch(() => undefined);
  }

  /* ------------------------------------------------ 4. AVEC UN VRAI JETON */
  if (realToken === "") {
    section("LE PARCOURS COMPLET N'A PAS ÉTÉ EXÉCUTÉ");
    say("  Il exige le jeton d'un BOT (xoxb-…) et l'identifiant d'un canal où le bot est invité :");
    say("    OATHRION_SLACK_TEST_TOKEN=xoxb-… OATHRION_SLACK_TEST_CHANNEL=C0… DATABASE_URL=… npm run verify:slack");
    say("");
    say("  Gratuit : un espace de travail Slack de test suffit. Le message envoyé est supprimé à la fin.");
    return finish(2);
  }

  section("PARCOURS COMPLET — jeton de bot réel");
  const identity = await direct(realToken, "/api/auth.test");
  record(
    "le jeton est accepté par Slack (auth.test)",
    identity.body.ok === true,
    identity.body.ok === true ? `espace « ${String(identity.body.team)} », bot ${String(identity.body.user)}` : slackError(identity),
  );
  if (identity.body.ok !== true) return finish(1, realToken);

  const db2 = await createThrowawayDatabase("oathrion_slack_full");
  let full: Oathrion | null = null;
  let postedTs = "";
  try {
    full = await bootOathrion(db2.url, realToken);
    record("le bundle démarre avec le jeton réel", full !== null);
    if (!full) return finish(1, realToken);

    const marker = `[Oathrion ${RUN}] message autorisé, envoyé par un agent à travers Oathrion — supprimé en fin de banc`;
    const posted = await agent(full.agentKey, "/api/chat.postMessage", { channel, text: marker });
    postedTs = String(posted.body.ts ?? "");
    record(
      "un message vers le canal autorisé est AUTORISÉ et PUBLIÉ par Slack",
      posted.status === 200 && posted.body.ok === true && postedTs !== "",
      posted.body.ok === true ? `ts ${postedTs}` : `${slackError(posted) || String(posted.body.code ?? posted.status)}`,
    );
    if (slackError(posted) === "not_in_channel") {
      say("    → le bot n'est pas membre du canal. Dans Slack, tapez /invite @<nom du bot> dans ce canal, puis relancez.");
    }
    record("… avec le jeton injecté par Oathrion", posted.headers.get("x-oathrion-credential-injected") === "true");

    const blocked = await agent(full.agentKey, "/api/chat.postMessage", { channel: FORBIDDEN_CHANNEL, text: "x" });
    record(
      "le canal réservé est REFUSÉ, avec le vrai jeton aussi",
      blocked.status === 403 && blocked.body.code === "blocked_by_policy",
      `statut ${String(blocked.status)}`,
    );

    const stored = (await api("/api/executions", { token: full.admin })).text;
    /*
     * Le `ts` est l'identifiant du message chez Slack, et il n'existe que dans la réponse :
     * s'il sort d'une lecture de la base, Oathrion y a écrit la réponse de Slack.
     */
    record(
      "la réponse de Slack n'est PAS écrite dans la base d'Oathrion",
      postedTs !== "" && !stored.includes(postedTs),
      postedTs ? "identifiant du message absent des exécutions" : "aucun message publié",
    );
    record(
      "le jeton n'apparaît ni dans la base, ni dans le journal du processus",
      !stored.includes(realToken) && !full.log().includes(realToken),
    );
  } finally {
    await stop(full);
    await db2.dispose().catch(() => undefined);
    if (postedTs) {
      const removed = await direct(realToken, "/api/chat.delete", { channel, ts: postedTs });
      say(`  ${removed.body.ok === true ? "·" : "!"} message de test ${removed.body.ok === true ? "supprimé" : `NON supprimé (${slackError(removed)})`}`);
    }
  }

  section("CE QUI RESTE NON PROUVÉ ICI");
  say("  · `files.getUploadURLExternal` et `chat.postEphemeral` : non exercés.");
  say("  · qu'un canal refusé n'a rien reçu : la preuve vient de la section sans jeton,");
  say("    puisque Slack ne répond jamais 403.");
  return finish(0, realToken);
}

function finish(code: number, realToken = ""): number {
  if (realToken !== "") {
    record("le jeton n'apparaît dans AUCUNE ligne affichée par ce banc", !printed.join("\n").includes(realToken));
  }
  const failed = checks.filter((c) => !c.ok).length;
  say("\n" + "=".repeat(72));
  say(`${String(checks.length - failed)}/${String(checks.length)} contrôles passés`);
  if (code === 2 && failed === 0) {
    say("Sortie 2 : le parcours avec un vrai jeton n'a pas été exécuté.");
    say("« Je n'ai pas pu tester » ne doit pas pouvoir se lire « j'ai testé ».");
  }
  say("=".repeat(72) + "\n");
  if (failed > 0) return 1;
  return code;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    const token = process.env.OATHRION_SLACK_TEST_TOKEN ?? "";
    const text = String(error instanceof Error ? error.stack : error);
    console.error(token ? text.split(token).join("‹jeton›") : text);
    process.exit(1);
  });
