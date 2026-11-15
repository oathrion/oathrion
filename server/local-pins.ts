/**
 * L'EMPREINTE DES DÉFINITIONS D'OUTILS — `oathrion wrap`, étape E5.
 *
 * ## L'attaque
 *
 * Un serveur MCP déclare ses outils : un nom, une description, un schéma. Le modèle lit la
 * description pour décider quoi appeler et comment. Un serveur — mis à jour, compromis, ou
 * malveillant dès le départ et patient — peut CHANGER une définition après qu'on l'a
 * adopté : une description qui glisse des instructions au modèle (« empoisonnement
 * d'outil »), un schéma qui réclame un champ de plus, un outil nouveau au nom anodin. Le
 * client, lui, relit la liste à chaque démarrage et ne dit rien.
 *
 * ## La défense
 *
 *   · Au PREMIER lancement d'un serveur, ses définitions sont épinglées : confiance au
 *     premier usage, dite comme telle.
 *   · Aux lancements suivants, un outil dont la définition a changé, ou qui est nouveau,
 *     est RETIRÉ de ce que l'agent voit, jusqu'à ce qu'une personne l'accepte
 *     (`oathrion tools accept`). Retiré et non « soumis à approbation » : l'empoisonnement
 *     est dans la DESCRIPTION, et la montrer au modèle, même sous approbation, serait déjà
 *     lui faire lire l'instruction.
 *   · En cours de session, la définition que voit l'agent est celle du démarrage, servie par
 *     Oathrion : une redéfinition annoncée par l'enfant en route n'atteint pas le modèle.
 *
 * ## Ce que l'empreinte couvre, et ce qu'elle ne peut pas couvrir
 *
 * Elle couvre ce que l'enfant DÉCLARE : nom, titre, description, schémas, annotations. Elle
 * ne peut rien contre un enfant qui garde la même déclaration et change son COMPORTEMENT —
 * c'est là le rôle des règles et des approbations, pas de l'empreinte.
 *
 * Les fichiers vivent dans le dossier d'état du serveur, en 0600 :
 *   · `outils-acceptes.json` — les empreintes acceptées ;
 *   · `outils-vus.json`      — les définitions vues au dernier lancement, pour que
 *                             `oathrion tools list` montre ce qui attend un accord.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Les champs d'une définition qui comptent. `_meta`, propre au fournisseur, est exclu. */
const FINGERPRINTED = ["name", "title", "description", "inputSchema", "outputSchema", "annotations"] as const;

export interface ToolDefinition {
  name: string;
  raw: Record<string, unknown>;
}

export interface SeenTool {
  name: string;
  fingerprint: string;
  definition: Record<string, unknown>;
}

export interface PinFile {
  server: string;
  acceptedAt: string;
  tools: Record<string, { fingerprint: string; definition: Record<string, unknown>; acceptedAt: string }>;
}

export type ToolStatus = "accepted" | "changed" | "new";

export interface ToolReview {
  name: string;
  status: ToolStatus;
  /** Pour un outil modifié : les champs dont la valeur a changé. */
  changedFields: string[];
}

/** Une sérialisation stable : les clés d'objet triées, à toute profondeur. */
function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

/** Ce qui est empreint d'une définition. */
export function definitionOf(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of FINGERPRINTED) if (raw[field] !== undefined) out[field] = raw[field];
  return out;
}

export function fingerprintOf(raw: Record<string, unknown>): string {
  return createHash("sha256").update(stable(definitionOf(raw)), "utf8").digest("hex");
}

const PINS = "outils-acceptes.json";
const SEEN = "outils-vus.json";

export function readPins(stateDir: string): PinFile | null {
  const file = join(stateDir, PINS);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf8")) as PinFile;
}

function writePins(stateDir: string, pins: PinFile): void {
  writeFileSync(join(stateDir, PINS), `${JSON.stringify(pins, null, 2)}\n`, { mode: 0o600 });
}

export function readSeen(stateDir: string): SeenTool[] {
  const file = join(stateDir, SEEN);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as SeenTool[]) : [];
}

/** Compare ce que l'enfant déclare à ce qui a été accepté. */
export function reviewTools(tools: readonly ToolDefinition[], pins: PinFile): ToolReview[] {
  return tools.map((tool) => {
    const pinned = pins.tools[tool.name];
    if (!pinned) return { name: tool.name, status: "new" as const, changedFields: [] };
    if (pinned.fingerprint === fingerprintOf(tool.raw)) return { name: tool.name, status: "accepted" as const, changedFields: [] };
    const now = definitionOf(tool.raw);
    const fields = FINGERPRINTED.filter((field) => stable(now[field]) !== stable(pinned.definition[field]));
    return { name: tool.name, status: "changed" as const, changedFields: [...fields] };
  });
}

/**
 * Au lancement : épingle tout la première fois, puis ne rend que les outils acceptés.
 * Écrit toujours `outils-vus.json`, pour que la personne puisse voir ce qui attend.
 */
export function selectAcceptedTools<T extends ToolDefinition>(
  server: string,
  stateDir: string,
  tools: readonly T[],
  now: string = new Date().toISOString(),
): { accepted: T[]; held: ToolReview[]; firstLaunch: boolean } {
  const seen: SeenTool[] = tools.map((tool) => ({ name: tool.name, fingerprint: fingerprintOf(tool.raw), definition: definitionOf(tool.raw) }));
  writeFileSync(join(stateDir, SEEN), `${JSON.stringify(seen, null, 2)}\n`, { mode: 0o600 });

  const pins = readPins(stateDir);
  if (!pins) {
    writePins(stateDir, {
      server,
      acceptedAt: now,
      tools: Object.fromEntries(seen.map((tool) => [tool.name, { fingerprint: tool.fingerprint, definition: tool.definition, acceptedAt: now }])),
    });
    return { accepted: [...tools], held: [], firstLaunch: true };
  }
  const reviews = reviewTools(tools, pins);
  const held = reviews.filter((review) => review.status !== "accepted");
  const heldNames = new Set(held.map((review) => review.name));
  return { accepted: tools.filter((tool) => !heldNames.has(tool.name)), held, firstLaunch: false };
}

/**
 * Accepte des outils tels qu'ils ont été vus au dernier lancement (`names` vide : tous ceux
 * qui attendent). Rend les noms acceptés ; un nom inconnu est une erreur, pas un silence.
 */
export function acceptTools(stateDir: string, names: readonly string[], now: string = new Date().toISOString()): string[] {
  const pins = readPins(stateDir);
  if (!pins) throw new Error("No fingerprint: this server was never started by oathrion wrap.");
  const seen = readSeen(stateDir);
  const reviews = reviewTools(seen.map((tool) => ({ name: tool.name, raw: tool.definition })), pins);
  const waiting = reviews.filter((review) => review.status !== "accepted").map((review) => review.name);
  const chosen = names.length === 0 ? waiting : [...names];
  for (const name of chosen) {
    if (!seen.some((tool) => tool.name === name)) throw new Error(`"${name}" was not seen at the last launch.`);
  }
  for (const name of chosen) {
    const tool = seen.find((candidate) => candidate.name === name)!;
    pins.tools[name] = { fingerprint: tool.fingerprint, definition: tool.definition, acceptedAt: now };
  }
  writePins(stateDir, pins);
  return chosen;
}
