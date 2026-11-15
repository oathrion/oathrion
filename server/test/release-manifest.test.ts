/**
 * Tests de la règle « ce qui a le droit de sortir du dépôt ».
 *
 * ## POURQUOI CE TEST EXISTE ET POURQUOI IL VIT ICI
 *
 * L'archive livrée contenait un `.env` réel. La correction est une commande
 * d'empaquetage vérifiable, et la partie de cette commande dont une erreur coûte un
 * secret publié est une fonction pure : « ce chemin peut-il sortir ? ». C'est celle-ci
 * qui est testée, pas l'invocation de `tar`.
 *
 * Le fichier est dans `server/test/` parce que c'est là que `vitest.config.ts` cherche
 * les tests. Il importe depuis `script/` plutôt que d'y déplacer la logique : la
 * configuration de découverte des tests n'a pas été modifiée.
 *
 * ## LE CAS QUI COMPTE
 *
 * `.env.example` doit sortir — c'est le gabarit, il ne contient aucune valeur — et
 * `.env`, `.env.production`, `.env.local` ne doivent pas. Une règle qui refuserait tout
 * ce qui commence par `.env` casserait la documentation ; une règle qui accepterait tout
 * ce qui commence par `.env` publierait le secret. C'est exactement la frontière sur
 * laquelle l'erreur d'origine a été commise.
 */

import { describe, expect, it } from "vitest";
import { manifestProblems, releasePathProblem } from "../../script/release-manifest";

describe("releasePathProblem — ce qui ne doit jamais sortir", () => {
  it("refuse tout fichier d'environnement sauf le gabarit", () => {
    for (const path of [
      ".env",
      ".env.production",
      ".env.local",
      ".env.staging",
      "config/.env",
      "./.env",
    ]) {
      expect(releasePathProblem(path), path).not.toBeNull();
      expect(releasePathProblem(path)).toMatch(/OATHRION_SESSION_SECRET/);
    }
  });

  it("refuse un fichier <nom>.env rempli (kit deploy/), garde son gabarit", () => {
    expect(releasePathProblem("deploy/placet.env")).not.toBeNull();
    expect(releasePathProblem("prod.env")).not.toBeNull();
    expect(releasePathProblem("deploy/placet.env.example")).toBeNull();
  });

  it("laisse sortir le gabarit versionné", () => {
    expect(releasePathProblem(".env.example")).toBeNull();
    expect(releasePathProblem("./.env.example")).toBeNull();
  });

  it("refuse la base SQLite et ses fichiers annexes", () => {
    for (const path of [
      "data.db",
      "data.db-wal",
      "data.db-shm",
      "data.db-journal",
      "var/data.db",
    ]) {
      expect(releasePathProblem(path), path).toMatch(/journal d'audit/);
    }
  });

  it("refuse les répertoires reconstruits et les états transitoires", () => {
    expect(releasePathProblem("node_modules/express/index.js")).not.toBeNull();
    expect(releasePathProblem("dist/index.cjs")).not.toBeNull();
    expect(releasePathProblem(".mutation-backup/server/auth.ts")).not.toBeNull();
    expect(releasePathProblem("npm-install.log")).not.toBeNull();
  });

  it("refuse une clé privée", () => {
    expect(releasePathProblem("deploy/id_rsa")).toMatch(/clé privée/);
    expect(releasePathProblem("certs/server.pem")).toMatch(/clé privée/);
  });

  it("refuse un chemin vide plutôt que de l'interpréter", () => {
    expect(releasePathProblem("")).not.toBeNull();
    expect(releasePathProblem("   ")).not.toBeNull();
  });

  it("laisse sortir le code, les tests et la documentation", () => {
    for (const path of [
      "package.json",
      "server/auth.ts",
      "server/bootstrap-admin.ts",
      "script/package-release.ts",
      "client/src/main.tsx",
      "shared/policy/engine.ts",
      "README.md",
      "Dockerfile",
      ".github/workflows/ci.yml",
      // Un nom qui contient « data.db » sans être la base : la règle est ancrée sur le
      // segment de chemin, pas sur une recherche de sous-chaîne.
      "docs/data.db.md",
      // Idem pour « dist » : un répertoire nommé « distribution » n'est pas « dist ».
      "docs/distribution/guide.md",
    ]) {
      expect(releasePathProblem(path), path).toBeNull();
    }
  });
});

describe("manifestProblems — tous les problèmes, pas seulement le premier", () => {
  it("signale chaque entrée fautive", () => {
    const problems = manifestProblems([
      "package.json",
      ".env",
      "server/auth.ts",
      "data.db",
      "debug.log",
    ]);
    expect(problems).toHaveLength(3);
    expect(problems.join("\n")).toContain(".env");
    expect(problems.join("\n")).toContain("data.db");
    expect(problems.join("\n")).toContain("debug.log");
  });

  it("ne signale rien sur un manifeste propre", () => {
    expect(manifestProblems(["package.json", "server/db.ts", ".env.example"])).toEqual([]);
  });
});

/**
 * Catégories ajoutées après relecture de la liste de contrôle d'empaquetage.
 *
 * La liste de refus initiale couvrait `.env`, `data.db`, les répertoires reconstruits, les
 * journaux et deux formes de clé privée. Elle laissait sortir un export de base
 * (`dump.sql`), un `.npmrc` — donc un jeton de publication au registre —, une seconde base
 * locale (`backup.db`), un cache, et les résidus d'un conflit de fusion.
 *
 * Aucun de ces fichiers n'est suivi par git aujourd'hui, et la liste d'autorisation les
 * arrêterait donc de toute façon. Mais la liste de refus n'existe que pour le cas où
 * l'autorisation a été forcée — `git add -f` — et couvrir « presque » ce cas revient à ne
 * pas le couvrir.
 */
describe("releasePathProblem — dumps, credentials, caches, résidus", () => {
  it("refuse un export de données mais laisse sortir une migration SQL", () => {
    for (const path of [
      "dump.sql",
      "backup/placet-2026-08.sql",
      "placet.dump",
      "db-backup.sql.gz",
      "snapshot.sql.zst",
    ]) {
      expect(releasePathProblem(path), path).toMatch(/export de base/);
    }
    // L'extension `.sql` sert aux deux : la migration PostgreSQL prévue doit sortir,
    // sinon la règle bloque le travail légitime et finit désactivée.
    for (const path of [
      "server/migrations/007-organisations.sql",
      "migrations/008.sql",
      "schema/init.sql",
    ]) {
      expect(releasePathProblem(path), path).toBeNull();
    }
  });

  it("refuse les fichiers de credentials, .npmrc en premier", () => {
    for (const path of [
      ".npmrc",
      ".netrc",
      ".pgpass",
      "kubeconfig",
      "credentials.json",
      "service-account.json",
      ".aws/credentials",
      "deploy/gcp-key.json",
      "secrets.yaml",
      "api-tokens.yml",
    ]) {
      expect(releasePathProblem(path), path).not.toBeNull();
    }
  });

  it("refuse toute base locale, pas seulement celle du projet", () => {
    for (const path of ["backup.db", "prod.sqlite", "copie.sqlite3", "tmp/x.db-wal"]) {
      expect(releasePathProblem(path), path).toMatch(/base/);
    }
  });

  it("refuse les magasins de clés au-delà de .pem", () => {
    for (const path of [
      "tls.key",
      "cert.p12",
      "cert.pfx",
      "keystore.jks",
      ".ssh/id_ed25519",
      ".gnupg/secring.gpg",
    ]) {
      expect(releasePathProblem(path), path).toMatch(/clé privée|magasin/);
    }
  });

  it("refuse les caches et rapports locaux", () => {
    for (const path of [
      "coverage/lcov.info",
      ".nyc_output/x.json",
      ".vite/deps/chunk.js",
      ".cache/x",
      ".turbo/log",
      "tsconfig.tsbuildinfo",
    ]) {
      expect(releasePathProblem(path), path).toMatch(/cache|rapport/);
    }
  });

  it("refuse les temporaires et les résidus de conflit de fusion", () => {
    // `.orig` et `.rej` contiennent une autre version du fichier voisin : livrés, ils
    // exposent du code que personne n'a relu.
    for (const path of [
      "notes.tmp",
      "server/routes.ts.orig",
      "server/auth.ts.rej",
      "server/auth.ts.bak",
      ".server.ts.swp",
      "server/routes.ts~",
      ".DS_Store",
    ]) {
      expect(releasePathProblem(path), path).toMatch(/temporaire|sauvegarde|résidu/);
    }
  });

  it("laisse sortir un gabarit, quelle que soit la règle qui le viserait", () => {
    // Généralisation de l'exception faite à `.env.example`. Sans elle, une fixture nommée
    // `service-account.example.json` serait refusée et l'auteur contournerait la règle.
    for (const path of [
      ".env.example",
      "secrets.example.yaml",
      "service-account.example.json",
      "kubeconfig.template",
      "credentials.sample.json",
    ]) {
      expect(releasePathProblem(path), path).toBeNull();
    }
  });

  it("laisse sortir les fichiers réels du dépôt", () => {
    // Garde-fou contre un faux positif : ces chemins existent, et une règle trop large
    // rendrait l'empaquetage impossible sans rien protéger de plus.
    for (const path of [
      "package.json",
      "package-lock.json",
      "components.json",
      "tsconfig.json",
      "drizzle.config.ts",
      "eslint.config.js",
      "postcss.config.js",
      "server/routes.ts",
      "server/migrations/001-baseline.ts",
      "shared/policy/engine.ts",
      "client/src/pages/agents.tsx",
      "script/secret-scan.ts",
      "README.md",
      ".github/workflows/ci.yml",
      "Dockerfile",
      ".dockerignore",
    ]) {
      expect(releasePathProblem(path), path).toBeNull();
    }
  });
});
