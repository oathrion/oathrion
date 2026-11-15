/**
 * Les « portes » d'un agent : pour chaque outil, l'agent garde-t-il une route qui
 * contourne Oathrion ? — le verdict, partagé par le serveur et la console.
 *
 * Pour chaque outil, la personne DÉCLARE si l'agent détenait sa propre clé ; le SERVICE
 * dit, quand l'ancienne clé lui est présentée, si elle fonctionne encore. Le verdict
 * n'affirme « incontournable » QUE si chaque outil est sans clé déclarée ou vérifié mort.
 * Une révocation seulement déclarée est dite déclarée ; une clé encore vivante est une
 * porte ouverte, et l'emporte sur tout le reste.
 */

export type DoorCheckState = "alive" | "dead" | "unknown" | "placet";

export interface DoorCheck {
  state: DoorCheckState;
  detail: string;
}

export type Door =
  | { declared: "none" }
  | { declared: "revoked"; check: DoorCheck | null }
  | { declared: null };

export type DoorsVerdict = "locked" | "declared" | "open" | "incomplete";

export function doorsVerdict(doors: Record<string, Door>, tools: readonly string[]): DoorsVerdict {
  const states = tools.map((t) => doors[t] ?? ({ declared: null } as Door));
  if (states.some((d) => d.declared === "revoked" && d.check?.state === "alive")) return "open";
  if (tools.length === 0 || states.some((d) => d.declared === null)) return "incomplete";
  if (states.every((d) => d.declared === "none" || (d.declared === "revoked" && d.check?.state === "dead"))) return "locked";
  return "declared";
}
