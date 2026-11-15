/**
 * PHASE 12 — redémarrage réel de PostgreSQL, et ce que fait Oathrion pendant que la base est
 * absente.
 *
 * La Phase 11 avait laissé cet élément en **NON TESTÉ**, et pour une bonne raison : un
 * `pool.end()` suivi d'une nouvelle requête ne prouve rien. Il ferme des sockets côté
 * client, pendant que le serveur reste debout — exactement le cas facile. Ce fichier
 * arrête et redémarre le vrai serveur PostgreSQL (`pg_ctlcluster`), ce qui coupe la
 * connexion depuis l'autre extrémité, comme un redémarrage de base gérée le ferait.
 *
 * Deux affirmations, distinctes :
 *
 *   golden AI — une instance vivante pendant un redémarrage se reconnecte et refonctionne,
 *               sans être relancée.
 *   golden AJ — pendant que la base est absente, l'identité n'est pas devinée : la requête
 *               échoue et l'appelant n'est pas authentifié (FAIL CLOSED). Il n'y a aucun
 *               repli SQLite, aucun cache mémoire, aucun « on laisse passer, ça revient ».
 *
 * ## Pourquoi ce fichier est SKIPPÉ par défaut
 *
 * Il arrête un service partagé de la machine. Dans un CI où d'autres suites parlent à la
 * même instance PostgreSQL, l'exécuter en parallèle les ferait échouer pour une raison qui
 * n'est pas la leur. Il faut donc le demander explicitement, et le SKIP est bruyant :
 *
 *   OATHRION_TEST_IDENTITY_PG_URL=postgres://postgres:placet@127.0.0.1:5432/oathrion_p12 \
 *   OATHRION_TEST_PG_RESTART=1 npx vitest run server/test/phase12-restart-reconnect.test.ts
 *
 * `OATHRION_TEST_PG_CLUSTER` ("18 main" par défaut) désigne le cluster à cycler, et la
 * commande passe par `sudo -n` : si sudo demande un mot de passe, le test échoue au lieu
 * de faire semblant.
 *
 * `OATHRION_TEST_PG_DOCKER=<conteneur>` remplace le cluster de l'hôte par un conteneur
 * PostgreSQL JETABLE : `docker stop` puis `docker start`, la même coupure vue depuis
 * l'autre extrémité. Les affirmations ne changent pas. Ajouté parce qu'une machine sans
 * PostgreSQL installé sur l'hôte (ni `pg_ctlcluster` ni `pg_isready`) ne pouvait jamais
 * exécuter ce fichier : il restait « non testé » faute de moyen, pas faute de raison.
 * Ne jamais désigner un conteneur partagé : il est réellement arrêté.
 */

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { KEY_PREFIX } from "../api-keys";

import {
  migratePhase12Database,
  parseInstanceOutput,
  PHASE12_IDENTITY_URL as IDENTITY_URL,
  runInstance,
  spawnInstance,
} from "./helpers/phase12-instance";

const RESTART_REQUESTED = process.env.OATHRION_TEST_PG_RESTART?.trim() === "1";
const [CLUSTER_VERSION, CLUSTER_NAME] = (
  process.env.OATHRION_TEST_PG_CLUSTER?.trim() ?? "18 main"
)
  .split(/\s+/)
  .concat("main");

const DOCKER = process.env.OATHRION_TEST_PG_DOCKER?.trim() ?? "";

/** La commande qui arrête ou redémarre la base : le conteneur jetable, ou le cluster de l'hôte. */
function cycleCommand(action: "stop" | "start"): string[] {
  return DOCKER !== ""
    ? ["docker", action, DOCKER]
    : ["sudo", "-n", "pg_ctlcluster", CLUSTER_VERSION, CLUSTER_NAME, action, "--skip-systemctl-redirect"];
}

const ENABLED = IDENTITY_URL !== "" && RESTART_REQUESTED;

if (!ENABLED) {
  console.warn(
    "[phase12] SKIPPED — redémarrage/reconnexion PostgreSQL NON TESTÉ : il faut " +
      "OATHRION_TEST_IDENTITY_PG_URL et OATHRION_TEST_PG_RESTART=1 (le test arrête un service partagé). " +
      "Aucune variante n'est rejouée sur SQLite : un fichier local ne peut pas redémarrer.",
  );
}

function pgctl(action: "stop" | "start"): void {
  const [command, ...args] = cycleCommand(action);
  const result = spawnSync(command!, args, { encoding: "utf8", timeout: 60_000 });
  // `stop` sur un cluster déjà arrêté et `start` sur un cluster déjà démarré renvoient un
  // code non nul ; c'est acceptable. Un échec de sudo ne l'est pas.
  if ((result.stderr ?? "").includes("password is required")) {
    throw new Error(
      "sudo -n a échoué : le test de redémarrage ne peut pas cycler PostgreSQL.",
    );
  }
}

function waitForPostgres(up: boolean, timeoutMs = 60_000): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe =
      DOCKER !== ""
        ? spawnSync("docker", ["exec", DOCKER, "pg_isready", "-q", "-t", "2"], { encoding: "utf8", timeout: 10_000 })
        : spawnSync("pg_isready", ["-h", "127.0.0.1", "-p", "5432", "-t", "2"], {
            encoding: "utf8",
            timeout: 10_000,
          });
    const isUp = probe.status === 0;
    if (isUp === up) return true;
    const wait = spawnSync("sleep", ["0.5"]);
    void wait;
  }
  return false;
}

const suite = ENABLED ? describe : describe.skip;

suite("Phase 12 — redémarrage PostgreSQL et fail-closed", () => {
  const tag = randomBytes(4).toString("hex");
  const org = `org_p12_restart_${tag}`;
  let secret = "";

  beforeAll(() => {
    expect(waitForPostgres(true)).toBe(true);
    migratePhase12Database();
    const created = runInstance([
      { op: "createApiKey", organization: org, role: "operator" },
    ]);
    secret = String(created[0].secret);
    expect(secret.startsWith(KEY_PREFIX)).toBe(true);
  }, 200_000);

  afterAll(() => {
    // La base est laissée dans l'état où les autres suites l'attendent, même si un test
    // a échoué au milieu du cycle.
    pgctl("start");
    waitForPostgres(true);
  }, 120_000);

  it("golden AI — une instance vivante traverse un vrai arrêt/redémarrage de PostgreSQL et se reconnecte", () => {
    const rendezvous = path.join(os.tmpdir(), `phase12-restart-${tag}`);
    if (fs.existsSync(rendezvous)) fs.rmSync(rendezvous);

    /*
     * Le cycle PostgreSQL est fait par un script détaché, parce que `spawnSync` bloque
     * ce processus : il attend que l'instance ait authentifié une première fois, arrête
     * le serveur, le redémarre, puis pose le fichier de rendez-vous qui débloque la
     * seconde authentification.
     */
    const script = path.join(os.tmpdir(), `phase12-cycle-${tag}.sh`);
    fs.writeFileSync(
      script,
      [
        "#!/bin/bash",
        "sleep 8",
        cycleCommand("stop").join(" "),
        "sleep 3",
        cycleCommand("start").join(" "),
        "sleep 3",
        `touch ${rendezvous}`,
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const cycler = spawn("bash", [script], { detached: true, stdio: "ignore" });
    cycler.unref();

    // L'instance authentifie une fois, attend le fichier — pendant lequel le serveur est
    // réellement arrêté puis redémarré — puis authentifie de nouveau, sans être relancée.
    const child = spawnSync(
      "npx",
      [
        "tsx",
        path.join(
          process.cwd(),
          "server/test/fixtures/phase12-identity-instance.ts",
        ),
        JSON.stringify({
          ops: [
            { op: "resolve", credential: secret },
            { op: "waitForFile", path: rendezvous, timeoutMs: 120_000 },
            { op: "resolve", credential: secret },
          ],
        }),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 200_000,
        env: {
          ...process.env,
          NODE_ENV: "test",
          DATABASE_DRIVER: "postgres",
          DATABASE_URL: IDENTITY_URL,
          OATHRION_IDENTITY_PLANE: "postgres",
          OATHRION_SESSION_SECRET: "phase12-multiprocess-session-secret",
          OATHRION_API_KEYS: "Phase12/CI:admin:phase12-multiprocess-bootstrap-key",
        },
      },
    );

    const results = parseInstanceOutput(child);
    expect(results[0].authenticated).toBe(true);
    expect(results[1].seen).toBe(true);
    // Après le redémarrage réel : la même instance, non relancée, authentifie encore.
    expect(results[2].authenticated).toBe(true);
  }, 300_000);

  it("golden AJ — base absente : l'identité n'est pas devinée, l'appelant n'est pas authentifié", () => {
    pgctl("stop");
    expect(waitForPostgres(false)).toBe(true);

    const attempt = spawnInstance(
      [{ op: "resolve", credential: secret }],
      {},
      90_000,
    );
    const stdout = attempt.stdout ?? "";
    const stderr = attempt.stderr ?? "";

    // Deux issues acceptables, toutes deux fermées : l'instance refuse de démarrer
    // (aucun repli SQLite disponible), ou elle démarre et la requête d'identité échoue.
    if (stdout.includes("RESULT:")) {
      const results = parseInstanceOutput(attempt);
      expect(results[0].authenticated).not.toBe(true);
      expect(results[0].id ?? null).toBeNull();
    } else {
      expect(attempt.status).not.toBe(0);
      // Le refus doit être explicite et dire pourquoi il n'y a pas de repli.
      expect(`${stdout}${stderr}`).toMatch(/identity plane/i);
    }

    // Et surtout : rien n'a été écrit dans un fichier SQLite local pendant la panne.
    expect(fs.existsSync(path.join(process.cwd(), "identity.db"))).toBe(false);

    pgctl("start");
    expect(waitForPostgres(true)).toBe(true);

    // La base revenue, une nouvelle instance authentifie de nouveau : la panne n'a rien
    // corrompu et n'a pas laissé de credential fantôme.
    const [after] = runInstance([{ op: "resolve", credential: secret }]);
    expect(after.authenticated).toBe(true);
  }, 300_000);
});
