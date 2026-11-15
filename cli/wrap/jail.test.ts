/**
 * `oathrion jail` (`jail.ts`) : les montages de bubblewrap, et la commande que le relais enverra
 * au pivot pour chaque serveur configuré (le registre des serveurs connus).
 */
import { describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expectedSpec, firstTimeHint, jailArguments, jailEnvironment, projectSecretFiles, userNamespaceHelp } from "./jail";

const HOME = "/home/p";
const STATE = "/home/p/.oathrion/_local";
const present = new Set([
  "/home/p/projet",
  "/home/p/.cursor",
  "/home/p/.ssh",
  "/home/p/.aws",
  "/home/p/.aws/credentials.backup",
  "/home/p/.netrc",
  `${STATE}/port`,
  `${STATE}/relay.secret`,
  `${STATE}/session.secret`,
]);
const args = jailArguments({ home: HOME, cwd: "/home/p/projet", stateDir: STATE, marker: "/tmp/m/jailed", relaySecret: "/tmp/m/relay.secret", exists: (p) => present.has(p) });
/** Les cibles d'une option de montage, dans l'ordre. */
const targets = (option: string) => args.flatMap((a, i) => (a === option ? [args[i + (option === "--tmpfs" ? 1 : 2)]!] : []));

describe("les montages de la prison", () => {
  it("le système en lecture seule ; le projet et les dossiers de l'agent en écriture", () => {
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(targets("--bind").slice(0, 3)).toEqual(["/tmp", "/home/p/projet", "/home/p/.cursor"]);
    /* Le leurre de ~/.aws, en lecture-écriture : sur un montage en lecture seule, le fil-piège ne verrait pas qu'on le lit. */
    expect(targets("--bind").slice(3).every((t) => t.startsWith("/home/p/.aws/"))).toBe(true);
    expect(targets("--bind")).toHaveLength(4);
  });

  it("les secrets masqués, sauf le leurre, remonté par-dessus", () => {
    expect(targets("--tmpfs")).toEqual(expect.arrayContaining(["/home/p/.ssh", "/home/p/.aws"]));
    const netrc = args.indexOf("/home/p/.netrc");
    expect(args.slice(netrc - 2, netrc + 1)).toEqual(["--ro-bind", "/dev/null", "/home/p/.netrc"]);
    expect(args.lastIndexOf("/home/p/.aws/credentials.backup")).toBeGreaterThan(args.indexOf("/home/p/.aws"));
  });

  it("Oathrion masqué : seuls le port, le secret relais et le marqueur restent ; jamais le secret de session", () => {
    expect(targets("--tmpfs")).toContain("/home/p/.oathrion");
    const visible = targets("--ro-bind").filter((t) => t.startsWith(STATE));
    expect(visible).toEqual([`${STATE}/port`, `${STATE}/relay.secret`, `${STATE}/jailed`]);
    expect(args).not.toContain(`${STATE}/session.secret`);
    expect(args.slice(-5)).toEqual(["--chdir", "/home/p/projet", "--setenv", "OATHRION_JAILED", "1"]);
  });
});

describe("les prises de la session de bureau", () => {
  it("/run/user/<uid> masqué : l'agent SSH, celui de GPG et D-Bus (le trousseau) hors de portée", () => {
    const withRuntime = jailArguments({ home: HOME, cwd: "/home/p/projet", stateDir: STATE, marker: "/tmp/m/jailed", relaySecret: "/tmp/m/relay.secret", runtimeDir: "/run/user/1000", exists: (p) => p === "/run/user/1000" || present.has(p) });
    const at = withRuntime.indexOf("/run/user/1000");
    expect(withRuntime[at - 1]).toBe("--tmpfs");
  });
});

describe("l'environnement de l'agent enfermé", () => {
  const source = {
    PATH: "/usr/bin",
    GITHUB_TOKEN: "ghp_x",
    CURSOR_API_KEY: "k",
    SSH_AUTH_SOCK: "/run/user/1000/keyring/ssh",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    GDMSESSION: "ubuntu",
    DESKTOP_SESSION: "ubuntu",
    SESSION_MANAGER: "local/x:@/tmp/.ICE-unix/1",
    GNOME_DESKTOP_SESSION_ID: "this-is-deprecated",
    XAUTHORITY: "/run/user/1000/gdm/Xauthority",
  };

  it("les secrets retirés, et les prises qui mènent à des clés ; les noms de la session de bureau gardés", () => {
    const { env, removed, sockets } = jailEnvironment(source, new Set());
    expect(removed.sort()).toEqual(["CURSOR_API_KEY", "GITHUB_TOKEN"]);
    expect(sockets).toEqual(["your SSH agent", "your desktop's D-Bus (and its keyring)"]);
    expect(Object.keys(env).sort()).toEqual(["DESKTOP_SESSION", "GDMSESSION", "GNOME_DESKTOP_SESSION_ID", "PATH", "SESSION_MANAGER", "XAUTHORITY"]);
  });

  it("--keep-env garde ce que la personne nomme", () => {
    expect(jailEnvironment(source, new Set(["CURSOR_API_KEY"])).env.CURSOR_API_KEY).toBe("k");
  });
});

describe("les secrets du projet", () => {
  it(".env, .env.local, une clé : montrés vides ; un modèle, les dépendances et un leurre : laissés", () => {
    const project = mkdtempSync(join(tmpdir(), "oathrion-projet-"));
    for (const dir of ["api", "node_modules/pkg"]) mkdirSync(join(project, dir), { recursive: true });
    for (const file of [".env", ".env.local", ".env.example", "api/server.pem", "api/index.ts", "node_modules/pkg/.env", "README.md", ".env.leurre"]) writeFileSync(join(project, file), "x");
    const hidden = projectSecretFiles(project, new Set([join(project, ".env.leurre")]));
    expect(hidden).toEqual([join(project, ".env"), join(project, ".env.local"), join(project, "api", "server.pem")]);

    const mounts = jailArguments({ home: HOME, cwd: project, stateDir: STATE, marker: "/tmp/m/jailed", relaySecret: "/tmp/m/relay.secret", hiddenFiles: hidden, exists: () => true });
    /* Masqués APRÈS le montage du projet en écriture : sinon il les rendrait visibles. */
    expect(mounts.indexOf(join(project, ".env"))).toBeGreaterThan(mounts.indexOf(project));
    expect(mounts[mounts.indexOf(join(project, ".env")) - 1]).toBe("/dev/null");
  });
});

describe("bubblewrap refusé par le système", () => {
  it("Ubuntu (AppArmor) : le profil à poser soi-même, et comment le retirer", () => {
    const help = userNamespaceHelp("1");
    expect(help).toMatch(/do it yourself/);
    expect(help).toMatch(/userns,/);
    expect(help).toMatch(/apparmor_parser -R/);
    expect(userNamespaceHelp(null)).toMatch(/user namespaces/);
  });
});

describe("la commande attendue d'un serveur protégé", () => {
  it("un serveur local : la commande d'origine, après « -- »", () => {
    expect(expectedSpec({ command: "node", args: ["/x/oathrion.mjs", "wrap", "--name", "carnet", "--", "npx", "-y", "carnet-mcp"] })).toEqual({ name: "carnet", command: "npx", args: ["-y", "carnet-mcp"] });
  });

  it("un serveur distant : le pont d'Oathrion vers son adresse", () => {
    expect(expectedSpec({ command: "node", args: ["/x/oathrion.mjs", "wrap", "--name", "linear", "--url", "https://mcp.linear.app/mcp", "--transport", "http"] })).toEqual({
      name: "linear",
      command: "node",
      args: ["/x/oathrion.mjs", "bridge", "--url", "https://mcp.linear.app/mcp", "--transport", "http"],
    });
  });

  it("un serveur que rien ne protège : rien à inscrire", () => {
    expect(expectedSpec({ command: "npx", args: ["-y", "carnet-mcp"] })).toBeNull();
  });
});

describe("la première fois d'un agent dans la prison", () => {
  it("agy : l'indication sur sa connexion, une seule fois ; un agent sans indication : rien", () => {
    const state = mkdtempSync(join(tmpdir(), "oathrion-premiere-"));
    expect(firstTimeHint(state, "agy")).toMatch(/keyring, which the jail hides/);
    expect(firstTimeHint(state, "agy")).toBeNull();
    expect(firstTimeHint(state, "inconnu")).toBeNull();
    expect(firstTimeHint(state, "inconnu")).toBeNull();
  });
});

describe("le nom de l'agent, depuis son programme", () => {
  it("claude.exe (Claude Code installé par npm) est « claude » : la prison lui ouvre Anthropic", async () => {
    const { agentName } = await import("./jail");
    const { DEFAULT_HOSTS } = await import("./jail-net");
    expect(agentName("/home/p/.nvm/versions/node/v22/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe")).toBe("claude");
    expect(DEFAULT_HOSTS[agentName("/x/claude.exe")]).toContain("anthropic.com");
    expect(agentName("/usr/local/bin/cursor-agent")).toBe("cursor-agent");
    expect(agentName("C:\\Tools\\agy.CMD".split("\\").join("/"))).toBe("agy");
  });
});
