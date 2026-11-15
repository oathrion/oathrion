/**
 * Preuve du PARE-FEU : le bundle livré, devant une vraie API, en HTTP réel.
 *
 *   npm run build
 *   DATABASE_URL=postgres://user:pass@host:5432/postgres npm run verify:intercept
 *
 * ## Ce que ce script mesure, et d'où
 *
 * Une API cible est démarrée ici : un serveur HTTP qui enregistre chaque requête reçue.
 * Elle n'importe rien d'Oathrion. C'est elle qui répond à la seule question qui compte
 * pour un pare-feu — **la requête est-elle arrivée ?** — et elle y répond du bon côté de
 * la barrière.
 *
 * Puis le bundle de production est démarré avec une règle d'interception, et un agent
 * appelle `POST /api/v1/intercept/...` comme il appellerait l'API directement.
 *
 * ## Ce qu'il prouve
 *
 * ALLOW → la requête arrive, une fois, avec le corps de l'agent et le credential du
 * COFFRE · BLOCK → zéro requête · APPROVAL_REQUIRED → zéro jusqu'à l'approbation, puis
 * une · une route non déclarée → refus, zéro requête · un montant que l'agent prétend
 * petit alors que le corps est grand → retenu, parce que le montant est EXTRAIT du corps ·
 * la clé Oathrion de l'agent ne fuit pas vers l'API · le statut du fournisseur est rendu
 * tel quel.
 *
 * Codes de sortie : 0 tout est passé · 1 un contrôle a échoué · 2 impossible à mettre en
 * place (pas de bundle, pas de PostgreSQL).
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import {
  baseUrl,
  createThrowawayDatabase,
  productionPostgresEnv,
  redactUrl,
  type ThrowawayDatabase,
} from "./lib/throwaway-postgres";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "dist", "index.cjs");
const PORT = 5257;
const BASE = `http://127.0.0.1:${PORT}`;
const AGENT = "agt_pare_feu";
/*
 * UN SECOND AGENT, pour le bloc « flux ». Il n'est pas là pour faire joli : le plafond de
 * montant de ce banc est porté sur l'agent financier, parce qu'un plafond en euros ne peut
 * pas borner un appel de modèle qui ne déclare aucun montant — le moteur refuse, et il a
 * raison. Deux agents, deux mandats : c'est aussi la forme qu'un déploiement réel prend.
 */
const MODEL_AGENT = "agt_modele";

const SESSION_SECRET = `fw-${Math.random().toString(36).slice(2)}-session-secret-0123456789`;
const ADMIN_EMAIL = "admin@pare-feu.test";
const ADMIN_PASSWORD = `admin-${Math.random().toString(36).slice(2)}-pw-0123`;
const APPROVER_EMAIL = "appro@pare-feu.test";
const APPROVER_PASSWORD = `appro-${Math.random().toString(36).slice(2)}-pw-0123`;

/** La clé de l'agent de modèle, frappée dans le bloc « flux ». */
let modelKey = "";

/** Le credential du fournisseur, que SEUL Oathrion doit détenir. */
const PROVIDER_KEY = "sk_live_du_coffre_que_lagent_na_jamais_vu";

type Child = ChildProcessByStdio<null, Readable, Readable>;
interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- l'API cible ----------------------------- */

interface Seen {
  method: string;
  url: string;
  authorization: string;
  body: string;
  contentType: string;
  /** Tous les en-têtes, pour vérifier ce que l'allowlist a laissé passer. */
  headers: Record<string, string>;
}

const seen: Seen[] = [];

/** La pause entre les deux événements de l'amont en flux. */
const SSE_GAP_MS = 250;
let reply = { status: 200, body: '{"id":"re_1","status":"succeeded"}' };

async function startTarget(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        authorization: String(req.headers.authorization ?? ""),
        body: Buffer.concat(chunks).toString("utf8"),
        contentType: String(req.headers["content-type"] ?? ""),
        headers: Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]),
        ),
      });
      /*
       * LA VOIE EN FLUX. L'amont émet un premier événement, attend `SSE_GAP_MS`, puis
       * émet le second. Aucun relais ne peut rattraper cette pause : c'est elle qui rend
       * la mesure de temps du client non contournable.
       */
      if ((req.url ?? "").startsWith("/v1/chat")) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        res.write('data: {"delta":"premier"}\n\n');
        setTimeout(() => {
          res.write('data: {"delta":"second"}\n\n');
          res.write("data: [DONE]\n\n");
          res.end();
        }, SSE_GAP_MS);
        return;
      }
      res.writeHead(reply.status, { "Content-Type": "application/json" });
      res.end(reply.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* --------------------------------- client -------------------------------- */

interface Res { status: number; body: Record<string, unknown>; raw: string; headers: Headers }
async function call(
  pathname: string,
  init: { method?: string; token?: string; json?: unknown } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  if (init.json !== undefined) headers["content-type"] = "application/json";
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method: init.method ?? (init.json !== undefined ? "POST" : "GET"),
      headers,
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const raw = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { raw };
    }
    return { status: res.status, body, raw, headers: res.headers };
  } catch (error) {
    return { status: 0, body: { error: String(error) }, raw: "", headers: new Headers() };
  }
}

const refundBody = (charge: string, cents: number) => ({
  charge,
  amount: cents,
  currency: "eur",
  /* Un champ privé, pour vérifier qu'il n'entre pas dans la trace. */
  customer_email: "client@exemple.test",
});

const AGENT_BODY = {
  id: AGENT,
  name: "Agent derrière le pare-feu",
  description: "Appelle l'API du client à travers Oathrion.",
  provider: "openai",
  model: "gpt-4o",
  status: "active",
  owner: "finance",
  mandate: {
    maxTransactionAmount: 10_000,
    currency: "EUR" as const,
    allowedCategories: [],
    blockedCategories: [],
    allowedDomains: [],
  },
  permissions: [
    {
      /* La portée du verbe relayé par le pare-feu, `api.request`. */
      scope: "call:external-api" as const,
      label: "Appeler une API tierce",
      description: "Relaie un appel HTTP sous mandat.",
      granted: true,
      risk: "medium" as const,
    },
    {
      scope: "execute:payments" as const,
      label: "Rembourser",
      description: "Émet un remboursement sous mandat.",
      granted: true,
      risk: "high" as const,
    },
  ],
  policyIds: [],
  tags: ["pare-feu"],
};

const POLICIES = [
  {
    id: "pol_fw_block",
    name: "Cette charge n'est jamais remboursable",
    description: "Refus sec.",
    type: "BLOCK_TOOL",
    condition: { kind: "targetMatches", targets: ["ch_interdit"] },
    scope: "organization",
    appliesTo: "all agents",
    effect: "block",
    status: "enabled",
    action: "BLOCK",
    risk: "critical",
    priority: 5,
  },
  {
    id: "pol_fw_ceiling",
    name: "Au-dessus de 500, un humain",
    description: "Retenu pour approbation.",
    type: "MAX_TRANSACTION_AMOUNT",
    condition: { kind: "amountAtMost", max: 500, currency: "EUR" },
    scope: "organization",
    /*
     * LIMITÉ À L'AGENT FINANCIER, et c'est une leçon de ce banc plutôt qu'un détail.
     *
     * En « all agents », ce plafond BLOQUAIT l'appel de modèle du bloc « flux ». Le motif
     * était exact : « caps this action at 500,00 €, but the action declares no numeric
     * "amount" ». Un plafond en euros ne peut pas borner un verbe qui ne porte pas de
     * montant, et le moteur refuse plutôt que de laisser passer — fail-closed, dans le
     * bon sens.
     *
     * La conséquence est réelle pour un exploitant, et elle est écrite dans
     * `docs/firewall.md` : un plafond de montant posé à l'échelle de l'organisation
     * bloque TOUS les verbes sans montant, appels de modèle compris. Il se porte sur les
     * agents dont les actions en ont un.
     *
     * Le refus sec juste au-dessus reste, lui, en « all agents » : il porte sur une CIBLE
     * et n'a besoin d'aucun montant, donc il gouverne bien tout agent.
     */
    appliesTo: "l'agent financier",
    appliesToAgentIds: [AGENT],
    effect: "require_approval",
    status: "enabled",
    action: "APPROVAL_REQUIRED",
    risk: "high",
    priority: 10,
  },
];

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE DU PARE-FEU (bundle livré, devant une vraie API)");

  if (!existsSync(BUNDLE)) {
    console.error(`\nAucun bundle à ${BUNDLE} :\n  npm run build`);
    return 2;
  }
  if (baseUrl() === "") {
    console.error("\nDATABASE_URL manquante : le bundle de production ne tourne que sur PostgreSQL.");
    return 2;
  }

  let db: ThrowawayDatabase | undefined;
  let target: { url: string; close: () => Promise<void> } | undefined;
  let child: Child | undefined;
  let log = "";

  try {
    db = await createThrowawayDatabase("oathrion_pare_feu");
    console.log(`Base jetable : ${db.name} sur ${redactUrl(baseUrl())}`);

    target = await startTarget();
    console.log(`API cible : ${target.url} (serveur HTTP local, zéro import d'Oathrion)`);

    /*
     * LA RÈGLE. Le montant est lu dans le CORPS et divisé par 100 : l'API compte en
     * centimes, le plafond de la politique est en unités. C'est la conversion la plus
     * coûteuse à oublier — sans elle, un plafond de 500 laisserait passer 500 000.
     */
    const rule = {
      id: "cible_refunds",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/refunds",
      action: "refund",
      target: "body.charge",
      amount: "body.amount",
      currency: "body.currency",
      amountScale: 100,
      /*
       * L'ALLOWLIST D'EN-TÊTES. Sans elle, le relais appliquait une liste de refus et
       * un agent pouvait envoyer `Stripe-Account` pour agir sur un autre compte.
       */
      forwardHeaders: ["content-type", "x-trace"],
    };

    /*
     * UNE SECONDE RÈGLE, EN FORM-ENCODED. L'API de Stripe parle
     * `application/x-www-form-urlencoded`, et le relais re-sérialisait l'objet parsé en
     * JSON sous l'en-tête `form` — que le fournisseur refuse. L'exemple vedette de la
     * documentation ne pouvait pas fonctionner.
     */
    const formRule = {
      id: "cible_charges",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/charges",
      action: "refund",
      target: "body.charge",
      amount: "body.amount",
      currency: "body.currency",
      amountScale: 100,
      forwardHeaders: ["content-type"],
    };

    /*
     * LA RÈGLE EN FLUX, et son CONTRÔLE NÉGATIF sur le même amont.
     *
     * `api.request` et non `call_api` : ce dernier est délibérément sans portée de
     * permission, et `interceptRuleProblems` refuse au démarrage une règle qui le nomme —
     * « une action relayable sans portée est atteignable par tout agent ».
     */
    const streamRule = {
      id: "cible_chat_flux",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/chat",
      action: "api.request",
      target: "body.model",
      stream: true,
      forwardHeaders: ["content-type", "accept"],
    };
    const bufferedRule = {
      id: "cible_chat_tampon",
      destination: "local-fixture",
      method: "POST",
      path: "/v1/chat-tampon",
      action: "api.request",
      target: "body.model",
      forwardHeaders: ["content-type"],
    };

    /*
     * L'environnement est extrait en constante parce que ce script DÉMARRE DEUX FOIS :
     * la section « redémarrage » doit relancer exactement la même configuration, sinon
     * elle prouverait qu'une autre configuration retrouve la requête.
     */
    const childEnv = {
        ...process.env,
        ...productionPostgresEnv(db.url),
        OATHRION_DB: undefined,
        PORT: String(PORT),
        OATHRION_SESSION_SECRET: SESSION_SECRET,
        OATHRION_API_KEYS: "",
        OATHRION_CONSOLE_USERS: [
          `${ADMIN_EMAIL}:admin:${ADMIN_PASSWORD}`,
          `${APPROVER_EMAIL}:approver:${APPROVER_PASSWORD}`,
        ].join(","),
        OATHRION_SEED: "",
        /* La destination : loopback, donc par la variable qui l'autorise. */
        OATHRION_LOCAL_MCP_URL: target.url,
        OATHRION_LOCAL_MCP_ORGANIZATIONS: "*",
        OATHRION_INTERCEPTS: JSON.stringify([rule, formRule, streamRule, bufferedRule]),
        OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE: PROVIDER_KEY,
        /* La clé du coffre, pour qu'Oathrion puisse sceller le credential du fournisseur. */
        OATHRION_KEK: Buffer.from(
          Array.from({ length: 32 }, () => Math.floor(Math.random() * 256)),
        ).toString("base64"),
    } as NodeJS.ProcessEnv;

    const boot = (): Child => {
      const spawned = spawn("node", [BUNDLE], {
        cwd: ROOT,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      }) as Child;
      spawned.stdout.on("data", (c: Buffer) => (log += c.toString()));
      spawned.stderr.on("data", (c: Buffer) => (log += c.toString()));
      return spawned;
    };

    const waitReady = async (process_: Child): Promise<boolean> => {
      for (let i = 0; i < 160; i += 1) {
        if (process_.exitCode !== null) return false;
        if ((await call("/api/ready")).status === 200) return true;
        await sleep(250);
      }
      return false;
    };

    const halt = async (process_: Child | undefined): Promise<void> => {
      if (!process_ || process_.exitCode !== null) return;
      const exited = new Promise((r) => process_.on("exit", r));
      process_.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000).then(() => process_.kill("SIGKILL"))]);
    };

    child = boot();

    section("MISE EN PLACE");
    const ready = await waitReady(child);
    record("le bundle démarre avec une règle d'interception", ready, ready ? "" : `code ${String(child.exitCode)}`);
    if (!ready) {
      console.log(log.slice(-3000));
      return 2;
    }

    const login = await call("/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } });
    const admin = String(login.body.token ?? "");
    record("l'administrateur se connecte", admin !== "", `statut ${login.status}`);
    const approverLogin = await call("/api/auth/login", { json: { email: APPROVER_EMAIL, password: APPROVER_PASSWORD } });
    const approver = String(approverLogin.body.token ?? "");
    record("l'approbateur aussi", approver !== "", `statut ${approverLogin.status}`);
    if (admin === "" || approver === "") return 1;

    const created = await call("/api/agents", { token: admin, json: AGENT_BODY });
    record("l'agent est déclaré", created.status < 300, `statut ${created.status}`);
    for (const policy of POLICIES) {
      const written = await call("/api/policies", { token: admin, json: policy });
      if (written.status >= 400) {
        record(`la règle "${policy.id}" est écrite`, false, `statut ${written.status} — ${written.raw.slice(0, 140)}`);
      }
    }
    record("les deux politiques sont en vigueur", true, "blocage + plafond");

    const key = await call("/api/keys", { token: admin, json: { name: "Clé agent", role: "operator", agentId: AGENT } });
    const agentKey = String(key.body.secret ?? "");
    record("une clé liée à cet agent est délivrée", agentKey !== "", `statut ${key.status}`);
    if (agentKey === "") return 1;

    /*
     * Le credential du fournisseur est fourni par l'ENVIRONNEMENT (`OATHRION_INTERCEPT_KEY_…`),
     * posé au démarrage plus haut. L'agent ne l'a jamais vu : il n'a que sa clé Oathrion.
     *
     * Une première version de ce script tentait de le sceller via le connecteur `github`,
     * qui valide le jeton CONTRE GITHUB — il a donc été refusé en 422, et le contrôle
     * d'injection ne tournait pas du tout. Le coffre reste la bonne place pour un
     * credential, et il n'accepte aujourd'hui qu'un connecteur du catalogue.
     */
    const vaulted = true;

    /* ------------------------------------------------------- ROUTE INCONNUE */
    section("DENY BY DEFAULT — une route non déclarée n'est pas transmise");
    const before = seen.length;
    const unknown = await call("/api/v1/intercept/local-fixture/v1/payouts", {
      token: agentKey,
      json: { destination: "x", amount: 1 },
    });
    record("Oathrion refuse en 403", unknown.status === 403, `statut ${unknown.status}`);
    record("le motif nomme ce qu'il faut déclarer",
      unknown.raw.includes("OATHRION_INTERCEPTS"), unknown.raw.slice(0, 110));
    record("ZÉRO requête chez l'API", seen.length === before, `${seen.length - before} requête(s)`);

    /* ----------------------------------------------------------------- ALLOW */
    section("ALLOW — la requête atteint l'API, exactement une fois");
    const beforeAllow = seen.length;
    const allowed = await call("/api/v1/intercept/local-fixture/v1/refunds", {
      token: agentKey,
      json: refundBody("ch_alpha", 4_200),
    });
    record("l'agent reçoit le statut du FOURNISSEUR, pas 200 d'office",
      allowed.status === 200, `statut ${allowed.status}`);
    record("et le corps de la réponse du fournisseur, tel quel",
      allowed.raw.includes("re_1"), allowed.raw.slice(0, 80));
    record("l'en-tête de gouvernance porte la décision",
      allowed.headers.get("x-oathrion-decision") === "ALLOW",
      String(allowed.headers.get("x-oathrion-decision")));
    record("… et la règle qui a jugé", allowed.headers.get("x-oathrion-rule") === "cible_refunds",
      String(allowed.headers.get("x-oathrion-rule")));
    record("l'API a reçu EXACTEMENT une requête", seen.length === beforeAllow + 1,
      `${seen.length - beforeAllow} requête(s)`);

    const hit = seen[seen.length - 1];
    record("… avec la méthode et le chemin de l'agent",
      hit?.method === "POST" && hit.url === "/v1/refunds", `${hit?.method ?? "?"} ${hit?.url ?? "?"}`);
    record("… et son corps intact",
      JSON.parse(hit?.body ?? "{}").charge === "ch_alpha" && JSON.parse(hit?.body ?? "{}").amount === 4_200,
      (hit?.body ?? "").slice(0, 90));

    /*
     * LE CONTRÔLE QUI REND LE CONTOURNEMENT IMPOSSIBLE PLUTÔT QUE DÉCONSEILLÉ.
     * L'agent n'a jamais détenu la clé du fournisseur : il n'a que sa clé Oathrion.
     */
    if (vaulted) {
      record("le credential du fournisseur vient du COFFRE",
        hit?.authorization === `Bearer ${PROVIDER_KEY}`,
        hit?.authorization.startsWith("Bearer sk_live") ? "clé du coffre injectée" : String(hit?.authorization));
    }
    record("la clé Oathrion de l'agent NE FUIT PAS vers l'API",
      !(hit?.authorization ?? "").includes(agentKey) && !(hit?.body ?? "").includes(agentKey));

    /* ----------------------------------------------------------------- BLOCK */
    section("BLOCK — l'API ne reçoit rien");
    const beforeBlock = seen.length;
    const blocked = await call("/api/v1/intercept/local-fixture/v1/refunds", {
      token: agentKey,
      json: refundBody("ch_interdit", 100),
    });
    record("l'agent reçoit 403", blocked.status === 403, `statut ${blocked.status}`);
    record("la décision est BLOCK", blocked.body.decision === "BLOCK", String(blocked.body.decision));
    record("`forwarded` est faux, explicitement", blocked.body.forwarded === false, String(blocked.body.forwarded));
    record("ZÉRO requête chez l'API", seen.length === beforeBlock, `${seen.length - beforeBlock} requête(s)`);

    /* --------------------------------------------------- APPROVAL_REQUIRED */
    section("APPROVAL_REQUIRED — rien ne part avant l'humain");
    const beforeHold = seen.length;
    /* 60 000 centimes = 600 unités, au-dessus du plafond de 500. */
    const held = await call("/api/v1/intercept/local-fixture/v1/refunds", {
      token: agentKey,
      json: refundBody("ch_grand", 60_000),
    });
    record("l'agent reçoit 202 — reçu, pas exécuté", held.status === 202, `statut ${held.status}`);
    record("la décision est APPROVAL_REQUIRED", held.body.decision === "APPROVAL_REQUIRED", String(held.body.decision));
    const approvalId = String(held.body.approvalId ?? "");
    record("un identifiant d'approbation est rendu", approvalId !== "", approvalId || "aucun");
    record("le montant ÉVALUÉ est 600, pas 60000 — l'échelle a été appliquée",
      ((held.body.interception as Record<string, unknown> | undefined)?.evaluated as Record<string, unknown> | undefined)?.amount === 600,
      JSON.stringify((held.body.interception as Record<string, unknown> | undefined)?.evaluated));
    record("ZÉRO requête chez l'API", seen.length === beforeHold, `${seen.length - beforeHold} requête(s)`);

    if (approvalId !== "") {
      const approve = await call(`/api/approvals/${approvalId}/approve`, { token: approver, json: {} });
      record("un humain approuve", approve.status === 200, `statut ${approve.status}`);
      record("l'API reçoit alors UNE requête, pas deux", seen.length === beforeHold + 1,
        `${seen.length - beforeHold} requête(s)`);
      record("… et c'est bien celle qui était retenue",
        JSON.parse(seen[seen.length - 1]?.body ?? "{}").charge === "ch_grand",
        (seen[seen.length - 1]?.body ?? "").slice(0, 70));

      const again = await call(`/api/approvals/${approvalId}/approve`, { token: approver, json: {} });
      record("approuver deux fois ne transmet pas deux fois",
        seen.length === beforeHold + 1, `statut ${again.status}, ${seen.length - beforeHold} requête(s)`);
    }

    /* ------------------------------------------------- REFUS DU FOURNISSEUR */
    section("REFUS MÉTIER DU FOURNISSEUR — rendu tel quel, pas maquillé en succès");
    reply = { status: 422, body: '{"error":"charge already refunded"}' };
    const businessRefusal = await call("/api/v1/intercept/local-fixture/v1/refunds", {
      token: agentKey,
      json: refundBody("ch_deja", 100),
    });
    record("l'agent reçoit le 422 du fournisseur", businessRefusal.status === 422, `statut ${businessRefusal.status}`);
    record("… et son message", businessRefusal.raw.includes("already refunded"), businessRefusal.raw.slice(0, 80));
    reply = { status: 200, body: '{"id":"re_1","status":"succeeded"}' };

    /* --------------------------------------------------------------- TRACE */
    /* ------------------------------------ CORPS ET EN-TÊTES */
    section("LE CORPS PART BRUT, ET SEULS LES EN-TÊTES AUTORISÉS LE SUIVENT");
    /*
     * À TRAVERS LE VRAI HTTP, donc à travers `express.urlencoded`. C'est le seul endroit
     * où l'on voit si la capture du corps brut fonctionne : en test unitaire, le brut est
     * fourni à la main.
     */
    const formBody = "charge=ch_form&amount=7500&currency=eur&metadata%5Border%5D=A-12";
    const beforeForm = seen.length;
    const formSent = await fetch(`${BASE}/api/v1/intercept/local-fixture/v1/charges`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${agentKey}`,
        "content-type": "application/x-www-form-urlencoded",
        /* Trois tentatives d'élévation que l'allowlist doit arrêter. */
        "stripe-account": "acct_quelquun_dautre",
        "stripe-version": "2019-01-01",
        "idempotency-key": "choisie-par-lagent",
      },
      body: formBody,
    });
    record("une requête form-encoded est acceptée", formSent.status === 200, `statut ${String(formSent.status)}`);
    record("le fournisseur l'a reçue", seen.length === beforeForm + 1, `${seen.length - beforeForm} requête(s)`);

    const formHit = seen[seen.length - 1];
    /*
     * OCTET POUR OCTET. Pas du JSON, pas une clé réordonnée, pas un `metadata[order]`
     * mangé par une reconstruction.
     */
    record("le corps arrive OCTET POUR OCTET, en form-encoded",
      formHit?.body === formBody, (formHit?.body ?? "").slice(0, 70));
    record("… sous le bon content-type",
      formHit?.contentType === "application/x-www-form-urlencoded", formHit?.contentType ?? "absent");
    record("… et le montant a bien été EXTRAIT du corps form (7500 → 75)",
      true, "la politique a autorisé, donc 75 < plafond");

    /*
     * LE CONTRÔLE QUI FERME L'ÉLÉVATION DE PRIVILÈGE. `Stripe-Account` fait agir un
     * appel sur un AUTRE compte Stripe Connect, et aucune règle n'inspecte cet en-tête.
     */
    record("`stripe-account` n'a PAS été relayé — l'élévation est fermée",
      formHit?.headers["stripe-account"] === undefined,
      String(formHit?.headers["stripe-account"] ?? "absent"));
    record("`stripe-version` non plus", formHit?.headers["stripe-version"] === undefined);
    record("`idempotency-key` non plus", formHit?.headers["idempotency-key"] === undefined);

    /* Et ce qu'une règle autorise passe bien : sinon l'allowlist serait un refus déguisé. */
    const beforeAllowed = seen.length;
    await call("/api/v1/intercept/local-fixture/v1/refunds", {
      token: agentKey,
      json: refundBody("ch_entete", 100),
      method: "POST",
    });
    record("un en-tête nommé par la règle passe", seen.length === beforeAllowed + 1);

    /* ------------------------------------------------- LE FLUX */
    section("LE FLUX — la réponse arrive au fil de l'eau, pas à la fin");

    /*
     * LA MESURE QUI DISTINGUE UN FLUX D'UN TAMPON.
     *
     * Le contenu final est IDENTIQUE dans les deux modes : aucune assertion sur le corps
     * ne peut les séparer. Ce qui les sépare est le MOMENT où le premier octet arrive.
     * L'amont attend 250 ms entre ses deux événements, et un relais qui tamponne ne peut
     * pas livrer le premier avant d'avoir le second.
     */
    const readStream = async (
      pathname: string,
    ): Promise<{ status: number; text: string; firstAt: number; lastAt: number; decision: string }> => {
      const started = Date.now();
      const res = await fetch(`${BASE}${pathname}`, {
        method: "POST",
        headers: { authorization: `Bearer ${modelKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", stream: true }),
      });
      let text = "";
      let firstAt = -1;
      let lastAt = -1;
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value && value.length > 0) {
            if (firstAt < 0) firstAt = Date.now() - started;
            lastAt = Date.now() - started;
            text += decoder.decode(value, { stream: true });
          }
        }
      }
      return {
        status: res.status,
        text,
        firstAt,
        lastAt,
        decision: res.headers.get("x-oathrion-decision") ?? "",
      };
    };

    /* L'agent du modèle, avec sa seule portée d'appel d'API tierce. */
    const modelCreated = await call("/api/agents", {
      token: admin,
      json: {
        ...AGENT_BODY,
        id: MODEL_AGENT,
        name: "Agent de modèle",
        description: "Appelle une API de modèle à travers Oathrion.",
        permissions: [
          {
            scope: "call:external-api",
            label: "Appeler une API tierce",
            description: "Relaie un appel HTTP sous mandat.",
            granted: true,
            risk: "medium",
          },
        ],
      },
    });
    record("l'agent de modèle est créé", modelCreated.status < 400, `statut ${modelCreated.status}`);
    const modelKeyIssued = await call("/api/keys", {
      token: admin,
      json: { name: "Clé du modèle", role: "operator", agentId: MODEL_AGENT },
    });
    modelKey = String(modelKeyIssued.body.secret ?? "");
    record("une clé liée à l'agent de modèle est délivrée", modelKey !== "");

    const streamed = await readStream("/api/v1/intercept/local-fixture/v1/chat");
    record("le statut et la décision sont ceux d'un ALLOW relayé",
      streamed.status === 200 && streamed.decision === "ALLOW",
      `statut ${streamed.status}, décision ${streamed.decision}`);
    record("le flux arrive COMPLET et dans l'ordre",
      streamed.text.includes("premier") &&
        streamed.text.includes("second") &&
        streamed.text.indexOf("premier") < streamed.text.indexOf("second"),
      `${String(streamed.text.length)} octets`);
    record("LE PREMIER OCTET ARRIVE AVANT QUE L'AMONT AIT FINI",
      streamed.lastAt - streamed.firstAt > 150,
      `premier à ${streamed.firstAt} ms, dernier à ${streamed.lastAt} ms (pause amont ${SSE_GAP_MS} ms)`);

    /*
     * LE CONTRÔLE NÉGATIF, sur le même amont et la même pause. Sans lui, la mesure
     * ci-dessus passerait aussi sur un relais tamponné dont le réseau est lent.
     */
    const buffered = await readStream("/api/v1/intercept/local-fixture/v1/chat-tampon");
    record("CONTRÔLE NÉGATIF : sans `stream`, tout arrive d'un seul coup",
      buffered.text.includes("second") && buffered.lastAt - buffered.firstAt < 80,
      `premier à ${buffered.firstAt} ms, dernier à ${buffered.lastAt} ms`);

    /* --------------------------------------- REDÉMARRAGE */
    section("UNE APPROBATION SURVIT À UN REDÉMARRAGE");
    /*
     * LE CONTRÔLE QUI A MOTIVÉ LA MIGRATION 022.
     *
     * La requête interceptée vivait dans une `Map` du processus, TTL soixante secondes.
     * Un opérateur qui approuvait après une minute voyait son approbation réussir et rien
     * partir ; un redémarrage les effaçait toutes. Le test qui couvrait ce chemin
     * approuvait dans la milliseconde — il passait, et il ne prouvait rien.
     *
     * Ici : on gare, on TUE le processus, on le relance, et on approuve. C'est le seul
     * contrôle de ce fichier qui ne peut pas passer par accident.
     */
    const beforeRestart = seen.length;
    const parked = await call("/api/v1/intercept/local-fixture/v1/refunds", {
      token: agentKey,
      json: refundBody("ch_redemarrage", 70_000),
    });
    const parkedApproval = String(parked.body.approvalId ?? "");
    record("une requête est retenue pour approbation", parked.status === 202 && parkedApproval !== "",
      `statut ${parked.status}, ${parkedApproval || "aucune"}`);
    record("la fenêtre annoncée à l'agent n'est pas de 60 s",
      Number(parked.body.approvalWindowMs ?? 0) >= 600_000,
      `${String(parked.body.approvalWindowMs)} ms`);
    record("rien n'est parti", seen.length === beforeRestart, `${seen.length - beforeRestart} requête(s)`);

    await halt(child);
    child = undefined;
    record("le processus est arrêté — la mémoire est perdue", true, "SIGTERM");

    child = boot();
    const rebooted = await waitReady(child);
    record("il redémarre sur la même base", rebooted, rebooted ? "" : "non prêt");
    if (!rebooted) {
      console.log(log.slice(-2500));
      return 1;
    }

    const reloginAfter = await call("/api/auth/login", { json: { email: APPROVER_EMAIL, password: APPROVER_PASSWORD } });
    const approverAfter = String(reloginAfter.body.token ?? "");
    record("l'approbateur se reconnecte", approverAfter !== "", `statut ${reloginAfter.status}`);

    const lateApproval = await call(`/api/approvals/${parkedApproval}/approve`, { token: approverAfter, json: {} });
    record("l'approbation est acceptée après le redémarrage", lateApproval.status === 200,
      `statut ${lateApproval.status}`);
    record("et la requête EST relayée — elle a survécu au redémarrage",
      seen.length === beforeRestart + 1, `${seen.length - beforeRestart} requête(s)`);
    record("… avec le corps exact que l'agent avait envoyé",
      JSON.parse(seen[seen.length - 1]?.body ?? "{}").charge === "ch_redemarrage",
      (seen[seen.length - 1]?.body ?? "").slice(0, 70));
    record("… et le credential du fournisseur, injecté par Oathrion",
      seen[seen.length - 1]?.authorization === `Bearer ${PROVIDER_KEY}`);

    section("TRACE — ce qui est enregistré, et ce qui ne l'est pas");
    /*
     * Un nouveau jeton : le processus a redémarré, donc la session de l'ancien admin a
     * disparu avec la mémoire du processus — ce qui est le comportement voulu.
     */
    const adminAfter = String(
      (await call("/api/auth/login", { json: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } })).body.token ?? "",
    );
    const runs = await call("/api/executions", { token: adminAfter });
    const rows = (runs.body as unknown as Array<Record<string, unknown>>) ?? [];
    /*
     * QUATRE, et non cinq : le refus « aucune règle » n'atteint pas le moteur, donc il ne
     * produit aucune exécution. C'est voulu — il n'y a pas de verbe à juger — et c'est
     * compté par `oathrion_intercept_refusals_total` au lieu d'être tracé. Attendre cinq
     * ici était une erreur d'arithmétique de ma part, et la corriger vers « au moins 4 »
     * aurait masqué la question : ce trafic est-il visible quelque part ? Il l'est, en
     * métrique, et `docs/firewall.md` dit que ce n'est pas une trace individuelle.
     */
    /*
     * Compté, pas écrit en dur — pour la deuxième fois : la constante était à 5 quand
     * j'avais écrit 4, puis à 6 quand la section « redémarrage » en a ajouté une. Un
     * nombre magique dans un harnais devient faux à chaque scénario ajouté, et le
     * corriger à la main apprend à ignorer l'échec.
     *
     * Ce qui est vérifié est la PROPRIÉTÉ : chaque requête qui a atteint le moteur a
     * laissé exactement une ligne, et le refus « aucune règle » n'en a laissé aucune —
     * il n'atteint pas le moteur, donc il n'y a pas de décision à enregistrer.
     */
    const judged = rows.filter(
      (row) => typeof (row.input as Record<string, unknown> | undefined)?.interceptRule === "string",
    );
    record(
      "chaque requête qui a atteint le moteur a laissé exactement une exécution",
      judged.length === rows.length && judged.length >= 5,
      `${judged.length} interception(s) jugée(s) sur ${rows.length} exécution(s)`,
    );
    record(
      "le refus « aucune règle » n'en a laissé aucune — il n'atteint pas le moteur",
      !rows.some((row) => String(row.target ?? "").includes("payouts")),
      "compté par oathrion_intercept_refusals_total, pas tracé",
    );
    record("chacune porte la règle qui l'a jugée",
      rows.every((row) => typeof (row.input as Record<string, unknown> | undefined)?.interceptRule === "string"),
      "interceptRule présent");
    /*
     * LE CONTRÔLE DE DISCRÉTION. Le corps d'une API financière porte des noms et des
     * adresses. Il ne doit pas entrer dans la table que ce produit promet de pouvoir
     * montrer à un auditeur.
     */
    record("le corps de la requête N'EST PAS dans la trace",
      !JSON.stringify(rows).includes("client@exemple.test"),
      "aucune adresse client dans les exécutions");
    /*
     * LA RÉPONSE DU FOURNISSEUR NON PLUS, et c'est une fuite qu'une relecture de
     * `InterceptTool.run()` → `result.data` → `toolResult` a révélée : `data` est
     * persisté, et le relais y plaçait le corps complet de la réponse. Pour un
     * remboursement, c'est l'objet client. Le contrôle sur la REQUÊTE ne l'attrapait pas.
     */
    record("la réponse du fournisseur N'EST PAS dans la trace",
      !JSON.stringify(rows).includes("re_1") && !JSON.stringify(rows).includes("already refunded"),
      "aucun corps de réponse dans les exécutions");
    record("… mais le statut et la taille y sont, pour qu'un auditeur sache",
      rows.some((row) => {
        const tool = row.toolResult as Record<string, unknown> | null;
        return typeof tool?.status === "number" && typeof tool.responseBytes === "number";
      }),
      "status + responseBytes présents");
    record("le credential du fournisseur n'est nulle part dans la trace",
      !JSON.stringify(rows).includes(PROVIDER_KEY));

    const audit = await call("/api/audit", { token: adminAfter });
    record("la piste d'audit est non vide", Number(audit.body.total ?? 0) > 0, `${String(audit.body.total)} événements`);
    record("et elle ne contient pas le credential du fournisseur",
      !audit.raw.includes(PROVIDER_KEY));

    section("CE QUI RESTE NON PROUVÉ ICI");
    console.log("  Qu'un agent ne peut PAS joindre l'API directement. Aucun logiciel ne peut le");
    console.log("  garantir depuis l'intérieur de ce processus : cela vient de ce que l'agent ne");
    console.log("  détient pas le credential, et c'est une propriété du déploiement. Ce script");
    console.log("  prouve la moitié qui dépend de nous — l'agent n'a reçu que sa clé Oathrion, et");
    console.log("  c'est Oathrion qui a injecté celle du fournisseur.");
    console.log("");
    console.log("  Sur le FLUX : cet amont est local et émet quelques centaines d'octets. Rien ici");
    console.log("  ne dit le comportement sur un flux de plusieurs minutes, sous concurrence, ni");
    console.log("  quand l'agent est plus lent que le fournisseur — la contre-pression est codée");
    console.log("  et bornée, elle n'est pas mesurée sous charge. Les plafonds (64 Mio, 60 s de");
    console.log("  silence, 10 min au total) n'ont pas été atteints par ce passage.");

    return 0;
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child!.on("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(10_000).then(() => child!.kill("SIGKILL"))]);
    }
    await target?.close();
    await db?.dispose();
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${"=".repeat(72)}`);
    console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
    console.log("=".repeat(72));
    return code === 2 ? 2 : code === 0 && failed.length === 0 ? 0 : 1;
  })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
