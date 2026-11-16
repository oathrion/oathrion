/**
 * LE FIL D'ACTUALITÉ DE LA CONSOLE LOCALE (11 novembre : « dans la console nous devons penser à
 * un fil d'actualité, et enlever tout ce qui rend l'expérience complexe »). Ce qui s'est passé,
 * en phrases simples, avec la mascotte de l'agent : les événements du pivot (`local-events.ts`),
 * les demandes tranchées, et les actions des agents — les actions ordinaires regroupées par agent
 * et par heure (« Nova did 12 things through Oathrion »), pour ne pas noyer le fil.
 *
 * Deux textes par élément : `title`, pour la personne (avec ce qu'elle a besoin de savoir), et
 * `share`, pour ce qu'elle partage — JAMAIS un chemin, un nom de fichier, une commande, un numéro
 * de processus, un nom de serveur ou d'utilisateur.
 */
import { describeApproval, notificationWords } from "@shared/approval-text";
import type { Approval, Execution } from "@shared/types";

import type { LocalEvent } from "./local-events";
import { defaultMascot } from "./local-mascots";

export interface FeedItem {
  id: string;
  at: string;
  agent: string;
  mascot: { id: string; name: string };
  /** good : protégé, approuvé ; warn : en pause, à décider ; bad : bloqué, leurre lu ; info : le reste. */
  tone: "good" | "warn" | "bad" | "info";
  title: string;
  /** Privé : affiché dans la console seulement. */
  detail?: string;
  /** Le texte à partager : rien de privé. */
  share: string;
}

/** Le visage d'un agent : la mascotte et le nom que la personne lui a donnés, sinon ceux d'office. */
export type Face = (agent: string) => { id: string; name: string };

const defaultFace: Face = (agent) => {
  const mascot = defaultMascot(agent);
  return { id: mascot.id, name: mascot.name };
};

const whoWith = (face: Face) => (agent: string) => {
  const mascot = face(agent);
  return { mascot: { id: mascot.id, name: mascot.name }, label: `${mascot.name} (${agent})` };
};

/** « mcp.fichiers.write_file » → « write file » ; le serveur et la cible restent privés. */
const actionWords = (action: string) => (action.split(".").pop() ?? action).replace(/_/g, " ");

/** La phrase à partager d'un événement (la notification la porte) ; rien de privé. */
export function shareOf(event: LocalEvent): string | undefined {
  return fromEvent(event)?.share;
}

function fromEvent(event: LocalEvent, face: Face = defaultFace): FeedItem | null {
  const who = whoWith(face);
  const { mascot, label } = who(event.agent);
  const base = { id: event.id, at: event.at, agent: event.agent, mascot, ...(event.detail ? { detail: event.detail } : {}) };
  switch (event.kind) {
    case "paused":
      return { ...base, tone: "warn", title: `${label} was paused: it was running without Oathrion's protection.`, share: `Oathrion caught my AI agent ${event.agent} running outside its jail, and paused it until I decided.` };
    case "reported":
      return { ...base, tone: "warn", title: `${label} is running without Oathrion's protection.`, share: `Oathrion told me my AI agent ${event.agent} was running outside its jail.` };
    case "resumed-once":
      return { ...base, tone: "info", title: `You let ${label} go on, this time only.`, share: `Oathrion paused my AI agent ${event.agent}; I let it go on, this time only.` };
    case "allowed":
      return { ...base, tone: "info", title: `You let ${label} run without Oathrion's protection, from now on.`, share: `I allowed my AI agent ${event.agent} outside Oathrion's jail.` };
    case "forgotten":
      return { ...base, tone: "good", title: `${label} must run with Oathrion's protection again.`, share: `My AI agent ${event.agent} now has to ask again, under Oathrion.` };
    case "stopped":
      return { ...base, tone: "good", title: `You stopped ${label}.`, share: `Oathrion caught my AI agent ${event.agent} acting where it should not, and I stopped it in one click.` };
    case "new-agent":
      return { ...base, tone: "warn", title: `First time Oathrion met ${event.agent}: it waited for your yes.`, share: `A program Oathrion had never seen wanted to act on my computer: it was stopped at the door until I said yes.` };
    case "trusted":
      return { ...base, tone: "good", title: `You confirmed ${label}: it is yours.`, share: `Oathrion checked that ${event.agent} is really my AI agent before letting it act.` };
    case "blocked":
      return { ...base, tone: "bad", title: `You blocked ${label}.`, share: `A program tried to act on my computer as an AI agent; Oathrion stopped it at the door, and I blocked it.` };
    case "decoy":
      return { ...base, tone: "bad", title: "Something read one of your decoys: no honest task does that.", share: "Something read one of the fake secrets Oathrion laid on my computer, and Oathrion told me at once." };
    default:
      return null;
  }
}

function fromApproval(approval: Approval, face: Face = defaultFace): FeedItem | null {
  const who = whoWith(face);
  if (approval.status !== "approved" && approval.status !== "rejected") return null;
  const execution = approval.executionId ?? approval.id;
  const { mascot, label } = who(approval.agentName);
  const at = approval.resolvedAt ?? approval.requestedAt;
  const approved = approval.status === "approved";
  /*
   * Ce qui était demandé, dit comme la console (16 novembre : la ligne montrait
   * « mcp.carnet.create note · mcp://carnet/create_note »), et qui a tranché.
   */
  const text = describeApproval(approval);
  const asked = [text.headline.replace(/^.*? wants to /, ""), text.where].filter(Boolean).join(" ");
  const content = notificationWords(approval, null).content;
  const byPass = approval.resolvedBy?.startsWith("your 1-hour permission") === true;
  return {
    id: `apr_${execution}`,
    at,
    agent: approval.agentName,
    mascot,
    tone: approved ? "good" : "bad",
    title: approved ? `${label} asked to ${asked}; ${byPass ? "your 1-hour permission approved it" : "you approved"}.` : `${label} asked to ${asked}; you refused.`,
    ...(content ? { detail: `“${content}”` } : {}),
    share: approved ? `My AI agent ${approval.agentName} asked me before acting, and only went on once I said yes.` : `My AI agent ${approval.agentName} asked me before acting; I said no, and nothing happened.`,
  };
}

/** Les actions des agents : les refus un par un ; le reste, regroupé par agent et par heure. */
function fromExecutions(executions: Execution[], face: Face = defaultFace): FeedItem[] {
  const who = whoWith(face);
  const items: FeedItem[] = [];
  const groups = new Map<string, { agent: string; at: string; count: number; kinds: Set<string> }>();
  for (const execution of executions) {
    if (execution.status === "pending") continue;
    /* Refusée par la personne : la ligne « you refused » de la demande le dit déjà ; pas un second « Oathrion blocked ». */
    if (execution.status === "blocked" && execution.approvalId) continue;
    if (execution.status === "blocked") {
      const { mascot, label } = who(execution.agentName);
      items.push({
        id: `exe_${execution.id}`,
        at: execution.timestamp,
        agent: execution.agentName,
        mascot,
        tone: "bad",
        title: `Oathrion blocked ${label}: ${actionWords(execution.action)}.`,
        /* Pourquoi : la raison de la décision, pas l'identifiant technique de l'action. */
        detail: execution.decisionReason || `${execution.action} · ${execution.target}`,
        share: `Oathrion blocked an action of my AI agent ${execution.agentName} before it ran.`,
      });
      continue;
    }
    const hour = execution.timestamp.slice(0, 13);
    const key = `${execution.agentName}|${hour}`;
    const group = groups.get(key) ?? { agent: execution.agentName, at: execution.timestamp, count: 0, kinds: new Set<string>() };
    group.count += 1;
    group.kinds.add(actionWords(execution.action));
    if (execution.timestamp > group.at) group.at = execution.timestamp;
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const { mascot, label } = who(group.agent);
    const kinds = [...group.kinds].slice(0, 3).join(", ");
    items.push({
      id: `grp_${key}`,
      at: group.at,
      agent: group.agent,
      mascot,
      tone: "info",
      title: `${label} did ${group.count === 1 ? "one thing" : `${String(group.count)} things`} through Oathrion: ${kinds}.`,
      share: `My AI agent ${group.agent} worked through Oathrion: ${group.count === 1 ? "one action" : `${String(group.count)} actions`}, each with a signed receipt.`,
    });
  }
  return items;
}

/* Deux éléments qui disent la même chose à moins de dix minutes d'écart n'en font qu'un. */
const SAME_WINDOW_MS = 10 * 60_000;

/** Le fil : le plus récent d'abord ; les répétitions regroupées (« · 5 times »). */
export function buildFeed(input: { events: LocalEvent[]; approvals: Approval[]; executions: Execution[]; face?: Face }, limit = 100): FeedItem[] {
  const face = input.face ?? defaultFace;
  const items = [...input.events.map((event) => fromEvent(event, face)), ...input.approvals.map((approval) => fromApproval(approval, face))].filter((i): i is FeedItem => i !== null);
  items.push(...fromExecutions(input.executions, face));
  items.sort((a, b) => b.at.localeCompare(a.at));
  const merged: (FeedItem & { times: number; oldest: string })[] = [];
  for (const item of items) {
    const last = merged.at(-1);
    if (last && last.title === item.title && Date.parse(last.oldest) - Date.parse(item.at) <= SAME_WINDOW_MS) {
      last.times += 1;
      last.oldest = item.at;
      continue;
    }
    merged.push({ ...item, times: 1, oldest: item.at });
  }
  return merged.slice(0, limit).map(({ times, oldest: _oldest, ...item }) => (times > 1 ? { ...item, title: `${item.title.replace(/\.$/, "")} · ${String(times)} times.` } : item));
}
