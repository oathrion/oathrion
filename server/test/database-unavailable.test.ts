/**
 * Une base injoignable répond 503, pas 500 — et seulement elle.
 *
 * Relevé en coupant PostgreSQL sous trafic continu (docs/STRESS-TEST-LOG.md) : Oathrion
 * restait fermé et repartait seul, mais répondait « Internal Server Error » pendant la
 * coupure. La preuve de bout en bout est l'expérience rejouée sur le bundle ; ce fichier
 * fige la classification, y compris ce qu'elle ne doit PAS attraper.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDatabaseUnavailable } from "../database-unavailable";
import { IdentityDatabaseError } from "../identity/sync-postgres";

const pgError = (code: string, message = "boom") => Object.assign(new Error(message), { code });

describe("isDatabaseUnavailable — ce qui est une indisponibilité de la base", () => {
  it("les arrêts et redémarrages de PostgreSQL (codes relevés pendant la coupure)", () => {
    expect(isDatabaseUnavailable(pgError("57P03", "the database system is shutting down"))).toBe(true);
    expect(isDatabaseUnavailable(pgError("57P01", "terminating connection due to administrator command"))).toBe(true);
    expect(isDatabaseUnavailable(pgError("08006"))).toBe(true);
    expect(isDatabaseUnavailable(pgError("53300", "sorry, too many clients already"))).toBe(true);
  });

  it("une base arrêtée qui refuse la connexion", () => {
    expect(isDatabaseUnavailable(pgError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:5432"))).toBe(true);
  });

  it("les messages de pg sans code", () => {
    expect(isDatabaseUnavailable(new Error("Connection terminated unexpectedly"))).toBe(true);
    expect(isDatabaseUnavailable(new Error("timeout exceeded when trying to connect"))).toBe(true);
  });

  it("le plan d'identité : code relayé du worker, ou délai dépassé", () => {
    expect(isDatabaseUnavailable(new IdentityDatabaseError("the database system is shutting down", "57P03"))).toBe(true);
    expect(isDatabaseUnavailable(new IdentityDatabaseError("the identity plane did not answer within 15000ms. No SQLite fallback"))).toBe(true);
    // Relevé pendant la coupure : le worker relaie la coupure réseau avec son code.
    expect(isDatabaseUnavailable(new IdentityDatabaseError("read ECONNRESET", "ECONNRESET"))).toBe(true);
  });
});

describe("isDatabaseUnavailable — ce qui n'en est PAS une", () => {
  it("un appel sortant raté (fetch vers GitHub ou un webhook) n'est pas une panne de base", () => {
    const outbound = Object.assign(new TypeError("fetch failed"), { cause: pgError("ECONNRESET", "read ECONNRESET") });
    expect(isDatabaseUnavailable(outbound)).toBe(false);
    const refusedOutbound = Object.assign(new TypeError("fetch failed"), { cause: pgError("ECONNREFUSED", "connect ECONNREFUSED 10.0.0.9:443") });
    expect(isDatabaseUnavailable(refusedOutbound)).toBe(false);
  });

  it("une contrainte violée, une requête invalide, un défaut de code restent des 500", () => {
    expect(isDatabaseUnavailable(pgError("23505", "duplicate key value violates unique constraint"))).toBe(false);
    expect(isDatabaseUnavailable(pgError("42703", 'column "x" does not exist'))).toBe(false);
    expect(isDatabaseUnavailable(new TypeError("Cannot read properties of undefined"))).toBe(false);
    expect(isDatabaseUnavailable(null)).toBe(false);
    expect(isDatabaseUnavailable("ECONNREFUSED")).toBe(false);
  });
});

describe("le gestionnaire d'erreurs du serveur s'en sert", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts"), "utf8");

  it("503 et Retry-After pour une base injoignable, seulement si la route n'a pas fixé de statut", () => {
    expect(source).toMatch(/const databaseDown = !e\.status && !e\.statusCode && isDatabaseUnavailable\(err\)/);
    expect(source).toMatch(/res\.setHeader\("Retry-After", String\(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS\)\)/);
    expect(source).toMatch(/sendApiError\(res, 503, DATABASE_UNAVAILABLE_MESSAGE\)/);
  });
});

describe("le relais d'interception s'en sert, sans inviter au doublon", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "routes-intercept.ts"), "utf8");

  it("503 seulement si RIEN n'est parti ET que la base est injoignable ; sinon 500 « ne réessayez pas »", () => {
    expect(source).toMatch(/const retrySafe = reached === null && isDatabaseUnavailable\(error\)/);
    expect(source).toMatch(/res\.status\(retrySafe \? 503 : 500\)/);
  });
});

describe("le gestionnaire des routes (`handle()`) s'en sert aussi", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "routes.ts"), "utf8");

  it("une base injoignable y donne 503 et Retry-After, pas 500", () => {
    expect(source).toMatch(/if \(isDatabaseUnavailable\(err\)\) \{\s*res\.setHeader\("Retry-After"/);
  });
});
