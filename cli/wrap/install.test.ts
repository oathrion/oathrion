/**
 * `oathrion install` — mettre Oathrion devant les serveurs d'un client, avec l'accord de la
 * personne, sans jamais perdre l'ancien fichier.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isWrapped, runInstall, show, unwrapServer, wrapNameFor, wrapServer } from "./install";

const CONFIG = {
  mcpServers: {
    github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "jeton-de-la-personne" } },
    "Mes Fichiers": { command: "node", args: ["./outils/serveur.js"] },
    distant: { url: "https://exemple.invalid/mcp" },
  },
};

function setup(config: unknown = CONFIG) {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-install-"));
  const home = mkdtempSync(join(tmpdir(), "oathrion-install-home-"));
  mkdirSync(join(dir, ".cursor"));
  writeFileSync(join(dir, ".cursor", "mcp.json"), typeof config === "string" ? config : JSON.stringify(config, null, 2));
  const lines: string[] = [];
  const io = (answer: boolean | null) => ({
    out: (l: string) => lines.push(l),
    err: (l: string) => lines.push(`ERR ${l}`),
    confirm: () => Promise.resolve(answer),
    cwd: dir,
    home,
    now: () => new Date("2026-10-28T18:00:00Z"),
  });
  const read = () => JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")) as typeof CONFIG;
  return { dir, home, lines, io, read };
}

describe("la transformation", () => {
  it("un serveur distant avec son jeton : un serveur local `wrap --url`, le jeton dans l'environnement, et l'aller-retour exact", () => {
    /* Cursor : `url` et `headers`, sans `type`. */
    const cursor = { url: "https://mcp.exemple.test/mcp", headers: { Authorization: "Bearer jeton" } };
    const wrapped = wrapServer("exemple", cursor, false);
    expect(wrapped).toEqual({
      command: "npx",
      args: ["-y", "oathrion", "wrap", "--name", "exemple", "--url", "https://mcp.exemple.test/mcp", "--transport", "http"],
      env: { MCP_REMOTE_HEADERS: JSON.stringify({ Authorization: "Bearer jeton" }) },
    });
    expect(JSON.stringify(wrapped.args)).not.toContain("jeton");
    expect(isWrapped(wrapped)).toBe(true);
    expect(unwrapServer(wrapped)).toEqual(cursor);
    /* Claude Code : `type` sse devient stdio, et revient. */
    const claude = { type: "sse", url: "https://mcp.exemple.test/sse", headers: { "X-Api-Key": "k" } };
    const wrappedSse = wrapServer("ex", claude, false);
    expect(wrappedSse).toMatchObject({ type: "stdio", args: expect.arrayContaining(["--transport", "sse"]) });
    expect(unwrapServer(wrappedSse)).toEqual(claude);
  });

  it("met la même commande derrière « npx -y oathrion wrap », et la retrouve", () => {
    const wrapped = wrapServer("github", CONFIG.mcpServers.github, false);
    expect(wrapped).toEqual({
      command: "npx",
      args: ["-y", "oathrion", "wrap", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "jeton-de-la-personne" },
    });
    expect(isWrapped(wrapped)).toBe(true);
    expect(unwrapServer(wrapped)).toEqual(CONFIG.mcpServers.github);
    expect(wrapServer("x", { command: "srv" }, true).args).toEqual(["-y", "oathrion", "wrap", "--name", "x", "--approval", "console", "--", "srv"]);
    expect(wrapNameFor("Mes Fichiers")).toBe("mes-fichiers");
    expect(isWrapped({ command: "node", args: ["/chemin/dist/oathrion.mjs", "wrap", "--", "srv"] })).toBe(true);
    expect(isWrapped(CONFIG.mcpServers.github)).toBe(false);
  });
});

describe("oathrion install cursor", () => {
  it("montre, demande, applique ; garde une copie ; laisse le serveur distant ; l'environnement suit", async () => {
    const { dir, lines, io, read } = setup();
    expect(await runInstall(["cursor"], io(true))).toBe(0);
    const after = read();
    expect(after.mcpServers.github.args).toEqual(["-y", "oathrion", "wrap", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"]);
    expect(after.mcpServers.github.env).toEqual(CONFIG.mcpServers.github.env);
    expect(after.mcpServers["Mes Fichiers"].args).toContain("mes-fichiers");
    expect(after.mcpServers.distant).toEqual(CONFIG.mcpServers.distant);
    expect(lines.join("\n")).toMatch(/before: npx -y @modelcontextprotocol\/server-github[\s\S]*after: {2}npx -y oathrion wrap --name github --/);
    expect(lines.join("\n")).toMatch(/distant: remote server with no token in the configuration — its sign-in \(OAuth\) is handled by the client/);
    const backups = readdirSync(join(dir, ".cursor")).filter((f) => f.startsWith("mcp.json.before-oathrion-"));
    expect(backups).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(dir, ".cursor", backups[0]!), "utf8"))).toEqual(CONFIG);
  });

  /*
   * Relevé en essayant le paquet sur la machine de l'utilisateur : `oathrion install` écrivait
   * `npx -y oathrion` sans version, quand `npx oathrion` épinglait déjà la sienne. Le client
   * serait allé chercher sur npm une autre Oathrion que celle installée.
   */
  it("le client lance CETTE Oathrion : la version exacte par npx, ou le paquet installé par son chemin", async () => {
    const viaNpx = setup();
    const npxIo = { ...viaNpx.io(true), script: "/home/x/.npm/_npx/ab12/node_modules/oathrion/oathrion.mjs", version: "0.1.0-preview.1" };
    expect(await runInstall(["cursor"], npxIo)).toBe(0);
    expect(viaNpx.read().mcpServers.github).toMatchObject({ command: "npx", args: ["-y", "oathrion@0.1.0-preview.1", "wrap", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"] });

    const installed = setup();
    const script = "/opt/projet/node_modules/oathrion/oathrion.mjs";
    expect(await runInstall(["cursor"], { ...installed.io(true), script, version: "0.1.0-preview.1" })).toBe(0);
    expect(installed.read().mcpServers.github).toMatchObject({ command: process.execPath, args: [script, "wrap", "--name", "github", "--", "npx", "-y", "@modelcontextprotocol/server-github"] });
    /* Et l'annulation retrouve l'original, quel que soit le lanceur. */
    expect(await runInstall(["cursor", "--undo", "--yes"], installed.io(null))).toBe(0);
    expect(installed.read()).toEqual(CONFIG);
  });

  it("relancé : rien à changer ; --annuler : tout redevient comme avant", async () => {
    const { io, read } = setup();
    await runInstall(["cursor"], io(true));
    const lines: string[] = [];
    const again = { ...io(true), out: (l: string) => lines.push(l) };
    expect(await runInstall(["cursor"], again)).toBe(0);
    expect(lines.join("\n")).toMatch(/github: already behind Oathrion[\s\S]*Nothing to change/);
    expect(await runInstall(["cursor", "--annuler", "--oui"], io(null))).toBe(0);
    expect(read()).toEqual(CONFIG);
  });

  it("refusé par la personne, ou personne pour répondre : rien n'est touché", async () => {
    const { dir, io, read, lines } = setup();
    expect(await runInstall(["cursor"], io(false))).toBe(1);
    expect(await runInstall(["cursor"], io(null))).toBe(1);
    expect(read()).toEqual(CONFIG);
    expect(readdirSync(join(dir, ".cursor"))).toEqual(["mcp.json"]);
    expect(lines.join("\n")).toMatch(/run again with --yes/);
  });

  it("un JSON illisible, ou pas de fichier : code 3, rien n'est touché", async () => {
    const broken = setup("{ pas du json");
    expect(await runInstall(["cursor", "--oui"], broken.io(true))).toBe(3);
    expect(readFileSync(join(broken.dir, ".cursor", "mcp.json"), "utf8")).toBe("{ pas du json");
    const none = setup();
    expect(await runInstall(["cursor", "--fichier", "absent.json", "--oui"], none.io(true))).toBe(3);
  });

  it("le même serveur, encore déclaré sans Oathrion dans la configuration globale : la personne est prévenue", async () => {
    const { home, io, lines } = setup();
    mkdirSync(join(home, ".cursor"));
    writeFileSync(join(home, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { github: CONFIG.mcpServers.github } }));
    expect(await runInstall(["cursor", "--oui"], io(null))).toBe(0);
    expect(lines.join("\n")).toMatch(/"github" is also declared in .*\.cursor\/mcp\.json, without Oathrion/);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
  });
});

/* Vu le 9 novembre : un serveur distant s'affichait sans rien dans la liste de `npx oathrion`. */
describe("la liste des serveurs", () => {
  it("un serveur distant montre son adresse, sans identifiants, requête ni fragment", () => {
    expect(show({ url: "https://user:secret@mcp.example.com/v1/sse?token=abc#x" })).toBe("https://mcp.example.com/v1/sse");
    expect(show({ url: "https://mcp.example.com/" })).toBe("https://mcp.example.com");
    expect(show({ url: "not a url" })).toBe("(remote server)");
    expect(show({ command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] })).toBe("npx -y @modelcontextprotocol/server-memory");
  });
});
