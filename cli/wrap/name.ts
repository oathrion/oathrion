/**
 * Le nom d'un serveur enveloppé, déduit de sa commande quand `--name` n'est pas donné.
 *
 * Il sert dans les verbes (`mcp.<nom>.<outil>`), dans les cibles des règles
 * (`mcp://<nom>/…`) et dans le dossier d'état (`~/.oathrion/<nom>`). Il doit donc être
 * stable d'un lancement à l'autre et lisible dans la console :
 *
 *     npx -y @modelcontextprotocol/server-github   →  github
 *     uvx mcp-server-fetch                          →  fetch
 *     docker run -i --rm ghcr.io/github/github-mcp-server  →  github
 *     node ./outils/mon-serveur.js                  →  mon-serveur
 */

const LAUNCHERS = new Set(["npx", "bunx", "uvx", "pnpx", "pipx", "docker", "podman", "node", "python", "python3", "deno", "bun", "uv"]);
const SUBCOMMANDS = new Set(["run", "dlx", "exec", "x", "tool"]);
const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Le premier argument qui désigne le serveur lui-même, après le lanceur et ses options. */
function packageArgument(command: string, args: readonly string[]): string {
  if (!LAUNCHERS.has(basename(command).replace(/\.(exe|cmd)$/i, ""))) return command;
  for (const arg of args) {
    if (arg.startsWith("-")) continue;
    if (SUBCOMMANDS.has(arg)) continue;
    return arg;
  }
  return command;
}

export function deriveServerName(command: string, args: readonly string[]): string {
  let name = basename(packageArgument(command, args)).toLowerCase();
  name = name.replace(/@[^@/]*$/, ""); // une version : paquet@1.2.3
  name = name.replace(/:[^:]*$/, ""); // une étiquette d'image : image:latest
  name = name.replace(/\.(m?js|cjs|ts|py|exe)$/, "");
  name = name.replace(/^(mcp-server-|server-|mcp-)/, "").replace(/(-mcp-server|-mcp|-server)$/, "");
  name = name.replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "").slice(0, 63);
  return NAME.test(name) ? name : "server";
}

/** Le nom d'un serveur distant, tiré de son hôte (`mcp.linear.app` → `linear`). */
export function deriveRemoteName(raw: string): string {
  let host = "";
  try {
    host = new URL(raw).hostname;
  } catch {
    return "distant";
  }
  const generic = new Set(["mcp", "www", "api", "app", "com", "io", "dev", "net", "org", "ai", "co", "fr", "localhost"]);
  const label = host.split(".").find((part) => part !== "" && !generic.has(part) && !/^\d+$/.test(part));
  const name = (label ?? "remote").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 63);
  return NAME.test(name) ? name : "remote";
}

/** Un nom donné par `--name` : refusé s'il n'est pas utilisable, jamais corrigé en silence. */
export function nameProblem(name: string): string | null {
  return NAME.test(name) ? null : `"${name}": lowercase letters, digits, - and _, 63 characters at most.`;
}
