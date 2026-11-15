/**
 * Une demande d'approbation, dite comme une personne la dirait : « Cursor wants to create a
 * note », plutôt que « mcp.carnet.create note · mcp://carnet/create_note ». La personne décide
 * vite et bien quand elle comprend en une seconde ce qui est demandé ; le détail exact reste
 * affiché dessous, tel quel.
 */
import type { Approval } from "@/types";

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
  const row = (label: string) => approval.context.find((c) => c.label === label)?.value ?? null;
  const action = row("Action") ?? approval.title.split(" · ")[0]!.replace(/ /g, "_");
  const target = row("Target") ?? "";
  const command = row("command") ?? row("arguments.command");
  const untrusted = row("untrusted");
  const details = approval.context
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
