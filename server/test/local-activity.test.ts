/**
 * La chronologie unique (`server/local-activity.ts`) : une ligne par action, lisible, sans doublon.
 */
import { describe, expect, it } from "vitest";

import type { Execution } from "@shared/types";

import type { JournalEntry } from "../../cli/wrap/claude-journal";
import { fromExecution, fromJournal, handoffAnswers, timeline } from "../local-activity";

const execution = (over: Partial<Execution>): Execution =>
  ({
    id: "exe_1",
    agentId: "agt_local_cursor",
    agentName: "Cursor",
    action: "mcp.files.read_file",
    target: "mcp://files/read_file",
    status: "allowed",
    risk: "low",
    durationMs: 3,
    cost: 0,
    timestamp: "2026-11-05T10:00:00.000Z",
    input: {},
    decision: "allow",
    decisionReason: "",
    policyEvaluated: null,
    policyId: null,
    result: "",
    audit: [],
    runState: "succeeded",
    ...over,
  }) as Execution;

let seq = 0;
const line = (over: Partial<JournalEntry>): JournalEntry =>
  ({ seq: (seq += 1), at: "2026-11-05T11:00:00.000Z", prev: null, hash: "h", phase: "pre", session: "s", toolUseId: "toolu_1", tool: "Bash", action: "claude.shell", target: "shell:///projet", ...over }) as JournalEntry;

describe("une exécution d'Oathrion devient une ligne", () => {
  it.each([
    [{}, "done"],
    [{ decision: "block", status: "blocked", runState: undefined, decisionReason: "destructive tool" }, "refused"],
    [{ decision: "require_approval", status: "pending", runState: "pending", approvalId: "apr_1" }, "waiting"],
    /* Après la réponse de la personne, la décision change (decision-service) : l'approbation reste. */
    [{ decision: "block", status: "blocked", runState: undefined, approvalId: "apr_1" }, "refused-by-person"],
    [{ decision: "allow", status: "allowed", runState: "succeeded", approvalId: "apr_1" }, "approved-done"],
    [{ decision: "allow", status: "failed", runState: "failed", approvalId: "apr_1" }, "approved-failed"],
    /* Le cas réel : le lien vers l'approbation est vide, l'historique la garde. */
    [{ decision: "allow", status: "allowed", runState: "succeeded", approvalId: null, audit: [{ at: "t", event: "Approval requested", actor: "x" }, { at: "t", event: "Approval granted", actor: "user" }] }, "approved-done"],
    [{ decision: "block", status: "blocked", runState: undefined, approvalId: null, audit: [{ at: "t", event: "Approval requested", actor: "x" }, { at: "t", event: "Approval rejected", actor: "user" }] }, "refused-by-person"],
    [{ status: "failed", runState: "failed" }, "failed"],
  ] as const)("%o → %s", (over, outcome) => {
    expect(fromExecution(execution(over as Partial<Execution>))?.outcome).toBe(outcome);
  });

  it("une demande du hook (mcp.claude-code.*) n'est pas répétée : le journal la porte", () => {
    expect(fromExecution(execution({ action: "mcp.claude-code.shell" }))).toBeNull();
  });
});

describe("le journal du hook : avant et après réunis", () => {
  it.each([
    [[line({ verdict: "none", command: "ls" }), line({ phase: "post", outcome: { interrupted: false } })], "done", "ls"],
    [[line({ verdict: "none", command: "ls /x" }), line({ phase: "post", outcome: { failed: true, exitCode: 2 } })], "failed", "ls /x"],
    [[line({ verdict: "deny", rule: "rm-outside-project", command: "rm -rf ~" })], "refused", "rm -rf ~"],
    [[line({ verdict: "ask", rule: "git-push", command: "git push" })], "asked-not-run", "git push"],
    [[line({ verdict: "ask", rule: "git-push", command: "git push" }), line({ phase: "post", outcome: {} })], "asked-done", "git push"],
    [[line({ verdict: "allow", person: "approved", mode: "auto", command: "git push" }), line({ phase: "post", outcome: { failed: true, exitCode: 128 } })], "approved-failed", "git push"],
    [[line({ verdict: "deny", person: "rejected", mode: "auto", command: "git push" })], "refused-by-person", "git push"],
  ] as const)("%# → %s", (lines, outcome, action) => {
    const [entry] = fromJournal(lines as unknown as JournalEntry[]);
    expect(entry).toMatchObject({ source: "claude-code", agent: "Claude Code", outcome, action, ref: "toolu_1" });
  });

  it("une écriture : « create » ou « replace », et le détail dit la règle, la personne, le mode", () => {
    const [created] = fromJournal([line({ tool: "Write", action: "claude.file.write", target: "file:///projet/a.txt", verdict: "none" }), line({ phase: "post", tool: "Write", outcome: { kind: "created" } })]);
    expect(created!.action).toBe("create /projet/a.txt");
    const [asked] = fromJournal([line({ verdict: "allow", person: "approved", mode: "auto", rule: "git-push", command: "git push" })]);
    expect(asked!.detail).toBe("rule git-push · person: approved · mode auto");
  });
});

describe("une commande envoyée à une personne (mode automatique)", () => {
  const sent = [line({ verdict: "deny", person: "pending", mode: "auto", rule: "git-push", command: "git push", target: "shell:///p" })];
  const handoff = (events: string[]) =>
    execution({ action: "mcp.claude-code.shell", target: "shell:///p", input: { command: "git push" }, decision: events.includes("Approval granted") ? "allow" : events.includes("Approval rejected") ? "block" : "require_approval", audit: events.map((event) => ({ at: "t", event, actor: "user" })) as Execution["audit"] });

  it("sans réponse : en attente ; approuvée : à redemander ; refusée : refusée par une personne", () => {
    expect(fromJournal(sent)[0]!.outcome).toBe("waiting");
    expect(fromJournal(sent, handoffAnswers([handoff(["Approval requested", "Approval granted"])]))[0]!.outcome).toBe("approved-not-run");
    expect(fromJournal(sent, handoffAnswers([handoff(["Approval requested", "Approval rejected"])]))[0]!.outcome).toBe("refused-by-person");
    expect(fromJournal(sent, handoffAnswers([handoff(["Approval requested"])]))[0]!.outcome).toBe("waiting");
  });
});

describe("le fil", () => {
  it("les deux sources, du plus récent au plus ancien, filtrables par agent", () => {
    const entries = timeline(
      [execution({ id: "exe_old", timestamp: "2026-11-05T09:00:00.000Z" }), execution({ id: "exe_new", timestamp: "2026-11-05T12:00:00.000Z" })],
      [line({ verdict: "none", command: "ls", at: "2026-11-05T10:30:00.000Z", toolUseId: "toolu_mid" })],
    );
    expect(entries.map((e) => e.ref)).toEqual(["exe_new", "toolu_mid", "exe_old"]);
    expect(timeline([execution({})], [line({ command: "ls", verdict: "none" })], { agent: "Claude Code" }).map((e) => e.agent)).toEqual(["Claude Code"]);
  });
});
