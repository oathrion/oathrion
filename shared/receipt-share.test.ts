/**
 * Le reçu partageable (`shared/receipt-share.ts`) : un caractère changé, et il ne vérifie plus ;
 * la clé reste la même d'un export à l'autre ; le fichier ne peut pas être refermé par une
 * commande d'agent.
 */
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { receiptHtml } from "../server/receipt-share-html";
import { canonical, extractShared, RECEIPT_TYPE, signingKey, signStatement, SIGNING_KEY_FILE, verifyShared, type ReceiptStatement } from "./receipt-share";

function statement(issuer: ReceiptStatement["issuer"], what = "rm -rf ~"): ReceiptStatement {
  return {
    type: RECEIPT_TYPE,
    issuedAt: "2026-11-06T10:00:00.000Z",
    issuer,
    action: { at: "2026-11-06T09:59:00.000Z", agent: "Claude Code", via: "Run by Claude Code itself, checked by Oathrion's hook", what, target: "shell:///p", outcome: "refused", outcomeLabel: "Refused by Oathrion", detail: "rule rm-outside-project", impact: "48,312 files (3.2 GB)", ref: "toolu_1" },
    evidence: { chain: "Claude Code journal kept by Oathrion's hook", entries: [{ seq: 7, hash: "ab".repeat(32) }], chainIntact: true, chainEntries: 7, chainHead: "ab".repeat(32) },
  };
}

function signed(what?: string) {
  const dir = mkdtempSync(join(tmpdir(), "oathrion-cle-"));
  const key = signingKey(dir);
  return { dir, key, shared: signStatement(statement({ name: "Oathrion local", publicKey: key.publicKey, fingerprint: key.fingerprint }, what), key.privateKey) };
}

describe("le reçu partageable", () => {
  it("vérifie tel quel ; une seule lettre changée, et il ne vérifie plus", () => {
    const { shared, key } = signed();
    expect(verifyShared(shared)).toEqual({ ok: true, fingerprint: key.fingerprint });
    const altered = structuredClone(shared);
    altered.statement.action.outcomeLabel = "Approved by a person, done";
    expect(verifyShared(altered)).toEqual({ ok: false, reason: "the receipt was changed after it was signed" });
  });

  it("une autre clé glissée dans le reçu, avec l'ancienne empreinte : refusé", () => {
    const { shared } = signed();
    const other = signed().shared;
    expect(verifyShared({ ...shared, statement: { ...shared.statement, issuer: { ...shared.statement.issuer, publicKey: other.statement.issuer.publicKey } } })).toEqual({
      ok: false,
      reason: "the fingerprint shown does not match the issuer's key",
    });
  });

  it("la clé : créée une fois, lisible par son seul propriétaire, la même ensuite", () => {
    const { dir, key } = signed();
    expect(statSync(join(dir, SIGNING_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(signingKey(dir).fingerprint).toBe(key.fingerprint);
    expect(key.fingerprint).toMatch(/^([0-9a-f]{4} ){7}[0-9a-f]{4}$/);
  });

  it("la forme canonique ne dépend pas de l'ordre des clés", () => {
    expect(canonical({ b: 1, a: { d: [2, { f: 1, e: 0 }], c: "x" } })).toBe('{"a":{"c":"x","d":[2,{"e":0,"f":1}]},"b":1}');
  });

  it("dans le fichier HTML : une commande qui contient </script> ne le referme pas, et le reçu en ressort intact", () => {
    const { shared } = signed('echo "</script><script>alert(1)</script>"');
    const html = receiptHtml(shared);
    expect(html.match(/<\/script>/g)).toHaveLength(2);
    expect(verifyShared(extractShared(html))).toMatchObject({ ok: true });
  });
});
