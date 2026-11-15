/**
 * PHASE 12 — les règles qui décident où vit l'identité, et la traduction SQL du pont.
 *
 * Ces tests n'ont pas besoin de PostgreSQL : ils portent sur les refus au démarrage et
 * sur la réécriture du SQL. Ils sont donc exécutés dans tous les runs, y compris ceux
 * sans base — c'est volontaire, parce que ce sont eux qui garantissent qu'un déploiement
 * mal configuré s'arrête au lieu de se replier en silence sur un fichier local.
 *
 * Ce que les tests exigent, en une phrase : **aucune combinaison ne se devine.** Un
 * pilote PostgreSQL sans plan d'identité déclaré refuse ; un plan SQLite en production
 * refuse ; une valeur inconnue refuse. Le seul cas silencieux est celui où tout est
 * cohérent.
 */

import { describe, expect, it } from "vitest";

import {
  assertAuthorityMatchesIdentityPlane,
  DatabaseConfigError,
  resolveDatabaseConfig,
  resolveIdentityPlane,
} from "../database-config";
import { translateIdentitySql, resolveIdentityWorkerPath } from "../identity/sync-postgres";

const PG_URL = "postgres://user:pw@db.internal:5432/placet";

function postgresConfig() {
  return resolveDatabaseConfig({ DATABASE_DRIVER: "postgres", DATABASE_URL: PG_URL });
}

function sqliteConfig() {
  return resolveDatabaseConfig({ OATHRION_DB: "data.db" });
}

describe("resolveIdentityPlane — le plan d'identité est déclaré, jamais deviné", () => {
  it("refuse un pilote PostgreSQL sans OATHRION_IDENTITY_PLANE : le silence n'est pas une réponse", () => {
    expect(() => resolveIdentityPlane(postgresConfig(), {})).toThrow(DatabaseConfigError);
    try {
      resolveIdentityPlane(postgresConfig(), {});
    } catch (error) {
      const message = (error as Error).message;
      // Le message doit proposer les deux réponses réelles et dire laquelle est pour la
      // production, sinon l'opérateur choisit au hasard.
      expect(message).toContain("OATHRION_IDENTITY_PLANE=postgres");
      expect(message).toContain("OATHRION_IDENTITY_PLANE=sqlite");
      expect(message).toMatch(/DEVELOPMENT|DEV/i);
    }
  });

  it("accepte postgres + postgres : le chemin de production complet", () => {
    expect(
      resolveIdentityPlane(postgresConfig(), { OATHRION_IDENTITY_PLANE: "postgres" }),
    ).toBe("postgres");
  });

  it("accepte postgres + sqlite hors production, et le refuse en production", () => {
    expect(resolveIdentityPlane(postgresConfig(), { OATHRION_IDENTITY_PLANE: "sqlite" })).toBe(
      "sqlite",
    );
    expect(() =>
      resolveIdentityPlane(postgresConfig(), {
        OATHRION_IDENTITY_PLANE: "sqlite",
        NODE_ENV: "production",
      }),
    ).toThrow(/production/i);
  });

  it("refuse un plan d'identité PostgreSQL avec un pilote SQLite : il n'y a pas de connexion à utiliser", () => {
    expect(() =>
      resolveIdentityPlane(sqliteConfig(), { OATHRION_IDENTITY_PLANE: "postgres" }),
    ).toThrow(DatabaseConfigError);
  });

  it("le pilote SQLite par défaut garde l'identité sur SQLite, sans exiger de déclaration", () => {
    expect(resolveIdentityPlane(sqliteConfig(), {})).toBe("sqlite");
  });

  it("refuse une valeur inconnue plutôt que de retomber sur un défaut", () => {
    for (const value of ["POSTGRESQL", "pg", "mysql", "true", "1", " "]) {
      expect(() =>
        resolveIdentityPlane(postgresConfig(), { OATHRION_IDENTITY_PLANE: value }),
      ).toThrow(DatabaseConfigError);
    }
  });
});

describe("assertAuthorityMatchesIdentityPlane — identité et autorisation sur le même moteur", () => {
  it("refuse une identité PostgreSQL avec l'autorité par défaut (SQLite)", () => {
    expect(() => assertAuthorityMatchesIdentityPlane("postgres", {})).toThrow(DatabaseConfigError);
    expect(() =>
      assertAuthorityMatchesIdentityPlane("postgres", { OATHRION_ACTION_AUTHORITY_DRIVER: "sqlite" }),
    ).toThrow(/OATHRION_ACTION_AUTHORITY_DRIVER=postgres/);
  });

  it("accepte identité PostgreSQL + autorité PostgreSQL", () => {
    expect(() =>
      assertAuthorityMatchesIdentityPlane("postgres", { OATHRION_ACTION_AUTHORITY_DRIVER: "postgres" }),
    ).not.toThrow();
  });

  it("ne dit rien quand l'identité est sur SQLite : c'est le mode développement existant", () => {
    expect(() => assertAuthorityMatchesIdentityPlane("sqlite", {})).not.toThrow();
  });
});

describe("translateIdentitySql — le même SQL, deux dialectes", () => {
  it("numérote les paramètres positionnels dans l'ordre", () => {
    const { text, names } = translateIdentitySql(
      "SELECT * FROM api_keys WHERE organization_id = ? AND id = ?",
    );
    expect(text).toBe("SELECT * FROM api_keys WHERE organization_id = $1 AND id = $2");
    // `null` — et non `[]` — signale « liaison positionnelle » au pont : c'est ce qui
    // décide s'il attend une liste ou un objet de paramètres.
    expect(names).toBeNull();
  });

  it("traduit les paramètres nommés de better-sqlite3 en positions, dans l'ordre d'apparition", () => {
    const { text, names } = translateIdentitySql(
      "INSERT INTO sessions (id, organization_id, user_id) VALUES (@id, @org, @user)",
    );
    expect(text).toBe(
      "INSERT INTO sessions (id, organization_id, user_id) VALUES ($1, $2, $3)",
    );
    expect(names).toEqual(["id", "org", "user"]);
  });

  it("réutilise la même position pour un nom répété", () => {
    const { text, names } = translateIdentitySql(
      "UPDATE users SET email = @email WHERE email = @email",
    );
    expect(text).toBe("UPDATE users SET email = $1 WHERE email = $1");
    expect(names).toEqual(["email"]);
  });

  it("traduit INSERT OR IGNORE en ON CONFLICT DO NOTHING", () => {
    const { text } = translateIdentitySql(
      "INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)",
    );
    expect(text).toContain("INSERT INTO organizations");
    expect(text).toContain("ON CONFLICT DO NOTHING");
    expect(text).not.toMatch(/OR IGNORE/i);
  });

  it("refuse INSERT OR REPLACE au lieu de produire un équivalent approximatif", () => {
    // `OR REPLACE` supprime puis réinsère en SQLite ; l'équivalent PostgreSQL dépend de
    // la contrainte visée. Traduire au hasard changerait la sémantique d'une écriture
    // d'identité — donc refus explicite, à écrire correctement à l'appel.
    expect(() =>
      translateIdentitySql("INSERT OR REPLACE INTO sessions (id) VALUES (?)"),
    ).toThrow(/OR REPLACE/i);
  });

  it("ne touche pas à un point d'interrogation dans une chaîne littérale", () => {
    const { text } = translateIdentitySql("SELECT 'why?' AS q WHERE id = ?");
    expect(text).toBe("SELECT 'why?' AS q WHERE id = $1");
  });

  it("refuse un mélange de paramètres nommés et positionnels", () => {
    expect(() => translateIdentitySql("UPDATE users SET email = @email WHERE id = ?")).toThrow(
      /mixed named and positional/i,
    );
  });

  it("laisse intacte une requête déjà portable", () => {
    const sql = "SELECT count(*) AS n FROM memberships WHERE organization_id = $1";
    expect(translateIdentitySql(sql).text).toBe(sql);
  });
});

describe("resolveIdentityWorkerPath — le worker doit être trouvable, sinon on le dit", () => {
  it("honore OATHRION_IDENTITY_PG_WORKER quand le fichier existe", () => {
    // Le fichier du dépôt lui-même : présent dans les sources et copié dans dist/ par
    // le build, ce qui est vérifié ici plutôt que supposé.
    const repoWorker = "server/identity/sync-postgres-worker.cjs";
    const resolved = resolveIdentityWorkerPath({ OATHRION_IDENTITY_PG_WORKER: repoWorker });
    expect(resolved).toContain("sync-postgres-worker.cjs");
  });

  it("échoue clairement quand le chemin demandé n'existe pas", () => {
    expect(() =>
      resolveIdentityWorkerPath({ OATHRION_IDENTITY_PG_WORKER: "/nowhere/absent-worker.cjs" }),
    ).toThrow(/absent-worker\.cjs/);
  });
});
