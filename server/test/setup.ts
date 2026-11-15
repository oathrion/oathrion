/**
 * Vitest setup — runs before any test module is imported.
 *
 * `server/db.ts` opens its SQLite handle at import time, so the database path
 * has to be redirected here, before the module graph is evaluated. Each test
 * run gets a throwaway file that is deleted on exit.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "placet-test-"));
process.env.OATHRION_DB = path.join(dir, "test.db");
/*
 * Les essais lancent de vrais relais depuis le programme de test, qui serait un « programme
 * inconnu » du pivot (`server/local-programs.ts`) : la suite le déclare de confiance. Les tests de
 * la quarantaine elle-même retirent ce réglage.
 */
process.env.OATHRION_UNSAFE_TRUST_ALL_PROGRAMS = "1";
/* Jamais la veille des agents ni la prison par défaut dans la vraie session (`cli/wrap/watch.ts`, `jail-always.ts`). */
process.env.OATHRION_NO_SESSION_CHANGES = "1";
/* Ni veille ni mise en pause des agents dans un pivot d'essai : les vrais agents de la machine n'y sont pour rien. */
process.env.OATHRION_LOCAL_AGENT_WATCH = "0";
/* Jamais notre fenêtre de notification pendant les essais : elle s'afficherait sur l'écran de la personne. */
process.env.OATHRION_LOCAL_NOTIFY_POPUP = "0";
/* Ni le son d'Oathrion sur les haut-parleurs, ni Telegram : un pivot d'essai ne sonne ni n'écrit au téléphone de la personne. */
process.env.OATHRION_LOCAL_NOTIFY_SOUND = "0";
process.env.OATHRION_LOCAL_NOTIFY_PHONE = "0";

process.on("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Auth configuration for the suite. Set before `server/auth.ts` is imported so
 * the tests exercise the real credential path rather than the dev fallback.
 */
process.env.OATHRION_API_KEYS = [
  "Test Service:admin:test-api-key-123456",
  "Test Viewer:viewer:test-viewer-key-123456",
  "Test Operator:operator:test-operator-key-123456",
  "Test Approver:approver:test-approver-key-123456",
  /*
   * A SECOND ORGANIZATION, present in every test run.
   *
   * These two keys carry the `Rival Corp/` prefix, so they authenticate into
   * `org_rival_corp` instead of the default organization. They exist so that the
   * adversarial suite (`tenant-isolation.test.ts`) attacks the real HTTP surface with
   * a real, fully authorised admin of a *different* tenant — the exact attacker that
   * matters. A viewer key would prove much less: the interesting question is not
   * whether an unauthorised caller is refused, it is whether a caller with every
   * permission in their own organization can reach into another one.
   */
  "Rival Corp/Rival Admin:admin:test-rival-admin-key-0001",
  "Rival Corp/Rival Viewer:viewer:test-rival-viewer-key-001",
].join(",");
/*
 * Console users are written with explicit e-mail addresses, because since P0-2 the
 * address is the sign-in identifier. The derivation path — a configuration that
 * carries only a display name, as every pre-P0-2 deployment does — is exercised
 * separately in `server/auth-credential-parsing.test.ts`, where the derived address
 * can be asserted precisely.
 */
process.env.OATHRION_CONSOLE_USERS = [
  "admin@placet.test:admin:test-console-password",
  "viewer@placet.test:viewer:test-viewer-password",
].join(",");
process.env.OATHRION_SESSION_SECRET = "test-session-secret-value-0123456789";

/**
 * Tests exercise the control plane against the configuration dataset (agents,
 * policies, integrations). They deliberately do NOT load the illustrative
 * ledger: an assertion about a metric must be built from executions the test
 * itself produced, never from a fixture.
 */
process.env.OATHRION_SEED = "config";
