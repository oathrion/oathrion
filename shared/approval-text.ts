/**
 * Une demande d'approbation, dite comme une personne la dirait : « Cursor wants to create a
 * note », plutôt que « mcp.carnet.create note · mcp://carnet/create_note ». La personne décide
 * vite et bien quand elle comprend en une seconde ce qui est demandé ; le détail exact reste
 * affiché dessous, tel quel. Partagé (16 novembre) : la notification dit la même chose que la
 * console (`server/notifications/desktop.ts`).
 */
import { friendlyAsk, type FriendlyAsk } from "./friendly-words";
import type { Approval } from "./types";

export interface ApprovalText {
  /** « Cursor wants to create note ». */
  headline: string;
  /** « on the carnet server », ou null. */
  where: string | null;
  /** Une commande ou un chemin, à montrer en entier. */
  command: string | null;
  /** Les arguments, sans les lignes déjà dites (action, cible, commande). */
  details: { label: string; value: string }[];
  /** La session a lu du contenu non fiable : la source (« WebFetch evil.example, at 10:42 UTC »). */
  untrusted: string | null;
}

/* Les premiers mots qui se lisent comme un verbe : « wants to create … ». Sinon : « wants to use … ». */
const VERBS = new Set(["add", "append", "archive", "cancel", "charge", "close", "comment", "copy", "create", "delete", "deploy", "drop", "edit", "execute", "insert", "invite", "merge", "move", "pay", "post", "publish", "push", "refund", "remove", "rename", "reply", "run", "send", "set", "transfer", "update", "upload", "write"]);

function phrase(tool: string): string {
  const words = tool.replace(/[_-]+/g, " ").trim();
  return VERBS.has(words.split(" ")[0]!.toLowerCase()) ? words : `use ${tool}`;
}

export function describeApproval(approval: Pick<Approval, "agentName" | "title" | "context" | "requestedValue">): ApprovalText {
  /* Une demande sans contexte (anciennes, ou de démonstration) : rien d'autre que le titre. */
  const context = approval.context ?? [];
  const row = (label: string) => context.find((c) => c.label === label)?.value ?? null;
  const action = row("Action") ?? approval.title.split(" · ")[0]!.replace(/ /g, "_");
  const target = row("Target") ?? "";
  const command = row("command") ?? row("arguments.command");
  const untrusted = row("untrusted");
  const details = context
    .filter((c) => !["Action", "Target", "command", "arguments.command", "reason", "untrusted", "from"].includes(c.label))
    .map((c) => ({ label: c.label.replace(/^arguments\./, ""), value: c.value }));

  if (action.startsWith("mcp.claude-code.")) {
    const file = action.endsWith(".file_write");
    return {
      headline: `${approval.agentName} wants to ${file ? "write a file" : "run a command"}`,
      where: "with its own tools, in auto mode",
      command: file ? target.replace(/^file:\/\//, "") : command,
      details,
      untrusted,
    };
  }
  const mcp = /^mcp\.([^.]+)\.(.+)$/.exec(action);
  if (mcp) return { headline: `${approval.agentName} wants to ${phrase(mcp[2]!)}`, where: `on the ${mcp[1]!} server`, command, details, untrusted };
  /* Une action d'équipe (« payment.refund ») : le montant demandé, s'il y en a un, fait partie de la phrase. */
  const amount = approval.requestedValue && approval.requestedValue !== target ? ` · ${approval.requestedValue}` : "";
  const last = action.split(".").pop() ?? action;
  return { headline: `${approval.agentName} wants to ${phrase(last)}${amount}`, where: target ? `on ${target}` : null, command, details, untrusted };
}

/**
 * Ce que la NOTIFICATION dit d'une demande (16 novembre, retour des premiers testeurs : « on ne
 * comprend pas la notification, alors on approuve sans regarder ») : qui veut faire quoi, sur
 * quoi exactement, et pourquoi Oathrion demande. Une ligne chacun.
 */
export interface NotificationWords {
  /** « claude-code wants to create note on the carnet server ». */
  headline: string;
  /** Ce qui est fait au juste : la commande, le fichier, ou les arguments ; null s'il n'y a rien. */
  content: string | null;
  /** Pourquoi on vous demande : la règle, ou la session qui a lu du contenu non fiable. */
  why: string | null;
  /** La même demande, dite par l'agent comme un ami (`shared/friendly-words.ts`) : la question, ce que ça change, le code. */
  friendly?: FriendlyAsk;
}

/** La demande dite par l'agent comme un ami : « Can I publish your code to the shared repository? ». */
export function friendlyApproval(approval: Pick<Approval, "agentName" | "title" | "context" | "requestedValue">): FriendlyAsk {
  const context = approval.context ?? [];
  const row = (label: string) => context.find((c) => c.label === label)?.value ?? null;
  const text = describeApproval(approval);
  const shown = text.details.filter((d) => d.value.trim() !== "");
  const content = text.command ?? (shown.length === 1 ? shown[0]!.value : shown.length > 1 ? shown.map((d) => `${d.label}: ${d.value}`).join(" · ") : null);
  return friendlyAsk({
    action: row("Action") ?? approval.title.split(" · ")[0]!.replace(/ /g, "_"),
    target: row("Target"),
    command: row("command") ?? row("arguments.command"),
    reason: row("reason"),
    untrusted: row("untrusted"),
    content: content ? (content.length > 160 ? `${content.slice(0, 157)}…` : content) : null,
  });
}

export function notificationWords(approval: Pick<Approval, "agentName" | "title" | "context" | "requestedValue">, policyName: string | null): NotificationWords {
  const text = describeApproval(approval);
  const reason = (approval.context ?? []).find((c) => c.label === "reason")?.value.replace(/^Oathrion:\s*/, "") ?? null;
  const shown = text.details.filter((d) => d.value.trim() !== "");
  const content =
    text.command ??
    (shown.length === 1 ? shown[0]!.value : shown.length > 1 ? shown.map((d) => `${d.label}: ${d.value}`).join(" · ") : null);
  /* La règle se cite entre guillemets : « Why: your rule “carnet: every write waits for approval” ». */
  const why = text.untrusted ? `this session read content from outside (${text.untrusted})` : (reason ?? (policyName ? `your rule “${policyName}”` : null));
  return {
    headline: [text.headline, text.where].filter(Boolean).join(" "),
    content: content ? (content.length > 160 ? `${content.slice(0, 157)}…` : content) : null,
    why: why ? why.replace(/\.$/, "") : null,
    friendly: friendlyApproval(approval),
  };
}
