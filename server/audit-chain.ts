/**
 * Hash chaining for the audit trail (audit findings I4 / S3).
 *
 * WHAT WAS BROKEN
 * ---------------
 * Nothing was broken, because nothing existed. The audit trail was an append-only
 * JSON array of `{at, actor, event, detail}` and every guarantee it offered came from
 * `appendAudit` being atomic: entries could not be *lost*, but a row that was edited
 * afterwards left no trace. "Trusted record of what happened to a governed action" and
 * "silently editable" cannot both be true.
 *
 * WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT
 * -------------------------------------------------
 * Each entry carries `prevHash` and `hash`, where
 *
 *     hash = sha256( prevHash | canonical(at, actor, event, detail) )
 *
 * so any edit, reordering, insertion or removal inside an execution's trail breaks the
 * link at that point and `verifyAuditChain` names the index.
 *
 * The chain is seeded per (organization, execution), NOT globally:
 *
 *   - Per execution because that is the unit the trail is stored on. A global ledger
 *     chain would need a serialized head per tenant in its own table, which is a schema
 *     change and a new write dependency on the decision path.
 *   - Seeded with the tenant id because otherwise an identical trail would produce
 *     identical hashes under every tenant, and a trail could be copied from one
 *     organization to another and still verify. The seed binds the chain to the tenant
 *     that owns it.
 *
 * LIMIT, STATED PLAINLY: this detects tampering *within* an execution's trail. It does
 * not detect the deletion of an entire execution row, because there is nothing left to
 * check the link against. Closing that requires a per-tenant ledger with a persisted
 * head — real work, not covered here, and it must not be claimed as done.
 */

import { createHash } from "node:crypto";
import type { AuditEntry } from "@shared/types";

/**
 * Versioned so that a future change to the hashed representation is a visibly different
 * chain rather than a silent mismatch on old rows.
 */
const CHAIN_VERSION = "placet-audit-v1";

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * The first link. Binds the chain to the tenant and to the execution, so a trail lifted
 * from another organization — or from another execution in the same one — fails at
 * index 0 instead of verifying happily.
 */
export function auditGenesisHash(organizationId: string, executionId: string): string {
  return sha256(`${CHAIN_VERSION}|genesis|${JSON.stringify([organizationId, executionId])}`);
}

/**
 * `JSON.stringify` of a fixed-order array rather than string concatenation with a
 * separator: concatenation lets a value containing the separator impersonate a field
 * boundary, so `actor="a|b", event="c"` and `actor="a", event="b|c"` would hash alike.
 * `detail` is normalised to `null` so that "absent" and "empty" are one thing, matching
 * the optional field in the type.
 */
export function auditEntryHash(prevHash: string, entry: AuditEntry): string {
  const canonical = JSON.stringify([entry.at, entry.actor, entry.event, entry.detail ?? null]);
  return sha256(`${CHAIN_VERSION}|${prevHash}|${canonical}`);
}

/**
 * Links `additions` onto the end of `stored`.
 *
 * `stored` is the trail as it exists in the database, read inside the same transaction
 * as the write. Passing a caller's snapshot here would reintroduce the lost-update bug
 * `appendAudit` exists to prevent, and would also fork the chain.
 *
 * Any `hash`/`prevHash` already present on an addition is overwritten: the chain is
 * computed by the repository, never accepted from a caller, so a client cannot dictate
 * a link and forge continuity.
 */
export function linkAuditEntries(
  organizationId: string,
  executionId: string,
  stored: AuditEntry[],
  additions: AuditEntry[],
): AuditEntry[] {
  let prev = headHash(organizationId, executionId, stored);
  const linked: AuditEntry[] = [];
  for (const entry of additions) {
    const base: AuditEntry = { at: entry.at, actor: entry.actor, event: entry.event };
    if (entry.detail !== undefined) base.detail = entry.detail;
    const hash = auditEntryHash(prev, base);
    linked.push({ ...base, prevHash: prev, hash });
    prev = hash;
  }
  return linked;
}

/**
 * The hash the next entry must point at.
 *
 * Falls back to the genesis hash for an empty trail. For a trail whose last entry has
 * no `hash`, it also returns genesis — see `verifyAuditChain` for why unhashed legacy
 * entries are reported rather than silently re-chained.
 */
export function headHash(
  organizationId: string,
  executionId: string,
  stored: AuditEntry[],
): string {
  const last = stored[stored.length - 1];
  return last?.hash ?? auditGenesisHash(organizationId, executionId);
}

export interface ChainVerdict {
  ok: boolean;
  /** Index of the first entry that does not verify, or `null` when the chain holds. */
  brokenAt: number | null;
  reason: string;
}

/**
 * Recomputes the chain and reports the first break.
 *
 * Entries written before this mechanism existed have no `hash`. They are reported as
 * `unhashed`, NOT treated as valid: an unverifiable entry is exactly what an attacker
 * would leave behind, so silently accepting it would make the whole check decorative.
 * A deployment with pre-existing rows will see them flagged, which is the honest answer.
 */
export function verifyAuditChain(
  organizationId: string,
  executionId: string,
  entries: AuditEntry[],
): ChainVerdict {
  let prev = auditGenesisHash(organizationId, executionId);

  for (const [i, entry] of entries.entries()) {
    if (entry.hash === undefined || entry.prevHash === undefined) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i} carries no hash (written before chaining, or stripped)`,
      };
    }
    if (entry.prevHash !== prev) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i} points at ${entry.prevHash.slice(0, 12)}… but the chain is at ${prev.slice(0, 12)}…`,
      };
    }
    const expected = auditEntryHash(prev, entry);
    if (entry.hash !== expected) {
      return {
        ok: false,
        brokenAt: i,
        reason: `entry ${i} has been modified: content hashes to ${expected.slice(0, 12)}… not ${entry.hash.slice(0, 12)}…`,
      };
    }
    prev = entry.hash;
  }

  return { ok: true, brokenAt: null, reason: `${entries.length} entry/entries verified` };
}
