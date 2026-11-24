/**
 * LE RELEVÉ D'UN CLIENT, AVEC LES ACCORDS SIGNÉS PAR LE TÉLÉPHONE (lot 1 de
 * `notes/CONCEPTION-SAINT-GRAAL-RECUS.md`) : le périmètre d'un dossier et de serveurs, les
 * décisions des personnes, l'accord du téléphone rattaché à la bonne action, la page qui se
 * vérifie seule, et `oathrion receipt verify` qui contrôle les deux signatures.
 */
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { approvalData, deviceFingerprint, PHONE_APPROVAL_TYPE, shownOf, verifyPhoneApproval, type PhoneApproval } from "@shared/phone-approval";
import { extractShared, signDocument, signingKey, signStatement, verifyShared } from "@shared/receipt-share";
import type { Execution } from "@shared/types";

import type { JournalEntry } from "../../cli/wrap/claude-journal";
import { runReceipt } from "../../cli/wrap/receipts";
import { runReport } from "../../cli/wrap/report";
import { fromExecution, timeline, type ActivityEntry } from "../local-activity";
import { readPhoneApprovals, recordPhoneApproval } from "../local-phone-approvals";
import { receiptStatement } from "../local-receipt";
import { reportStatement } from "../local-report";
import { statementHtml } from "../statement-html";

/** Un téléphone : sa clé d'appareil, et l'accord qu'il signe sur ce qu'il a montré. */
function phone(label = "Android phone") {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = pair.publicKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, "base64url"), Buffer.from(jwk.y!, "base64url")]).toString("base64url");
  return {
    publicKey,
    approve: (title: string, choice = "approve"): PhoneApproval => {
      const shown = shownOf({ route: "AAAAAAAAAAA", agent: "Claude Code", computer: "FORCE-N", title, body: "rule git-push", at: 1_795_000_000_000 });
      const at = 1_795_000_005_000;
      const data = approvalData({ shown, nonce: "abcdefghijkl", choice, at });
      return {
        type: PHONE_APPROVAL_TYPE,
        device: { publicKey, fingerprint: deviceFingerprint(publicKey), label },
        shown,
        nonce: "abcdefghijkl",
        choice,
        at,
        signature: sign("sha256", Buffer.from(`oathrion-phone-v1|${data}`), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"),
      };
    },
  };
}

let n = 0;
const entry = (over: Partial<ActivityEntry>): ActivityEntry => ({
  at: "2026-11-10T10:00:00.000Z",
  source: "claude-code",
  agent: "Claude Code",
  action: "npm test",
  target: "shell:///home/awa/clients/acme",
  outcome: "done",
  detail: null,
  ref: `t${String((n += 1))}`,
  ...over,
});

const chain = { ok: true, entries: 12, head: "h12" };
const build = (entries: ActivityEntry[], over: Partial<Parameters<typeof reportStatement>[0]> = {}) =>
  reportStatement({
    entries,
    since: "2026-11-01T00:00:00.000Z",
    until: "2026-11-30T23:59:59.999Z",
    subject: "Acme",
    home: "/home/awa",
    countsOnly: false,
    partial: false,
    receipts: chain,
    journal: chain,
    issuer: { name: "Oathrion local", publicKey: "k", fingerprint: "f" },
    issuedAt: "2026-12-01T08:00:00.000Z",
    ...over,
  });

describe("le relevé d'un client : son dossier, ses serveurs, ses décisions", () => {
  const p = phone();
  const signed = p.approve("Claude Code wants to run: git push origin main");
  const entries = [
    entry({}),
    entry({ action: "cd /home/awa/clients/acme/api && npm run build", target: "shell:///home/awa/clients/acme/api" }),
    entry({ action: "git push origin main", outcome: "approved-done", detail: "rule git-push · person: approved", phone: signed }),
    entry({ action: "psql -c 'drop table users'", outcome: "refused-by-person", detail: "rule sql-destroy · person: rejected" }),
    entry({ action: "rm -rf /home/awa/clients/acme/dist", outcome: "refused", detail: "rule rm-recursive", impact: "49 files (3.1 MB)" }),
    /* Un autre client, et le dossier personnel : hors du relevé. */
    entry({ action: "rm -rf /home/awa/clients/globex", target: "shell:///home/awa/clients/globex", outcome: "refused" }),
    entry({ action: "ls", target: "shell:///home/awa" }),
    entry({ source: "oathrion", agent: "Cursor", action: "mcp.github.create_pull_request", target: "mcp://github", outcome: "approved-done" }),
    entry({ source: "oathrion", agent: "Cursor", action: "mcp.notes.write_file", target: "mcp://notes", outcome: "done" }),
  ];

  it("garde seulement le dossier (et ses sous-dossiers) et les serveurs nommés", () => {
    const report = build(entries, { scope: { project: "/home/awa/clients/acme", servers: ["github"] } });
    expect(report.scope).toEqual({ project: "~/clients/acme", servers: ["github"] });
    expect(report.summary).toMatchObject({ total: 6, passed: 2, blocked: 1, approvedByPerson: 2, refusedByPerson: 1, signedByPhone: 1 });
    const text = JSON.stringify(report);
    expect(text).not.toContain("globex");
    expect(text).not.toContain("write_file");
    /* Le dossier du client devient « . », le dossier personnel « ~ ». */
    expect(text).not.toContain("/home/awa");
    expect(report.saves!.map((save) => save.what)).toEqual(["rm -rf ./dist"]);
    expect(report.limits.join(" ")).toMatch(/Only this scope: what Claude Code did in the project folder \(written \.\), and the MCP servers github/);
  });

  it("liste les décisions des personnes, la plus récente d'abord, avec l'accord du téléphone quand il existe", () => {
    const report = build(entries, { scope: { project: "/home/awa/clients/acme", servers: ["github"] } });
    expect(report.decisions!.map((d) => [d.what, d.outcomeLabel, d.approval !== null])).toEqual([
      ["git push origin main", "Approved by a person, done", true],
      ["psql -c 'drop table users'", "Refused by a person", false],
      ["mcp.github.create_pull_request", "Approved by a person, done", false],
    ]);
    expect(verifyPhoneApproval(report.decisions![0]!.approval).ok).toBe(true);
    expect(build(entries, { countsOnly: true }).decisions).toBeNull();
  });

  it("garde toutes les étapes du projet, en mots simples, dans l'ordre ; les décisions et les arrêts disent ce qui a été demandé", () => {
    const report = build(entries, { scope: { project: "/home/awa/clients/acme", servers: ["github"] } });
    expect(report.steps!.map((step) => step.done)).toEqual(["Ran the tests", "Built the project", "Published the code to the shared repository", "Deleted data from the database", "Deleted files", "Used create pull request"]);
    expect(report.steps![1]).toMatchObject({ what: "cd ./api && npm run build", key: "build" });
    expect(report.decisions![0]!.todo).toBe("publish the code to the shared repository");
    expect(report.saves![0]!.todo).toBe("delete files");
    /* Sans périmètre (toute la machine), ou en nombres seulement : aucune étape. */
    expect(build(entries).steps).toBeUndefined();
    expect(build(entries, { scope: { project: "/home/awa/clients/acme", servers: [] }, countsOnly: true }).steps).toBeUndefined();
  });

  it("sans périmètre, toute la machine, comme avant", () => {
    const report = build(entries);
    expect(report.scope).toBeUndefined();
    expect(report.summary.total).toBe(entries.length);
  });
});

describe("l'accord du téléphone, rattaché à la bonne action", () => {
  it("par l'exécution ou l'approbation d'Oathrion, et par le passage de relais du hook de Claude Code", () => {
    const p = phone();
    const approvals = new Map([
      ["exe_held", p.approve("Cursor wants to use: create_pull_request")],
      ["apr_handoff", p.approve("Claude Code wants to run: git push")],
    ]);
    const base = { agentId: "agt", agentName: "Cursor", destinationId: null, decisionReason: "asks a person", input: {}, status: "succeeded", runState: "succeeded" };
    const executions = [
      { ...base, id: "exe_held", timestamp: "2026-11-10T10:00:00.000Z", action: "mcp.github.create_pull_request", target: "mcp://github", decision: "allow", approvalId: "apr_held", audit: [{ event: "Approval requested" }, { event: "Approval granted" }] },
      { ...base, id: "exe_quiet", timestamp: "2026-11-10T10:01:00.000Z", action: "mcp.github.list_issues", target: "mcp://github", decision: "allow", approvalId: null, audit: [] },
      { ...base, id: "exe_handoff", agentName: "Claude Code", timestamp: "2026-11-10T10:02:00.000Z", action: "mcp.claude-code.shell", target: "shell:///w", decision: "allow", approvalId: "apr_handoff", input: { command: "git push" }, audit: [{ event: "Approval requested" }, { event: "Approval granted" }] },
    ] as unknown as Execution[];
    const journal = [
      { seq: 1, at: "2026-11-10T10:02:00.000Z", phase: "pre", tool: "Bash", action: "claude.shell", target: "shell:///w", command: "git push", verdict: "allow", person: "approved", mode: "auto", rule: "git-push", toolUseId: "toolu_1", hash: "h1", prev: "h0" },
    ] as unknown as JournalEntry[];
    const all = timeline(executions, journal, { approvals });
    expect(all.find((e) => e.ref === "exe_held")?.phone?.shown.title).toBe("Cursor wants to use: create_pull_request");
    expect(all.find((e) => e.ref === "toolu_1")?.phone?.shown.title).toBe("Claude Code wants to run: git push");
    expect(all.find((e) => e.ref === "exe_quiet")?.phone).toBeUndefined();
    /* Une action qui n'a demandé personne n'emprunte jamais un accord. */
    expect(fromExecution(executions[1]!)?.decidedIn).toBeUndefined();
  });

  it("le fichier des accords : seuls ceux que le téléphone a vraiment signés sont lus", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-accords-"));
    const good = phone().approve("Claude Code wants to run: git push");
    recordPhoneApproval(dir, { executionId: "exe_1", approvalId: "apr_1", eventId: "ntf_1", approval: good });
    recordPhoneApproval(dir, { executionId: "exe_2", approvalId: null, eventId: "ntf_2", approval: { ...good, choice: "reject" } });
    writeFileSync(join(dir, "phone-approvals.jsonl"), `${readFileSync(join(dir, "phone-approvals.jsonl"), "utf8")}{abîmé\n`);
    const read = readPhoneApprovals(dir);
    expect([...read.keys()].sort()).toEqual(["apr_1", "exe_1"]);
  });
});

describe("la page du relevé, et oathrion receipt verify", () => {
  const signedStatement = (dir: string, approval: PhoneApproval | null) => {
    const key = signingKey(join(dir, "cle"));
    const statement = build(
      [
        entry({ action: "git push origin main", outcome: "approved-done", ...(approval ? { phone: approval } : {}) }),
        entry({ action: "echo '</script><img src=x onerror=alert(1)>'", outcome: "refused" }),
      ],
      { scope: { project: "/home/awa/clients/acme", servers: [] }, issuer: { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint } },
    );
    return signDocument(statement, key.privateKey);
  };

  it("se vérifie seule, sans rien de la déclaration posé en HTML", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-releve-"));
    const shared = signedStatement(dir, phone().approve("Claude Code wants to run: git push origin main"));
    const html = statementHtml(shared);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("checkPhone(");
    /* Comme l'écran de Claude Code : le fil, les groupes repliés, la preuve repliée en bas. */
    expect(html).toContain('<div class="thread" id="thread"></div>');
    expect(html).toContain('<details class="proofbox">');
    expect(html).not.toMatch(/<(link|script)[^>]+src=/);
    expect(verifyShared(extractShared(html))).toMatchObject({ ok: true });
  });

  it("verify dit l'accord du téléphone vérifié ; un accord trafiqué rend tout le relevé non valide", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-releve-"));
    const p = phone();
    const file = join(dir, "acme.html");
    writeFileSync(file, statementHtml(signedStatement(dir, p.approve("Claude Code wants to run: git push origin main"))));
    const lines: string[] = [];
    expect(runReceipt(["verify", file], (l) => lines.push(l), (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(/Verified statement: .*each phone's own signature checks/);
    expect(lines.join("\n")).toMatch(/📱 Approved by a person, done, signed on Android phone: git push origin main/);

    /* La machine signe un accord que le téléphone n'a jamais donné : sa signature tient, celle du téléphone non. */
    const forged = { ...p.approve("Claude Code wants to run: git push origin main"), choice: "reject" };
    writeFileSync(file, statementHtml(signedStatement(dir, forged)));
    const again: string[] = [];
    expect(runReceipt(["verify", file], (l) => again.push(l), (l) => again.push(l))).toBe(1);
    expect(again.join("\n")).toMatch(/NOT VALID: it is signed, but 1 phone approval\(s\) inside it do not check/);
    expect(again.join("\n")).not.toContain("git push");
  });

  it("le reçu d'une action porte l'accord ; verify le revérifie", () => {
    const dir = mkdtempSync(join(tmpdir(), "oathrion-recu-tel-"));
    const key = signingKey(join(dir, "cle"));
    const p = phone("Pixel de Awa");
    const decided = entry({ action: "git push origin main", outcome: "approved-done", phone: p.approve("Claude Code wants to run: git push origin main") });
    const evidence = { chain: "journal", entries: [], chainIntact: true, chainEntries: 1, chainHead: null };
    const file = join(dir, "recu.json");
    writeFileSync(file, JSON.stringify(signStatement(receiptStatement(decided, evidence, { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint }, "2026-11-23T10:00:00.000Z"), key.privateKey)));
    const lines: string[] = [];
    expect(runReceipt(["verify", file], (l) => lines.push(l), (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(/📱 Approved on Pixel de Awa \(key .{4} .{4}…\), .*the phone's own signature checks/);

    const forged = entry({ ...decided, phone: { ...decided.phone!, shown: { ...decided.phone!.shown, title: "Claude Code wants to run: ls" } } });
    writeFileSync(file, JSON.stringify(signStatement(receiptStatement(forged, evidence, { name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint }, "2026-11-23T10:00:00.000Z"), key.privateKey)));
    const again: string[] = [];
    expect(runReceipt(["verify", file], (l) => again.push(l), (l) => again.push(l))).toBe(1);
    expect(again.join("\n")).toMatch(/NOT VALID: the receipt is signed, but the phone's approval inside it is not/);
  });

  it("oathrion receipt report --project --server : le périmètre part au pivot, une page HTML est écrite", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "oathrion-releve-cli-"));
    const asked: Record<string, unknown>[] = [];
    const shared = signedStatement(cwd, null);
    const lines: string[] = [];
    const io = { out: (l: string) => lines.push(l), err: (l: string) => lines.push(l), cwd, env: {}, now: () => new Date("2026-11-30T00:00:00.000Z") };
    const hub = async () => ({ op: async <T>(body: Record<string, unknown>) => (asked.push(body), { status: 200, body: shared as T }) });
    expect(await runReport(["--project", "clients/acme", "--server", "github", "--for", "Acme"], { ...io, hub })).toBe(0);
    expect(asked[0]).toMatchObject({ op: "report", subject: "Acme", scope: { project: join(cwd, "clients/acme"), servers: ["github"] } });
    const file = join(cwd, "oathrion-statement-acme-2026-11-01-to-2026-11-30.html");
    expect(verifyShared(extractShared(readFileSync(file, "utf8")))).toMatchObject({ ok: true });
    expect(lines.join("\n")).toMatch(/Oathrion statement for Acme/);
    expect(await runReport(["--server", "Not A Name"], { ...io, hub })).toBe(3);
  });
});
