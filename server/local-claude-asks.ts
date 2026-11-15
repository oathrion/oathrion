/**
 * Les questions du hook Claude Code posées à une personne DANS Oathrion (mode automatique).
 *
 * Le hook (`cli/wrap/claude-hook.ts`) appelle le pivot : `ask` crée la demande (règle, approbation,
 * notification « Decide »), `status` dit où elle en est.
 *
 *   · LA BASE FAIT FOI, pas la mémoire du pivot : un pivot sans porteur s'arrête trente secondes
 *     après le hook, et la personne approuve souvent plus tard, dans un pivot relancé par
 *     `oathrion console`. La même commande redemandée retrouve alors sa demande ;
 *   · une approbation vaut UNE exécution : une fois rendue au hook, elle est notée comme
 *     utilisée (`claude-code/used-approvals.json`), et la redemander en crée une nouvelle.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { OrganizationId } from "@shared/tenancy";

import { CLAUDE_HANDOFF_VERBS, registerClaudeHandoff } from "./gateway/tools/claude-handoff-tool";
import { ensureClaudeHookPolicy, ensureClientAgent } from "./local-bootstrap";
import { repositoriesFor } from "./repositories";

export type AskStatus = "approved" | "pending" | "rejected" | "expired";

export interface AskInput {
  kind: "shell" | "file_write";
  target: string;
  command?: string;
  reason: string;
  /** La session a lu du contenu non fiable : la source, montrée sur la carte d'approbation. */
  untrusted?: string;
}

interface GatewayLike {
  execute(request: { agentId: string; action: string; target: string; metadata: Record<string, unknown>; actor?: string }): Promise<{ decision: string; approvalId: string | null }>;
}

const USED_LIMIT = 500;

export class ClaudeAsks {
  private readonly usedFile: string;

  constructor(
    private readonly organizationId: OrganizationId,
    stateDir: string,
  ) {
    this.usedFile = join(stateDir, "claude-code", "used-approvals.json");
  }

  private used(): string[] {
    try {
      const parsed = JSON.parse(readFileSync(this.usedFile, "utf8")) as unknown;
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch {
      return [];
    }
  }

  private markUsed(approvalId: string): void {
    const ids = [...this.used().filter((id) => id !== approvalId), approvalId].slice(-USED_LIMIT);
    if (!existsSync(join(this.usedFile, ".."))) mkdirSync(join(this.usedFile, ".."), { recursive: true, mode: 0o700 });
    writeFileSync(this.usedFile, `${JSON.stringify(ids)}\n`, { mode: 0o600 });
  }

  /** La dernière demande de CETTE commande, s'il y en a une encore utile. */
  private async existing(agentId: string, action: string, input: AskInput): Promise<{ id: string; status: AskStatus } | null> {
    const used = new Set(this.used());
    for (const approval of await repositoriesFor(this.organizationId).approvals.list(200)) {
      if (approval.agentId !== agentId || approval.requestedValue !== input.target || !approval.title.startsWith(action)) continue;
      const command = approval.context.find((entry) => entry.label === "command")?.value;
      if ((command ?? "") !== (input.command ?? "")) continue;
      if (approval.status === "pending") return { id: approval.id, status: "pending" };
      if (approval.status === "approved" && !used.has(approval.id)) return { id: approval.id, status: "approved" };
    }
    return null;
  }

  /** Crée la demande, ou retrouve celle de la même commande. */
  async ask(input: AskInput, gateway: GatewayLike): Promise<{ status: AskStatus; approvalId: string | null }> {
    registerClaudeHandoff();
    await ensureClaudeHookPolicy(this.organizationId, Object.values(CLAUDE_HANDOFF_VERBS));
    const { agentId } = await ensureClientAgent(this.organizationId, "Claude Code");
    const action = CLAUDE_HANDOFF_VERBS[input.kind];

    const known = await this.existing(agentId, action, input);
    if (known?.status === "approved") this.markUsed(known.id);
    if (known) return { status: known.status, approvalId: known.id };

    const result = await gateway.execute({
      agentId,
      action,
      target: input.target,
      metadata: { ...(input.command ? { command: input.command } : {}), reason: input.reason, ...(input.untrusted ? { untrusted: input.untrusted } : {}), from: "claude-code-hook" },
      actor: "Claude Code (hook)",
    });
    if (result.decision === "BLOCK") return { status: "rejected", approvalId: null };
    if (result.decision === "ALLOW" || !result.approvalId) return { status: "approved", approvalId: null };
    return { status: "pending", approvalId: result.approvalId };
  }

  /** Où en est une demande ; une approbation lue ici est utilisée. */
  async status(approvalId: string): Promise<AskStatus> {
    const approval = await repositoriesFor(this.organizationId).approvals.findById(approvalId);
    const status = approval?.status;
    if (status === "approved") {
      if (this.used().includes(approvalId)) return "expired";
      this.markUsed(approvalId);
      return "approved";
    }
    return status === "rejected" || status === "expired" ? status : "pending";
  }
}
