/**
 * PROTÉGÉ, ET ANGLES MORTS — ce qu'Oathrion couvre réellement, agent par agent, sur cette machine.
 *
 * La promesse dit « Oathrion s'interpose sur chaque action ». Ce n'est vrai que de ce qui passe
 * par lui : cet écran le dit sans arrondir. Pour chaque client trouvé (Claude Code, Cursor,
 * Claude Desktop), chaque porte par laquelle son agent agit, dans l'un de quatre états :
 *
 *   · `protected` — un serveur MCP derrière Oathrion : lectures, écritures sur approbation,
 *     destructions bloquées, et un reçu pour chaque action ;
 *   · `checked`   — le shell et les écritures de Claude Code, jugés par les règles locales du
 *     hook (la ligne de commande telle qu'écrite, pas ce qu'elle fera) ;
 *   · `bypasses`  — à côté d'Oathrion, mais `npx oathrion` sait l'y mettre ;
 *   · `blind`     — Oathrion ne le voit pas, et aucune commande ne change ça aujourd'hui.
 *
 * Fonction pure : la route (`/api/local/protection`) lui passe ce qu'elle a lu sur le disque.
 */

export type Coverage = "protected" | "checked" | "bypasses" | "blind";

export interface ProtectionItem {
  /** La porte : un serveur MCP (son nom), ou un outil du client (« Shell and file edits »). */
  what: string;
  kind: "mcp-server" | "built-in";
  coverage: Coverage;
  /** Où c'est configuré (« Claude Code · all your projects »), pour un serveur. */
  where: string | null;
  why: string;
  /** La commande qui change l'état, quand il y en a une. */
  fix: string | null;
}

export interface AgentProtection {
  client: Client;
  items: ProtectionItem[];
}

export type Client = "Claude Code" | "Cursor" | "Claude Desktop";

export interface ProtectionInput {
  /** Les clients présents sur la machine (leur dossier existe), même sans serveur MCP. */
  clients: readonly Client[];
  servers: readonly { client: Client; where: string; name: string; config: Record<string, unknown>; wrapped: boolean }[];
  /** Les hooks de Claude Code : pour tous les projets (`~/.claude/settings.json`), et projet par projet. */
  hooks: { allProjects: boolean; projects: readonly string[] };
}

export const PROTECT = "npx oathrion";

const PROTECTED_WHY = "Reads go through, writes wait for your approval, destructive tools are blocked. Every action gets a receipt.";

function serverItem(server: ProtectionInput["servers"][number]): ProtectionItem {
  const base = { what: server.name, kind: "mcp-server" as const, where: server.where };
  if (server.wrapped) return { ...base, coverage: "protected", why: PROTECTED_WHY, fix: null };
  const headers = server.config.headers !== null && typeof server.config.headers === "object" && Object.keys(server.config.headers as object).length > 0;
  if (typeof server.config.url === "string" && !headers) {
    return { ...base, coverage: "blind", why: `Remote, with its sign-in (OAuth) handled by ${server.client}: Oathrion cannot sit in front of it yet.`, fix: null };
  }
  return { ...base, coverage: "bypasses", why: "Your agent uses it directly: nothing is asked of you, nothing is written to the log.", fix: PROTECT };
}

function builtIns(client: Client, hooks: ProtectionInput["hooks"]): ProtectionItem[] {
  const item = (what: string, coverage: Coverage, why: string, fix: string | null = null): ProtectionItem => ({ what, kind: "built-in", coverage, where: null, why, fix });
  if (client === "Claude Code") {
    const rules =
      "Checked by Oathrion's local rules: obviously dangerous commands are refused, git push and publishing are asked. In auto mode, Oathrion asks you itself. The rules read the command line, not what a script will do.";
    const shell = hooks.allProjects
      ? item("Shell and file edits", "checked", rules)
      : hooks.projects.length > 0
        ? item("Shell and file edits", "bypasses", `Checked only in ${hooks.projects.join(", ")}. In your other projects, Claude Code runs them without Oathrion.`, PROTECT)
        : item("Shell and file edits", "bypasses", "Claude Code runs commands and writes files without Oathrion: only its own permission prompts apply.", PROTECT);
    return [shell, item("File reads, web fetches and searches", "blind", "Claude Code's own reads are not intercepted: Oathrion neither sees nor records them.")];
  }
  if (client === "Cursor") {
    return [item("Terminal and file edits", "blind", "Cursor's own tools do not go through Oathrion. Keep Cursor's approval for terminal commands on.")];
  }
  return [
    item("Extensions installed from Claude Desktop", "blind", "Extensions added from Claude Desktop's settings are not in its configuration file: Oathrion does not see them."),
    item("Connectors added in Claude's settings", "blind", "Connectors enabled in Claude (claude.ai) run at Anthropic, not on this machine: Oathrion cannot see them."),
  ];
}

const ORDER: Record<Coverage, number> = { bypasses: 0, blind: 1, checked: 2, protected: 3 };

export function protectionReport(input: ProtectionInput): { agents: AgentProtection[]; counts: Record<Coverage, number> } {
  const clients = (["Claude Code", "Cursor", "Claude Desktop"] as const).filter(
    (client) => input.clients.includes(client) || input.servers.some((server) => server.client === client),
  );
  const agents = clients.map((client) => ({
    client,
    /* Ce qui demande une action d'abord : à côté, puis invisible, puis couvert. */
    items: [...input.servers.filter((s) => s.client === client).map(serverItem), ...builtIns(client, input.hooks)].sort((a, b) => ORDER[a.coverage] - ORDER[b.coverage]),
  }));
  const counts: Record<Coverage, number> = { protected: 0, checked: 0, bypasses: 0, blind: 0 };
  for (const agent of agents) for (const item of agent.items) counts[item.coverage] += 1;
  return { agents, counts };
}
