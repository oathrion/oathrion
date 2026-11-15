/**
 * LE CONNECTEUR LINEAR, CONTRE UN LINEAR LOCAL QUI RÉPOND COMME LINEAR.
 *
 * Test SIMULÉ au sens du rapport de release : le serveur imite l'API GraphQL de Linear
 * (erreurs dans `errors[].extensions.code`, statut 400 pour une authentification
 * refusée). La preuve contre le vrai Linear est `npm run verify:linear`.
 *
 * Ce qu'il fixe :
 *   · une clé personnelle part brute, un jeton OAuth part en `Bearer` ;
 *   · la clé d'équipe de la cible est la frontière : un commentaire sur une issue d'une
 *     autre équipe ne part pas, même si l'identifiant a été maquillé ;
 *   · la création est idempotente CHEZ LINEAR : même exécution, même UUID ;
 *   · chaque erreur devient un code machine et une phrase.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { OrganizationId } from "@shared/tenancy";

import {
  issueIdFor,
  linearAuthorization,
  LinearConnector,
  linearProbeCode,
  parseLinearTarget,
} from "../connectors/linear";
import { writeOAuthSecret } from "../connectors/oauth-install";
import type { ConnectorContext } from "../connectors/types";
import type { ConnectorVault } from "../connectors/vault";

const KEY = "lin_api_bonnecleOathrionTestxxxxxxxxxxxxxxxx";
const OAUTH = "lin_oauth_jetonaccesplacetxxxxxxxxxxxxxxxx";
const LIMITED = "lin_api_limiteOathrionTestxxxxxxxxxxxxxxxxx";
const FORBIDDEN = "lin_api_lectureSeuleOathrionxxxxxxxxxxxxxxx";

interface Seen {
  path: string;
  authorization: string;
  query: string;
  variables: Record<string, unknown>;
}

let server: Server;
let origin = "";
const seen: Seen[] = [];
const createdIds = new Set<string>();

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  const authorization = req.headers.authorization ?? "";
  if (req.url === "/oauth/revoke") {
    seen.push({ path: req.url, authorization, query: "", variables: {} });
    return send(res, authorization === `Bearer ${OAUTH}` ? 200 : 400, {});
  }
  const { query, variables } = JSON.parse(raw) as { query: string; variables: Record<string, unknown> };
  seen.push({ path: req.url ?? "", authorization, query, variables: variables ?? {} });

  if (authorization === LIMITED) {
    return send(res, 400, { errors: [{ message: "Rate limit exceeded", extensions: { code: "RATELIMITED" } }] });
  }
  if (authorization !== KEY && authorization !== `Bearer ${OAUTH}` && authorization !== FORBIDDEN) {
    return send(res, 400, {
      errors: [{ message: "Authentication required, not authenticated", extensions: { code: "AUTHENTICATION_ERROR" } }],
    });
  }

  if (query.includes("viewer")) {
    return send(res, 200, { data: { viewer: { id: "u1", name: "Mariama", email: "a@x" }, organization: { name: "Kryxor", urlKey: "kryxor" } } });
  }
  if (query.includes("teams(first")) {
    return send(res, 200, { data: { teams: { nodes: [{ id: "t-eng", key: "ENG", name: "Engineering" }, { id: "t-ops", key: "OPS", name: "Ops" }] } } });
  }
  if (query.includes("teams(filter")) {
    const key = variables.key;
    const nodes = key === "ENG" ? [{ id: "t-eng", key: "ENG" }] : key === "OPS" ? [{ id: "t-ops", key: "OPS" }] : [];
    return send(res, 200, { data: { teams: { nodes } } });
  }
  if (query.includes("issues(filter")) {
    return send(res, 200, {
      data: { issues: { nodes: [{ identifier: "ENG-1", title: "Corriger la connexion", url: "https://linear.app/kryxor/issue/ENG-1", priority: 2, state: { name: "Todo" } }] } },
    });
  }
  if (query.includes("issueCreate")) {
    if (authorization === FORBIDDEN) {
      return send(res, 200, { data: null, errors: [{ message: "Forbidden: insufficient permissions", extensions: { code: "FORBIDDEN" } }] });
    }
    const input = variables.input as { id: string; title: string };
    if (createdIds.has(input.id)) {
      return send(res, 200, { data: null, errors: [{ message: "Entity already exists", extensions: { code: "INVALID_INPUT" } }] });
    }
    createdIds.add(input.id);
    return send(res, 200, {
      data: { issueCreate: { success: true, issue: { id: input.id, identifier: "ENG-42", title: input.title, url: "https://linear.app/kryxor/issue/ENG-42" } } },
    });
  }
  if (query.includes("issue(id")) {
    const id = variables.id;
    if (id === "ENG-7") return send(res, 200, { data: { issue: { id: "i-7", identifier: "ENG-7", team: { key: "ENG" } } } });
    /* ENG-8 a été DÉPLACÉE chez OPS : l'ancien identifiant reste un alias. */
    if (id === "ENG-8") return send(res, 200, { data: { issue: { id: "i-8", identifier: "OPS-3", team: { key: "OPS" } } } });
    return send(res, 200, { data: null, errors: [{ message: "Entity not found", extensions: { code: "INVALID_INPUT" } }] });
  }
  if (query.includes("commentCreate")) {
    return send(res, 200, { data: { commentCreate: { success: true, comment: { id: "c1", url: "https://linear.app/kryxor/issue/ENG-7#comment-c1" } } } });
  }
  return send(res, 400, { errors: [{ message: "Unknown query" }] });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => handle(req, res, body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  seen.length = 0;
  createdIds.clear();
});

function contextWith(secret: string | null): ConnectorContext & { forgotten: () => boolean } {
  let stored = secret;
  const vault = {
    open: () => Promise.resolve(stored === null ? null : { secretEnvelope: stored, account: "", scopes: [] }),
    describe: () => Promise.resolve(null),
    revoke: () => {
      const had = stored !== null;
      stored = null;
      return Promise.resolve(had);
    },
  } as unknown as ConnectorVault;
  return {
    organizationId: "org_test" as OrganizationId,
    vault,
    env: { OATHRION_LINEAR_API_ORIGIN: origin, OATHRION_WEBHOOK_ALLOW_PRIVATE: "true", OATHRION_CONNECTOR_TIMEOUT_MS: "1000" },
    forgotten: () => stored === null,
  };
}

const linear = new LinearConnector();
const oauthSecret = writeOAuthSecret({ accessToken: OAUTH, scopes: ["read", "issues:create", "comments:create"] });

function request(action: string, target: string, metadata: Record<string, unknown> = {}, executionId = "exe_linear_1") {
  return { action, target, metadata, executionId };
}

describe("la cible nomme l'équipe", () => {
  it("lit les trois formes", () => {
    expect(parseLinearTarget("linear.app")).toEqual({ team: null, issue: null });
    expect(parseLinearTarget("linear.app/eng")).toEqual({ team: "ENG", issue: null });
    expect(parseLinearTarget("https://linear.app/ENG/ENG-12/")).toEqual({ team: "ENG", issue: "ENG-12" });
  });

  it.each([
    ["un autre hôte", "evil.example/ENG"],
    ["une issue d'une autre équipe", "linear.app/ENG/OPS-3"],
    ["une clé invalide", "linear.app/../admin"],
    ["trop de segments", "linear.app/ENG/ENG-1/delete"],
  ])("refuse %s", (_label, target) => {
    expect(() => parseLinearTarget(target)).toThrow();
  });
});

describe("l'authentification", () => {
  it("une clé personnelle part brute, un jeton OAuth en Bearer", () => {
    expect(linearAuthorization(KEY)).toBe(KEY);
    expect(linearAuthorization(OAUTH)).toBe(`Bearer ${OAUTH}`);
  });

  it("une bonne clé nomme l'espace et la personne tels que Linear les rend", async () => {
    const probe = await linear.verify(KEY, {}, contextWith(null).env);
    expect(probe).toMatchObject({ ok: true, code: "ok", account: "Kryxor (Mariama)" });
    expect(seen[0]!.authorization).toBe(KEY);
  });

  it("un secret OAuth scellé est lu, et part en Bearer avec ses portées", async () => {
    const probe = await linear.verify(oauthSecret, {}, contextWith(null).env);
    expect(probe.ok).toBe(true);
    expect(probe.scopes).toEqual(["read", "issues:create", "comments:create"]);
    expect(seen[0]!.authorization).toBe(`Bearer ${OAUTH}`);
  });

  it("une clé refusée est « unauthorized » et dit de reconnecter", async () => {
    const probe = await linear.verify("lin_api_mauvaise", {}, contextWith(null).env);
    expect(probe).toMatchObject({ ok: false, code: "unauthorized", account: "" });
    expect(probe.detail).toMatch(/Reconnect Linear/);
  });

  it("une limite de débit est un quota", async () => {
    expect((await linear.verify(LIMITED, {}, contextWith(null).env)).code).toBe("rate_limited");
  });
});

describe("les quatre verbes", () => {
  it("liste les équipes, sans leurs identifiants internes", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.teams.list", "linear.app"));
    expect(result.ok).toBe(true);
    expect(result.data.teams).toEqual([{ key: "ENG", name: "Engineering" }, { key: "OPS", name: "Ops" }]);
  });

  it("recherche dans UNE équipe, filtrée par la clé de la cible", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.issue.search", "linear.app/ENG", { query: "connexion", limit: 999 }));
    expect(result.ok).toBe(true);
    expect(seen.at(-1)!.variables).toEqual({ filter: { team: { key: { eq: "ENG" } }, title: { containsIgnoreCase: "connexion" } }, first: 25 });
  });

  it("crée une issue avec un UUID dérivé de l'exécution, et rend son lien", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.issue.create", "linear.app/ENG", { title: "Déployer la v2", priority: 2 }));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ identifier: "ENG-42", url: "https://linear.app/kryxor/issue/ENG-42" });
    const create = seen.find((s) => s.query.includes("issueCreate"))!;
    expect((create.variables.input as { id: string; teamId: string }).id).toBe(issueIdFor("exe_linear_1"));
    expect((create.variables.input as { teamId: string }).teamId).toBe("t-eng");
  });

  it("rejouer LA MÊME exécution ne crée pas de seconde issue : Linear refuse l'UUID", async () => {
    const first = await linear.execute(contextWith(KEY), request("linear.issue.create", "linear.app/ENG", { title: "Une" }));
    const again = await linear.execute(contextWith(KEY), request("linear.issue.create", "linear.app/ENG", { title: "Une" }));
    expect(first.ok).toBe(true);
    expect(again.ok).toBe(false);
    expect(createdIds.size).toBe(1);
  });

  it("l'UUID est un v4 stable et distinct par exécution", () => {
    expect(issueIdFor("a")).toBe(issueIdFor("a"));
    expect(issueIdFor("a")).not.toBe(issueIdFor("b"));
    expect(issueIdFor("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("une permission refusée par Linear est « forbidden »", async () => {
    const result = await linear.execute(contextWith(FORBIDDEN), request("linear.issue.create", "linear.app/ENG", { title: "x" }));
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("une équipe inconnue est « not_found » et rien n'est créé", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.issue.create", "linear.app/NOPE", { title: "x" }));
    expect(result.code).toBe("not_found");
    expect(seen.some((s) => s.query.includes("issueCreate"))).toBe(false);
  });

  it("commente une issue de l'équipe nommée", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.comment.create", "linear.app/ENG/ENG-7", { body: "Vu." }));
    expect(result.ok).toBe(true);
    expect(seen.at(-1)!.variables).toMatchObject({ input: { issueId: "i-7" } });
  });

  it("une issue DÉPLACÉE dans une autre équipe n'est pas commentée : Linear fait foi, pas l'identifiant", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.comment.create", "linear.app/ENG/ENG-8", { body: "x" }));
    expect(result).toMatchObject({ ok: false, code: "forbidden", data: { dispatched: false, reason: "team_mismatch" } });
    expect(seen.some((s) => s.query.includes("commentCreate"))).toBe(false);
  });

  it("une issue introuvable est « not_found »", async () => {
    const result = await linear.execute(contextWith(KEY), request("linear.comment.create", "linear.app/ENG/ENG-999", { body: "x" }));
    expect(result.code).toBe("not_found");
  });
});

describe("ce qui ne part jamais", () => {
  it.each([
    ["création sans titre", "linear.issue.create", "linear.app/ENG", {}],
    ["création sur une issue", "linear.issue.create", "linear.app/ENG/ENG-1", { title: "x" }],
    ["priorité hors bornes", "linear.issue.create", "linear.app/ENG", { title: "x", priority: 9 }],
    ["commentaire vide", "linear.comment.create", "linear.app/ENG/ENG-7", { body: " " }],
    ["commentaire sans issue", "linear.comment.create", "linear.app/ENG", { body: "x" }],
    ["cible étrangère", "linear.issue.create", "evil.example/ENG", { title: "x" }],
  ])("%s", async (_label, action, target, metadata) => {
    const result = await linear.execute(contextWith(KEY), request(action, target, metadata));
    expect(result.ok).toBe(false);
    expect(result.data.dispatched).toBe(false);
    expect(seen.some((s) => s.query.includes("Create"))).toBe(false);
  });

  it("sans connexion, rien ne part", async () => {
    const result = await linear.execute(contextWith(null), request("linear.teams.list", "linear.app"));
    expect(result).toMatchObject({ ok: false, code: "unauthorized", data: { dispatched: false } });
    expect(seen).toHaveLength(0);
  });

  it("la clé n'apparaît dans aucun résultat", async () => {
    const results = [
      await linear.verify(KEY, {}, contextWith(null).env),
      await linear.execute(contextWith(KEY), request("linear.issue.create", "linear.app/ENG", { title: "x" })),
    ];
    expect(JSON.stringify(results)).not.toContain(KEY);
  });
});

describe("déconnecter", () => {
  it("une connexion OAuth est révoquée chez Linear", async () => {
    const revocation = await linear.revoke(contextWith(oauthSecret), "admin@test");
    expect(seen.some((s) => s.path === "/oauth/revoke")).toBe(true);
    expect(revocation).toMatchObject({ ok: true, remoteStillValid: false });
  });

  it("une clé personnelle ne peut pas l'être, et la réponse dit où la supprimer", async () => {
    const revocation = await linear.revoke(contextWith(KEY), "admin@test");
    expect(revocation.remoteStillValid).toBe(true);
    expect(revocation.detail).toMatch(/Personal API keys/);
    expect(seen).toHaveLength(0);
  });
});

describe("le code machine", () => {
  it("lit `extensions.code` et le statut", () => {
    expect(linearProbeCode(200, [])).toBe("ok");
    expect(linearProbeCode(400, [{ code: "AUTHENTICATION_ERROR", message: "" }])).toBe("unauthorized");
    expect(linearProbeCode(400, [{ code: "RATELIMITED", message: "" }])).toBe("rate_limited");
    expect(linearProbeCode(200, [{ code: "FORBIDDEN", message: "" }])).toBe("forbidden");
    expect(linearProbeCode(200, [{ code: "INVALID_INPUT", message: "Entity not found" }])).toBe("not_found");
    expect(linearProbeCode(502, [])).toBe("unreachable");
  });
});
