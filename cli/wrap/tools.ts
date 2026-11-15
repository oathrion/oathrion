/**
 * `oathrion tools list|accept --name <nom> [outil…]` — voir et accepter les définitions
 * d'outils d'un serveur enveloppé (`server/local-pins.ts`, étape E5).
 *
 *     oathrion tools list   --name github
 *     oathrion tools accept --name github create_issue      # un outil
 *     oathrion tools accept --name github                   # tous ceux qui attendent
 *
 * L'acceptation prend effet au PROCHAIN lancement de `oathrion wrap` : la liste annoncée à
 * l'agent est fixée au démarrage, et c'est voulu (une définition ne change pas en cours de
 * session sous les yeux du modèle).
 *
 * Codes de sortie : 0 · 1 des outils attendent un accord (`list`) · 3 usage.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { acceptTools, readPins, readSeen, reviewTools } from "../../server/local-pins";
import { HUB_DIRNAME } from "./hub";
import { stateRoot } from "./launch";
import { nameProblem } from "./name";

export const TOOLS_USAGE = `
oathrion tools list   --name <name>
oathrion tools accept --name <name> [tool…]

  A tool whose definition (description, schema, annotations) has changed since you last
  approved it, or which is new, is withdrawn from what the agent sees. "list" shows which
  ones; "accept" accepts them (all those waiting, without a tool name). The approval takes
  effect the next time oathrion wrap starts.
`;

export function runTools(argv: readonly string[], env: NodeJS.ProcessEnv, out: (l: string) => void, err: (l: string) => void): number {
  const [sub, ...rest] = argv;
  if (sub !== "list" && sub !== "accept") {
    err(TOOLS_USAGE);
    return 3;
  }
  let name: string | undefined;
  const tools: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--name") name = rest[++i];
    else if (rest[i]?.startsWith("--")) {
      err(`Unknown option: ${String(rest[i])}.${TOOLS_USAGE}`);
      return 3;
    } else tools.push(rest[i]!);
  }
  if (!name || nameProblem(name)) {
    err(`--name is required and must be a valid server name.${TOOLS_USAGE}`);
    return 3;
  }
  /* Le pivot local garde les définitions par serveur (`_local/serveurs/<nom>`) ; l'ancien dossier par serveur reste lu. */
  const hubServerDir = join(stateRoot(env), HUB_DIRNAME, "serveurs", name);
  const dir = existsSync(hubServerDir) ? hubServerDir : join(stateRoot(env), name);
  const pins = existsSync(dir) ? readPins(dir) : null;
  if (!pins) {
    err(`No fingerprint for "${name}": start it first with oathrion wrap.`);
    return 3;
  }

  if (sub === "list") {
    if (tools.length > 0) {
      err(`"list" takes no tool name.${TOOLS_USAGE}`);
      return 3;
    }
    const seen = readSeen(dir);
    const reviews = reviewTools(seen.map((tool) => ({ name: tool.name, raw: tool.definition })), pins);
    const label = { accepted: "accepted", changed: "CHANGED — withdrawn", new: "NEW — withdrawn" } as const;
    for (const review of reviews.sort((a, b) => a.name.localeCompare(b.name))) {
      out(
        `${review.status === "accepted" ? "  " : "! "}${review.name.padEnd(32)} ${label[review.status]}` +
          (review.changedFields.length > 0 ? ` (${review.changedFields.join(", ")})` : ""),
      );
    }
    const waiting = reviews.filter((review) => review.status !== "accepted").length;
    out(waiting === 0 ? "Every tool seen at the last launch is accepted." : `${String(waiting)} tool(s) waiting for your approval: oathrion tools accept --name ${name} <tool>`);
    return waiting === 0 ? 0 : 1;
  }

  try {
    const accepted = acceptTools(dir, tools);
    out(accepted.length === 0 ? "Nothing was waiting for approval." : `Accepted: ${accepted.join(", ")}. Takes effect the next time oathrion wrap starts.`);
    return 0;
  } catch (error) {
    err(error instanceof Error ? error.message : String(error));
    return 3;
  }
}
