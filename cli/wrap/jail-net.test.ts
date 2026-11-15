/**
 * Le réseau de la prison (`jail-net.ts`) : le mandataire n'ouvre que les hôtes permis, en HTTPS,
 * et dit pourquoi aux autres ; le passage du pivot mène au pivot.
 */
import { mkdtempSync } from "node:fs";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HUB_SOCKET, hostAllowed, PROXY_SOCKET, startGate } from "./jail-net";

describe("les hôtes permis", () => {
  it("un hôte et ses sous-domaines ; jamais un nom qui le contient seulement", () => {
    expect(hostAllowed("api2.cursor.sh", ["cursor.sh"])).toBe(true);
    expect(hostAllowed("cursor.sh", ["*.cursor.sh"])).toBe(true);
    expect(hostAllowed("evilcursor.sh", ["cursor.sh"])).toBe(false);
    expect(hostAllowed("cursor.sh.evil.com", ["cursor.sh"])).toBe(false);
    expect(hostAllowed("API.Anthropic.com.", ["anthropic.com"])).toBe(true);
  });
});

describe("les passages de la prison", () => {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-gate-"));
  const refused: string[] = [];
  const reached: string[] = [];
  /* Le « fournisseur » et le « pivot » : deux serveurs locaux qui répondent en écho. */
  const echo = createServer((s) => s.on("data", (d) => s.write(`écho:${String(d)}`)));
  const hub = createServer((s) => s.on("data", () => s.end("pivot")));
  let close: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    await new Promise<void>((done) => echo.listen(0, "127.0.0.1", () => done()));
    await new Promise<void>((done) => hub.listen(0, "127.0.0.1", () => done()));
    const gate = await startGate({
      dir,
      hubPort: (hub.address() as AddressInfo).port,
      allowed: ["fournisseur.test"],
      onRefused: (host) => refused.push(host),
      connect: (host, onConnect) => {
        reached.push(host);
        return createConnection({ host: "127.0.0.1", port: (echo.address() as AddressInfo).port }, onConnect);
      },
    });
    close = gate.close;
  });
  afterAll(async () => {
    await close();
    echo.close();
    hub.close();
  });

  const exchange = (socket: string, send: string, then?: string) =>
    new Promise<string>((done) => {
      const s = createConnection(join(dir, socket), () => s.write(send));
      let text = "";
      s.on("data", (d) => {
        text += String(d);
        if (then && text.includes("200 Connection established") && !text.includes("écho")) s.write(then);
        if (then && text.includes("écho")) s.end();
      });
      s.on("close", () => done(text));
    });

  it("un hôte permis : le tunnel s'ouvre, et ce qui passe arrive", async () => {
    const text = await exchange(PROXY_SOCKET, "CONNECT api.fournisseur.test:443 HTTP/1.1\r\n\r\n", "bonjour");
    expect(text).toMatch(/^HTTP\/1\.1 200 Connection established/);
    expect(text).toContain("écho:bonjour");
    expect(reached).toEqual(["api.fournisseur.test"]);
  });

  it("un hôte non permis : 403, une raison que l'agent lit, et rien n'est joint", async () => {
    const text = await exchange(PROXY_SOCKET, "CONNECT ailleurs.example:443 HTTP/1.1\r\n\r\n");
    expect(text).toMatch(/^HTTP\/1\.1 403/);
    expect(text).toContain("--allow-host ailleurs.example");
    expect(refused).toEqual(["ailleurs.example"]);
    expect(reached).toEqual(["api.fournisseur.test"]);
  });

  it("autre chose que HTTPS : refusé, même vers un hôte permis", async () => {
    expect(await exchange(PROXY_SOCKET, "CONNECT api.fournisseur.test:22 HTTP/1.1\r\n\r\n")).toMatch(/only HTTPS/);
    expect(await exchange(PROXY_SOCKET, "GET http://api.fournisseur.test/ HTTP/1.1\r\n\r\n")).toMatch(/^HTTP\/1\.1 403[\s\S]*only HTTPS/);
  });

  it("du HTTP simple vers un hôte non permis : la réponse nomme l'hôte, pas l'adresse", async () => {
    const text = await exchange(PROXY_SOCKET, "GET http://autre.example/page HTTP/1.1\r\n\r\n");
    expect(text).toContain("--allow-host autre.example.");
    expect(text).not.toContain("--allow-host http://");
    expect(refused).toContain("autre.example");
  });

  it("le passage du pivot mène au pivot", async () => {
    expect(await exchange(HUB_SOCKET, "x")).toBe("pivot");
  });
});
