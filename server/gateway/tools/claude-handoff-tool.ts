/**
 * LE PASSAGE DE RELAIS du hook Claude Code — une approbation d'Oathrion pour une action que
 * CLAUDE CODE exécute lui-même.
 *
 * En mode automatique (« auto mode on »), Claude Code ne demande plus rien à personne : une
 * question de son hook serait tranchée par son classifieur. Décision de l'utilisateur, le
 * 5 novembre : Oathrion doit alors demander LUI-MÊME à une personne — console, notification
 * « Decide » —, comme pour une écriture MCP. Le hook (`cli/wrap/claude-hook.ts`) passe par le
 * pivot, et l'action suit le chemin ordinaire : règle, approbation, passerelle, reçu.
 *
 * Mais ce n'est pas Oathrion qui exécute : à l'approbation, cet outil ne fait RIEN, il rend la
 * main. Le reçu le dit (« handed back to Claude Code »), et le résultat réel, lui, va au journal
 * du hook. Il ne prétend jamais avoir lancé la commande.
 */

import { registerLocalTool } from "./stdio-mcp-tool";
import { CountingTool, type ToolContext, type ToolResult } from "./types";

export const CLAUDE_HANDOFF_NAME = "claude-code";
export const CLAUDE_HANDOFF_VERBS = { shell: "mcp.claude-code.shell", file_write: "mcp.claude-code.file_write" } as const;

export class ClaudeHandoffTool extends CountingTool {
  readonly id = "claude_code_handoff";
  readonly name = "Claude Code hand-off";
  readonly description = "Hands an approved shell command or file write back to Claude Code, which runs it itself.";

  protected async run(context: ToolContext): Promise<ToolResult> {
    return {
      ok: true,
      summary: `Approved by a person in Oathrion: handed back to Claude Code, which runs it itself (${context.target}).`,
      data: { handedOff: true, command: typeof context.metadata.command === "string" ? context.metadata.command : null },
    };
  }
}

/** Inscrit l'outil et ses deux verbes, une fois par processus. */
export function registerClaudeHandoff(): void {
  registerLocalTool(CLAUDE_HANDOFF_NAME, new ClaudeHandoffTool(), [
    { action: CLAUDE_HANDOFF_VERBS.shell, requiredScope: "mcp:write", financial: false, outbound: false, risk: "HIGH", description: "A shell command Claude Code runs itself, approved by a person in Oathrion." },
    { action: CLAUDE_HANDOFF_VERBS.file_write, requiredScope: "mcp:write", financial: false, outbound: false, risk: "MEDIUM", description: "A file write Claude Code makes itself, approved by a person in Oathrion." },
  ]);
}
