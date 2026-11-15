/**
 * Oathrion authentication and authorisation — the control plane's front door.
 *
 * Two caller shapes, one identity model:
 *
 *  1. **Service callers** (agents, CI, integrations) send a long-lived API key:
 *     `Authorization: Bearer <api-key>`. Keys live only in the server process,
 *     declared in `OATHRION_API_KEYS` as `name:role:key`. They are never sent to,
 *     or embedded in, the browser bundle.
 *
 *  2. **Console users** (the web UI) exchange a password for a server-side
 *     session at `POST /api/auth/login`. The returned token is
 *     `<sessionId>.<hmac>`: the signature makes it unforgeable, the stored row
 *     makes it revocable. The frontend keeps it in React memory only — no
 *     localStorage, no cookie, no secret compiled into the bundle.
 *
 * Every authenticated request carries a resolved `Identity` with a `role`.
 * The role is derived from the presented credential and from nothing else:
 * there is no request field, header or claim a client can set to widen it.
 * Anything that records *who did this* — most importantly `approval.resolvedBy`
 * — reads that identity, never a client-supplied field.
 *
 * There are no fallback credentials. A missing or weak secret is a startup
 * failure, not a warning.
 */

import { CONSOLE_HEADER, lacksConsoleHeader, readSessionCookie } from "./session-cookie";
import crypto from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { can, capabilitiesOf, denialMessage, isRole, type Capability, type Role } from "@shared/roles";
import { sessionStore, type SessionRecord } from "./repositories/sessions";
import { organizationStore } from "./repositories/organizations";
import { normaliseEmail, userStore, type UserRecord } from "./repositories/users";
import { apiKeyStore, isExpired } from "./repositories/api-keys";
import { hashKey, displayPrefixOf } from "./api-keys";
import { hashPassword, needsRehash, spendVerificationTime, verifyPassword } from "./passwords";
import {
  DEFAULT_ORGANIZATION_ID,
  organizationNameProblem,
  type OrganizationId,
} from "@shared/tenancy";
import { quotaStore, resetRateLimits } from "./rate-limit";
import { sendApiError } from "./api-error";
import { ERROR_CODES } from "@shared/error-codes";
import "./env-compat";
import { increment } from "./observability/metrics";
import { timedSync } from "./observability/timing";

export type IdentityKind = "service" | "user";

export interface Identity {
  /** Stable identifier, e.g. `svc:ci` or `user:jane`. */
  id: string;
  /** Human-readable name written into audit trails. */
  name: string;
  kind: IdentityKind;
  /** Determined server-side from the credential. Never client-supplied. */
  role: Role;
  /**
   * The tenant this caller acts within, resolved from the credential and from
   * nothing else. There is deliberately no way to override it per request — no
   * header, no query parameter, no body field — because any such switch is a
   * cross-tenant access path that only needs one authorisation bug to open.
   */
  organizationId: OrganizationId;
  /** Present for console callers: the session this request rides on. */
  sessionId?: string;
  /**
   * The one agent this credential speaks for, or `null`/absent when unbound.
   *
   * Read from the credential row and from nothing else — there is no header,
   * body field or query parameter that can set or widen it, for the same reason
   * `organizationId` has none. A caller may *name* an agent in a request, but
   * that value is only ever compared against this one; see
   * `server/identity/agent-binding.ts`.
   *
   * Always `null` for console sessions: a human administrator is not an agent,
   * and confining one to a single agent would break the console rather than
   * secure it. The reasoning is in the binding module's header.
   */
  agentId?: string | null;
}

declare module "express-serve-static-core" {
  interface Request {
    /** Set by `authenticate()`. Present on every route behind the middleware. */
    identity?: Identity;
  }
}

/* ------------------------------- Configuration ---------------------------- */

const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;
const MIN_SECRET_LENGTH = 16;
const MIN_CREDENTIAL_LENGTH = 12;

/**
 * Values that shipped as documented demo credentials, plus the usual suspects.
 * Refusing them by name is blunt, and that is the point: a pilot must not boot
 * on a password that was printed in a README.
 *
 * Exported — and nothing else about this module changed — so that
 * `server/bootstrap-admin.ts` refuses exactly the same values as the boot check.
 * The alternative was a second copy of the list, which would have meant two
 * definitions of "refused credential" drifting apart, with the weaker of the two
 * being the one that creates administrators.
 */
export const FORBIDDEN_CREDENTIALS = new Set([
  "placet-demo",
  "placet-dev-key",
  // Conservés du nommage ARIA, pour la même raison que les valeurs AgentOS ci-dessous :
  // ces chaînes ont été publiées dans la documentation précédente et dorment
  // certainement dans de vrais fichiers .env. Un secret refusé doit le RESTER à travers
  // un renommage, donc cette liste ne fait que grandir et ne rétrécit jamais. C'est la
  // différence entre retirer un alias de confort et retirer une protection.
  "aria-demo",
  "aria-dev-key",
  // Kept from the AgentOS naming: these strings were published in the previous
  // README and are certainly sitting in real .env files. A refused secret must
  // stay refused across a rename, so the list grows and never shrinks.
  "agentos-demo",
  "agentos-dev-key",
  "changeme",
  "change-me",
  "password",
  "secret",
  "admin",
  "test",
]);

export class AuthConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Oathrion cannot start — authentication is not configured:\n  - ${problems.join("\n  - ")}`);
    this.name = "AuthConfigError";
  }
}

interface ConsoleUser {
  /**
   * The sign-in identifier. Since P0-2 a console user is a row in `users`, keyed by
   * e-mail: a password alone can no longer identify a person, because two people are
   * allowed to choose the same one.
   */
  email: string;
  /** True when the address was derived rather than configured — reported at boot. */
  derivedEmail: boolean;
  name: string;
  role: Role;
  password: string;
  organizationId: OrganizationId;
  organizationName: string;
}

interface ServiceKey {
  id: string;
  name: string;
  role: Role;
  key: string;
  organizationId: OrganizationId;
  organizationName: string;
}

interface AuthConfig {
  secret: string;
  ttlMs: number;
  consoleUsers: ConsoleUser[];
  serviceKeys: ServiceKey[];
}

/**
 * A principal before its organization's identifier is known.
 *
 * The two phases are a consequence of migration 18. Identifiers stopped being derived
 * from names, so they can only come from the registry — and `build()` must stay a pure
 * function of the environment, because `authConfigProblems()` calls it at boot to
 * report a misconfiguration, possibly before any database is reachable. So `build()`
 * produces drafts, and `resolveOrganizations()` — called from `config()`, which is the
 * single gate every consumer passes through — turns them into principals carrying a
 * real identifier.
 *
 * Expressed as `Omit` rather than as a second hand-written interface on purpose: a
 * field added to `ConsoleUser` later cannot be forgotten here, and the compiler will
 * not let a draft be used where a resolved principal is expected.
 */
type Unresolved<T> = Omit<T, "organizationId">;

interface AuthConfigDraft {
  secret: string;
  ttlMs: number;
  consoleUsers: Unresolved<ConsoleUser>[];
  serviceKeys: Unresolved<ServiceKey>[];
}

/**
 * `Name:role:secret` — the shared shape of both credential lists.
 *
 * ROOT CAUSE OF THE HISTORICAL "INCORRECT PASSWORD" REPORT
 * -------------------------------------------------------
 * This function used to call `.trim()` on the parsed secret. That single call is
 * the mechanism behind operators reporting that the password they configured is
 * rejected: an `OATHRION_CONSOLE_USERS` value written as
 *
 *     Alice:admin: my-passphrase
 *
 * (a stray space after the colon, which is how people naturally format lists)
 * stored `my-passphrase` while the operator believed the password was
 * ` my-passphrase`. Configuration validated cleanly, the server booted healthy,
 * and every login attempt with the value from the env file failed — with no
 * diagnostic anywhere, because from the server's point of view nothing was wrong.
 *
 * The fix is deliberately NOT to trim both sides at comparison time. That would
 * make the password ambiguous (two different strings would open the same session)
 * and would silently weaken authentication to paper over a configuration bug.
 * Instead the ambiguity is refused at boot, loudly, with an accurate message.
 * `safeEqual` and the comparison path are untouched.
 *
 * A second, related mechanism: a password containing `,` is split, because `,`
 * separates entries. That was already loud — the fragments fail validation and the
 * server refuses to start — but the message read "the secret is shorter than 12
 * characters", which is unactionable when the operator is looking at a
 * 20-character password. An operator who cannot reach the real cause from the
 * error text is an operator who eventually adds a permissive fallback, so the
 * message now names the comma explicitly.
 *
 * See `server/auth-credential-parsing.test.ts` for the proof of each mechanism.
 */
function parseTriples(raw: string | undefined, label: string, problems: string[]) {
  const out: {
    name: string;
    role: Role;
    secret: string;
    /** The name as typed. Its identifier is resolved later — see the block below. */
    organizationName: string;
  }[] = [];
  if (!raw?.trim()) return out;

  const entries = raw.split(",");
  /*
   * Only offered when the value actually contains a separator, so the hint cannot
   * misdirect someone whose single entry is simply malformed.
   */
  const commaHint =
    entries.length > 1
      ? ` If a secret in this list contains a comma, that is the cause: "," separates entries,` +
        ` so the value was split into fragments. Remove the comma from the secret.`
      : "";

  for (const [index, rawEntry] of entries.entries()) {
    if (!rawEntry.trim()) continue;

    /*
     * Line breaks around an entry are formatting — operators write these lists
     * across multiple lines — so they are stripped. Spaces adjacent to a secret are
     * NOT stripped, because there they are ambiguous rather than decorative. That
     * asymmetry is the whole fix, so it is spelled out rather than folded into a
     * single `.trim()`.
     */
    const entry = rawEntry.replace(/^[\r\n]+|[\r\n]+$/g, "");
    const position = `entry #${index + 1}`;

    const parts = entry.split(":");
    if (parts.length < 3) {
      // The entry is never echoed. It used to be truncated to 12 characters, which
      // for a split password fragment meant printing part of the secret into the
      // log — a secret leak inside an error message.
      problems.push(`${label}: ${position} is not in "name:role:secret" form.${commaHint}`);
      continue;
    }

    /*
     * TENANT PREFIX — `Organization/Name:role:secret`
     *
     * The organization is written as an optional prefix on the NAME field, separated
     * by "/", rather than as a fourth colon-separated field. That is not a style
     * choice: secrets may legitimately contain ":" (everything after the role is the
     * secret), so a fourth colon field would be indistinguishable from a secret
     * beginning with a colon and would silently truncate real passwords.
     *
     * No prefix means the default organization, so every existing single-tenant
     * configuration keeps working unchanged.
     */
    const rawName = parts[0].trim();
    const slash = rawName.indexOf("/");
    const organizationName = slash >= 0 ? rawName.slice(0, slash).trim() : "";
    const name = (slash >= 0 ? rawName.slice(slash + 1) : rawName).trim();
    const role = parts[1].trim();

    /*
     * The organization's IDENTIFIER is deliberately not computed here any more.
     *
     * Until migration 18 this line read `organizationIdFromName(organizationName)`, so
     * "Acme Corp" became `org_acme_corp` — which leaked the customer's name into every
     * log line, audit row and receipt. Identifiers are now opaque and are resolved from
     * the name by a lookup (`organizationStore.ensureByName`, called by
     * `resolveOrganizations` below). Parsing is a pure function of the environment with
     * no database access, so the most it can do is refuse a name that could never be a
     * lookup key.
     *
     * One consequence is an improvement rather than a trade-off: the old check refused
     * any name whose slug was not a valid identifier, which mangled or rejected real
     * legal names — accents, apostrophes, non-Latin scripts. A name is now stored as
     * typed, and only its normalised form is a key.
     */
    if (organizationName === "" && slash >= 0) {
      problems.push(
        `${label}: ${position} has an empty organization before "/". Write ` +
          `"Organization/Name:role:secret", or omit the prefix to use the default organization.`,
      );
      continue;
    }
    if (organizationName !== "") {
      const nameProblem = organizationNameProblem(organizationName);
      if (nameProblem !== null) {
        problems.push(`${label}: ${position} names an organization, but ${nameProblem}`);
        continue;
      }
    }
    // Secrets may legitimately contain ":" — everything after the role is secret.
    const secret = parts.slice(2).join(":");

    if (!name) {
      problems.push(`${label}: ${position} has an empty name.`);
      continue;
    }
    if (!isRole(role)) {
      problems.push(`${label}: "${role}" is not a role (viewer, operator, approver, admin).`);
      continue;
    }

    if (secret !== secret.trim()) {
      // THE HISTORICAL BUG, now visible. An internal space is fine and is not
      // touched: "four random common words" is good practice.
      problems.push(
        `${label}: the secret for "${name}" begins or ends with whitespace, which is ambiguous. ` +
          `It is refused rather than silently trimmed, because trimming it is what previously ` +
          `caused correct-looking passwords to be rejected at sign-in. Remove the surrounding ` +
          `whitespace, or quote the whole ${label} value if your shell is adding it.`,
      );
      continue;
    }
    if (secret.length < MIN_CREDENTIAL_LENGTH) {
      problems.push(
        `${label}: the secret for "${name}" is shorter than ${MIN_CREDENTIAL_LENGTH} characters.${commaHint}`,
      );
      continue;
    }
    if (FORBIDDEN_CREDENTIALS.has(secret.toLowerCase())) {
      problems.push(`${label}: the secret for "${name}" is a known demo value and is refused.`);
      continue;
    }

    out.push({ name, role, secret, organizationName });
  }
  return out;
}

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function build(): { config: AuthConfigDraft | null; problems: string[] } {
  const problems: string[] = [];

  const secret = process.env.OATHRION_SESSION_SECRET?.trim() ?? "";
  if (!secret) {
    problems.push("OATHRION_SESSION_SECRET is not set.");
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problems.push(`OATHRION_SESSION_SECRET is shorter than ${MIN_SECRET_LENGTH} characters.`);
  } else if (FORBIDDEN_CREDENTIALS.has(secret.toLowerCase())) {
    problems.push("OATHRION_SESSION_SECRET is a known demo value and is refused.");
  }

  const consoleUsers: Unresolved<ConsoleUser>[] = parseTriples(
    process.env.OATHRION_CONSOLE_USERS,
    "OATHRION_CONSOLE_USERS",
    problems,
  ).map((u) => {
    /*
     * CONFIGURED NAME → SIGN-IN ADDRESS
     *
     * Sign-in now needs an identifier, and existing configurations only carry a
     * display name. Two cases, no third:
     *
     *   - the name is already an e-mail address → it is the identifier;
     *   - otherwise an address is derived, `<name>@<organization>.aria.local`, and
     *     reported at boot with the exact string to sign in with.
     *
     * Deriving silently would lock every existing deployment out of its own console
     * at the next upgrade, which is why `authConfigNotices()` prints it. `.aria.local`
     * is used rather than a plausible domain so nobody mistakes it for a real mailbox
     * or sends anything to it.
     */
    const looksLikeEmail = u.name.includes("@");
    const orgSlug = slug(u.organizationName) || "default";
    return {
      /*
       * `.aria.local` SURVIT au renommage, et c'est la décision la plus importante de
       * tout le lot. Cette adresse est la CLÉ DE CONNEXION de la personne, stockée dans
       * la colonne `email`. La passer à `.placet.local` ferait créer un SECOND compte
       * pour la même personne au démarrage suivant : l'ancien garderait son mot de
       * passe et son rôle, resterait cité dans le journal d'audit comme auteur de
       * décisions, et la personne se connecterait à un compte vide sans comprendre
       * pourquoi. Une ligne écrite ne se renomme pas.
       */
      email: looksLikeEmail ? normaliseEmail(u.name) : `${slug(u.name)}@${orgSlug}.aria.local`,
      derivedEmail: !looksLikeEmail,
      name: u.name,
      role: u.role,
      password: u.secret,
      /*
       * The RAW name, possibly "". The display fallback ("Default organization") is
       * applied by `resolveOrganizations`, not here: this value is the lookup key, and
       * a credential with no prefix must resolve to `org_default` by the empty-prefix
       * rule — not by matching the label a migration happened to write. Applying the
       * fallback at this point made a customer genuinely named "Default organization"
       * resolve to the default tenant.
       */
      organizationName: u.organizationName,
    };
  });

  const serviceKeys: Unresolved<ServiceKey>[] = parseTriples(
    process.env.OATHRION_API_KEYS,
    "OATHRION_API_KEYS",
    problems,
  ).map((k) => ({
    id: `svc:${slug(k.organizationName)}${k.organizationName ? "/" : ""}${slug(k.name)}`,
    name: k.name,
    role: k.role,
    key: k.secret,
    /** The raw name — see the note on the console-user mapping above. */
    organizationName: k.organizationName,
  }));

  /*
   * MECHANISM (c): two credentials sharing one secret.
   *
   * Historically both lists were checked here: `login()` took a password and no
   * username, so a password configured twice signed the operator in as whichever
   * entry was reached first — privilege confusion, refused at boot.
   *
   * Since P0-2 a console sign-in carries an e-mail address, so two console users
   * sharing a password is no longer identity confusion by itself. The refusal is kept
   * anyway, for two reasons that survive the change: an API key is still matched on
   * its value alone, so a duplicate there is silent identity confusion; and a console
   * password that equals an API key means one secret grants two different roles
   * through two different doors. Neither is something an operator does on purpose,
   * and refusing at boot costs a deployment nothing it wanted.
   *
   * Duplicates are reported by NAME only; the shared secret is never in the message.
   */
  const seenSecrets = new Map<string, string>();
  const secretHolders = [
    ...consoleUsers.map((u) => ({ label: `console user "${u.name}"`, secret: u.password })),
    ...serviceKeys.map((k) => ({ label: `API key "${k.name}"`, secret: k.key })),
  ];
  for (const entry of secretHolders) {
    const owner = seenSecrets.get(entry.secret);
    if (owner !== undefined) {
      problems.push(
        `${owner} and ${entry.label} are configured with the same secret. A bearer key is ` +
          `matched on its value alone, and one secret must not grant two different roles. ` +
          `Give each credential its own distinct value.`,
      );
      continue;
    }
    seenSecrets.set(entry.secret, entry.label);
  }

  /*
   * Two configured console users on one address, on the other hand, is still fatal:
   * they would be the same row in `users`, so the second entry's role and password
   * would depend on adoption order. That is the same class of bug as a duplicate key,
   * expressed on the new identifier.
   */
  const seenEmails = new Map<string, string>();
  for (const user of consoleUsers) {
    const owner = seenEmails.get(user.email);
    if (owner !== undefined) {
      problems.push(
        `console users "${owner}" and "${user.name}" resolve to the same sign-in address ` +
          `"${user.email}", so one would overwrite the other. Give them distinct names, or write ` +
          `an explicit e-mail address in place of the name.`,
      );
      continue;
    }
    seenEmails.set(user.email, user.name);
  }

  /*
   * AUCUN IDENTIFIANT DANS L'ENVIRONNEMENT : refusé, SAUF intention déclarée.
   *
   * Le refus protège l'exploitant qui a oublié de configurer quoi que ce soit. Mais un
   * déploiement hébergé crée ses comptes EN BASE — liens `workspace:create`,
   * `bootstrap:admin`, invitations — et n'a aucun mot de passe à mettre dans
   * l'environnement : le refus inconditionnel l'empêchait de démarrer, donc rendait le
   * parcours sans terminal impossible. `OATHRION_ACCOUNTS=database` dit « les comptes
   * viennent de la base » ; sans elle, rien ne change. Démarrer sans compte n'ouvre
   * rien : toute route reste derrière l'authentification.
   */
  if (consoleUsers.length === 0 && serviceKeys.length === 0 && !accountsFromDatabase()) {
    problems.push(
      "No credentials configured. Set OATHRION_CONSOLE_USERS and/or OATHRION_API_KEYS as \"name:role:secret\" lists, " +
        "or set OATHRION_ACCOUNTS=database when accounts are created in the database (npm run workspace:create).",
    );
  }

  const ttlRaw = Number(process.env.OATHRION_SESSION_TTL_MS);
  const ttlMs = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : DEFAULT_TTL_MS;

  if (problems.length > 0) return { config: null, problems };
  return { config: { secret, ttlMs, consoleUsers, serviceKeys }, problems };
}

let cached: AuthConfig | null = null;

/**
 * Validates the environment. Returns the list of problems; empty means ready.
 * Called at boot so a misconfigured deployment fails loudly and immediately
 * instead of silently accepting a default password.
 */
export function authConfigProblems(): string[] {
  return build().problems;
}

/**
 * Makes sure every organization named by a credential exists in the registry.
 *
 * Done once per configuration load, not per request. Without it, a credential
 * written as "Acme/alice:admin:…" would authenticate into the scope `org_acme`
 * while no such row exists — `isActive` refuses that, so the effect would be a
 * correct-looking credential that never works. Registering it here means the
 * environment is the source of truth for *which* tenants exist, and the table is
 * the source of truth for whether each one is currently allowed in.
 */
function resolveOrganizations(draft: AuthConfigDraft): AuthConfig {
  /*
   * Memoised per call, by NAME. Two reasons, and the second is the one that matters:
   * a configuration naming one organization for ten credentials must not perform ten
   * lookups at every boot; and every credential of the same organization must end up
   * with the SAME identifier. Resolving each credential independently would be correct
   * only as long as `ensureByName` is — which it is, but relying on that here would
   * make a future concurrency bug show up as two halves of one tenant.
   */
  const byName = new Map<string, OrganizationId>();

  const resolve = (organizationName: string): OrganizationId => {
    /*
     * The empty prefix still means the default organization, as it always did, and it
     * is NOT looked up by name: `org_default` is created by migration 3 and its name
     * ("Default organization") is a label, not a key. Looking it up by name would make
     * every single-tenant deployment depend on a string in a migration.
     */
    if (organizationName === "") return DEFAULT_ORGANIZATION_ID;

    const cached = byName.get(organizationName);
    if (cached) return cached;

    /*
     * This is the call that replaced `organizationIdFromName`. It finds the tenant that
     * already carries this name, or creates it with an opaque identifier — so the same
     * `OATHRION_CONSOLE_USERS` entry resolves to the same tenant at every boot without the
     * identifier ever being computed from the name.
     *
     * It may throw (`InvalidOrganizationName`, or a database error). It is not caught
     * here: `config()` is called on the authentication path, and a configuration whose
     * organization cannot be resolved must fail the request loudly rather than
     * authenticate the caller into some other scope. The name itself was already
     * validated at parse time, so reaching a throw here means the registry is in a
     * state an operator has to see.
     */
    const organization = organizationStore.ensureByName(organizationName);
    byName.set(organizationName, organization.id);
    return organization.id;
  };

  return {
    secret: draft.secret,
    ttlMs: draft.ttlMs,
    consoleUsers: draft.consoleUsers.map((u) => ({
      ...u,
      organizationId: resolve(u.organizationName),
      organizationName: u.organizationName || "Default organization",
    })),
    serviceKeys: draft.serviceKeys.map((k) => ({
      ...k,
      organizationId: resolve(k.organizationName),
      organizationName: k.organizationName || "Default organization",
    })),
  };
}

/**
 * Adopts every configured console user into the `users` table.
 *
 * Runs once per configuration load. The rules, in order of importance:
 *
 *   1. **An existing account's password is never overwritten by the environment
 *      once its owner has changed it.** `password_source` records that. A stale
 *      entry in an .env file resetting a real password on every restart would be a
 *      persistent account takeover path, and the operator would see nothing.
 *   2. While the source is still `config`, a *changed* environment password is
 *      applied — that is how an operator rotates a credential for someone who has
 *      never signed in.
 *   3. The membership and role are re-applied on every boot, so removing an entry's
 *      role from configuration takes effect. The account itself is not deleted:
 *      deleting it would destroy the audit link from `resolvedBy` to a person.
 *
 * Hashing is skipped when the stored hash already verifies, because scrypt costs
 * ~40 ms and this loop runs on the startup path.
 */
function adoptConfiguredUsers(cfg: AuthConfig): void {
  for (const configured of cfg.consoleUsers) {
    const existing = userStore.findByEmail(configured.email);
    const user =
      existing ??
      userStore.ensure({
        email: configured.email,
        name: configured.name,
        passwordHash: hashPassword(configured.password),
        passwordSource: "config",
      });

    if (
      existing &&
      existing.passwordSource === "config" &&
      !verifyPassword(configured.password, existing.passwordHash)
    ) {
      userStore.setPassword(existing.id, hashPassword(configured.password), "config");
    }
    if (existing && existing.name !== configured.name) userStore.rename(existing.id, configured.name);

    if (existing && existing.status !== "active") userStore.setStatus(existing.id, "active");
    userStore.grant(configured.organizationId, user.id, configured.role);
  }

  /*
   * Reconciliation in the other direction.
   *
   * Before P0-2, deleting a line from OATHRION_CONSOLE_USERS removed that person's access
   * at the next request, and that is the first thing an operator does when an account
   * has to be shut off. Storing users in the database would silently break it: the row
   * would survive the deletion and keep working.
   *
   * So an account the configuration owns — `passwordSource === "config"` — and that
   * the configuration no longer lists is suspended. Suspended, not deleted: the audit
   * trail refers to it, and a deletion would leave dangling references. A suspended
   * account fails `credentialStillValid`, so live sessions stop within one request.
   *
   * Accounts whose owner set their own password are NOT touched here. They were not
   * created by the environment and must not be revoked by it — otherwise the first
   * user who changes their password would be locked out at the next restart.
   */
  const configured = new Set(cfg.consoleUsers.map((u) => normaliseEmail(u.email)));
  for (const owned of userStore.listBySource("config")) {
    if (configured.has(owned.email) || owned.status !== "active") continue;
    userStore.setStatus(owned.id, "suspended");
  }
}

/**
 * Adopts every configured API key into the `api_keys` table — P0-5.
 *
 * Same shape as `adoptConfiguredUsers`, and the same principle: the environment stays
 * authoritative for what it created, and never touches what the product created.
 *
 *   1. A configured key not in the database is inserted, hashed.
 *   2. A configured key whose *value* changed is re-pointed at the new digest. That is
 *      how an operator rotates a machine credential by editing a file, which is the only
 *      way they could do it before P0-5 and must keep working.
 *   3. A key whose line has been deleted is **revoked**. Before P0-5, deleting the line
 *      was the revocation, and it took effect at the next request. Persisting keys would
 *      have silently broken that: the row would outlive the deletion and keep opening the
 *      gateway. Revoked rather than deleted, because executions in the audit log name it
 *      as their actor.
 *   4. A key issued through the console (`source = "user"`) is never inserted, re-pointed
 *      or revoked here. It has no plaintext in any file, so the environment has no
 *      opinion about it — and a restart that revoked the customer's own keys would be
 *      indistinguishable from an outage.
 *
 * Unlike password adoption there is no hashing cost to avoid: SHA-256 of a handful of
 * keys is immeasurable, so a changed value is detected by comparing digests directly.
 */
function adoptConfiguredKeys(cfg: AuthConfig): void {
  for (const configured of cfg.serviceKeys) {
    const hash = hashKey(configured.key);
    const prefix = displayPrefixOf(configured.key);
    const byId = apiKeyStore.listBySource("config").find((k) => k.id === configured.id);

    if (!byId) {
      /*
       * A digest already present under a different id means two configuration entries
       * resolve to the same secret, or an entry was renamed. `build()` already refuses
       * duplicate secrets at boot, so the first case cannot reach here; the second is a
       * rename, and inserting would violate the UNIQUE constraint and crash the boot.
       * Handled explicitly instead: the existing row is re-pointed at the new identity.
       */
      const byHash = apiKeyStore.resolve(hash);
      if (byHash && byHash.source === "config") {
        apiKeyStore.rename(byHash.organizationId, byHash.id, configured.name);
        apiKeyStore.setRole(byHash.id, configured.role);
        apiKeyStore.reinstate(byHash.id);
        continue;
      }
      apiKeyStore.create({
        id: configured.id,
        organizationId: configured.organizationId,
        name: configured.name,
        role: configured.role,
        secretHash: hash,
        prefix,
        source: "config",
        createdBy: "OATHRION_API_KEYS",
      });
      continue;
    }

    if (byId.secretHash !== hash) apiKeyStore.replaceSecret(byId.id, hash, prefix);
    if (byId.name !== configured.name) apiKeyStore.rename(byId.organizationId, byId.id, configured.name);
    if (byId.role !== configured.role) apiKeyStore.setRole(byId.id, configured.role);
    if (byId.revokedAt) apiKeyStore.reinstate(byId.id);
  }

  const configuredIds = new Set(cfg.serviceKeys.map((k) => k.id));
  for (const owned of apiKeyStore.listBySource("config")) {
    if (configuredIds.has(owned.id) || owned.revokedAt) continue;
    apiKeyStore.revoke(owned.organizationId, owned.id, "OATHRION_API_KEYS", "removed from configuration");
  }
}

function config(): AuthConfig {
  if (cached) return cached;
  const { config: draft, problems } = build();
  if (!draft) throw new AuthConfigError(problems);
  /*
   * Resolution comes FIRST and its result is what everything downstream sees. Since
   * migration 18 an organization's identifier exists only in the registry, so the
   * adoption of users and keys — which writes `organization_id` on their rows — cannot
   * run on a draft. Nothing is cached before the resolution succeeds: a failed lookup
   * must leave the module unconfigured so the next request retries, rather than caching
   * principals scoped to an identifier that was never resolved.
   */
  const resolved = resolveOrganizations(draft);
  adoptConfiguredUsers(resolved);
  adoptConfiguredKeys(resolved);
  cached = resolved;
  return cached;
}

/**
 * Non-fatal things an operator has to be told at boot.
 *
 * Separate from `authConfigProblems()` on purpose: a problem stops the process, a
 * notice must not. The one notice that exists today is the derived sign-in address,
 * and it is not cosmetic — without it, an operator upgrading from a build where
 * sign-in took only a password has no way to guess what to type.
 */
/** `OATHRION_ACCOUNTS=database` : les comptes sont créés en base, pas dans l'environnement. */
function accountsFromDatabase(): boolean {
  return process.env.OATHRION_ACCOUNTS?.trim().toLowerCase() === "database";
}

export function authConfigNotices(): string[] {
  const { config: built } = build();
  if (!built) return [];
  const database =
    built.consoleUsers.length === 0 && built.serviceKeys.length === 0
      ? [
          "No credential in the environment (OATHRION_ACCOUNTS=database): accounts come from the database. " +
            'Create a customer workspace and its one-time link with: node dist/workspace-create.cjs --org "<name>" --email <admin address> ' +
            "(in the Docker image: docker compose exec placet node dist/workspace-create.cjs …; from a checkout: npm run workspace:create -- …)",
        ]
      : [];
  return database.concat(built.consoleUsers
    .filter((u) => u.derivedEmail)
    .map(
      (u) =>
        `console user "${u.name}" has no e-mail address in OATHRION_CONSOLE_USERS. Sign in with ` +
        `"${u.email}". To choose the address, write it in place of the name: ` +
        `"${u.organizationName === "Default organization" ? "" : `${u.organizationName}/`}${u.email}:${u.role}:<password>".`,
    ));
}

/** Test seam: forget the memoised configuration after changing the environment. */
export function resetAuthConfig(): void {
  cached = null;
}

/* --------------------------------- Crypto --------------------------------- */

/** Length-safe, timing-safe string comparison. */
function safeEqual(a: string, b: string): boolean {
  // Hash both sides so the comparison length never leaks the secret's length.
  const ah = crypto.createHash("sha256").update(Buffer.from(a, "utf8")).digest();
  const bh = crypto.createHash("sha256").update(Buffer.from(b, "utf8")).digest();
  return crypto.timingSafeEqual(ah, bh);
}

function sign(sessionId: string): string {
  return crypto.createHmac("sha256", config().secret).update(sessionId).digest("base64url");
}

/**
 * A non-reversible fingerprint of the credential a session was opened with.
 *
 * Computed over the stored *hash*, never over the password: the plaintext is not
 * available on any path that needs this (a request carries a token, not a password),
 * and keying it with the session secret means the value sitting next to the session
 * row is useless anywhere else and is not a password digest that could be attacked
 * offline if the database leaked. `passwordUpdatedAt` is included so that setting the
 * same password again still invalidates existing sessions.
 */
function credentialFingerprint(user: Pick<UserRecord, "passwordHash" | "passwordUpdatedAt">): string {
  return crypto
    .createHmac("sha256", config().secret)
    .update(`cred:${user.passwordHash}:${user.passwordUpdatedAt}`)
    .digest("base64url");
}

/**
 * Whether the account behind a session is still entitled to it.
 *
 * This closes a revocation gap found by the fault-injection bench: `resolveBearer`
 * used to check the HMAC and the session row, and neither depends on the password,
 * so rotating a leaked password — the first move in any incident — left every
 * session it had issued working for the rest of its 12-hour TTL.
 *
 * Since P0-2 it answers four questions on every request, not one:
 *
 *   - does the user still exist, and is the account still active?
 *   - is the password still the one this session was opened with?
 *   - do they still hold a membership in the organization the session is scoped to?
 *   - is that membership's role still the role recorded on the session?
 *
 * The last two matter as much as the password. Demoting an admin to viewer, or
 * removing them from an organization, previously took effect only at their next
 * sign-in — so the window in which a compromised or departing account keeps full
 * access was the session TTL. Now it is one request.
 */
function credentialStillValid(record: SessionRecord): boolean {
  // A row written before `credential_fp` existed cannot be tied back to a
  // credential. It is refused rather than trusted: an unverifiable session is
  // precisely what this check exists to stop, and the cost is one extra sign-in
  // after the upgrade. Accepting it would be a permissive fallback.
  if (!record.credentialFp) return false;
  const user = userStore.findById(record.subject);
  if (!user || user.status !== "active") return false;
  if (!safeEqual(record.credentialFp, credentialFingerprint(user))) return false;

  const membership = userStore.membership(record.organizationId, user.id);
  if (!membership) return false;
  /*
   * A membership suspended since this session was opened ends it on the NEXT
   * request rather than at the next sign-in — P2 identity. Removing somebody who
   * is already signed in has to take effect immediately, otherwise "suspended"
   * means "suspended in twelve hours", which is not what an administrator
   * revoking access during an incident is asking for. Checked here, on the path
   * every authenticated request already takes, so no route can forget it.
   */
  if (membership.suspendedAt) return false;
  return membership.role === record.role;
}

function toIdentity(record: SessionRecord): Identity {
  return {
    id: record.subject,
    name: record.name,
    kind: "user",
    role: record.role,
    organizationId: record.organizationId,
    sessionId: record.id,
    /*
     * Explicitly null, not omitted. A console session is a human, and binding a
     * human to one agent would break the console rather than secure it — see
     * `server/identity/agent-binding.ts`. Writing it out means a reader can tell
     * this is a decision and not a field somebody forgot, and it means adding a
     * binding to sessions later has to be a deliberate edit here.
     */
    agentId: null,
  };
}

/* ------------------------------- Credentials ------------------------------ */

export interface IssuedSession {
  token: string;
  expiresAt: string;
  session: SessionRecord;
  identity: Identity;
}

/** Why a sign-in was refused. Never sent to the client — see the route. */
export type LoginFailure =
  | "invalid_credentials"
  | "account_suspended"
  | "no_active_organization"
  | "ambiguous_organization";

export interface LoginResult {
  session: IssuedSession | null;
  failure: LoginFailure | null;
}

/**
 * Verifies an e-mail and password against the `users` table and opens a
 * **persisted** session.
 *
 * ## Why the identifier is required
 *
 * This used to be `login(password)` — no username, matching the password against
 * every configured user. That cannot survive real accounts: two people who happen to
 * choose the same password would sign in as whichever one the loop reached first,
 * with that person's role. The identifier removes the ambiguity instead of forbidding
 * the collision.
 *
 * ## Constant work for an unknown account
 *
 * Every rejection path spends a scrypt verification, either against the real hash or
 * against a decoy. Without that, "unknown address" answers in microseconds and
 * "wrong password" takes ~40 ms, which turns this endpoint into a reliable
 * account-enumeration oracle for anyone on the network.
 *
 * ## One organization per session
 *
 * A session is scoped to exactly one organization, resolved here and never taken
 * from a later request. A user with memberships in several active organizations must
 * therefore say which one; `organization` carries that. Without it the sign-in is
 * refused rather than guessed, because guessing would silently place someone in the
 * wrong tenant. The organization *picker* in the console is P1 — see the changelog.
 */
export function login(email: string, password: string, organization?: OrganizationId): LoginResult {
  if (typeof email !== "string" || typeof password !== "string" || password.length === 0) {
    return { session: null, failure: "invalid_credentials" };
  }

  /*
   * Forces the configuration to be resolved before the first lookup. Configured
   * console users are adopted into the database by `config()`, so on a process that
   * has not touched authentication yet the accounts do not exist until this runs, and
   * the first sign-in after a boot would be refused.
   *
   * La valeur rendue ne sert plus ici : le TTL de session est lu par `openSession`, qui
   * rappelle `config()` — elle est mise en cache, donc le second appel ne coûte rien.
   * L'appel reste pour son EFFET, qui est l'adoption des comptes configurés.
   */
  config();

  const user = userStore.findByEmail(email);
  if (!user) {
    spendVerificationTime(password);
    return { session: null, failure: "invalid_credentials" };
  }
  if (!verifyPassword(password, user.passwordHash)) {
    return { session: null, failure: "invalid_credentials" };
  }
  // Checked *after* the password so a suspended account is indistinguishable from a
  // wrong password to anyone who does not already know the password.
  if (user.status !== "active") return { session: null, failure: "account_suspended" };

  /*
   * Cost upgrade on use. When the parameters in `passwords.ts` are raised, accounts
   * migrate as their owners sign in rather than through a forced reset. Done before
   * the fingerprint is computed, so the session is bound to the hash that will be
   * stored and not to the one it replaced.
   */
  let current = user;
  if (needsRehash(user.passwordHash)) {
    userStore.setPassword(user.id, hashPassword(password), user.passwordSource);
    current = userStore.findById(user.id) ?? user;
  }

  return openSession(current, organization);
}

/**
 * Ouvre une session pour un utilisateur DÉJÀ AUTHENTIFIÉ, quelle qu'ait été la preuve.
 *
 * ## Pourquoi cette fonction est extraite
 *
 * Le SSO (`server/identity/oidc.ts`) authentifie par un jeton d'identité signé par le
 * fournisseur du client, et non par un mot de passe. Tout ce qui SUIT l'authentification
 * — quelle organisation, l'appartenance est-elle suspendue, l'organisation est-elle
 * active, le cas ambigu de plusieurs appartenances, le TTL, l'empreinte de credential,
 * la signature du jeton de session — est identique dans les deux cas.
 *
 * Le dupliquer aurait créé **deux implémentations de « qui a le droit d'ouvrir une
 * session et dans quel locataire »**. C'est exactement la classe de divergence qui
 * produit un trou d'autorisation : on corrige une règle d'un côté et pas de l'autre, et
 * personne ne le voit parce que les deux chemins ont l'air de marcher.
 *
 * Donc : le SSO remplace la VÉRIFICATION, jamais ce qui vient après.
 *
 * `credentialFingerprint` continue d'être calculée sur l'utilisateur stocké : une session
 * SSO est donc invalidée par un changement de mot de passe local comme n'importe quelle
 * autre, ce qui est le sens sûr — si un administrateur réinitialise le compte, toutes les
 * sessions tombent, quelle que soit la façon dont elles ont été obtenues.
 */
/**
 * Force l'adoption des comptes et des clés déclarés dans l'environnement.
 *
 * ## Pourquoi cette fonction existe, et ce qu'elle a évité
 *
 * `OATHRION_CONSOLE_USERS` déclare des comptes ; ils n'existent EN BASE qu'après le premier
 * appel à `config()`, qui les adopte. `login()` le fait depuis toujours — son commentaire
 * dit exactement pourquoi : « sur un processus qui n'a pas encore touché à
 * l'authentification, les comptes n'existent pas, et la première connexion après un
 * démarrage serait refusée ».
 *
 * Le SSO cherche l'utilisateur PAR SON ADRESSE, sans passer par `login()`. Sans cet
 * appel, la première connexion SSO après un démarrage était refusée pour « aucun
 * utilisateur de console » — et, pire, avec le provisionnement automatique activé, elle
 * aurait CRÉÉ un doublon pour une adresse qui désigne un administrateur configuré,
 * c'est-à-dire un second compte au rôle le plus faible portant la même adresse.
 *
 * Trouvé par `oidc-flow.test.ts`, qui tourne sur un processus froid — le seul endroit où
 * ce défaut est visible.
 */
export function ensureConfiguredPrincipals(): void {
  config();
}

export function openSession(user: UserRecord, organization?: OrganizationId): LoginResult {
  const cfg = config();

  /*
   * A suspended membership is not a candidate. Filtered here rather than refused
   * after selection, so that somebody suspended by one customer can still sign in
   * to the other organizations they belong to — the whole reason suspension lives
   * on the relationship and not on the user.
   */
  const active = userStore
    .membershipsOf(user.id)
    .filter((m) => !m.suspendedAt && organizationStore.isActive(m.organizationId));
  if (active.length === 0) return { session: null, failure: "no_active_organization" };

  let membership = active[0];
  if (organization) {
    const requested = active.find((m) => m.organizationId === organization);
    if (!requested) return { session: null, failure: "no_active_organization" };
    membership = requested;
  } else if (active.length > 1) {
    return { session: null, failure: "ambiguous_organization" };
  }

  const session = sessionStore.create({
    organizationId: membership.organizationId,
    subject: user.id,
    name: user.name,
    role: membership.role,
    ttlMs: cfg.ttlMs,
    credentialFp: credentialFingerprint(user),
  });
  userStore.recordLogin(user.id);

  return {
    session: {
      token: `${session.id}.${sign(session.id)}`,
      expiresAt: session.expiresAt,
      session,
      identity: toIdentity(session),
    },
    failure: null,
  };
}

/**
 * Sets a user's own password.
 *
 * Every other session that account holds is revoked, because the reason a person
 * changes a password is usually that they believe the old one is known to somebody
 * else — leaving that somebody's session alive would defeat the act. `keepSessionId`
 * spares the caller's own session so the change does not sign them out of the tab
 * they are in.
 */
export function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId?: string,
): { ok: boolean; failure?: "invalid_credentials" | "unknown_user" } {
  const user = userStore.findById(userId);
  if (!user) return { ok: false, failure: "unknown_user" };
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return { ok: false, failure: "invalid_credentials" };
  }

  userStore.setPassword(user.id, hashPassword(newPassword), "user");
  const updated = userStore.findById(user.id);
  if (!updated) return { ok: false, failure: "unknown_user" };

  /*
   * The scoped session list requires an organization, and a session belongs to
   * exactly one, so every membership is walked: a user who works with two
   * organizations has sessions in both, and both have to end.
   */
  for (const membership of userStore.membershipsOf(user.id)) {
    for (const session of sessionStore.listFor(membership.organizationId, user.id, 500)) {
      if (session.id === keepSessionId) {
        /*
         * The caller's own session survives — but it is bound to the credential that
         * opened it, and that credential has just changed, so it has to be re-bound or
         * the next request would refuse it. Skipping the check for this one session
         * instead would be the wrong fix: it would leave a session whose binding no
         * longer matches anything.
         */
        if (!session.revokedAt) {
          sessionStore.rebind(membership.organizationId, session.id, credentialFingerprint(updated));
        }
        continue;
      }
      if (session.revokedAt) continue;
      sessionStore.revoke(session.id, "system:password-changed", membership.organizationId);
    }
  }
  return { ok: true };
}

/** Resolves a bearer credential to an identity, or `null` when it is not valid. */
export function resolveBearer(credential: string): Identity | null {
  const dot = credential.indexOf(".");
  if (dot > 0) {
    const sessionId = credential.slice(0, dot);
    const signature = credential.slice(dot + 1);
    // Signature first: an unsigned guess must never even hit the database.
    if (safeEqual(signature, sign(sessionId))) {
      const record = sessionStore.resolveActive(sessionId);
      if (!record) {
        // A well-formed token whose session was revoked or expired stops here.
        return null;
      }
      if (!credentialStillValid(record)) {
        // The password behind this session was rotated, or the user was removed.
        // The row is revoked so the decision is recorded once, and appears in the
        // session audit list, instead of being recomputed on every request.
        sessionStore.revoke(record.id, "system:credential-changed", record.organizationId);
        return null;
      }
      /*
       * A live, correctly signed session whose organization has since been suspended
       * is refused. Suspension has to take effect on the next request, not at the next
       * sign-in, or a session opened before suspension keeps full access for its whole
       * remaining TTL.
       */
      if (!organizationStore.isActive(record.organizationId)) return null;
      return toIdentity(record);
    }
  }

  /*
   * Machine credentials — P0-5.
   *
   * This used to be a loop comparing the presented string to every plaintext in
   * `OATHRION_API_KEYS`. It is now a single indexed lookup on the digest, which is not
   * primarily a performance change: it means a key can be revoked, expired, issued from
   * the console and attributed, none of which a list in the environment can express.
   *
   * `config()` is still called first, and must be: it is what adopts the configured keys
   * into the table, so on a fresh database the first request would otherwise find nothing.
   */
  config();
  /*
   * UNE SEULE LECTURE D'IDENTITÉ, et c'est une mesure qui l'a décidé.
   *
   * C'étaient deux appels : la clé, puis l'état de son organisation. Sur le plan
   * d'identité PostgreSQL, chacun est un aller-retour BLOQUANT — le prix assumé de la
   * phase 12, qui garde une seule implémentation des opérations de sécurité pour les deux
   * moteurs.
   *
   * Un profil processeur sous 48 clients concurrents a nommé ces deux appels comme les
   * DEUX PLUS GROS consommateurs du processus : 2,6 s de temps bloquant sur 11 s de
   * profil, loin devant le reste. Et ce temps ne se chevauche pas — pendant qu'une
   * requête attend sa clé, aucune autre n'avance.
   *
   * La jointure rend la même information en un aller-retour. Ce n'est pas un cache :
   * révocation et suspension prennent effet au prochain appel, comme avant.
   */
  const resolved = apiKeyStore.resolveWithOrganization(hashKey(credential));
  if (!resolved) return null;
  const key = resolved.key;

  // Three refusals, in the order that costs least and reveals least. All of them are
  // silent — a caller learns only that the credential does not work, never which of the
  // four possible reasons applies, because that distinction is exactly what tells an
  // attacker they hold a real but retired key.
  if (key.revokedAt) return null;
  if (isExpired(key)) return null;
  /*
   * L'organisation, lue dans la MÊME ligne. Une clé dont l'organisation a disparu ou est
   * suspendue est refusée ici — et une organisation absente (`LEFT JOIN` sans
   * correspondance) compte comme inactive, ce qui est le sens sûr : une clé rattachée à
   * rien n'autorise rien.
   */
  if (!resolved.organizationActive) return null;

  // Records use. Throttled inside the store to one write per key per minute, so this does
  // not put a write lock in front of every agent call.
  apiKeyStore.touch(key);

  return {
    id: key.id,
    name: key.name,
    kind: "service",
    role: key.role,
    organizationId: key.organizationId,
    /*
     * The binding, carried from the credential row into the identity. This is
     * the only place it is ever set: everything downstream reads
     * `identity.agentId` and nothing downstream can write it.
     */
    agentId: key.agentId,
  };
}

/* ------------------------------- Rate limiting ---------------------------- */

/*
 * The login throttle now runs on the shared quota store (P0-7).
 *
 * It used to be a `Map` in this module, with its own sweep and its own ceiling —
 * the same structure as the request limiter, duplicated. Behind two instances that
 * map meant ten guesses *per process*: an attacker with twenty attempts a minute
 * simply reconnected until the load balancer handed them the other one, and neither
 * process ever saw more than ten. The counter is now one counter, wherever the
 * attempt lands.
 *
 * The window (60 s), the ceiling (10) and the rule that **only failed attempts
 * count** are all unchanged. Counting successes would lock out an entire office
 * behind one address after ten normal sign-ins — a self-inflicted outage that buys
 * nothing, since someone who knows the password is not the attacker this guards
 * against.
 *
 * The key is prefixed `login:` so it cannot collide with a request-limiter scope in
 * the shared table. The address is the subject because at this point in the request
 * there is no identity yet; that is the whole difference between this limiter and
 * the per-credential one.
 */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

function loginKey(ip: string): string {
  return `login:${ip}`;
}

/**
 * Test seam: clears the throttle window. Never called by the server — it
 * exists so a suite that signs in many times exercises the real limiter
 * instead of forcing us to weaken it.
 *
 * Synchronous for the reason documented on `resetRateLimits`: the in-memory store
 * clears before its promise exists, and every call site here uses that store.
 */
export function resetLoginThrottle(): void {
  resetRateLimits();
}

/**
 * Whether this address has already used up its failed-attempt budget.
 *
 * A read, not a consume. The reasoning — and the honest bound on what a read-based
 * gate guarantees under a concurrent burst — is on `QuotaStore.peek`.
 *
 * A store failure answers `false`, i.e. not throttled, and this is the one place in
 * the codebase where an unavailable limiter store does not refuse the request. The
 * alternative is worse: an unreachable store would make every sign-in in the
 * deployment fail, so a limiter outage becomes a total authentication outage, and
 * Oathrion's own operators would be locked out of the console during exactly the
 * incident they need it for. The protection this weakens is a *rate* limit on
 * guessing, not the password check — every attempt is still verified against a
 * scrypt hash. That is a bounded, deliberate exception to the fail-closed default,
 * logged when it happens.
 */
export async function loginThrottled(ip: string): Promise<boolean> {
  try {
    const decision = await quotaStore().peek(loginKey(ip), LOGIN_MAX_ATTEMPTS);
    return !decision.allowed;
  } catch (error) {
    console.error(
      "[auth] the login throttle store is unavailable; sign-in proceeds unthrottled:",
      error instanceof Error ? error.message : String(error),
    );
    return false;
  }
}

/**
 * Records a rejected password so repeated guessing eventually trips the limit.
 *
 * A store failure is logged and swallowed. It must not turn a wrong password into a
 * 500: the caller learns nothing from the difference, and an operator watching for
 * failed sign-ins would see the endpoint break instead of seeing the failure.
 */
export async function registerFailedLogin(ip: string): Promise<void> {
  try {
    await quotaStore().consume(loginKey(ip), LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
  } catch (error) {
    console.error(
      "[auth] could not record a failed sign-in attempt:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/*
 * Redemption of an identity token (P2 identity), throttled on exactly the same
 * terms as sign-in and for the same reason.
 *
 * The first version of this guard was a plain `rateLimit("identity-token", 10, …)`
 * in front of both redemption routes, and it was wrong. Those two routes are public,
 * so there is no identity for `quotaKey` to key on and the bucket falls back to the
 * address — which means the budget is per office, not per person. Counting *every*
 * attempt then makes onboarding self-limiting: a company that invites its first
 * fifteen employees, who all accept from behind one corporate NAT within a minute,
 * would see the eleventh onwards answered 429 for doing exactly what they were asked
 * to do. Discovered by `identity-lifecycle.test.ts`, which redeems many tokens from
 * one address.
 *
 * So only refusals count, exactly as `loginThrottled` documents. What this actually
 * guards is worth stating precisely, because it is NOT the secret: that is 32 random
 * bytes, and no rate limit is what makes guessing it hopeless. It guards two other
 * things. First, the scrypt call on the submitted password, which is deliberately
 * expensive and reachable without credentials — an anonymous CPU-exhaustion lever.
 * Second, id enumeration: a caller who learns that some ids are "valid but wrong
 * secret" would learn nothing today (the answers are byte-identical), but the
 * throttle means a future regression there cannot be exploited quickly.
 *
 * A separate scope from `login:` so a burst of bad tokens cannot lock an office out
 * of the console, and vice versa. One is not evidence about the other.
 */
const TOKEN_WINDOW_MS = 60_000;
const TOKEN_MAX_FAILURES = 10;

function tokenKey(ip: string): string {
  return `identity-token:${ip}`;
}

/**
 * How many seconds this address must wait, or `null` when it is not throttled.
 *
 * Seconds rather than a boolean so the route can answer with `Retry-After`. A 429
 * without it tells the caller to slow down but not by how much, and the client's
 * only option is to guess — which in practice means retrying immediately and
 * extending its own lockout. `peek` already knows when the window ends; returning
 * that is free.
 */
export async function tokenRedemptionThrottled(ip: string): Promise<number | null> {
  try {
    const decision = await quotaStore().peek(tokenKey(ip), TOKEN_MAX_FAILURES);
    if (decision.allowed) return null;
    return Math.max(Math.ceil((decision.resetAt - Date.now()) / 1000), 1);
  } catch (error) {
    /*
     * Fails OPEN, and unlike `loginThrottled` this needs its own justification
     * rather than an appeal to precedent. Fail-closed here would mean that a
     * limiter-store outage makes every invitation in the deployment unredeemable —
     * a limiter incident becomes an onboarding incident — while the thing being
     * protected, the token secret, is still 32 bytes verified in constant time
     * against a digest. The bound is a rate limit on wrong guesses, not the check
     * itself.
     */
    console.error(
      "[auth] the identity-token throttle store is unavailable; redemption proceeds unthrottled:",
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/** Records a refused redemption so repeated attempts eventually trip the limit. */
export async function registerFailedTokenRedemption(ip: string): Promise<void> {
  try {
    await quotaStore().consume(tokenKey(ip), TOKEN_MAX_FAILURES, TOKEN_WINDOW_MS);
  } catch (error) {
    console.error(
      "[auth] could not record a refused identity-token redemption:",
      error instanceof Error ? error.message : String(error),
    );
  }
}

/* -------------------------------- Middleware ------------------------------ */

/**
 * Routes reachable without credentials. Everything else under /api is closed.
 *
 * `/api/live` and `/api/ready` join `/api/health` here (P1-1): an orchestrator's probe
 * carries no bearer credential, and a readiness endpoint that answers 401 is read as a
 * failing probe — which would make every instance permanently unready. Each of the
 * three is written to disclose nothing beyond "this process is running" and "its
 * database answers": no version, no schema state, no tenant, no counts.
 */
const PUBLIC_API_PATHS = new Set([
  "/api/auth/login",
  "/api/health",
  "/api/live",
  "/api/ready",
  /*
   * The two token-redemption endpoints (P2 identity). Both are public *by
   * necessity*: the person accepting an invitation has no account yet, and the
   * person redeeming a reset has no usable password — requiring a credential would
   * make both unreachable. Each carries its own bearer of a kind: a single-use,
   * expiring, hashed-at-rest token bound to one organization, checked in constant
   * time, and rate-limited per address at the route. Neither ever reveals whether
   * an account exists, and neither issues a session: after redeeming, the person
   * signs in normally, so a stolen token yields at most one password change and
   * never a live session.
   */
  "/api/invitations/accept",
  /* Lire ce qu'une invitation propose avant de l'accepter. Même étranglement. */
  "/api/invitations/inspect",
  "/api/auth/password/reset",
  /*
   * Les interactions Slack. Publique PAR NÉCESSITÉ, comme les deux au-dessus : c'est
   * Slack qui appelle, et Slack ne connaît aucun credential Oathrion.
   *
   * Elle porte son propre bearer, d'une autre nature : une signature HMAC de
   * l'application Slack sur le corps BRUT, un horodatage de moins de cinq minutes, une
   * correspondance nominative déclarée entre identifiant Slack et utilisateur de console,
   * et la capacité `approve` vérifiée sur le rôle de cette personne. Les quatre sont dans
   * `server/routes-slack.ts`, et sans le secret de signature la route répond 404 — la
   * fonctionnalité n'existe pas plutôt que d'exister sans garde.
   */
  "/api/slack/interactions",
  /*
   * Les deux routes du SSO. Publiques PAR NÉCESSITÉ : quelqu'un qui se connecte n'a pas
   * encore de session, et exiger un credential rendrait la connexion inatteignable.
   *
   * Ce qui les protège est dans `server/routes-oidc.ts` : un `state` à usage unique lié
   * au navigateur par un cookie `HttpOnly` (sans quoi un attaquant fait connecter la
   * victime à SON compte), un `nonce` vérifié dans le jeton, la vérification complète du
   * jeton d'identité, et le refus par défaut d'une adresse qui ne désigne aucun
   * utilisateur de console. Plus l'étranglement par adresse de la page de connexion.
   */
  "/api/auth/sso/start",
  "/api/auth/sso/callback",
  /*
   * L'échange du ticket et la question « le SSO est-il configuré ? ». Les deux
   * précèdent nécessairement toute session : c'est leur objet.
   */
  "/api/auth/sso/claim",
  "/api/auth/sso/status",
  /*
   * La console LOCALE (`oathrion console`). Publique par nécessité, comme la connexion : on
   * vient y chercher une session. Ce qui la protège : elle répond 404 hors du mode local
   * (qui n'écoute que sur la boucle locale), et le ticket est signé avec le secret de session,
   * vaut deux minutes et ne sert qu'une fois (`shared/local-login-ticket.ts`).
   */
  "/api/local/login",
  /* Le pivot local : même nécessité, même garde (ticket signé, usage unique, 404 hors du pivot). */
  "/api/local/hub",
  /*
   * Le bouton « Décider » d'une notification Windows : Windows ouvre l'adresse, sans
   * session. Elle porte un jeton à usage unique, émis par le pivot pour cette notification et
   * gardé en mémoire quinze minutes (`server/local-decide-links.ts`) ; 404 hors du pivot.
   */
  "/api/local/decider",
  /*
   * Le retour OAuth d'un connecteur (Slack, Linear). Publique PAR NÉCESSITÉ : c'est le
   * fournisseur qui redirige le navigateur, sans le bearer de la console. Ce qui la
   * protège : un `state` à usage unique émis par une session `manage`, lié au navigateur
   * par un cookie `HttpOnly`, et un jeton VÉRIFIÉ contre le service avant d'être scellé.
   * Voir `server/connectors/oauth-install.ts`.
   */
  "/api/connectors/oauth/callback",
]);

/**
 * Global gate. Mounted before every route: any `/api/*` path that is not
 * explicitly public requires a valid bearer credential, and every downstream
 * handler can rely on `req.identity` being present.
 */
export function authenticate(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.path.startsWith("/api")) return next();
    if (PUBLIC_API_PATHS.has(req.path)) return next();

    const header = req.get("authorization") ?? "";
    const [scheme, ...rest] = header.split(" ");
    let credential = rest.join(" ").trim();

    /*
     * LE COOKIE DE SESSION DE LA CONSOLE, quand aucun `Authorization` n'est présenté
     * (`server/session-cookie.ts`). Il ne vaut QUE pour une session : une clé d'API n'est
     * jamais posée en cookie, et une valeur de cookie qui en serait une est refusée plus
     * bas. Une requête qui modifie doit porter l'en-tête de la console.
     */
    let viaCookie = false;
    if (!header) {
      const fromCookie = readSessionCookie(req);
      if (fromCookie) {
        credential = fromCookie;
        viaCookie = true;
      }
    }

    if (!viaCookie && (!header || scheme.toLowerCase() !== "bearer" || !credential)) {
      /*
       * Distingué du credential invalide, parce que les deux signifient des choses
       * différentes pour qui est d'astreinte : un flot de `missing_credential` est
       * presque toujours une intégration mal déployée ou une sonde mal câblée, un flot
       * de `invalid_credential` est une clé révoquée encore en service — ou quelqu'un
       * qui essaie. Les confondre efface la seule information utile.
       */
      increment("oathrion_auth_failures_total", { reason: "missing_credential" });
      sendApiError(res, 401, "Authentication required", ERROR_CODES.unauthenticated);
      return;
    }

    const resolved = timedSync("auth", () => resolveBearer(credential));
    /* Par cookie, seule une SESSION est acceptée. */
    const identity = viaCookie && resolved && !resolved.sessionId ? null : resolved;
    if (!identity) {
      /*
       * Un seul motif pour les quatre causes possibles (inconnue, expirée, révoquée,
       * organisation inactive) : `resolveBearer` ne les distingue pas, et c'est
       * volontaire — une réponse qui le ferait répondrait « ce credential a existé »
       * à qui sonde. La métrique n'en sait donc pas plus que le serveur, et ne prétend
       * pas le contraire.
       */
      increment("oathrion_auth_failures_total", { reason: "invalid_credential" });
      sendApiError(res, 401, "Invalid credentials", ERROR_CODES.invalidCredentials);
      return;
    }

    if (viaCookie && lacksConsoleHeader(req)) {
      increment("oathrion_auth_failures_total", { reason: "missing_console_header" });
      sendApiError(
        res,
        403,
        `A request that changes something, authenticated only by the console session cookie, must carry the ${CONSOLE_HEADER} header.`,
        ERROR_CODES.consoleHeaderRequired,
      );
      return;
    }

    req.identity = identity;
    next();
  };
}

/**
 * Capability gate. Authentication answers *who*; this answers *may they*.
 * Refusals are 403 — the credential was valid, the permission was not.
 */
export function requireCapability(capability: Capability): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const identity = req.identity;
    if (!identity) {
      sendApiError(res, 401, "Authentication required", ERROR_CODES.unauthenticated);
      return;
    }
    if (!can(identity.role, capability)) {
      /*
       * `role` is kept alongside the standard body: the console shows the caller their
       * own role in the refusal, and dropping it to tidy the shape would remove a
       * working explanation from the UI. It is the caller's own role — nothing about
       * anyone else's permissions is disclosed.
       */
      sendApiError(res, 403, denialMessage(identity.role, capability), ERROR_CODES.forbiddenCapability, {
        role: identity.role,
      });
      return;
    }
    next();
  };
}

/** Identity of the current request. Throws if used outside the middleware. */
export function requireIdentity(req: Request): Identity {
  if (!req.identity) throw new Error("No authenticated identity on this request");
  return req.identity;
}

/** In-handler check, for routes whose required capability depends on the body. */
export function ensureCapability(req: Request, res: Response, capability: Capability): boolean {
  const identity = requireIdentity(req);
  if (can(identity.role, capability)) return true;
  sendApiError(res, 403, denialMessage(identity.role, capability), ERROR_CODES.forbiddenCapability, {
    role: identity.role,
  });
  return false;
}

export { capabilitiesOf };
