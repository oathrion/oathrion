/**
 * SecretProvider and envelope encryption (S1).
 *
 * These tests are the reason the modules can be trusted at all: a crypto module that is
 * only exercised on its happy path proves that it can encrypt, not that it can refuse.
 * Most of what follows is failure cases — wrong key, altered bytes, wrong tenant, missing
 * key, malformed record — because those are the paths that matter when a database is
 * dumped or a row is edited.
 */

import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  EnvSecretProvider,
  MissingSecretError,
  SecretProviderConfigError,
  resolveSecretProvider,
} from "../secrets/provider";
import {
  EnvelopeDecryptError,
  EnvelopeFormatError,
  EnvelopeKeyError,
  isEnvelope,
  loadKeyring,
  openSecret,
  rewrap,
  sealSecret,
  secretEquals,
  type Keyring,
} from "../secrets/envelope";

const KEK_A = randomBytes(32).toString("base64");
const KEK_B = randomBytes(32).toString("base64");
const CONTEXT = "integration:org_acme:int_stripe";
const SECRET = "sk_live_51H8xQ2example_credential_value";

async function keyringWith(env: NodeJS.ProcessEnv): Promise<Keyring> {
  return loadKeyring(new EnvSecretProvider(env));
}

describe("SecretProvider", () => {
  it("reads a secret from the environment", async () => {
    const provider = new EnvSecretProvider({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    expect(await provider.get("OATHRION_KEK")).toBe(KEK_A);
  });

  it("throws a named error for a missing secret rather than returning undefined", async () => {
    const provider = new EnvSecretProvider({} as NodeJS.ProcessEnv);
    await expect(provider.get("OATHRION_KEK")).rejects.toThrow(MissingSecretError);
  });

  it("says which secret is missing and where it comes from", async () => {
    const provider = new EnvSecretProvider({} as NodeJS.ProcessEnv);
    await expect(provider.get("OATHRION_KEK")).rejects.toThrow(/OATHRION_KEK/);
    await expect(provider.get("OATHRION_KEK")).rejects.toThrow(/environment variables/);
  });

  /*
   * A variable set to the empty string is a deployment template that failed to
   * interpolate. Accepting it would mean encrypting with an empty key.
   */
  it("treats blank and whitespace-only values as absent", async () => {
    const provider = new EnvSecretProvider({ A: "", B: "   " } as NodeJS.ProcessEnv);
    expect(await provider.getOptional("A")).toBeNull();
    expect(await provider.getOptional("B")).toBeNull();
    await expect(provider.get("A")).rejects.toThrow(MissingSecretError);
  });

  it("never invents a default", async () => {
    const provider = new EnvSecretProvider({} as NodeJS.ProcessEnv);
    expect(await provider.getOptional("OATHRION_KEK")).toBeNull();
  });

  it("defaults to the environment provider", () => {
    expect(resolveSecretProvider({} as NodeJS.ProcessEnv).description).toBe(
      "environment variables",
    );
  });

  /*
   * The important one. A cloud provider name must not silently degrade to process.env,
   * because the operator would believe their secrets came from a managed store.
   */
  it("refuses an unimplemented cloud provider instead of falling back to the environment", () => {
    for (const name of ["aws", "vault", "gcp", "azure", "aws-secrets-manager"]) {
      expect(() =>
        resolveSecretProvider({ SECRET_PROVIDER: name } as NodeJS.ProcessEnv),
      ).toThrow(SecretProviderConfigError);
    }
  });

  it("says the provider is not implemented rather than merely unknown", () => {
    try {
      resolveSecretProvider({ SECRET_PROVIDER: "vault" } as NodeJS.ProcessEnv);
      throw new Error("should have refused");
    } catch (error) {
      expect((error as Error).message).toMatch(/does not implement/i);
      expect((error as Error).message).toMatch(/refuses to start/i);
    }
  });

  it("refuses an unrecognised value", () => {
    expect(() =>
      resolveSecretProvider({ SECRET_PROVIDER: "banana" } as NodeJS.ProcessEnv),
    ).toThrow(SecretProviderConfigError);
  });
});

describe("keyring", () => {
  it("loads the active key and defaults its id", async () => {
    const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    expect(keyring.activeKekId).toBe("1");
    expect(keyring.keys.size).toBe(1);
  });

  it("refuses a KEK that is not 32 bytes rather than stretching it", async () => {
    const short = randomBytes(16).toString("base64");
    await expect(keyringWith({ OATHRION_KEK: short } as NodeJS.ProcessEnv)).rejects.toThrow(
      EnvelopeKeyError,
    );
  });

  it("does not echo the key material in the error", async () => {
    const short = randomBytes(16).toString("base64");
    await expect(keyringWith({ OATHRION_KEK: short } as NodeJS.ProcessEnv)).rejects.toThrow(
      /16 bytes/,
    );
    try {
      await keyringWith({ OATHRION_KEK: short } as NodeJS.ProcessEnv);
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });

  it("refuses a missing KEK", async () => {
    await expect(keyringWith({} as NodeJS.ProcessEnv)).rejects.toThrow(MissingSecretError);
  });

  it("refuses a kekId that would corrupt the envelope format", async () => {
    await expect(
      keyringWith({ OATHRION_KEK: KEK_A, OATHRION_KEK_ID: "v1.2" } as NodeJS.ProcessEnv),
    ).rejects.toThrow(EnvelopeKeyError);
  });

  it("loads retired keys so old records stay readable", async () => {
    const keyring = await keyringWith({
      OATHRION_KEK: KEK_B,
      OATHRION_KEK_ID: "2",
      OATHRION_KEK_RETIRED_IDS: "1",
      OATHRION_KEK_1: KEK_A,
    } as NodeJS.ProcessEnv);
    expect(keyring.activeKekId).toBe("2");
    expect([...keyring.keys.keys()].sort()).toEqual(["1", "2"]);
  });

  it("refuses when a listed retired key is not supplied", async () => {
    await expect(
      keyringWith({
        OATHRION_KEK: KEK_B,
        OATHRION_KEK_ID: "2",
        OATHRION_KEK_RETIRED_IDS: "1",
      } as NodeJS.ProcessEnv),
    ).rejects.toThrow(MissingSecretError);
  });
});

describe("envelope encryption", () => {
  it("round-trips a secret", async () => {
    const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    const sealed = sealSecret(keyring, CONTEXT, SECRET);
    expect(openSecret(keyring, CONTEXT, sealed)).toBe(SECRET);
  });

  it("does not leave the plaintext in the stored record", async () => {
    const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    const sealed = sealSecret(keyring, CONTEXT, SECRET);
    expect(sealed).not.toContain(SECRET);
    expect(sealed).not.toContain("sk_live");
  });

  it("produces the documented eight-field versioned format", async () => {
    const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    const sealed = sealSecret(keyring, CONTEXT, SECRET);
    const parts = sealed.split(".");
    expect(parts).toHaveLength(8);
    expect(parts[0]).toBe("aria-env-v1");
    expect(parts[1]).toBe("1");
    expect(isEnvelope(sealed)).toBe(true);
  });

  /*
   * A fresh DEK and IV per call. If either were reused, two identical plaintexts would
   * produce identical ciphertexts — and under GCM, IV reuse under one key is a total
   * break, not a weakness.
   */
  it("uses fresh key material for every value", async () => {
    const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const sealed = sealSecret(keyring, CONTEXT, SECRET);
      const [, , wrapIv, wrappedDek, , iv, ciphertext] = sealed.split(".");
      // Same plaintext, same context, same key: everything below must still differ.
      expect(seen.has(iv)).toBe(false);
      expect(seen.has(wrapIv)).toBe(false);
      expect(seen.has(wrappedDek)).toBe(false);
      expect(seen.has(ciphertext)).toBe(false);
      seen.add(iv).add(wrapIv).add(wrappedDek).add(ciphertext);
    }
  });

  it("handles empty, unicode and long values", async () => {
    const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
    for (const value of ["", "clé—très—unicode 🔐", "x".repeat(100_000)]) {
      expect(openSecret(keyring, CONTEXT, sealSecret(keyring, CONTEXT, value))).toBe(value);
    }
  });

  describe("refusals", () => {
    it("fails with the wrong KEK", async () => {
      const a = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const b = await keyringWith({ OATHRION_KEK: KEK_B } as NodeJS.ProcessEnv);
      const sealed = sealSecret(a, CONTEXT, SECRET);
      expect(() => openSecret(b, CONTEXT, sealed)).toThrow(EnvelopeDecryptError);
    });

    it("fails on an altered ciphertext", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const parts = sealSecret(keyring, CONTEXT, SECRET).split(".");
      const bytes = Buffer.from(parts[6], "base64url");
      bytes[0] ^= 0x01;
      parts[6] = bytes.toString("base64url");
      expect(() => openSecret(keyring, CONTEXT, parts.join("."))).toThrow(EnvelopeDecryptError);
    });

    it("fails on an altered authentication tag", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const parts = sealSecret(keyring, CONTEXT, SECRET).split(".");
      const bytes = Buffer.from(parts[7], "base64url");
      bytes[0] ^= 0x01;
      parts[7] = bytes.toString("base64url");
      expect(() => openSecret(keyring, CONTEXT, parts.join("."))).toThrow(EnvelopeDecryptError);
    });

    it("fails on an altered wrapped DEK", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const parts = sealSecret(keyring, CONTEXT, SECRET).split(".");
      const bytes = Buffer.from(parts[3], "base64url");
      bytes[0] ^= 0x01;
      parts[3] = bytes.toString("base64url");
      expect(() => openSecret(keyring, CONTEXT, parts.join("."))).toThrow(EnvelopeDecryptError);
    });

    it("fails on an altered IV", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const parts = sealSecret(keyring, CONTEXT, SECRET).split(".");
      const bytes = Buffer.from(parts[5], "base64url");
      bytes[0] ^= 0x01;
      parts[5] = bytes.toString("base64url");
      expect(() => openSecret(keyring, CONTEXT, parts.join("."))).toThrow(EnvelopeDecryptError);
    });

    /*
     * The tenant-binding property. Without AAD, this ciphertext would decrypt into
     * another organisation's row: the bytes are authentic, just not for that record.
     */
    it("refuses a ciphertext moved to another tenant's row", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const sealed = sealSecret(keyring, "integration:org_acme:int_stripe", SECRET);
      expect(() =>
        openSecret(keyring, "integration:org_rival_corp:int_stripe", sealed),
      ).toThrow(EnvelopeDecryptError);
    });

    it("refuses a ciphertext moved to another record in the same tenant", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const sealed = sealSecret(keyring, "integration:org_acme:int_stripe", SECRET);
      expect(() => openSecret(keyring, "integration:org_acme:int_slack", sealed)).toThrow(
        EnvelopeDecryptError,
      );
    });

    it("requires a non-empty context rather than defaulting one", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      expect(() => sealSecret(keyring, "", SECRET)).toThrow(EnvelopeFormatError);
      expect(() => sealSecret(keyring, "   ", SECRET)).toThrow(EnvelopeFormatError);
    });

    it("refuses a context containing the field separator", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      expect(() => sealSecret(keyring, "integration:org.acme:x", SECRET)).toThrow(
        EnvelopeFormatError,
      );
    });

    it("reports a malformed record as a format error, not a crypto failure", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      for (const bad of ["", "plain text credential", "a.b.c", "aria-env-v1.1.a.b.c.d.e"]) {
        expect(() => openSecret(keyring, CONTEXT, bad)).toThrow(EnvelopeFormatError);
      }
    });

    it("refuses an unknown format version instead of reinterpreting it", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const sealed = sealSecret(keyring, CONTEXT, SECRET).replace("aria-env-v1", "aria-env-v9");
      expect(() => openSecret(keyring, CONTEXT, sealed)).toThrow(/Unsupported envelope format/);
    });

    /*
     * A missing key is an operational condition, so it is distinguished. Wrong key versus
     * tampered data is NOT distinguished, so probing the store reveals nothing.
     */
    it("distinguishes a missing key from an authentication failure", async () => {
      const a = await keyringWith({ OATHRION_KEK: KEK_A, OATHRION_KEK_ID: "7" } as NodeJS.ProcessEnv);
      const sealed = sealSecret(a, CONTEXT, SECRET);
      const other = await keyringWith({ OATHRION_KEK: KEK_B, OATHRION_KEK_ID: "9" } as NodeJS.ProcessEnv);
      expect(() => openSecret(other, CONTEXT, sealed)).toThrow(EnvelopeKeyError);
      expect(() => openSecret(other, CONTEXT, sealed)).toThrow(/OATHRION_KEK_7/);
    });

    it("never returns a partial plaintext on failure", async () => {
      const a = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const b = await keyringWith({ OATHRION_KEK: KEK_B } as NodeJS.ProcessEnv);
      const sealed = sealSecret(a, CONTEXT, SECRET);
      let returned: string | undefined;
      try {
        returned = openSecret(b, CONTEXT, sealed);
      } catch {
        returned = undefined;
      }
      expect(returned).toBeUndefined();
    });
  });

  describe("KEK rotation", () => {
    it("re-wraps under the new KEK and the value still opens", async () => {
      const before = await keyringWith({ OATHRION_KEK: KEK_A, OATHRION_KEK_ID: "1" } as NodeJS.ProcessEnv);
      const sealed = sealSecret(before, CONTEXT, SECRET);

      const after = await keyringWith({
        OATHRION_KEK: KEK_B,
        OATHRION_KEK_ID: "2",
        OATHRION_KEK_RETIRED_IDS: "1",
        OATHRION_KEK_1: KEK_A,
      } as NodeJS.ProcessEnv);

      // Old records are readable throughout: there is no window of unavailability.
      expect(openSecret(after, CONTEXT, sealed)).toBe(SECRET);

      const rotated = rewrap(after, CONTEXT, sealed);
      expect(rotated.split(".")[1]).toBe("2");
      expect(openSecret(after, CONTEXT, rotated)).toBe(SECRET);
    });

    /*
     * The property that makes envelope encryption worth the extra layer: rotation touches
     * the wrapped DEK only. If the data ciphertext changed, the plaintext would have been
     * decrypted and re-encrypted, which is the expensive rotation this design avoids.
     */
    it("leaves the data ciphertext, IV and tag byte-identical", async () => {
      const before = await keyringWith({ OATHRION_KEK: KEK_A, OATHRION_KEK_ID: "1" } as NodeJS.ProcessEnv);
      const sealed = sealSecret(before, CONTEXT, SECRET);
      const after = await keyringWith({
        OATHRION_KEK: KEK_B,
        OATHRION_KEK_ID: "2",
        OATHRION_KEK_RETIRED_IDS: "1",
        OATHRION_KEK_1: KEK_A,
      } as NodeJS.ProcessEnv);

      const oldParts = sealed.split(".");
      const newParts = rewrap(after, CONTEXT, sealed).split(".");

      expect(newParts[5]).toBe(oldParts[5]); // iv
      expect(newParts[6]).toBe(oldParts[6]); // ciphertext
      expect(newParts[7]).toBe(oldParts[7]); // tag
      // Only the wrapping layer changed.
      expect(newParts[1]).not.toBe(oldParts[1]);
      expect(newParts[3]).not.toBe(oldParts[3]);
    });

    it("is idempotent, so a rotation pass can be re-run or resumed", async () => {
      const keyring = await keyringWith({ OATHRION_KEK: KEK_A } as NodeJS.ProcessEnv);
      const sealed = sealSecret(keyring, CONTEXT, SECRET);
      expect(rewrap(keyring, CONTEXT, sealed)).toBe(sealed);
    });

    it("cannot re-wrap a record whose old KEK is gone", async () => {
      const before = await keyringWith({ OATHRION_KEK: KEK_A, OATHRION_KEK_ID: "1" } as NodeJS.ProcessEnv);
      const sealed = sealSecret(before, CONTEXT, SECRET);
      const after = await keyringWith({ OATHRION_KEK: KEK_B, OATHRION_KEK_ID: "2" } as NodeJS.ProcessEnv);
      expect(() => rewrap(after, CONTEXT, sealed)).toThrow(EnvelopeKeyError);
    });
  });
});

describe("secretEquals", () => {
  it("compares equal and unequal values", () => {
    expect(secretEquals("abc", "abc")).toBe(true);
    expect(secretEquals("abc", "abd")).toBe(false);
    expect(secretEquals("abc", "abcd")).toBe(false);
    expect(secretEquals("", "")).toBe(true);
  });
});
