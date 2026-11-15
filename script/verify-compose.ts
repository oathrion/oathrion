/**
 * Preuve de la pile de déploiement complète : `docker compose up`, de bout en bout.
 *
 *   npm run verify:compose
 *
 * ## Pourquoi ce script existe
 *
 * Le rapport de la Phase 13 marquait « `docker compose up` complet : **SKIPPED** — pas
 * de plugin compose ni réseau bridge ici ». Le kit de déploiement était donc livré sans
 * que personne ne l'ait jamais démarré — alors que c'est exactement la façon dont un
 * pilote sera installé.
 *
 * ## Ce qu'il prouve
 *
 * Que la pile des quatre services démarre dans le bon ordre, que la migration **garde**
 * le démarrage d'Oathrion, que le proxy sert en HTTPS avec HSTS et redirige le port 80, que
 * le durcissement annoncé est réel (rootfs en lecture seule, utilisateur non root,
 * PostgreSQL non publié), qu'un parcours client complet passe par le proxy, et qu'une
 * panne de base donne 503 sur `/api/ready` sans tuer le processus ni empêcher la reprise.
 *
 * ## Ce qu'il ne prouve pas
 *
 * **Le certificat public.** Caddy obtient un certificat Let's Encrypt par un défi ACME,
 * qui exige un nom DNS public pointant sur la machine et un port 80 joignable depuis
 * l'extérieur. Ce script tourne avec `OATHRION_DOMAIN=localhost`, donc la **CA interne** de
 * Caddy. Tout le chemin TLS est vérifié sauf l'obtention du certificat lui-même, et
 * c'est dit plutôt que laissé entendre.
 */

import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEPLOY = path.join(ROOT, "deploy");
const ENV_FILE = path.join(DEPLOY, "placet.env");
const BASE = "https://localhost";

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 66 - label.length))}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function run(cmd: string, args: string[], cwd = DEPLOY, timeout = 900_000) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout });
  return { status: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
const compose = (...args: string[]) => run("docker", ["compose", "--env-file", "placet.env", ...args]);

/** `curl -k` : la CA interne de Caddy n'est pas dans le magasin du système. */
function curl(args: string[]): { status: number; body: string } {
  const r = run("curl", ["-sk", "-m", "15", ...args], ROOT, 30_000);
  return { status: r.status, body: r.out };
}
function httpCode(url: string, extra: string[] = []): string {
  return curl(["-o", "/dev/null", "-w", "%{http_code}", ...extra, url]).body.trim();
}

function secret(bytes: number): string {
  return run("openssl", ["rand", "-hex", String(bytes)], ROOT, 10_000).out.trim();
}

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE DE LA PILE DE DÉPLOIEMENT (docker compose, bout en bout)");

  if (run("docker", ["compose", "version"], ROOT, 30_000).status !== 0) {
    console.log("\nSKIPPÉ BRUYAMMENT : `docker compose` est introuvable sur cette machine.");
    console.log("Ce script ne peut rien prouver sans lui, et ne prétend donc rien.");
    return 0;
  }

  /*
   * Refus d'écraser un `placet.env` existant. Il porte les secrets d'un déploiement réel ;
   * le remplacer par des valeurs de test serait la pire chose que ce script puisse faire.
   */
  if (existsSync(ENV_FILE)) {
    console.error(`\nRefus : ${ENV_FILE} existe déjà. Ce script écrirait par-dessus les`);
    console.error("secrets d'un déploiement. Déplacez-le, puis relancez.");
    return 2;
  }

  const adminPassword = `pilote-${secret(12)}`;
  writeFileSync(
    ENV_FILE,
    [
      "OATHRION_DOMAIN=localhost",
      `POSTGRES_PASSWORD=${secret(24)}`,
      `OATHRION_SESSION_SECRET=${secret(32)}`,
      `OATHRION_CONSOLE_USERS=Pilote/admin@pilote.test:admin:${adminPassword}`,
      "OATHRION_API_KEYS=",
      "RATE_LIMIT_FAIL_MODE=closed",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  try {
    section("DÉMARRAGE — quatre services, dans l'ordre");
    const up = compose("up", "-d", "--build");
    record("`docker compose up -d --build` réussit", up.status === 0, up.out.trim().split("\n").pop() ?? "");
    if (up.status !== 0) {
      console.log(up.out.slice(-2500));
      return 1;
    }

    for (let i = 0; i < 60 && httpCode(`${BASE}/api/ready`) !== "200"; i += 1) await sleep(2000);

    const migrateExit = run("docker", ["inspect", "placet-migrate-1", "--format", "{{.State.ExitCode}}"], ROOT, 30_000);
    record("la migration ponctuelle s'est terminée avec succès", migrateExit.out.trim() === "0", `code ${migrateExit.out.trim()}`);
    const migrateLog = compose("logs", "migrate");
    record(
      "elle a réellement appliqué le schéma, avant tout démarrage",
      /the database is at version \d+/.test(migrateLog.out),
      migrateLog.out.trim().split("\n").pop()?.slice(-60) ?? "",
    );

    section("TLS — le proxy, avec la CA interne de Caddy");
    record("HTTPS répond 200 sur /api/ready", httpCode(`${BASE}/api/ready`) === "200");
    const headers = curl(["-I", `${BASE}/api/ready`]).body;
    record("HSTS est posé", /strict-transport-security:\s*max-age=\d+/i.test(headers));
    record("l'en-tête Server est retiré", !/^server:/im.test(headers));
    record("le port 80 redirige en 308", httpCode("http://localhost/api/ready") === "308");

    section("DURCISSEMENT — ce que le compose annonce est réel");
    const inspect = run("docker", ["inspect", "placet-placet-1", "--format",
      "{{.Config.User}}|{{.HostConfig.ReadonlyRootfs}}|{{index .HostConfig.SecurityOpt 0}}"], ROOT, 30_000).out.trim();
    const [user, readonly, secopt] = inspect.split("|");
    record("le processus ne tourne pas en root", user === "node", `user=${user}`);
    record("le système de fichiers est en lecture seule", readonly === "true");
    record("no-new-privileges est posé", (secopt ?? "").includes("no-new-privileges:true"));
    const write = compose("exec", "-T", "placet", "sh", "-c", "touch /app/preuve");
    record("une écriture dans /app est effectivement refusée", /read-only file system/i.test(write.out), write.out.trim().split("\n").pop() ?? "");
    const pgPorts = run("docker", ["inspect", "placet-postgres-1", "--format", "{{json .NetworkSettings.Ports}}"], ROOT, 30_000).out.trim();
    record("PostgreSQL n'est pas publié sur l'hôte", !/"HostPort"/.test(pgPorts), pgPorts);

    section("RÉSEAU — écoute, publication et proxy, trois décisions distinctes");
    /*
     * L'ÉCOUTE : dans le conteneur, Oathrion doit écouter sur l'interface du réseau Compose
     * (0.0.0.0), sinon Caddy ne l'atteint pas — et il doit le DIRE, parce que c'est une
     * décision (OATHRION_HOST) et non plus une valeur en dur. Lu dans /proc/net/tcp du
     * conteneur : c'est le noyau qui répond, pas la configuration.
     */
    const placetLog = compose("logs", "placet").out;
    record("Oathrion annonce son écoute de conteneur, et qu'elle n'est pas la boucle locale",
      /listening on 0\.0\.0\.0:5000 — NOT loopback/.test(placetLog));
    const tcp = compose("exec", "-T", "placet", "cat", "/proc/net/tcp").out;
    const listening = tcp.split("\n").filter((line) => / 0A /.test(line)).map((line) => line.trim().split(/\s+/)[1]);
    record("le noyau du conteneur montre l'écoute sur 0.0.0.0:5000", listening.includes("00000000:1388"), listening.join(" "));
    /*
     * LA PUBLICATION : le port 5000 n'atteint pas l'hôte. `docker port` liste ce qui est
     * publié ; une connexion directe à 127.0.0.1:5000 depuis l'hôte doit échouer (rien
     * d'autre de ce banc n'écoute sur ce port de l'hôte).
     */
    const placetPorts = run("docker", ["port", "placet-placet-1"], ROOT, 30_000).out.trim();
    record("aucun port d'Oathrion n'est publié sur l'hôte", placetPorts === "", placetPorts || "aucun");
    const direct = curl(["-o", "/dev/null", "-w", "%{http_code}", "-m", "3", "http://127.0.0.1:5000/api/live"]).body.trim();
    record("une connexion directe de l'hôte au port 5000 n'aboutit pas", direct === "000", `code ${direct}`);
    const proxyPorts = run("docker", ["port", "placet-proxy-1"], ROOT, 30_000).out.trim();
    record("seul le proxy est publié (80 et 443)", /^80\/tcp/m.test(proxyPorts) && /^443\/tcp/m.test(proxyPorts), proxyPorts.replace(/\n/g, " ; "));
    /* LE PROXY : la porte publique, et l'authentification y reste exigée. */
    record("à travers le proxy, une route protégée sans credential répond 401", httpCode(`${BASE}/api/agents`) === "401");

    section("PARCOURS CLIENT — à travers le proxy, pas en direct");
    const login = curl(["-X", "POST", `${BASE}/api/auth/login`, "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ email: "admin@pilote.test", password: adminPassword })]);
    const token = (JSON.parse(login.body || "{}") as { token?: string }).token ?? "";
    record("l'administrateur se connecte", token !== "");
    const session = curl([`${BASE}/api/auth/session`, "-H", `Authorization: Bearer ${token}`]);
    const org = (JSON.parse(session.body || "{}") as { identity?: { organizationId?: string } }).identity?.organizationId ?? "";
    record("son locataire porte un identifiant opaque", /^org_[a-z0-9]{20}$/.test(org), org);
    const verify = curl([`${BASE}/api/actions/receipts/verify`, "-H", `Authorization: Bearer ${token}`]);
    record("il peut vérifier sa chaîne de reçus", /"ok":true/.test(verify.body), verify.body.trim().slice(0, 70));
    const tools = curl([`${BASE}/api/tools`, "-H", `Authorization: Bearer ${token}`]);
    record("l'inventaire déclare la simulation", /"simulated":(true|false)/.test(tools.body));

    section("INVITER UN CLIENT — la commande de l'exploitant, DANS l'image");
    const clientPassword = `client-${secret(10)}`;
    /*
     * Le parcours d'invitation tel qu'un exploitant le suit : la commande est livrée dans
     * l'image (`dist/workspace-create.cjs`), la base n'est pas publiée, et le client ne lit
     * le lien qu'à travers le proxy HTTPS.
     */
    const invited = compose(
      "exec", "-T", "placet", "node", "dist/workspace-create.cjs", "--org", "Client pilote", "--email", "client@pilote.test",
    );
    const link = /#\/bienvenue\?invitation=(\S+)/.exec(invited.out)?.[1] ?? "";
    record("`docker compose exec placet node dist/workspace-create.cjs` imprime un lien", invited.status === 0 && link !== "",
      invited.status === 0 ? "lien imprimé" : invited.out.trim().slice(-200));
    if (link) {
      const token = decodeURIComponent(link);
      const inspected = curl(["-X", "POST", `${BASE}/api/invitations/inspect`, "-H", "Content-Type: application/json",
        "-d", JSON.stringify({ token })]);
      record("le lien se lit à travers le proxy : organisation, adresse, rôle", /"role":"admin"/.test(inspected.body) && /Client pilote/.test(inspected.body));
      const accepted = curl(["-X", "POST", `${BASE}/api/invitations/accept`, "-H", "Content-Type: application/json",
        "-w", "\n%{http_code}", "-d", JSON.stringify({ token, name: "Cliente", password: clientPassword })]);
      record("le client crée son compte depuis la page d'accueil", accepted.body.trim().endsWith("201"));
    }

    section("PANNE ET REPRISE — base arrêtée sous une instance vivante");
    compose("stop", "postgres");
    await sleep(6000);
    record("/api/ready passe à 503", httpCode(`${BASE}/api/ready`) === "503");
    record("/api/live reste 200 — le processus est vivant, pas prêt", httpCode(`${BASE}/api/live`) === "200");
    const alive = run("docker", ["inspect", "placet-placet-1", "--format", "{{.State.Running}}"], ROOT, 30_000).out.trim();
    record("Oathrion n'est pas mort", alive === "true");

    compose("start", "postgres");
    let back = "";
    for (let i = 0; i < 40; i += 1) {
      back = httpCode(`${BASE}/api/ready`);
      if (back === "200") break;
      await sleep(2000);
    }
    record("la même instance redevient prête SANS redémarrage", back === "200", `ready ${back}`);

    section("ARRÊT NORMAL ET REDÉMARRAGE — les données et les secrets restent");
    /*
     * `docker compose down` SANS `-v` : ce que fait un exploitant pour une mise à jour ou
     * une maintenance. Le volume doit survivre, et les secrets ne sont pas régénérés : le
     * fichier d'environnement n'est pas réécrit, donc une session signée reste vérifiable
     * et les comptes créés en base se connectent.
     */
    const envBefore = run("sha256sum", [ENV_FILE], ROOT, 10_000).out.split(" ")[0];
    const down = compose("down");
    record("`docker compose down` (sans -v) réussit", down.status === 0);
    const upAgain = compose("up", "-d");
    record("`docker compose up -d` redémarre la pile", upAgain.status === 0);
    let again = "";
    for (let i = 0; i < 60; i += 1) {
      again = httpCode(`${BASE}/api/ready`);
      if (again === "200") break;
      await sleep(2000);
    }
    record("la pile redevient prête", again === "200", `ready ${again}`);
    const relog = curl(["-X", "POST", `${BASE}/api/auth/login`, "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ email: "admin@pilote.test", password: adminPassword })]);
    record("l'administrateur se reconnecte après l'arrêt", /"token"/.test(relog.body));
    const clientLogin = curl(["-X", "POST", `${BASE}/api/auth/login`, "-H", "Content-Type: application/json",
      "-d", JSON.stringify({ email: "client@pilote.test", password: clientPassword })]);
    record("le compte client créé en base a survécu à l'arrêt", /"token"/.test(clientLogin.body));
    record("les secrets n'ont pas été régénérés", run("sha256sum", [ENV_FILE], ROOT, 10_000).out.split(" ")[0] === envBefore);

    section("CE QUI RESTE NON PROUVÉ");
    console.log("  Le certificat PUBLIC. Caddy l'obtient par un défi ACME, qui exige un nom");
    console.log("  DNS public pointant sur la machine et un port 80 joignable de l'extérieur.");
    console.log("  Ce passage tourne avec OATHRION_DOMAIN=localhost, donc la CA interne : tout le");
    console.log("  chemin TLS est vérifié sauf l'obtention du certificat lui-même.");

    return 0;
  } finally {
    compose("down", "-v");
    rmSync(ENV_FILE, { force: true });
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    if (checks.length > 0) {
      console.log(`\n${"=".repeat(72)}`);
      console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
      console.log("=".repeat(72));
    }
    process.exit(code === 0 && failed.length === 0 ? 0 : 1);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
