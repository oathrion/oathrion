/**
 * LA SESSION DE LA CONSOLE DANS UN COOKIE PROTÉGÉ (`server/session-cookie.ts`).
 *
 * Ce qui doit tenir :
 *   · la connexion pose un cookie HttpOnly, SameSite=Strict, limité à `/api`, qui expire
 *     avec la session ; `Secure` derrière HTTPS ;
 *   · ce cookie seul suffit à LIRE (un rechargement de page reprend la session) ;
 *   · une requête qui MODIFIE, portée par le seul cookie, est refusée sans l'en-tête de la
 *     console — la seconde protection contre la requête forgée ;
 *   · le cookie n'accepte qu'une SESSION : une clé d'API glissée dedans est refusée ;
 *   · la déconnexion efface le cookie, et la session morte ne rouvre rien ;
 *   · le chemin `Authorization: Bearer` (agents, scripts, SDK) est inchangé.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ROLE_KEYS, TEST_CONSOLE_EMAIL, TEST_CONSOLE_PASSWORD, startTestServer, type TestClient } from "./harness";

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});

afterAll(async () => {
  await client?.close();
});

async function login(headers: Record<string, string> = {}): Promise<{ cookie: string; setCookie: string; token: string }> {
  const res = await fetch(`${client.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ email: TEST_CONSOLE_EMAIL, password: TEST_CONSOLE_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("oathrion_session=")) ?? "";
  const body = (await res.json()) as { token: string };
  return { cookie: setCookie.split(";")[0]!, setCookie, token: body.token };
}

function withCookie(cookie: string, init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie } };
}

describe("le cookie posé à la connexion", () => {
  it("est HttpOnly, SameSite=Strict, limité à /api, et expire avec la session", async () => {
    const { setCookie } = await login();
    expect(setCookie).toMatch(/^oathrion_session=[^;]+;/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/api");
    expect(Number(/Max-Age=(\d+)/.exec(setCookie)?.[1])).toBeGreaterThan(0);
    /* En HTTP local, pas de Secure : le navigateur ne le poserait pas. */
    expect(setCookie).not.toContain("Secure");
  });

  it("porte Secure derrière HTTPS", async () => {
    const { setCookie } = await login({ "x-forwarded-proto": "https" });
    expect(setCookie).toContain("Secure");
  });
});

describe("ce que le cookie seul permet", () => {
  it("lire : la session est reprise, comme après un rechargement de page", async () => {
    const { cookie } = await login();
    const res = await fetch(`${client.baseUrl}/api/auth/session`, withCookie(cookie));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { identity: { role: string } };
    expect(body.identity.role).toBe("admin");
  });

  it("modifier : refusé SANS l'en-tête de la console, accepté AVEC", async () => {
    const { cookie } = await login();
    const forged = await fetch(`${client.baseUrl}/api/auth/logout`, withCookie(cookie, { method: "POST" }));
    expect(forged.status).toBe(403);
    expect(((await forged.json()) as { code: string }).code).toBe("console_header_required");
    /* La session n'a pas été touchée par la requête refusée. */
    expect((await fetch(`${client.baseUrl}/api/auth/session`, withCookie(cookie))).status).toBe(200);

    const real = await fetch(`${client.baseUrl}/api/auth/logout`, withCookie(cookie, { method: "POST", headers: { "X-Oathrion-Console": "1" } }));
    expect(real.status).toBe(200);
    /* La déconnexion efface le cookie… */
    expect(real.headers.getSetCookie().find((c) => c.startsWith("oathrion_session="))).toMatch(/Max-Age=0/);
    /* … et la session morte ne rouvre rien, même si le navigateur garde le cookie. */
    expect((await fetch(`${client.baseUrl}/api/auth/session`, withCookie(cookie))).status).toBe(401);
  });

  it("une clé d'API glissée dans le cookie est refusée : le cookie ne porte qu'une session", async () => {
    const res = await fetch(`${client.baseUrl}/api/auth/session`, withCookie(`oathrion_session=${ROLE_KEYS.admin}`));
    expect(res.status).toBe(401);
  });

  it("une valeur quelconque est refusée", async () => {
    expect((await fetch(`${client.baseUrl}/api/auth/session`, withCookie("oathrion_session=n-importe-quoi"))).status).toBe(401);
  });
});

describe("le chemin des agents et des scripts", () => {
  it("Authorization: Bearer reste inchangé, sans en-tête de console, même pour modifier", async () => {
    const { token } = await login();
    const res = await fetch(`${client.baseUrl}/api/auth/logout`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });
});
