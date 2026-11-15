/**
 * Oathrion — PREUVE DU PARCOURS DE LANCEMENT, CONTRE LES VRAIS SERVICES.
 *
 *   DATABASE_URL=postgres://… npm run verify:launch
 *
 * Variables de test, toutes optionnelles (chaque service absent est DIT, jamais réputé
 * réussi) :
 *
 *   OATHRION_GITHUB_TEST_TOKEN   jeton GitHub à portée fine (Issues: Read and write)
 *   OATHRION_GITHUB_TEST_REPO    owner/repo — un dépôt de TEST, des issues y sont ouvertes puis fermées
 *   OATHRION_SLACK_TEST_TOKEN    jeton de BOT (xoxb-), invité dans le canal
 *   OATHRION_SLACK_TEST_CHANNEL  identifiant du canal de test (C0…)
 *   OATHRION_LINEAR_TEST_KEY     clé d'API personnelle Linear (lin_api_…)
 *   OATHRION_LINEAR_TEST_TEAM    clé d'une équipe de TEST (ENG) — une issue y est créée puis archivée
 *   OATHRION_STRIPE_TEST_KEY     clé Stripe de TEST (sk_test_… ou rk_test_…) — une clé réelle est
 *                              refusée. Un remboursement de 1 unité est fait sur un paiement de
 *                              test réussi : IRRÉVERSIBLE, mais en mode test (aucun argent réel).
 *
 * ## Ce que ce banc prouve, dans l'ordre
 *
 *   0. Sans aucun credential : les trois services RÉELS sont joints et refusent une clé
 *      fabriquée — avec leur propre message. Un connecteur simulé ne passerait pas.
 *   1. Le bundle LIVRÉ démarre sans aucun compte dans l'environnement
 *      (`OATHRION_ACCOUNTS=database`). Un espace est créé par `workspace:create`, le lien est
 *      lu puis accepté par l'API publique, et la personne se connecte : le parcours client
 *      sans terminal, sur le binaire de production.
 *   2. Pour chaque service fourni : connexion vérifiée par le service, ressources réelles,
 *      choix du périmètre écrit en politiques.
 *   3. Le scénario guidé, par la passerelle, contre les vrais services : lecture autorisée,
 *      écritures retenues puis approuvées, tentative hors périmètre bloquée sans appel ;
 *      chaque création est ensuite RELUE directement chez le fournisseur.
 *      Stripe : lecture des paiements par le scénario, remboursement hors périmètre bloqué
 *      sans appel, remboursement retenu puis approuvé, RELU chez Stripe, et la clé
 *      d'idempotence de l'exécution rejouée directement : Stripe rend le MÊME remboursement.
 *   4. Nettoyage : l'issue GitHub est fermée, l'issue Linear archivée, les messages Slack
 *      supprimés. Le jeton Slack n'est PAS révoqué : c'est le vôtre. Un remboursement Stripe
 *      ne s'annule pas : il reste dans le compte de TEST, marqué `placet_execution`.
 *
 * Sortie 0 : les services ont tous été éprouvés. Sortie 2 : au moins un service n'a pas
 * de credential de test (le reste peut être vert). Sortie 1 : un contrôle a échoué.
 */

import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import https from "node:https";
import path from "node:path";
import type { Readable } from "node:stream";

import { createThrowawayDatabase, productionPostgresEnv } from "./lib/throwaway-postgres";
import { CONNECT_ATTEMPT_MS } from "../server/notifications/webhook-transport";
import { GithubConnector } from "../server/connectors/github";
import { SlackConnector } from "../server/connectors/slack";
import { LinearConnector } from "../server/connectors/linear";
import { StripeConnector } from "../server/connectors/stripe";

const ROOT = path.resolve(import.meta.dirname, "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5324;
const BASE = `http://127.0.0.1:${String(PORT)}`;
const RUN = randomBytes(4).toString("hex");
const EMAIL = `fondatrice-${RUN}@placet.test`;
const PASSWORD = `lancement-${randomBytes(12).toString("hex")}`;

type Child = ChildProcessByStdio<null, Readable, Readable>;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const env = (name: string) => process.env[name]?.trim() ?? "";
const GH_TOKEN = env("OATHRION_GITHUB_TEST_TOKEN");
const GH_REPO = env("OATHRION_GITHUB_TEST_REPO").replace(/^https?:\/\/github\.com\//, "").replace(/\/+$/, "");
const SLACK_TOKEN = env("OATHRION_SLACK_TEST_TOKEN");
const SLACK_CHANNEL = env("OATHRION_SLACK_TEST_CHANNEL");
const LINEAR_KEY = env("OATHRION_LINEAR_TEST_KEY");
const LINEAR_TEAM = env("OATHRION_LINEAR_TEST_TEAM").toUpperCase();
const STRIPE_KEY = env("OATHRION_STRIPE_TEST_KEY");
/* Le banc n'utilise JAMAIS une clé réelle : un remboursement y déplacerait de l'argent. */
const STRIPE_LIVE = /^(sk|rk)_live_/.test(STRIPE_KEY);
const SECRETS = [GH_TOKEN, SLACK_TOKEN, LINEAR_KEY, STRIPE_KEY, PASSWORD].filter((s) => s.length >= 8);

const have = {
  github: GH_TOKEN !== "" && /^[^/\s]+\/[^/\s]+$/.test(GH_REPO),
  slack: SLACK_TOKEN !== "" && /^[CG][A-Z0-9]{8,}$/.test(SLACK_CHANNEL),
  linear: LINEAR_KEY !== "" && /^[A-Z][A-Z0-9_]{0,9}$/.test(LINEAR_TEAM),
  stripe: /^(sk|rk)_test_[A-Za-z0-9]{10,}$/.test(STRIPE_KEY),
};

interface Check {
  name: string;
  ok: boolean;
}
const checks: Check[] = [];
const printed: string[] = [];

function mask(line: string): string {
  let out = line;
  for (const secret of SECRETS) out = out.split(secret).join("‹secret›");
  return out;
}
function say(line: string): void {
  const masked = mask(line);
  printed.push(masked);
  console.log(masked);
}
function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok });
  say(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  say(`\n── ${label} ${"─".repeat(Math.max(0, 72 - label.length))}`);
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

async function http(url: string, init: RequestInit = {}): Promise<Reply> {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      body = Array.isArray(parsed) ? { items: parsed } : (parsed as Record<string, unknown>);
    } catch {
      body = { raw: text.slice(0, 300) };
    }
    return { status: res.status, body };
  } catch (error) {
    return { status: 0, body: { error: String(error) } };
  }
}

const api = (p: string, o: { token?: string; json?: unknown; method?: string } = {}) =>
  http(`${BASE}${p}`, {
    method: o.method ?? (o.json === undefined ? "GET" : "POST"),
    headers: { "content-type": "application/json", ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.json === undefined ? undefined : JSON.stringify(o.json),
  });

/** Un appel DIRECT au fournisseur, par le banc : relire ce qu'Oathrion dit avoir créé. */
function direct(url: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve) => {
    const req = https.request(
      url,
      {
        method: init.method ?? "GET",
        headers: { "user-agent": "placet-verify-launch", ...(init.headers ?? {}) },
        timeout: 20_000,
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
            body = { raw: text.slice(0, 200) };
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("délai dépassé")));
    req.on("error", (e: NodeJS.ErrnoException) => resolve({ status: 0, body: { error: `${e.code ?? ""} ${e.message}` } }));
    req.end(init.body ?? "");
  });
}

const github = (p: string, method = "GET", json?: unknown) =>
  direct(`https://api.github.com${p}`, {
    method,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(json ? { "content-type": "application/json" } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
  });
const slack = (method: string, json: unknown) =>
  direct(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SLACK_TOKEN}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(json),
  });
const stripeApi = (p: string, method = "GET", form?: Record<string, string>, idempotencyKey?: string) =>
  direct(`https://api.stripe.com${p}`, {
    method,
    headers: {
      authorization: `Bearer ${STRIPE_KEY}`,
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
const linear = (query: string, variables: Record<string, unknown> = {}) =>
  direct("https://api.linear.app/graphql", {
    method: "POST",
    headers: { authorization: LINEAR_KEY, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

/* ------------------------------------------------------------------------------ */

async function phaseZero(): Promise<void> {
  section("0. LES VRAIS SERVICES RÉPONDENT — sans aucun credential");
  const fake = (prefix: string) => `${prefix}${"0".repeat(10)}-placetCleFabriquee${RUN}`;
  const probes: [string, Promise<{ ok: boolean; code: string; detail: string }>, RegExp][] = [
    ["GitHub", new GithubConnector().verify(fake("github_pat_"), {}, process.env), /\(GitHub : Bad credentials\)/],
    ["Slack", new SlackConnector().verify(`xoxb-${fake("")}`, {}, process.env), /invalid_auth/],
    ["Linear", new LinearConnector().verify(fake("lin_api_"), {}, process.env), /Linear : /],
    ["Stripe", new StripeConnector().verify(`sk_test_${fake("").replace(/-/g, "")}`, {}, process.env), /\(Stripe : Invalid API Key provided: sk_test_\*\*\*\)/],
  ];
  for (const [label, pending, quote] of probes) {
    const probe = await pending;
    record(`${label} refuse une clé fabriquée, classée « unauthorized »`, !probe.ok && probe.code === "unauthorized", probe.code);
    record(`… et le motif cite ${label}, pas Oathrion`, quote.test(probe.detail), probe.detail.slice(0, 90));
  }
}

interface Oathrion {
  child: Child;
  log: () => string;
}

async function boot(dbUrl: string): Promise<Oathrion | null> {
  let log = "";
  const child = spawn("node", [BUNDLE], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...productionPostgresEnv(dbUrl),
      OATHRION_DB: undefined,
      PORT: String(PORT),
      OATHRION_SESSION_SECRET: `lancement-${randomBytes(16).toString("hex")}`,
      OATHRION_ACCOUNTS: "database",
      OATHRION_CONSOLE_USERS: "",
      OATHRION_API_KEYS: "",
      OATHRION_SEED: "",
      OATHRION_PUBLIC_URL: BASE,
      OATHRION_KEK: randomBytes(32).toString("base64"),
      OATHRION_GITHUB_TEST_TOKEN: undefined,
      OATHRION_SLACK_TEST_TOKEN: undefined,
      OATHRION_LINEAR_TEST_KEY: undefined,
      OATHRION_STRIPE_TEST_KEY: undefined,
      OATHRION_STRIPE_ALLOW_LIVE: undefined,
      OATHRION_STRIPE_API_ORIGIN: undefined,
    } as NodeJS.ProcessEnv,
    stdio: ["ignore", "pipe", "pipe"],
  }) as Child;
  child.stdout.on("data", (c: Buffer) => (log += c.toString()));
  child.stderr.on("data", (c: Buffer) => (log += c.toString()));
  for (let i = 0; i < 160; i += 1) {
    if (child.exitCode !== null) break;
    if ((await api("/api/ready")).status === 200) return { child, log: () => log };
    await sleep(400);
  }
  say(mask(log.slice(-1500)));
  child.kill("SIGTERM");
  return null;
}

async function stop(placet: Oathrion | null): Promise<void> {
  if (!placet) return;
  placet.child.kill("SIGTERM");
  for (let i = 0; i < 40 && placet.child.exitCode === null; i += 1) await sleep(250);
}

/** Le parcours client : lien → lecture → acceptation → connexion. Rend le jeton de session. */
async function phaseOne(dbUrl: string): Promise<string | null> {
  section("1. UN ESPACE SANS TERMINAL CÔTÉ CLIENT — sur le bundle livré");
  /*
   * Le BUNDLE `dist/workspace-create.cjs`, celui qu'un exploitant lance dans l'image de
   * production (`docker compose exec placet node dist/workspace-create.cjs …`) — pas le
   * script TypeScript, absent de l'image.
   */
  const created = spawnSync(
    "node",
    [path.join(ROOT, "dist", "workspace-create.cjs"), "--org", `Lancement ${RUN}`, "--email", EMAIL],
    { cwd: ROOT, env: { ...process.env, ...productionPostgresEnv(dbUrl), OATHRION_DB: undefined, OATHRION_PUBLIC_URL: BASE }, encoding: "utf8" },
  );
  const link = /(http\S+#\/bienvenue\?invitation=\S+)/.exec(created.stdout ?? "")?.[1] ?? "";
  record("dist/workspace-create.cjs (exploitant, bundle de l'image) imprime un lien d'accueil", created.status === 0 && link !== "", `sortie ${String(created.status)}`);
  if (!link) {
    say(mask((created.stderr ?? "").slice(-600)));
    return null;
  }
  const token = decodeURIComponent(new URL(link.replace("#/", "")).searchParams.get("invitation") ?? "");
  SECRETS.push(token);
  record("le jeton voyage dans le FRAGMENT de l'URL, jamais envoyé à un serveur", link.includes("/console#/bienvenue?invitation="));

  const inspected = await api("/api/invitations/inspect", { json: { token } });
  record(
    "la page d'accueil lit ce que le lien propose (organisation, adresse, rôle)",
    inspected.status === 200 && inspected.body.role === "admin" && inspected.body.email === EMAIL,
    `${String(inspected.status)} ${String(inspected.body.organizationName ?? "")}`,
  );
  const accepted = await api("/api/invitations/accept", { json: { token, name: "Fondatrice du banc", password: PASSWORD } });
  record("le compte est créé depuis la page, sans commande", accepted.status === 201, String(accepted.status));
  const again = await api("/api/invitations/accept", { json: { token, password: PASSWORD } });
  record("le lien ne sert qu'une fois", again.status === 400, String(again.status));
  const session = await api("/api/auth/login", { json: { email: EMAIL, password: PASSWORD } });
  const sessionToken = String(session.body.token ?? "");
  SECRETS.push(sessionToken);
  record("la personne se connecte avec ce qu'elle vient de choisir", session.status === 200 && sessionToken !== "", String(session.status));
  return sessionToken || null;
}

interface Connected {
  github: string | null;
  slack: string | null;
  linear: string | null;
  stripe: string | null;
}

async function phaseTwo(admin: string): Promise<Connected> {
  section("2. CONNECTER, CHOISIR — vérifié par chaque service");
  const plan: [keyof Connected, string, string][] = [
    ["github", GH_TOKEN, `github.com/${GH_REPO}`],
    ["slack", SLACK_TOKEN, `slack.com/${SLACK_CHANNEL}`],
    ["linear", LINEAR_KEY, `linear.app/${LINEAR_TEAM}`],
    /* Le compte n'est pas une variable : c'est celui de la clé, lu chez Stripe à la connexion. */
    ["stripe", STRIPE_KEY, ""],
  ];
  const out: Connected = { github: null, slack: null, linear: null, stripe: null };
  for (const [id, secret, wanted] of plan) {
    if (!have[id]) {
      say(
        id === "stripe" && STRIPE_LIVE
          ? "  · stripe : la clé fournie est RÉELLE (live) — refusée par le banc, NON ÉPROUVÉ. Fournissez une clé de test."
          : `  · ${id} : aucun credential de test — NON ÉPROUVÉ contre le service réel`,
      );
      continue;
    }
    const connected = await api(`/api/connectors/${id}/connect`, { token: admin, json: { secret } });
    record(`${id} : le service accepte le credential, Oathrion le scelle`, connected.status === 201, `${String(connected.status)} ${String(connected.body.detail ?? "").slice(0, 80)}`);
    if (connected.status !== 201) continue;
    const resources = await api(`/api/connectors/${id}/resources`, { token: admin });
    const targets = ((resources.body.resources ?? []) as { target: string }[]).map((r) => r.target.toLowerCase());
    const resource = wanted !== "" ? wanted : (((resources.body.resources ?? []) as { target: string }[])[0]?.target ?? "");
    record(`${id} : la ressource de test figure dans ce que le service liste`, targets.includes(resource.toLowerCase()), `${String(targets.length)} listée(s)`);
    const saved = await api(`/api/connectors/${id}/selection`, { token: admin, method: "PUT", json: { resources: [resource], writes: "approval" } });
    record(`${id} : le périmètre devient deux politiques`, saved.status === 200, String(saved.status));
    if (saved.status === 200) out[id] = resource;
  }
  return out;
}

const DOMAIN = { github: "github.com", slack: "slack.com", linear: "linear.app", stripe: "stripe.com" } as const;
const SCOPES = {
  github: ["read:repository", "write:repository"],
  slack: ["read:chat", "write:chat"],
  linear: ["read:tasks", "write:tasks"],
  stripe: ["read:payments", "execute:payments"],
} as const;

interface Step {
  key: string;
  decision: string;
  target: string;
  attempted: boolean;
  succeeded: boolean;
  approvalId: string | null;
  executionId: string | null;
  url: string | null;
}

interface Created {
  githubIssue: number | null;
  linearIssue: string | null;
  slackTs: string[];
}

async function phaseThree(admin: string, connected: Connected, created: Created): Promise<void> {
  section("3. LE SCÉNARIO GUIDÉ — par la passerelle, contre les vrais services");
  const ids = (Object.keys(connected) as (keyof Connected)[]).filter((k) => connected[k]);
  const agentId = `agt_lancement_${RUN}`;
  const agent = await api("/api/agents", {
    token: admin,
    json: {
      id: agentId,
      name: "Agent de lancement",
      description: "Joue le scénario guidé contre les vrais services.",
      provider: "custom",
      model: "agent-mcp",
      status: "active",
      owner: "banc",
      mandate: { maxTransactionAmount: null, currency: "EUR", allowedCategories: [], blockedCategories: [], allowedDomains: ids.map((k) => DOMAIN[k]) },
      permissions: ids.flatMap((k) => SCOPES[k].map((scope) => ({ scope, label: scope, description: "", granted: true, risk: "medium" }))),
      policyIds: [],
      tags: ["demarrage"],
    },
  });
  record("l'agent est créé avec les portées des seuls outils connectés", agent.status < 300, String(agent.status));

  const ran = await api("/api/scenario/run", { token: admin, json: { agentId } });
  const steps = (ran.body.steps ?? []) as Step[];
  record("le scénario se joue", ran.status === 200 && steps.length > 0, `${String(ran.status)} · ${String(steps.length)} étape(s)`);
  const by = Object.fromEntries(steps.map((s) => [s.key, s])) as Record<string, Step | undefined>;

  if (by.read) record("lecture du contexte : AUTORISÉE et réussie chez le service", by.read.decision === "ALLOW" && by.read.succeeded, `${by.read.decision} · ${by.read.target}`);
  if (by.payments) {
    record("lecture des paiements Stripe : AUTORISÉE et réussie chez Stripe", by.payments.decision === "ALLOW" && by.payments.succeeded, `${by.payments.decision} · ${by.payments.target}`);
  }
  if (by.outside) {
    record("action hors périmètre : BLOQUÉE", by.outside.decision === "BLOCK", `${by.outside.decision} · ${by.outside.target}`);
    record("… et jamais tentée chez le service", by.outside.attempted === false);
  }

  for (const key of ["task", "issue"] as const) {
    const step = by[key];
    if (!step) continue;
    record(`${key === "task" ? "tâche Linear" : "issue GitHub"} : RETENUE avant approbation, rien de parti`, step.decision === "APPROVAL_REQUIRED" && !step.attempted, step.decision);
    if (!step.approvalId) continue;
    const approved = await api(`/api/approvals/${step.approvalId}/approve`, { token: admin, json: {} });
    const url = String((approved.body.toolResult as { url?: unknown } | null)?.url ?? "");
    record(`… approuvée : le service l'a créée`, approved.status === 200 && approved.body.succeeded === true, url || String(approved.status));
    if (key === "issue" && url) {
      const number = Number(/\/issues\/(\d+)$/.exec(url)?.[1] ?? 0);
      created.githubIssue = number || null;
      const read = await github(`/repos/${GH_REPO}/issues/${String(number)}`);
      record("RELUE directement chez GitHub : l'issue existe et porte l'exécution", read.status === 200 && String(read.body.body ?? "").includes("placet-execution"), `#${String(number)}`);
    }
    if (key === "task" && url) {
      const identifier = /\/issue\/([A-Z0-9_]+-\d+)/.exec(url)?.[1] ?? "";
      const read = await linear("query($id: String!) { issue(id: $id) { id identifier team { key } } }", { id: identifier });
      const issue = (read.body.data as { issue?: { id?: string; team?: { key?: string } } } | undefined)?.issue;
      created.linearIssue = issue?.id ?? null;
      record("RELUE directement chez Linear : l'issue existe dans l'équipe choisie", issue?.team?.key === LINEAR_TEAM, identifier);
      /*
       * LA GARANTIE D'IDEMPOTENCE, ÉPROUVÉE ICI ET NULLE PART AILLEURS. Oathrion envoie un
       * UUID dérivé de l'exécution ; la règle de rejeu ne s'y fie pas tant que Linear n'a
       * pas montré qu'il refuse un second `issueCreate` portant le même identifiant.
       */
      if (issue?.id) {
        const team = await linear("query($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id } } }", { key: LINEAR_TEAM });
        const teamId = ((team.body.data as { teams?: { nodes?: { id?: string }[] } } | undefined)?.teams?.nodes ?? [])[0]?.id;
        const again = await linear(
          "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id } } }",
          { input: { id: issue.id, teamId, title: "Doublon volontaire du banc — ne doit pas être créé" } },
        );
        const duplicateCreated = (again.body.data as { issueCreate?: { success?: boolean } } | null | undefined)?.issueCreate?.success === true;
        record(
          "Linear REFUSE un second issueCreate au même identifiant (garantie d'idempotence)",
          !duplicateCreated && Array.isArray(again.body.errors),
          duplicateCreated ? "DOUBLON CRÉÉ — la création Linear n'est pas idempotente" : String((again.body.errors as { message?: string }[] | undefined)?.[0]?.message ?? ""),
        );
      }
    }
    const replay = await api(`/api/approvals/${step.approvalId}/approve`, { token: admin, json: {} });
    record("… une seconde approbation ne relâche rien", replay.body.attempted !== true, String(replay.status));
  }

  if (connected.github) {
    /*
     * LE REFUS RÉEL DU FOURNISSEUR. Un commentaire sur une issue qui n'existe pas dans le
     * dépôt de test : GitHub répond 404, rien n'est créé chez lui. Oathrion doit le DIRE —
     * tentative faite, échec, pas d'« effet inconnu », pas de « réussi » — et le reçu doit
     * porter cet échec. Rien à nettoyer : rien n'a été écrit.
     */
    const asked = await api("/api/execute", {
      token: admin,
      json: {
        agentId,
        action: "github.issue.comment",
        target: `github.com/${GH_REPO}`,
        metadata: { issue: 999_999_999, body: "Ce commentaire vise une issue inexistante : GitHub doit le refuser." },
      },
    });
    let outcome = asked.body as { decision?: string; approvalId?: string | null; attempted?: boolean; succeeded?: boolean; executionId?: string; dispatched?: unknown };
    if (outcome.decision === "APPROVAL_REQUIRED" && outcome.approvalId) {
      const approved = await api(`/api/approvals/${outcome.approvalId}/approve`, { token: admin, json: {} });
      outcome = { ...outcome, ...(approved.body as typeof outcome) };
    }
    record(
      "REFUS RÉEL de GitHub (issue inexistante) : tentative faite, échec dit tel quel, aucun « réussi »",
      outcome.attempted === true && outcome.succeeded === false,
      `${String(outcome.decision)} · attempted=${String(outcome.attempted)} · succeeded=${String(outcome.succeeded)}`,
    );
    if (outcome.executionId) {
      const detail = await api(`/api/executions/${outcome.executionId}`, { token: admin });
      const text = JSON.stringify(detail.body);
      record("… l'exécution enregistrée porte l'échec, pas un succès ni un effet inconnu",
        detail.status === 200 && !/"runState":"succeeded"/.test(text) && !/"dispatched":"unknown"/.test(text),
        String(detail.status));
    }
  }

  if (connected.stripe) await stripeRefund(admin, agentId, connected.stripe);

  if (connected.slack) {
    const executionIds = steps.map((s) => s.executionId).filter((x): x is string => !!x);
    const notified = await api("/api/scenario/notify", { token: admin, json: { agentId, executionIds } });
    const step = notified.body.step as Step | undefined;
    record("résumé Slack : RETENU avant approbation", step?.decision === "APPROVAL_REQUIRED", String(step?.decision));
    if (step?.approvalId) {
      const approved = await api(`/api/approvals/${step.approvalId}/approve`, { token: admin, json: {} });
      const result = approved.body.toolResult as { ts?: unknown } | null;
      const ts = typeof result?.ts === "string" ? result.ts : "";
      if (ts) created.slackTs.push(ts);
      record("… approuvé : Slack l'a publié", approved.body.succeeded === true && ts !== "", ts);
      const history = await slack("conversations.history", { channel: SLACK_CHANNEL, latest: ts, inclusive: true, limit: 1 });
      const text = String(((history.body.messages ?? []) as { text?: string }[])[0]?.text ?? "");
      record("RELU directement chez Slack : le message est là, avec les liens réellement créés", text.includes("Oathrion · résumé"), text.slice(0, 60));
    }
  }

  const executions = await api("/api/executions", { token: admin });
  const rows = ((executions.body.items ?? []) as { actor?: string; audit?: unknown }[]);
  record("l'audit nomme le scénario guidé comme acteur", JSON.stringify(rows).includes("scénario guidé"));
}

/**
 * LE REMBOURSEMENT, CONTRE LE VRAI STRIPE (mode test). Le seul verbe qui déplace de
 * l'argent : il doit être bloqué hors périmètre sans appel, retenu avant approbation,
 * exécuté UNE fois après, relu chez Stripe — et sa clé d'idempotence doit rendre le même
 * remboursement quand on la rejoue.
 */
async function stripeRefund(admin: string, agentId: string, account: string): Promise<void> {
  const listed = await stripeApi("/v1/payment_intents?limit=20");
  const payment = ((listed.body.data ?? []) as { id?: string; status?: string; currency?: string; amount_received?: number }[]).find(
    (p) => p.status === "succeeded" && ["eur", "usd"].includes(String(p.currency)) && (p.amount_received ?? 0) >= 100,
  );
  if (!payment?.id) {
    record("Stripe : un paiement de TEST réussi (EUR ou USD) existe pour rembourser 1 unité", false, "aucun — créez un paiement de test dans le tableau de bord");
    return;
  }
  const currency = String(payment.currency).toUpperCase();
  const target = `${account}/${payment.id}`;
  const refundsOf = async () => {
    const reply = await stripeApi(`/v1/refunds?payment_intent=${encodeURIComponent(payment.id!)}&limit=100`);
    return ((reply.body.data ?? []) as { id: string }[]).map((r) => r.id);
  };

  const outside = await api("/api/execute", {
    token: admin,
    json: { agentId, action: "stripe.refund.create", target: `stripe.com/acct_OutOfScope0/${payment.id}`, metadata: { amount: 1, currency } },
  });
  record("Stripe : remboursement sur un compte NON choisi — BLOQUÉ, jamais tenté", outside.body.decision === "BLOCK" && outside.body.attempted === false, String(outside.body.decision));

  const before = await refundsOf();
  const held = await api("/api/execute", {
    token: admin,
    json: {
      agentId,
      action: "stripe.refund.create",
      target,
      metadata: { amount: 1, currency, refund_reason: "requested_by_customer", reason: `Banc de lancement ${RUN}` },
    },
  });
  const approvalId = typeof held.body.approvalId === "string" ? held.body.approvalId : "";
  const executionId = typeof held.body.executionId === "string" ? held.body.executionId : "";
  record("Stripe : remboursement RETENU avant approbation", held.body.decision === "APPROVAL_REQUIRED" && held.body.attempted === false, String(held.body.decision));
  record("… et RELU chez Stripe : aucun remboursement n'est parti", (await refundsOf()).length === before.length, `${String(before.length)} avant`);
  if (!approvalId || !executionId) return;

  const approved = await api(`/api/approvals/${approvalId}/approve`, { token: admin, json: {} });
  const result = (approved.body.toolResult ?? {}) as { refund?: unknown; amount?: unknown; currency?: unknown };
  const refundId = typeof result.refund === "string" ? result.refund : "";
  record("… approuvé : Stripe a remboursé 1 unité", approved.body.succeeded === true && refundId.startsWith("re_") && result.amount === 1, `${refundId} · ${String(result.amount)} ${String(result.currency)}`);
  if (!refundId) return;

  const read = await stripeApi(`/v1/refunds/${refundId}`);
  record(
    "RELU directement chez Stripe : le remboursement existe, au montant décidé, marqué de l'exécution",
    read.status === 200 && read.body.amount === 100 && read.body.payment_intent === payment.id &&
      (read.body.metadata as { placet_execution?: unknown } | undefined)?.placet_execution === executionId,
    `${String(read.body.status)} · ${String(read.body.amount)} ${String(read.body.currency)}`,
  );

  const replay = await api(`/api/approvals/${approvalId}/approve`, { token: admin, json: {} });
  record("… une seconde approbation ne relâche rien", replay.body.attempted !== true && (await refundsOf()).length === before.length + 1, String(replay.status));

  /*
   * LA GARANTIE D'IDEMPOTENCE, ÉPROUVÉE CONTRE STRIPE. La même requête, avec la clé
   * `placet-<exécution>` qu'Oathrion a envoyée : Stripe doit rendre le MÊME remboursement,
   * pas en créer un second.
   */
  const again = await stripeApi(
    "/v1/refunds",
    "POST",
    { payment_intent: payment.id, amount: "100", reason: "requested_by_customer", "metadata[placet_execution]": executionId },
    `placet-${executionId}`,
  );
  const after = await refundsOf();
  record(
    "Stripe rend le MÊME remboursement à la même clé d'idempotence (aucun doublon)",
    again.body.id === refundId && after.length === before.length + 1,
    again.body.id === refundId ? `${refundId} · ${String(after.length - before.length)} créé` : `DOUBLON ou refus : ${JSON.stringify(again.body).slice(0, 120)}`,
  );
}

async function cleanup(created: Created): Promise<void> {
  section("4. NETTOYAGE — ce que le banc a créé chez les services");
  if (created.githubIssue) {
    const closed = await github(`/repos/${GH_REPO}/issues/${String(created.githubIssue)}`, "PATCH", { state: "closed", state_reason: "not_planned" });
    record(`issue GitHub #${String(created.githubIssue)} fermée`, closed.status === 200, String(closed.status));
  }
  if (created.linearIssue) {
    const archived = await linear("mutation($id: String!) { issueArchive(id: $id) { success } }", { id: created.linearIssue });
    const ok = (archived.body.data as { issueArchive?: { success?: boolean } } | undefined)?.issueArchive?.success === true;
    record("issue Linear archivée", ok, ok ? "" : JSON.stringify(archived.body).slice(0, 120));
  }
  for (const ts of created.slackTs) {
    const deleted = await slack("chat.delete", { channel: SLACK_CHANNEL, ts });
    record("message Slack supprimé", deleted.body.ok === true, String(deleted.body.error ?? ""));
  }
  say("  · le jeton Slack n'est PAS révoqué : « Déconnecter » appellerait auth.revoke sur VOTRE jeton.");
  if (have.stripe) say("  · un remboursement Stripe ne s'annule pas : il reste dans le compte de TEST (aucun argent réel).");
}

async function main(): Promise<number> {
  say("\n" + "=".repeat(78));
  say("Oathrion — PREUVE DU PARCOURS DE LANCEMENT (appels réels à GitHub, Slack, Linear, Stripe)");
  say("=".repeat(78));
  say(`  services fournis : GitHub ${have.github ? "oui" : "non"} · Slack ${have.slack ? "oui" : "non"} · Linear ${have.linear ? "oui" : "non"} · Stripe ${have.stripe ? "oui (test)" : STRIPE_LIVE ? "REFUSÉ (clé réelle)" : "non"}`);

  await phaseZero();

  if (!existsSync(BUNDLE)) {
    say("\nBundle absent : lancez `npm run build` d'abord.");
    return finish(1);
  }
  if (!process.env.DATABASE_URL) {
    say("\nDATABASE_URL manquante : le bundle de production ne tourne que sur PostgreSQL.");
    return finish(2);
  }

  const db = await createThrowawayDatabase("launch");
  let placet: Oathrion | null = null;
  const created: Created = { githubIssue: null, linearIssue: null, slackTs: [] };
  try {
    placet = await boot(db.url);
    record("le bundle livré démarre SANS aucun compte dans l'environnement (OATHRION_ACCOUNTS=database)", placet !== null);
    if (!placet) return finish(1);
    record("… et dit à l'exploitant comment créer un espace", placet.log().includes("workspace:create"));

    const admin = await phaseOne(db.url);
    if (!admin) return finish(1);

    const connected = await phaseTwo(admin);
    if (connected.github || connected.slack || connected.linear || connected.stripe) {
      await phaseThree(admin, connected, created);
    } else {
      section("3. LE SCÉNARIO GUIDÉ");
      say("  · aucun service connecté : le scénario contre les vrais services n'a PAS été joué.");
    }
  } finally {
    await cleanup(created).catch((e: unknown) => say(`  ✗ nettoyage interrompu : ${String(e)}`));
    await stop(placet);
    await db.dispose();
  }

  const missing = (Object.keys(have) as (keyof typeof have)[]).filter((k) => !have[k]);
  return finish(missing.length > 0 ? 2 : 0, missing);
}

function finish(code: number, missing: string[] = []): number {
  record("aucun secret n'apparaît dans les lignes affichées", !SECRETS.some((s) => printed.join("\n").includes(s)));
  const failed = checks.filter((c) => !c.ok).length;
  say("\n" + "=".repeat(78));
  say(`${String(checks.length - failed)}/${String(checks.length)} contrôles passés`);
  if (failed === 0 && missing.length > 0) {
    say(`Sortie 2 : NON ÉPROUVÉ contre le service réel — ${missing.join(", ")} (credential de test absent).`);
  }
  say("=".repeat(78) + "\n");
  return failed > 0 ? 1 : code;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(mask(String(error instanceof Error ? error.stack : error)));
    process.exit(1);
  });
