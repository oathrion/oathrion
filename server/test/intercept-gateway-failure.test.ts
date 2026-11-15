/**
 * QUAND LA PASSERELLE ÉCHOUE SOUS LE PARE-FEU : la réponse doit dire si la requête est
 * partie.
 *
 * ## Le défaut, et comment il s'est manifesté
 *
 * Un passage de charge de 2 451 appels relayés a produit **un** 500 sans en-tête de
 * décision. Le symptôme désignait une ligne précise de `routes-intercept.ts` :
 *
 *     const result = await pending;   // hors de tout `try`
 *
 * `gateway.execute()` n'attrape rien en interne — ni `decide()`, qui écrit en base et
 * applique les quotas, ni `dispatch()`. Un échec de base transitoire, un plafond de quota
 * atteint ou une contention d'écriture remontait donc jusqu'au gestionnaire d'erreur
 * générique, qui répond 500 et rien d'autre.
 *
 * ## Pourquoi le 500 nu est le vrai défaut
 *
 * Il ne dit ni la décision, ni — et c'est le pire — si la requête A ÉTÉ TRANSMISE. Pour
 * un pare-feu de gouvernance, « je ne sais pas si votre remboursement a été envoyé » est
 * la plus mauvaise réponse possible : l'agent ne peut ni réessayer sans risquer un
 * doublon, ni renoncer sans risquer une perte.
 *
 * Or Oathrion PEUT répondre. La table en mémoire du relais ne contient une réponse que si
 * le fournisseur a effectivement répondu. On la lit, et on dit laquelle des deux
 * situations s'est produite.
 *
 * ## Les deux déclencheurs employés ici
 *
 * 1. Un PLAFOND DE QUOTA d'exécutions, atteint entre deux appels. Il lève
 *    `QuotaExceededError` à l'intérieur de `decide()`, donc AVANT tout envoi. Ce n'est pas
 *    une panne : depuis le 27 octobre 2026, le relais le rend comme le reste de l'API
 *    (429 `quota_exceeded`, la limite, la remise à zéro, `forwarded: false`).
 * 2. Une VRAIE PANNE : `AgentGateway.execute` qui lève une erreur de base, injectée par
 *    un espion. C'est la branche 500 `gateway_failed`, qui ne doit rien divulguer.
 *
 * ## Ce que ce fichier NE prouve pas
 *
 * La branche `forwarded: true` — fournisseur contacté, puis échec d'enregistrement — est
 * écrite et lisible, mais elle n'est pas exercée ici : la déclencher demanderait
 * d'injecter une panne après le relais. Elle est rapportée comme telle, non comme
 * éprouvée.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

type Harness = typeof import("./harness");

const AGENT_ID = "agt_quota_pare_feu";
const PROVIDER_KEY = "cle-du-fournisseur-de-test";
const DEST = "local-fixture";

let harness: Harness;
let client: Awaited<ReturnType<Harness["startTestServer"]>>;
let upstream: Server;
let agentKey = "";
/** Les requêtes réellement reçues par l'amont : la preuve de ce qui est parti. */
const received: string[] = [];
const saved: Record<string, string | undefined> = {};

async function startUpstream(): Promise<string> {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push(req.url ?? "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  const url = await startUpstream();

  for (const name of [
    "OATHRION_LOCAL_MCP_URL", "OATHRION_LOCAL_MCP_ORGANIZATIONS", "OATHRION_KEK",
    "OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE", "OATHRION_INTERCEPTS",
    "OATHRION_QUOTAS", "OATHRION_QUOTA_MODE",
  ]) saved[name] = process.env[name];

  process.env.OATHRION_LOCAL_MCP_URL = url;
  process.env.OATHRION_LOCAL_MCP_ORGANIZATIONS = "*";
  process.env.OATHRION_KEK = randomBytes(32).toString("base64");
  process.env.OATHRION_INTERCEPT_KEY_LOCAL_FIXTURE = PROVIDER_KEY;
  process.env.OATHRION_INTERCEPTS = JSON.stringify([
    {
      id: "regle_relais",
      destination: DEST,
      method: "POST",
      path: "/v1/chose",
      action: "api.request",
      target: "body.id",
      forwardHeaders: ["content-type"],
    },
  ]);
  /*
   * UN PLAFOND TRÈS BAS, et en mode `enforce`.
   *
   * Le harnais sème déjà des exécutions, donc le plafond est franchi dès le premier
   * appel relayé : c'est ce qu'on veut, puisque le cas à éprouver est « la passerelle
   * lève avant d'avoir rien transmis ».
   */
  process.env.OATHRION_QUOTAS = "default:executions=1";
  process.env.OATHRION_QUOTA_MODE = "enforce";

  harness = await import("./harness");
  client = await harness.startTestServer();

  const login = await client.post<{ token?: string }>("/api/auth/login", {
    email: harness.TEST_CONSOLE_EMAIL,
    password: harness.TEST_CONSOLE_PASSWORD,
  });
  const session = String(login.body.token ?? "");
  expect(session).not.toBe("");

  await client.post(
    "/api/agents",
    {
      id: AGENT_ID,
      name: "Agent sous plafond",
      description: "Traverse le pare-feu alors que le quota est atteint.",
      provider: "openai",
      model: "gpt-4o",
      status: "active",
      owner: "ia",
      mandate: {
        maxTransactionAmount: 10_000,
        currency: "EUR",
        allowedCategories: [],
        blockedCategories: [],
        allowedDomains: [],
      },
      permissions: [
        {
          scope: "call:external-api",
          label: "Appeler une API tierce",
          description: "Sous mandat.",
          granted: true,
          risk: "medium",
        },
      ],
      policyIds: [],
      tags: ["quota"],
    },
    { auth: harness.ROLE_KEYS.admin },
  );

  const key = await client.post<{ secret?: string }>(
    "/api/keys",
    { name: "clé quota", role: "operator", agentId: AGENT_ID },
    { auth: session },
  );
  agentKey = String(key.body.secret ?? "");
  expect(agentKey).not.toBe("");
}, 60_000);

afterAll(async () => {
  await client.close();
  await new Promise<void>((r) => upstream.close(() => r()));
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function relay() {
  const res = await fetch(`${client.baseUrl}/api/v1/intercept/${DEST}/v1/chose`, {
    method: "POST",
    headers: { authorization: `Bearer ${agentKey}`, "content-type": "application/json" },
    body: JSON.stringify({ id: "objet-42" }),
  });
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers };
}

/*
 * LE PREMIER APPEL PASSE, et c'est voulu : il épuise le plafond et prouve du même coup
 * que la voie heureuse marche toujours. Sans lui, le fichier n'éprouverait que la panne,
 * et un relais cassé en permanence lui aurait paru correct.
 */
beforeAll(async () => {
  const premier = await relay();
  expect(premier.status).toBe(200);
  expect(premier.headers.get("x-oathrion-decision")).toBe("ALLOW");
  expect(received.length).toBeGreaterThan(0);
}, 30_000);

describe("un quota atteint sous le pare-feu est un refus nommé, pas une panne", () => {
  /*
   * Jusqu'au 27 octobre 2026, ce cas rendait « 500 : la décision n'a pas pu être
   * enregistrée ». Une passe d'endurance de 12 h l'a produit 303 273 fois après le
   * 100 000e appel du mois. Le reste de l'API répond 429 `quota_exceeded` ; le relais
   * dit maintenant la même chose.
   */
  it("429, quota_exceeded, la limite et la remise à zéro", async () => {
    const res = await relay();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe("quota_exceeded");
    expect(res.body.counter).toBe("executions");
    expect(res.body.limit).toBe(1);
    expect(typeof res.body.resetAt).toBe("string");
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(String(res.body.message)).toMatch(/Quota reached for/);
  });

  it("DIT que la requête n'est pas partie, et l'amont le confirme", async () => {
    const avant = received.length;
    const res = await relay();
    expect(res.body.forwarded).toBe(false);
    expect(received.length).toBe(avant);
  });

  it("porte la référence de relais, et aucun en-tête de décision", async () => {
    const res = await relay();
    const interception = res.body.interception as Record<string, unknown> | undefined;
    expect(interception?.rule).toBe("regle_relais");
    expect(interception?.destination).toBe(DEST);
    expect(String(interception?.ref).length).toBeGreaterThan(8);
    /* Rien n'a été jugé : un `x-oathrion-decision: ALLOW` fabriqué ferait croire l'action relâchée. */
    expect(res.headers.get("x-oathrion-decision")).toBeNull();
    expect(res.body.decision).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/sqlite|postgres|SQL/i);
  });
});

describe("une vraie panne de la passerelle ne rend toujours pas un 500 muet", () => {
  /*
   * Le quota ne déclenche plus cette branche : la panne est injectée là où elle naîtrait
   * — `AgentGateway.execute` qui lève une erreur de base — sans toucher au relais.
   */
  let restore: (() => void) | null = null;
  beforeAll(async () => {
    const { AgentGateway } = await import("../gateway/agent-gateway");
    const spy = vi.spyOn(AgentGateway.prototype, "execute").mockRejectedValue(new Error("SQLITE_BUSY: database is locked (table executions)"));
    restore = () => spy.mockRestore();
  });
  afterAll(() => restore?.());

  it("nomme la panne au lieu de rendre une erreur générique", async () => {
    const res = await relay();
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("intercept_gateway_failed");
    expect(res.body.code).toBe("gateway_failed");
  });

  it("DIT que la requête n'est pas partie, par une observation", async () => {
    const avant = received.length;
    const res = await relay();
    expect(res.body.forwarded).toBe(false);
    expect(String(res.body.message)).toMatch(/did NOT forward/);
    expect(String(res.body.message)).toMatch(/retrying is safe/);
    expect(received.length).toBe(avant);
  });

  it("porte la référence de relais, pour que l'incident soit rattachable", async () => {
    const res = await relay();
    const interception = res.body.interception as Record<string, unknown> | undefined;
    expect(interception?.rule).toBe("regle_relais");
    expect(typeof interception?.ref).toBe("string");
    expect(String(interception?.ref).length).toBeGreaterThan(8);
  });

  it("ne divulgue pas la cause interne dans la réponse", async () => {
    const res = await relay();
    const rendu = JSON.stringify(res.body);
    expect(rendu).not.toMatch(/sqlite|postgres|SQL|locked|table executions/i);
  });

  it("ne rend jamais un succès : aucun en-tête de décision n'est posé", async () => {
    const res = await relay();
    expect(res.headers.get("x-oathrion-decision")).toBeNull();
    expect(res.body.decision).toBeUndefined();
  });
});
