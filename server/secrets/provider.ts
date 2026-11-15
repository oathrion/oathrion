/**
 * SecretProvider — the single door through which a secret enters the process (S1).
 *
 * ## Why an abstraction rather than `process.env.FOO`
 *
 * Scattered `process.env` reads are not a style problem, they are three concrete ones:
 * a missing secret surfaces as `undefined` flowing into a crypto function instead of a
 * refusal at the point of failure; nothing can enumerate what the deployment actually
 * requires; and swapping in a real secret manager later means finding every read site.
 * One interface fixes all three, and it is small enough to be honest about.
 *
 * ## What is real here, and what is not
 *
 * `EnvSecretProvider` is real and is the only implementation. It reads the environment,
 * which is the correct source for development, tests, containers and CI.
 *
 * **No cloud provider is implemented, and none is pretended.** There is no AWS Secrets
 * Manager, no Vault, no GCP Secret Manager, no Azure Key Vault in this file or anywhere
 * in the repository. `SECRET_PROVIDER=vault` does not silently fall back to the
 * environment — it refuses to start and says the implementation does not exist. A
 * provider that quietly degraded to `process.env` would be the worst outcome available:
 * an operator would believe their secrets came from a managed store while they sat in
 * the container's environment.
 *
 * What this file does provide is the seam. Adding a real provider means implementing this
 * interface and registering it in `resolveSecretProvider` — no call site changes.
 */

import "../env-compat";

export class MissingSecretError extends Error {
  constructor(
    readonly secretName: string,
    detail: string,
  ) {
    super(
      `Required secret "${secretName}" is not available.\n  ${detail}\n` +
        `  The value is never defaulted, generated, or guessed: a secret with a fallback is not a secret.`,
    );
    this.name = "MissingSecretError";
  }
}

export class SecretProviderConfigError extends Error {}

export interface SecretProvider {
  /**
   * Returns the secret, or throws `MissingSecretError`.
   *
   * Throwing is the point. The alternative — returning `undefined` and letting the
   * caller decide — is how an empty encryption key reaches a cipher, and how a blank
   * signing secret produces tokens that validate against each other and nothing else.
   */
  get(name: string): Promise<string>;

  /**
   * Returns the secret or `null`, for genuinely optional configuration.
   *
   * Separate method rather than a flag, so that reading a secret optionally is a visible
   * decision at the call site rather than an argument someone can leave on by habit.
   */
  getOptional(name: string): Promise<string | null>;

  /** Human-readable source, for boot logs and error messages. Never contains a value. */
  readonly description: string;
}

/**
 * Reads secrets from an environment map.
 *
 * Blank and whitespace-only values are treated as absent. A variable set to `""` is
 * almost always a deployment template that failed to interpolate, and accepting it would
 * mean encrypting with an empty key rather than refusing to start.
 */
export class EnvSecretProvider implements SecretProvider {
  readonly description = "environment variables";

  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async get(name: string): Promise<string> {
    const value = await this.getOptional(name);
    if (value === null) {
      throw new MissingSecretError(
        name,
        `Set the environment variable ${name}. Source: ${this.description}.`,
      );
    }
    return value;
  }

  async getOptional(name: string): Promise<string | null> {
    const raw = this.env[name];
    if (raw === undefined) return null;
    const trimmed = raw.trim();
    return trimmed === "" ? null : trimmed;
  }
}

/**
 * The providers that exist. Deliberately a list of one.
 *
 * Named values that are *recognised but unimplemented* are listed separately below so
 * that `SECRET_PROVIDER=aws` produces "not implemented in this build" rather than
 * "unknown value" — the difference matters to an operator reading the message.
 */
export const IMPLEMENTED_SECRET_PROVIDERS = ["env"] as const;

const RECOGNISED_BUT_UNIMPLEMENTED = ["aws", "aws-secrets-manager", "vault", "gcp", "azure"];

export function resolveSecretProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  const raw = env.SECRET_PROVIDER?.trim().toLowerCase();

  if (raw === undefined || raw === "" || raw === "env") {
    return new EnvSecretProvider(env);
  }

  if (RECOGNISED_BUT_UNIMPLEMENTED.includes(raw)) {
    throw new SecretProviderConfigError(
      `SECRET_PROVIDER is "${raw}", which Oathrion does not implement in this build.\n` +
        `  There is no ${raw} integration in this repository. Rather than reading your secrets from ` +
        `the environment while reporting a managed secret store, Oathrion refuses to start.\n` +
        `  Implemented: ${IMPLEMENTED_SECRET_PROVIDERS.join(", ")}.\n` +
        `  Adding one means implementing the SecretProvider interface in server/secrets/provider.ts; ` +
        `no call site needs to change.`,
    );
  }

  throw new SecretProviderConfigError(
    `SECRET_PROVIDER is "${raw}", which is not a value Oathrion recognises. ` +
      `Implemented: ${IMPLEMENTED_SECRET_PROVIDERS.join(", ")}. ` +
      `An unrecognised value stops the server rather than falling back to a source you did not choose.`,
  );
}
