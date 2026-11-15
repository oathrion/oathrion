/**
 * Machine credentials in the database — P0-5.
 *
 * Four things had to become true, and each is a way this could go wrong:
 *
 *   1. **No plaintext key is stored.** The table must contain nothing that can be
 *      replayed, and no route may return the digest either.
 *   2. **Revocation takes effect on the next request**, not at the next restart. This is
 *      the whole point: before P0-5, cutting off a compromised agent required editing a
 *      file and restarting the process.
 *   3. **Nothing regressed for existing deployments.** `OATHRION_API_KEYS` still works, a
 *      value changed there still rotates the credential, and a line deleted there still
 *      removes access — that last one is the property most likely to be lost silently by
 *      moving keys into a database, because the row survives the deletion.
 *   4. **One tenant cannot touch another's keys**, even knowing the exact id.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_ORGANIZATION_ID } from "@shared/tenancy";
import { resetAuthConfig, resolveBearer } from "../auth";
import { apiKeyStore, isExpired, toPublicKey } from "../repositories/api-keys";
import { generateKey, hashKey, displayPrefixOf, keyProblems, KEY_PREFIX } from "../api-keys";
import { organizationStore } from "../repositories/organizations";
import { rawDb } from "../db";
import { ensureRivalOrganization } from "./rival-organization";

/*
 * L'identifiant HÉRITÉ de la deuxième organisation — la forme dérivée d'avant la
 * migration 18, conservée volontairement. Ce fichier n'ouvre pas le harnais HTTP, donc
 * il crée la ligne lui-même : une organisation inconnue est inactive, et
 * `resolveBearer` refuserait la clé avant d'arriver à ce que le test mesure.
 */
const RIVAL = ensureRivalOrganization();

/** Runs `body` with a replaced key list, restoring the environment afterwards. */
function withApiKeys<T>(value: string, body: () => T): T {
  const original = process.env.OATHRION_API_KEYS;
  process.env.OATHRION_API_KEYS = value;
  resetAuthConfig();
  try {
    return body();
  } finally {
    if (original === undefined) delete process.env.OATHRION_API_KEYS;
    else process.env.OATHRION_API_KEYS = original;
    resetAuthConfig();
  }
}

function issue(overrides: Partial<Parameters<typeof apiKeyStore.create>[0]> = {}) {
  const generated = generateKey();
  const key = apiKeyStore.create({
    id: `key_test_${Math.random().toString(36).slice(2, 10)}`,
    organizationId: DEFAULT_ORGANIZATION_ID,
    name: "Test integration",
    role: "operator",
    secretHash: generated.hash,
    prefix: generated.displayPrefix,
    source: "user",
    createdBy: "test",
    ...overrides,
  });
  return { key, secret: generated.secret };
}

describe("key material", () => {
  it("generates a recognisable, transport-safe, high-entropy key", () => {
    const { secret } = generateKey();
    expect(secret.startsWith(KEY_PREFIX)).toBe(true);
    // base64url only: a key that needs quoting in a shell or YAML file will one day be
    // transported wrong, and the failure will look like an authentication bug.
    expect(secret.slice(KEY_PREFIX.length)).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes in base64url is 43 characters. This asserts the entropy that makes a slow
    // KDF unnecessary — if someone shortens it, the reasoning in api-keys.ts stops holding.
    expect(secret.slice(KEY_PREFIX.length).length).toBe(43);
  });

  it("never generates the same key twice", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateKey().secret));
    expect(seen.size).toBe(200);
  });

  it("hashes deterministically and irreversibly", () => {
    const { secret, hash } = generateKey();
    expect(hashKey(secret)).toBe(hash);
    expect(hash.startsWith("sha256$")).toBe(true);
    // The digest must not contain the secret, in any form a grep would find.
    expect(hash).not.toContain(secret);
    expect(hash).not.toContain(secret.slice(KEY_PREFIX.length, 20));
  });

  it("shows a fragment of a generated key but nothing of an adopted one", () => {
    const { secret } = generateKey();
    /*
     * Dérivé de `KEY_PREFIX`, et non le littéral `11` qui était écrit ici.
     *
     * Onze, c'était `aria_` (5) plus six caractères de corps. Le renommage a porté le
     * préfixe à `placet_` (7), donc à treize — et ce test a échoué en attendant
     * `placet_af5a` et en recevant `placet_af5aRq`. Un nombre magique qui encode la
     * longueur d'une constante se périme exactement comme la phrase « Eleven characters
     * (`aria_` + 6) » du commentaire de `DISPLAY_PREFIX_LENGTH`, qui était fausse elle
     * aussi. Les deux sont corrigés en cessant de restater ce que la constante dit.
     */
    expect(displayPrefixOf(secret)).toBe(secret.slice(0, KEY_PREFIX.length + 6));
    // A key from the environment may be a human-chosen string whose beginning is
    // meaningful, and its plaintext has never been displayed in a browser. It stays that way.
    expect(displayPrefixOf("acme-production-key-0001")).toBe("env:");
  });

  it("refuses a candidate that is too short or padded with whitespace", () => {
    expect(keyProblems(generateKey().secret)).toEqual([]);
    expect(keyProblems("short")).toContain("must be at least 16 characters");
    expect(keyProblems(" a-key-with-leading-space")).toContain(
      "must not begin or end with whitespace",
    );
  });
});

describe("api key store", () => {
  it("stores no plaintext anywhere in the row", () => {
    const { secret, key } = issue();
    const row = rawDb.prepare("SELECT * FROM api_keys WHERE id = ?").get(key.id) as Record<string, unknown>;
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(secret);
    // Not even the part shown in the console should let a reader reconstruct the key: it
    // is present, and that is intended, but the remaining 37 characters must be absent.
    expect(serialised).not.toContain(secret.slice(11));
  });

  it("cannot expose the digest through the public shape", () => {
    const { key } = issue();
    const shape = toPublicKey(key) as unknown as Record<string, unknown>;
    expect("secretHash" in shape).toBe(false);
    expect(JSON.stringify(shape)).not.toContain(key.secretHash);
  });

  it("refuses two keys with the same digest", () => {
    const { secret } = issue();
    // The engine enforces this, not application code: one credential resolving to two
    // identities would be decided by row order.
    expect(() =>
      apiKeyStore.create({
        id: "key_duplicate_digest",
        organizationId: RIVAL,
        name: "Impostor",
        role: "admin",
        secretHash: hashKey(secret),
        prefix: "oathrion_xx",
        source: "user",
        createdBy: "test",
      }),
    ).toThrow();
  });

  it("records who revoked a key, and keeps the first answer", () => {
    const { key } = issue();
    expect(apiKeyStore.revoke(DEFAULT_ORGANIZATION_ID, key.id, "Alice", "leaked in a log")).toBe(true);
    // A second revocation reports that it changed nothing rather than overwriting the
    // record of who acted first — that record is what an incident review reads.
    expect(apiKeyStore.revoke(DEFAULT_ORGANIZATION_ID, key.id, "Bob", "again")).toBe(false);
    const after = apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id);
    expect(after?.revokedBy).toBe("Alice");
    expect(after?.revokedReason).toBe("leaked in a log");
  });

  it("treats an unparseable expiry as expired rather than unlimited", () => {
    const { key } = issue({ expiresAt: "not-a-date" });
    expect(isExpired(key)).toBe(true);
    const live = issue({ expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(isExpired(live.key)).toBe(false);
  });

  it("records use at most once a minute", () => {
    const { key } = issue();
    const start = Date.now();
    expect(apiKeyStore.touch(key, start)).toBe(true);
    const touched = apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id);
    // A second call inside the window writes nothing: one UPDATE per agent request would
    // put a write lock in front of the whole gateway.
    expect(apiKeyStore.touch(touched!, start + 5_000)).toBe(false);
    expect(apiKeyStore.touch(touched!, start + 61_000)).toBe(true);
  });

  it("reports revoked, expired and active as three distinct states", () => {
    expect(toPublicKey(issue().key).status).toBe("active");
    expect(toPublicKey(issue({ expiresAt: new Date(Date.now() - 1_000).toISOString() }).key).status).toBe("expired");
    const { key } = issue();
    apiKeyStore.revoke(DEFAULT_ORGANIZATION_ID, key.id, "test");
    expect(toPublicKey(apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id)!).status).toBe("revoked");
  });

  it("falls back to the least privileged role when the stored role is unreadable", () => {
    const { key } = issue({ role: "admin" });
    // Simulates a corrupt write. Corrupt data must fail towards *less* access: trusting
    // the stored string would let a bad row mint an administrator.
    rawDb.prepare("UPDATE api_keys SET role = 'superuser' WHERE id = ?").run(key.id);
    expect(apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id)?.role).toBe("viewer");
  });
});

describe("tenant isolation", () => {
  it("does not let one organization read, revoke or rename another's key", () => {
    const { key } = issue({ organizationId: RIVAL, name: "Rival integration" });

    // Knowing the exact id is not enough. A foreign row reads as absent, which is what
    // lets the route answer 404 instead of 403 — 403 would confirm the id exists.
    expect(apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id)).toBeUndefined();
    expect(apiKeyStore.revoke(DEFAULT_ORGANIZATION_ID, key.id, "attacker")).toBe(false);
    expect(apiKeyStore.rename(DEFAULT_ORGANIZATION_ID, key.id, "Taken over")).toBe(false);

    // And the row is genuinely untouched, not merely reported as unchanged.
    const still = apiKeyStore.findIn(RIVAL, key.id);
    expect(still?.name).toBe("Rival integration");
    expect(still?.revokedAt).toBeNull();
  });

  it("lists only the caller's organization", () => {
    issue({ organizationId: RIVAL, name: "Rival only" });
    const ours = apiKeyStore.list(DEFAULT_ORGANIZATION_ID);
    expect(ours.every((k) => k.organizationId === DEFAULT_ORGANIZATION_ID)).toBe(true);
    expect(ours.some((k) => k.name === "Rival only")).toBe(false);
  });
});

describe("authentication through the database", () => {
  it("resolves a key issued through the product", () => {
    const { secret, key } = issue({ name: "Issued integration", role: "approver" });
    const identity = resolveBearer(secret);
    expect(identity).toMatchObject({
      id: key.id,
      name: "Issued integration",
      kind: "service",
      role: "approver",
      organizationId: DEFAULT_ORGANIZATION_ID,
    });
  });

  it("refuses a revoked key on the very next request", () => {
    const { secret, key } = issue();
    expect(resolveBearer(secret)).not.toBeNull();
    apiKeyStore.revoke(DEFAULT_ORGANIZATION_ID, key.id, "Alice", "compromised");
    // No restart, no cache invalidation, no waiting for a TTL. This is the property the
    // whole migration exists for.
    expect(resolveBearer(secret)).toBeNull();
  });

  it("refuses an expired key without it having been revoked", () => {
    const { secret, key } = issue({ expiresAt: new Date(Date.now() - 1_000).toISOString() });
    expect(resolveBearer(secret)).toBeNull();
    expect(apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id)?.revokedAt).toBeNull();
  });

  it("refuses a key of a suspended organization", () => {
    const { secret } = issue({ organizationId: RIVAL });
    expect(resolveBearer(secret)).not.toBeNull();
    organizationStore.setActive(RIVAL, false);
    try {
      // Suspension has to bite on the next request, not at the key's expiry: a tenant
      // switched off for non-payment or during an incident must stop acting immediately.
      expect(resolveBearer(secret)).toBeNull();
    } finally {
      organizationStore.setActive(RIVAL, true);
    }
  });

  it("refuses a credential that resembles a key but is not one", () => {
    expect(resolveBearer(`${KEY_PREFIX}${"A".repeat(43)}`)).toBeNull();
    expect(resolveBearer("")).toBeNull();
    // A near-miss of a real key: one character changed. The digest lookup makes partial
    // matching impossible, which is also why there is no timing signal to measure.
    const { secret } = issue();
    const nearMiss = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;
    expect(resolveBearer(nearMiss)).toBeNull();
  });

  it("records the last use of a key that authenticates", () => {
    const { secret, key } = issue();
    expect(apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id)?.lastUsedAt).toBeNull();
    resolveBearer(secret);
    expect(apiKeyStore.findIn(DEFAULT_ORGANIZATION_ID, key.id)?.lastUsedAt).not.toBeNull();
  });
});

describe("adoption from OATHRION_API_KEYS", () => {
  const ADOPTED = "adopted-integration-key-0001";

  afterEach(() => {
    resetAuthConfig();
  });

  it("still authenticates a key configured in the environment", () => {
    withApiKeys(`Adopted Bot:operator:${ADOPTED}`, () => {
      const identity = resolveBearer(ADOPTED);
      expect(identity).toMatchObject({ name: "Adopted Bot", kind: "service", role: "operator" });
      // And it landed in the table hashed, not in clear.
      const stored = apiKeyStore.resolve(hashKey(ADOPTED));
      expect(stored?.source).toBe("config");
      expect(stored?.prefix).toBe("env:");
    });
  });

  it("applies a value changed in the environment, and retires the old one", () => {
    const rotated = "rotated-integration-key-0002";
    withApiKeys(`Adopted Bot:operator:${ADOPTED}`, () => {
      expect(resolveBearer(ADOPTED)).not.toBeNull();
    });
    withApiKeys(`Adopted Bot:operator:${rotated}`, () => {
      // Editing the file and restarting is how an operator rotated a machine credential
      // before P0-5. It has to keep working, and the previous value has to stop working.
      expect(resolveBearer(rotated)).not.toBeNull();
      expect(resolveBearer(ADOPTED)).toBeNull();
    });
  });

  it("revokes a key whose line has been deleted", () => {
    withApiKeys(`Adopted Bot:operator:${ADOPTED},Second Bot:viewer:second-integration-key-0003`, () => {
      expect(resolveBearer("second-integration-key-0003")).not.toBeNull();
    });
    withApiKeys(`Adopted Bot:operator:${ADOPTED}`, () => {
      /*
       * The property most likely to have been lost by this migration: before P0-5 the
       * deletion *was* the revocation, and a database row would happily outlive it.
       */
      expect(resolveBearer("second-integration-key-0003")).toBeNull();
      const stored = apiKeyStore.resolve(hashKey("second-integration-key-0003"));
      expect(stored?.revokedReason).toBe("removed from configuration");
      // Revoked, not deleted: the audit log names this key as the actor of past decisions.
      expect(stored).toBeDefined();
    });
  });

  it("brings a key back when its line is restored", () => {
    withApiKeys("Adopted Bot:operator:third-integration-key-0004", () => {
      expect(resolveBearer("third-integration-key-0004")).not.toBeNull();
    });
    withApiKeys("Unrelated Bot:viewer:unrelated-integration-key-05", () => {
      expect(resolveBearer("third-integration-key-0004")).toBeNull();
    });
    withApiKeys("Adopted Bot:operator:third-integration-key-0004", () => {
      // Otherwise a deletion would be irreversible without hand-written SQL.
      expect(resolveBearer("third-integration-key-0004")).not.toBeNull();
    });
  });

  it("never revokes a key issued through the product", () => {
    const { secret } = issue({ name: "Console-issued" });
    withApiKeys("Adopted Bot:operator:fourth-integration-key-006", () => {
      /*
       * The environment has no opinion about a key it did not create — there is no
       * plaintext of this one in any file. A restart that revoked the customer's own keys
       * would be indistinguishable from an outage.
       */
      expect(resolveBearer(secret)).not.toBeNull();
    });
  });

  it("is idempotent across repeated boots", () => {
    withApiKeys(`Adopted Bot:operator:${ADOPTED}`, () => {
      resetAuthConfig();
      resolveBearer(ADOPTED);
      resetAuthConfig();
      resolveBearer(ADOPTED);
      const matching = apiKeyStore
        .listBySource("config")
        .filter((k) => k.secretHash === hashKey(ADOPTED));
      expect(matching).toHaveLength(1);
      expect(resolveBearer(ADOPTED)).not.toBeNull();
    });
  });
});

describe("no key is left in the environment path", () => {
  beforeEach(() => {
    resetAuthConfig();
  });

  it("resolves the suite's own configured keys through the table", () => {
    // The test harness configures several keys. After P0-5 every one of them must be
    // resolvable *from the database* — if any still worked only through the old
    // in-memory loop, this would pass while the loop was still there.
    const configured = (process.env.OATHRION_API_KEYS ?? "").split(",").filter(Boolean);
    expect(configured.length).toBeGreaterThan(1);
    resolveBearer("prime-the-configuration");
    for (const entry of configured) {
      const secret = entry.slice(entry.lastIndexOf(":") + 1);
      expect(apiKeyStore.resolve(hashKey(secret)), `configured key "${entry}" is not in the table`).toBeDefined();
    }
  });
});
