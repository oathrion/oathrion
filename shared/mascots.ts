/**
 * QUELLE MASCOTTE POUR QUEL AGENT : la règle seule, partagée par le pivot (notifications, fil)
 * et la console (page des agents). Les dessins et leurs couleurs restent dans
 * `server/local-mascots.ts` ; les illustrations dans `client/public/mascots/<id>.png`.
 */
export const MASCOT_NAMES = {
  ember: "Ember",
  pixel: "Pixel",
  nova: "Nova",
  bolt: "Bolt",
  echo: "Echo",
  orbit: "Orbit",
  shade: "Shade",
  warden: "Warden",
} as const;

export type MascotId = keyof typeof MASCOT_NAMES;

/**
 * LA FAMILLE d'un agent : ce qui le désigne, quel que soit le nom sous lequel il se montre
 * (« Claude Code » comme client MCP, « claude » comme processus). La mascotte et le nom choisis
 * par la personne valent pour toute la famille.
 */
export function agentFamily(agent: string): string {
  const name = agent.toLowerCase();
  for (const [family, test] of [
    ["claude", /claude/],
    ["cursor", /cursor/],
    ["antigravity", /agy|antigravity/],
    ["codex", /codex/],
    ["gemini", /gemini/],
    ["aider", /aider/],
    ["goose", /goose/],
    ["opencode", /opencode/],
  ] as const) {
    if (test.test(name)) return family;
  }
  return name.trim().replace(/\s+/g, " ");
}

/** Les mascottes que la personne peut donner à un agent (Warden reste celle d'Oathrion). */
export const CHOOSABLE_MASCOTS: readonly MascotId[] = (Object.keys(MASCOT_NAMES) as MascotId[]).filter((id) => id !== "warden");

/** Le nom qu'une personne donne à son agent : court, lisible, sans rien qui casse un affichage. */
export function cleanAgentNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  /* Sans caractère de contrôle ni ce qui casserait un affichage (< > & "). */
  const kept = [...raw.normalize("NFC")].filter((c) => c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) !== 0x7f && !'<>&"'.includes(c)).join("");
  const name = kept.replace(/\s+/g, " ").trim();
  return name.length > 0 && name.length <= 24 ? name : null;
}

/** La mascotte d'office d'un agent, par famille ; « shade » pour un programme inconnu et pour ce qui lit un leurre, « warden » pour Oathrion lui-même. */
export function mascotIdFor(agent: string): MascotId {
  const name = agent.toLowerCase();
  if (/claude/.test(name)) return "ember";
  if (/cursor/.test(name)) return "pixel";
  if (/agy|antigravity/.test(name)) return "nova";
  if (/codex/.test(name)) return "bolt";
  if (/gemini/.test(name)) return "echo";
  if (/aider|goose|opencode/.test(name)) return "orbit";
  if (/oathrion|feedback/.test(name)) return "warden";
  return "shade";
}

/**
 * La couleur de chaque mascotte (la maquette du 11 novembre, `notes/DESIGN-NOTIFICATIONS.md`) :
 * principale, éclat, profonde, halo. La fenêtre de notification (`popup.ts`) porte les mêmes.
 */
export const MASCOT_ACCENTS: Record<MascotId, { main: string; highlight: string; deep: string; glow: string }> = {
  ember: { main: "#FF812E", highlight: "#FFB45C", deep: "#D94D22", glow: "rgba(255,129,46,.45)" },
  pixel: { main: "#398BFF", highlight: "#65D8FF", deep: "#2546D8", glow: "rgba(57,139,255,.45)" },
  nova: { main: "#963EFF", highlight: "#DF64FF", deep: "#5935D9", glow: "rgba(150,62,255,.5)" },
  bolt: { main: "#43D66B", highlight: "#B8F45A", deep: "#168B56", glow: "rgba(67,214,107,.4)" },
  echo: { main: "#19CFCB", highlight: "#76F5F0", deep: "#087E97", glow: "rgba(25,207,203,.45)" },
  orbit: { main: "#FFC343", highlight: "#FFE98C", deep: "#DE8B20", glow: "rgba(255,195,67,.42)" },
  shade: { main: "#A7B0C5", highlight: "#E0E4F0", deep: "#697389", glow: "rgba(167,176,197,.35)" },
  warden: { main: "#505CFF", highlight: "#7AABFF", deep: "#272D9C", glow: "rgba(80,92,255,.5)" },
};

/** Un leurre lu : le rouge, sans changer la mascotte. */
export const DANGER_ACCENT = { main: "#FF334F", highlight: "#FF6679", deep: "#B91E3B", glow: "rgba(255,52,79,.4)" };
