/**
 * Preuve du connecteur GitHub — APPELS RÉELS à api.github.com.
 *
 *   npm run verify:github                     # ce qui ne demande pas de credential
 *   OATHRION_GITHUB_TEST_TOKEN=github_pat_… \
 *   OATHRION_GITHUB_TEST_REPO=owner/repo \
 *     npm run verify:github                   # le parcours complet
 *
 * ## Pourquoi ce script est séparé de la suite
 *
 * `npm test` ne sort pas sur le réseau, et c'est une qualité : une suite qui dépend d'un
 * service tiers échoue quand ce service tousse, et on finit par l'ignorer. Mais une suite
 * qui ne sort jamais ne peut rien dire d'une intégration. Les deux existent donc, et
 * elles ne se remplacent pas :
 *
 *   `server/test/connector-*.test.ts`  le coffre, le chiffrement, ALLOW/BLOCK/APPROVAL
 *                                      contre un connecteur espion. Hors ligne.
 *   `npm run verify:github`            GitHub répond-il vraiment, et comme prévu.
 *
 * ## Deux sections, et la première tourne toujours
 *
 * SANS CREDENTIAL, on peut déjà vérifier beaucoup contre le vrai service : qu'un jeton
 * invalide reçoit un 401 et qu'Oathrion rend le message de GitHub et non le sien, que le
 * transport TLS joint l'hôte épinglé, que les refus locaux (cible mal formée, jeton vide)
 * n'envoient rien.
 *
 * AVEC CREDENTIAL, on vérifie ce qui ne se devine pas : le compte réel, les capacités
 * dérivées de ce que GitHub annonce, une lecture, une écriture, un 404 sur un dépôt
 * absent, et le cycle complet jusqu'à la révocation.
 *
 * ## Codes de sortie
 *
 * 0 tout est passé · 1 un contrôle a échoué · 2 impossible à mettre en place. Un jeton
 * absent donne **2 et jamais 0** : « je n'ai pas pu tester » ne doit pas pouvoir être lu
 * comme « j'ai testé ».
 *
 * ## Ce que ce script n'écrit nulle part
 *
 * Le jeton. Il est lu dans l'environnement, passé au connecteur, et n'apparaît dans
 * aucune sortie — seulement son empreinte de six caractères.
 */

import { randomBytes } from "node:crypto";

import Database from "better-sqlite3";

import type { OrganizationId } from "@shared/tenancy";

import { GithubConnector, parseRepository, RepositoryTargetError } from "../server/connectors/github";
import { ConnectorVault, fingerprintOf, resetVaultKeyring } from "../server/connectors/vault";
import { connectorCredentials } from "../server/migrations/021-connector-credentials";
import { sqliteExecutor } from "../server/sql/executor";
import type { ConnectorContext } from "../server/connectors/types";

const ORG = "org_verifygithub00000" as OrganizationId;

/** Un jeton manifestement invalide. Pas un secret : il n'en a jamais été un. */
const INVALID_TOKEN = "github_pat_11INVALIDE000000000_ceci_nest_pas_un_jeton";

interface Check { name: string; ok: boolean; detail: string }
const checks: Check[] = [];

function record(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(label: string): void {
  console.log(`\n── ${label} ${"─".repeat(Math.max(0, 68 - label.length))}`);
}

/** Un coffre jetable en mémoire, avec sa propre clé. Rien n'est écrit sur le disque. */
function throwawayVault(): { vault: ConnectorVault; close: () => void; env: NodeJS.ProcessEnv } {
  const database = new Database(":memory:");
  for (const statement of connectorCredentials.statements({
    dialect: "sqlite",
    tableExists: () => false,
    columns: () => new Set<string>(),
  })) {
    database.exec(statement);
  }
  /*
   * Une clé neuve par passage, jamais écrite. Le coffre n'est pas ce qu'on teste ici
   * (`server/test/connector-vault.test.ts` s'en charge) ; il est là pour que le chemin
   * « sceller puis rouvrir puis appeler GitHub » soit exercé en entier.
   */
  const env = { ...process.env, OATHRION_KEK: randomBytes(32).toString("base64") } as NodeJS.ProcessEnv;
  resetVaultKeyring();
  return {
    vault: new ConnectorVault(sqliteExecutor(database), ORG, env),
    close: () => {
      database.close();
      resetVaultKeyring();
    },
    env,
  };
}

async function main(): Promise<number> {
  console.log("Oathrion — PREUVE DU CONNECTEUR GITHUB (appels réels à api.github.com)");

  const connector = new GithubConnector();
  const token = process.env.OATHRION_GITHUB_TEST_TOKEN?.trim() ?? "";
  const repo = process.env.OATHRION_GITHUB_TEST_REPO?.trim() ?? "";

  /* ------------------------------------------------- refus purement locaux */
  section("REFUS LOCAUX — rien ne part sur le réseau");

  for (const [bad, why] of [
    ["placet-labs/pilote", "forme courte, sans hôte"],
    ["github.com/placet-labs", "un seul segment après l'hôte"],
    ["github.com/placet-labs/pilote/issues", "un segment de trop"],
    ["github.com/../../user", "remontée de chemin"],
    ["placet-labs/pilote?x=1", "paramètre de requête"],
  ] as const) {
    let refused = false;
    let message = "";
    try {
      parseRepository(bad);
    } catch (error) {
      refused = error instanceof RepositoryTargetError;
      message = error instanceof Error ? error.message.split(".")[0]! : "";
    }
    record(`la cible "${bad}" est refusée (${why})`, refused, message.slice(0, 80));
  }

  record(
    'la forme "github.com/owner/repo" est acceptée, et l\'hôte est lisible',
    JSON.stringify(parseRepository("github.com/placet-labs/pilote")) ===
      JSON.stringify({ host: "github.com", owner: "placet-labs", repo: "pilote" }),
  );

  const empty = await connector.verify("", {}, process.env);
  record(
    "un jeton vide est refusé sans appeler GitHub",
    !empty.ok && empty.code === "unauthorized",
    empty.detail.slice(0, 70),
  );

  /* --------------------------------------- le vrai service, sans credential */
  section("GITHUB RÉPOND — avec un jeton invalide, sans aucun credential requis");

  const bad = await connector.verify(INVALID_TOKEN, {}, process.env);

  if (bad.code === "unreachable") {
    console.error(`\nL'API GitHub est injoignable depuis cette machine : ${bad.detail}`);
    console.error("Ce script prouve un chemin RÉSEAU ; il refuse de passer sans réseau.");
    return 2;
  }

  record("GitHub refuse le jeton invalide", !bad.ok, `code ${bad.code}`);
  record("… et Oathrion le classe « unauthorized »", bad.code === "unauthorized", bad.code);
  /*
   * LE CONTRÔLE QUI DISTINGUE UN VRAI APPEL D'UNE SIMULATION. « Bad credentials » est la
   * formulation de GitHub, elle n'est écrite dans aucun code livré. Un connecteur qui
   * fabriquerait ses erreurs rendrait une autre phrase. Depuis le parcours guidé, le
   * détail commence par la consigne en français et CITE GitHub entre parenthèses.
   */
  record(
    "… en citant le message de GITHUB, pas le sien",
    bad.detail.endsWith("(GitHub : Bad credentials)"),
    JSON.stringify(bad.detail),
  );
  record("aucun compte n'est inventé pour un jeton refusé", bad.account === "", JSON.stringify(bad.account));
  record("le jeton n'apparaît pas dans la réponse", !JSON.stringify(bad).includes(INVALID_TOKEN));

  /* ------------------------------------------------------- avec credential */
  if (token === "" || repo === "") {
    section("LE PARCOURS COMPLET N'A PAS ÉTÉ EXÉCUTÉ");
    console.log("  Les contrôles ci-dessus sont réels et passent. Ce qui suit demande un jeton");
    console.log("  et un dépôt de test, et n'a donc PAS été vérifié :");
    console.log("    · le compte réel rendu par GitHub");
    console.log("    · les capacités dérivées de ce que GitHub annonce");
    console.log("    · la lecture d'un dépôt");
    console.log("    · l'ouverture d'une issue et un commentaire");
    console.log("    · le 404 d'un dépôt absent, et le cycle jusqu'à la révocation");
    console.log("");
    console.log("  Pour les exécuter :");
    console.log("    1. https://github.com/settings/personal-access-tokens/new");
    console.log("    2. « Repository access » → seulement votre dépôt de test");
    console.log("    3. « Repository permissions » → Issues: Read and write, Metadata: Read-only");
    console.log("    4. puis :");
    console.log("");
    console.log("       OATHRION_GITHUB_TEST_TOKEN=github_pat_… \\");
    console.log("       OATHRION_GITHUB_TEST_REPO=votre-compte/votre-depot-de-test \\");
    console.log("         npm run verify:github");
    console.log("");
    console.log("  Ce passage sort en 2 (« impossible à mettre en place ») et non en 0 :");
    console.log("  « je n'ai pas pu tester » ne doit pas pouvoir se lire « j'ai testé ».");
    return 2;
  }

  section("MISE EN PLACE — le credential traverse le coffre chiffré");
  const { vault, close, env } = throwawayVault();
  const context: ConnectorContext = { organizationId: ORG, vault, env };

  try {
    const probe = await connector.verify(token, {}, env);
    record("GitHub accepte le jeton fourni", probe.ok, probe.ok ? `compte ${probe.account}` : probe.detail);
    if (!probe.ok) {
      console.error("\nLe jeton fourni est refusé par GitHub ; la suite ne peut rien prouver.");
      console.error(`  ${probe.detail}`);
      return 2;
    }
    record("… en nommant un compte réel", probe.account !== "", probe.account);

    await vault.store({
      connectorId: connector.id,
      secret: token,
      account: probe.account,
      scopes: probe.scopes,
      connectedBy: "verify:github",
      verified: true,
    });
    const stored = await vault.describe(connector.id);
    record("le jeton est scellé puis relu", stored?.state === "connected", `empreinte ${stored?.fingerprint}`);
    record(
      "l'empreinte stockée est celle du jeton, et n'en est pas un morceau",
      stored?.fingerprint === fingerprintOf(token) && !token.includes(stored?.fingerprint ?? "x"),
      stored?.fingerprint,
    );

    const retested = await connector.test(context);
    record("un test de connexion depuis le coffre réussit", retested.ok, retested.detail.slice(0, 70));

    section("CAPACITÉS — dérivées de ce que GitHub annonce, jamais supposées");
    const capabilities = await connector.capabilities(context);
    /*
     * La liste EXACTE, écrite ici et non lue dans le connecteur : un verbe ajouté ou retiré
     * doit faire échouer ce banc jusqu'à ce que quelqu'un le décide. Ce contrôle comptait
     * « trois » depuis que le connecteur en déclare cinq (`github.repos.list` et
     * `github.issue.search` ajoutés pour le choix du périmètre) — personne ne l'avait vu,
     * parce que le banc n'avait jamais tourné avec un vrai jeton.
     */
    const expectedVerbs = ["github.issue.comment", "github.issue.create", "github.issue.search", "github.repo.read", "github.repos.list"];
    const describedVerbs = capabilities.map((c) => c.action).sort();
    record(
      "les cinq verbes déclarés sont décrits, et eux seuls",
      JSON.stringify(describedVerbs) === JSON.stringify(expectedVerbs),
      describedVerbs.join(", "),
    );
    const read = capabilities.find((c) => c.action === "github.repo.read");
    record("la lecture est annoncée disponible", read?.available === true);
    const write = capabilities.find((c) => c.action === "github.issue.create");
    /*
     * Un jeton à portée fine ne permet PAS de l'affirmer, et le connecteur le dit au lieu
     * de supposer. Les deux réponses sont donc acceptables ici — ce qui ne l'est pas,
     * c'est `available: true` sans motif pour un jeton dont GitHub n'annonce rien.
     */
    record(
      "l'écriture est annoncée avec un motif quand elle ne peut pas être affirmée",
      write?.available === true || (write?.available === false && (write.reason ?? "") !== ""),
      write?.available === true ? "affirmée (jeton classique avec repo)" : (write?.reason ?? "").slice(0, 80),
    );

    section("EXÉCUTION — lire, écrire, et un dépôt qui n'existe pas");
    const target = `github.com/${repo}`;

    const readResult = await connector.execute(context, {
      action: "github.repo.read",
      target,
      metadata: {},
      executionId: "exe_verify_read",
    });
    record("la lecture du dépôt réussit", readResult.ok, readResult.summary.slice(0, 80));
    record("… et rend des données du dépôt, non une forme vide", typeof readResult.data.repository === "string",
      String(readResult.data.repository));

    const missing = await connector.execute(context, {
      action: "github.repo.read",
      target: `github.com/${repo}-placet-inexistant-${Date.now().toString(36)}`,
      metadata: {},
      executionId: "exe_verify_404",
    });
    record("un dépôt absent donne « not_found », pas une panne", missing.code === "not_found", missing.code);

    const issue = await connector.execute(context, {
      action: "github.issue.create",
      target,
      metadata: {
        title: `Oathrion — vérification du connecteur (${new Date().toISOString()})`,
        body:
          "Issue ouverte par `npm run verify:github` pour prouver que le connecteur GitHub " +
          "atteint réellement l'API. Vous pouvez la fermer.",
      },
      executionId: `exe_verify_${Date.now().toString(36)}`,
    });
    record("l'ouverture d'une issue réussit", issue.ok, issue.summary.slice(0, 90));
    const issueNumber = typeof issue.data.issueNumber === "number" ? issue.data.issueNumber : 0;
    record("… et GitHub rend un numéro d'issue", issueNumber > 0, `#${String(issueNumber)}`);
    record("… et une URL consultable", typeof issue.data.url === "string", String(issue.data.url));

    if (issueNumber > 0) {
      const comment = await connector.execute(context, {
        action: "github.issue.comment",
        target,
        metadata: { issue: issueNumber, body: "Commentaire de vérification du connecteur Oathrion." },
        executionId: `exe_verify_c_${Date.now().toString(36)}`,
      });
      record("le commentaire réussit", comment.ok, comment.summary.slice(0, 90));
    }

    section("REFUS D'EXÉCUTION — ce qui ne part pas, et le dit");
    const noTitle = await connector.execute(context, {
      action: "github.issue.create",
      target,
      metadata: { body: "sans titre" },
      executionId: "exe_verify_notitle",
    });
    record(
      "une issue sans titre n'est pas envoyée",
      !noTitle.ok && noTitle.data.dispatched === false && noTitle.data.reason === "missing_title",
      String(noTitle.data.reason),
    );

    const badTarget = await connector.execute(context, {
      action: "github.issue.create",
      target: repo,
      metadata: { title: "x" },
      executionId: "exe_verify_badtarget",
    });
    record(
      "une cible sans hôte n'est pas envoyée, et l'erreur dit quoi écrire",
      !badTarget.ok && badTarget.data.dispatched === false && badTarget.summary.includes("github.com/"),
      String(badTarget.data.reason),
    );

    const unsupported = await connector.execute(context, {
      action: "github.repo.delete",
      target,
      metadata: {},
      executionId: "exe_verify_unsupported",
    });
    record(
      "un verbe que le connecteur ne sert pas n'est pas envoyé",
      !unsupported.ok && unsupported.data.reason === "unsupported_action",
      String(unsupported.data.reason),
    );

    section("RÉVOCATION — et ce qu'elle ne fait pas");
    const revocation = await connector.revoke(context, "verify:github");
    record("Oathrion oublie le jeton", revocation.ok);
    /*
     * LE CONTRÔLE LE PLUS IMPORTANT DE CETTE SECTION. GitHub n'offre aucune API
     * permettant à un tiers d'invalider un jeton d'accès personnel. Un connecteur qui
     * répondrait `false` ici mentirait, et la console afficherait « déconnecté » pour un
     * jeton toujours actif.
     */
    record("… et déclare que GitHub le considère TOUJOURS valide", revocation.remoteStillValid === true);
    record("… en disant où aller le supprimer", revocation.detail.includes("github.com/settings/tokens"));

    const afterRevoke = await vault.describe(connector.id);
    record("l'état passe à « revoked », distinct de « jamais configuré »", afterRevoke?.state === "revoked",
      String(afterRevoke?.state));

    const afterToken = await vault.open(connector.id);
    record("le coffre ne rend plus rien", afterToken === null);

    const refused = await connector.execute(context, {
      action: "github.repo.read",
      target,
      metadata: {},
      executionId: "exe_verify_after_revoke",
    });
    record(
      "une action après révocation n'est pas envoyée, et le dit",
      !refused.ok && refused.data.reason === "connector_not_connected",
      String(refused.data.reason),
    );

    section("CE QUI RESTE NON PROUVÉ ICI");
    console.log("  Qu'une action BLOQUÉE n'atteint pas GitHub : prouvé hors ligne, contre un");
    console.log("  connecteur espion, par server/test/connector-control-point.test.ts — un zéro");
    console.log("  appel réseau serait ambigu, il pourrait venir d'une panne.");
    console.log("  La révocation côté GitHub : impossible par l'API, voir docs/connectors.md.");

    return 0;
  } finally {
    close();
  }
}

main()
  .then((code) => {
    const failed = checks.filter((c) => !c.ok);
    console.log(`\n${"=".repeat(72)}`);
    console.log(`${checks.length - failed.length}/${checks.length} contrôles passés`);
    console.log("=".repeat(72));
    return code === 2 ? 2 : code === 0 && failed.length === 0 ? 0 : 1;
  })
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
