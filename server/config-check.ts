/**
 * Boot-time validation of the runtime environment.
 *
 * `server/auth.ts` already refuses to start when the *credentials* are not
 * configured. This module extends the same fail-closed posture to the three
 * settings that the fault-injection bench (`script/chaos.ts`, category `config`)
 * showed being coerced or reported unhelpfully:
 *
 *   PORT                  was passed through `parseInt`, which truncates instead of
 *                         rejecting. `PORT="80o0"` became 80, `"5e3"` became 5, and
 *                         `"0x1f44"` became 0 — a random kernel-assigned port. Every
 *                         one of those boots looks healthy while being unreachable
 *                         at the address the operator configured.
 *   OATHRION_TRUST_PROXY   went straight to Express, so a wrong value surfaced as
 *                         `TypeError: invalid IP address: …` from proxy-addr with no
 *                         mention of the variable responsible.
 *   OATHRION_DB            produced `SqliteError: unable to open database file` with
 *                         neither the path nor the variable name.
 *
 * Nothing here changes behaviour for a valid configuration. The only new outcome is
 * a refusal to start, which is the point: a process that comes up on the wrong port
 * is harder to diagnose than one that explains why it did not come up at all.
 *
 * Pure functions, no I/O, so they are cheap to test directly.
 */

import net from "node:net";
import { resolve } from "node:path";
import { parseQuotaOverrides } from "@shared/quotas";
import { resolveUndeclaredActionPosture } from "@shared/policy/posture";
import { agentBindingPosture } from "./identity/agent-binding";
import { resolveQuotaMode } from "./quotas";
import { destinationRegistryProblems } from "./authority/destinations";
import { declaredToolProblems } from "./gateway/tools/declared-tool";
import { interceptRuleProblems } from "./intercept/rules-check";
import { parseInterceptRules } from "./intercept/rules";
import { isLocalMode } from "./local-mode";
import { rateLimitConfigProblems } from "./rate-limit/limits";
import { describeScrapeToken, scrapeTokenProblem } from "./observability/scrape-token";
import { resolveFailMode } from "./rate-limit";
import { oauthConfigProblems } from "./connectors/oauth";
import { slackConfigProblems } from "./notifications/slack-signature";
import { sigv4ConfigProblems } from "./connectors/sigv4";
import { oidcConfigProblems } from "./identity/oidc";

/** The port used when `PORT` is unset, unchanged from the original default. */
export const DEFAULT_PORT = 5000;

/** The highest legal TCP port. 0 is legal too: it asks the kernel for a free one. */
const MAX_PORT = 65_535;

/**
 * Turns `PORT` into a number, or throws an error that names the variable and the
 * value it rejected.
 *
 * Deliberately stricter than `parseInt`: a value that is not exactly a run of digits
 * is a mistake, and guessing what the operator meant is how `"80o0"` became port 80.
 */
export function resolvePort(raw: string | undefined): number {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_PORT;

  if (!/^\d+$/.test(value)) {
    throw new Error(
      `PORT must be a whole number between 0 and ${MAX_PORT}, but it is "${value}". ` +
        `Values such as "80o0", "5e3" or "0x1f44" used to be silently truncated to a ` +
        `different port; they are now refused instead.`,
    );
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > MAX_PORT) {
    throw new Error(`PORT must be between 0 and ${MAX_PORT}, but it is "${value}".`);
  }
  return port;
}

/** Adresse d'écoute par défaut : la boucle locale de la machine. */
export const DEFAULT_HOST = "127.0.0.1";

/**
 * L'adresse sur laquelle le serveur écoute, lue dans `OATHRION_HOST`.
 *
 * Le serveur écoutait toujours sur `0.0.0.0`, en dur : une instance lancée sur un poste
 * de développement ou de démonstration était joignable depuis tout le réseau local. Le
 * défaut est désormais la boucle locale ; écouter ailleurs est une décision écrite dans la
 * configuration — l'image Docker la prend (`0.0.0.0` DANS le conteneur, condition pour
 * que le proxy ou la publication de port l'atteigne), un lancement direct sur l'hôte non.
 *
 * Seuls une adresse IP littérale ou `localhost` sont acceptés : un nom résolu au
 * démarrage pourrait désigner une autre interface que celle que l'exploitant croit.
 */
export function resolveHost(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  if (value === "") return DEFAULT_HOST;
  /*
   * Le mode local (`oathrion wrap`) n'écoute QUE sur la boucle locale : c'est la condition
   * qui le rend acceptable sur SQLite (`server/local-mode.ts`). Une autre adresse est un
   * refus de démarrer, pas un réglage ignoré.
   */
  if (isLocalMode() && !isLoopbackHost(value)) {
    throw new Error(`Oathrion's local mode only listens on loopback; OATHRION_HOST="${value}" is refused.`);
  }
  if (value === "localhost" || net.isIP(value) !== 0) return value;
  throw new Error(
    `OATHRION_HOST must be an IP address (127.0.0.1, 0.0.0.0, ::1, ::, or an interface ` +
      `address) or "localhost", but it is "${value}". A host name is refused: it could ` +
      `resolve to a different interface than the one intended.`,
  );
}

/** Vrai pour une adresse qui n'accepte que des connexions de la machine elle-même. */
export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || /^127\./.test(host);
}

/** Express keywords that `trust proxy` accepts as-is. */
const TRUST_PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal", "true", "false"]);

/**
 * Validates `OATHRION_TRUST_PROXY`, returning a human-readable problem or `null`.
 *
 * Accepts an empty value or "false"/"0" (disabled), a hop count such as "1", an
 * Express keyword, or a comma-separated list of addresses and subnets.
 */
export function trustProxyProblem(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (value === "") return null;

  for (const part of value.split(",")) {
    const item = part.trim();
    if (item === "") {
      return `OATHRION_TRUST_PROXY contains an empty entry: "${value}".`;
    }
    if (/^\d+$/.test(item) || TRUST_PROXY_KEYWORDS.has(item.toLowerCase())) continue;

    // An address, optionally with a CIDR prefix.
    const [address, prefix, ...rest] = item.split("/");
    if (rest.length > 0 || net.isIP(address ?? "") === 0) {
      return (
        `OATHRION_TRUST_PROXY is "${value}", which Express cannot interpret. ` +
        `Use "false" to disable it, a number of proxy hops such as "1", ` +
        `a subnet such as "10.0.0.0/8", or a keyword such as "loopback".`
      );
    }
    if (prefix !== undefined && !/^\d+$/.test(prefix)) {
      return `OATHRION_TRUST_PROXY has a non-numeric subnet prefix in "${item}".`;
    }
  }
  return null;
}

/**
 * Builds the message shown when the SQLite file cannot be opened.
 *
 * better-sqlite3 reports "unable to open database file" for a missing directory, a
 * directory without write permission, and a path that is itself a directory — three
 * different mistakes with one message, and it never mentions the path or the variable
 * that supplied it.
 */
export function describeDatabaseOpenFailure(path: string, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const absolute = resolve(path);
  const lines = [
    `Oathrion cannot open its database.`,
    ``,
    `  OATHRION_DB   ${path}`,
    `  resolved to  ${absolute}`,
    `  SQLite says  ${reason}`,
  ];

  // Only add a hint when the underlying message is one we actually recognise;
  // guessing at an unfamiliar error would be worse than staying quiet.
  if (/unable to open database file/i.test(reason)) {
    lines.push(
      ``,
      `That message covers several causes. Check, in order:`,
      `  - the parent directory exists`,
      `  - the process can write to it (a read-only volume fails here)`,
      `  - the path is a file, not a directory`,
    );
  } else if (/not a database/i.test(reason)) {
    lines.push(``, `The file exists but is not a SQLite database. Point OATHRION_DB elsewhere,`, `or move the existing file aside.`);
  }
  return lines.join("\n");
}

/**
 * Every runtime configuration problem, collected so one restart fixes all of them
 * instead of the operator discovering them one boot at a time.
 *
 * `OATHRION_DB` is absent from this list on purpose: the database is opened while
 * `server/db.ts` is imported, which happens before any code in `server/index.ts`
 * runs, so it reports itself from there.
 */
export function runtimeConfigProblems(env: NodeJS.ProcessEnv = process.env): string[] {
  const problems: string[] = [];

  try {
    resolvePort(env.PORT);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  try {
    resolveHost(env.OATHRION_HOST);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const trustProxy = trustProxyProblem(env.OATHRION_TRUST_PROXY);
  if (trustProxy) problems.push(trustProxy);

  /*
   * P3 — quota configuration, validated HERE so a bad value stops the deploy instead
   * of the first request.
   *
   * Both `parseQuotaOverrides` and `resolveQuotaMode` refuse rather than fall back, and
   * without this they would refuse lazily, on whichever customer request happened to
   * reach a quota check first: that customer gets a 500, and the operator learns about
   * a typo from an incident rather than from a failed deploy. Checked in the same list
   * as PORT and OATHRION_TRUST_PROXY, which is exactly the same class of problem.
   *
   * Note the deliberate difference from `OATHRION_MAX_TOOL_ATTEMPTS` in server/limits.ts,
   * which warns and falls back. There, a fallback keeps a safety ceiling in place, so
   * the safe answer is obvious. Here there is no safe guess: defaulting an unreadable
   * OATHRION_QUOTA_MODE to `enforce` could start refusing a live customer's traffic in a
   * deployment whose operator wrote `observe`, and defaulting it to `observe` would
   * silently remove every ceiling. Refusing to boot is the only answer that cannot
   * quietly do the wrong thing.
   */
  try {
    parseQuotaOverrides(env.OATHRION_QUOTAS);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  try {
    resolveQuotaMode(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  /*
   * Phase 8 — OATHRION_UNDECLARED_ACTION, validated at boot for the same reason as
   * the quota settings, only more sharply: this variable decides what happens to
   * an action Oathrion has never heard of. Validating it lazily would mean a typo is
   * discovered by whichever request first names an unknown verb — in other
   * words, by the exact request the setting exists to govern.
   */
  try {
    resolveUndeclaredActionPosture(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  /*
   * Multi-tenant production — the action destination registry. Validated at boot
   * so a malformed OATHRION_DESTINATIONS, or a production entry that does not declare
   * which organizations may use it, stops the deploy instead of silently blocking
   * (or, worse, sharing) every destination.
   */
  problems.push(...destinationRegistryProblems(env));
  /*
   * Le registre d'outils DÉCLARÉ (`OATHRION_TOOLS`). Validé juste après les destinations,
   * et dans cet ordre : un outil déclaré nomme une destination, donc le registre doit
   * avoir été jugé lisible avant qu'on reproche à l'outil de viser un identifiant absent.
   */
  problems.push(...declaredToolProblems(env));
  /*
   * Les règles d'interception. Validées ici, au démarrage : une règle qui nomme un verbe
   * hors catalogue, une destination absente ou une source illisible doit arrêter le
   * déploiement — pas laisser passer une requête qu'aucune règle ne reconnaîtra, ce qui
   * se traduirait par un refus que l'exploitant lirait comme une panne.
   */
  problems.push(...interceptRuleProblems(env));
  /*
   * Les configurations OAuth des destinations. Refusées au DÉMARRAGE, parce qu'une
   * configuration présente et fausse ne se verrait autrement qu'au premier appel d'un
   * agent — et sous la forme d'un 401 du fournisseur, qui fait chercher l'erreur du
   * mauvais côté.
   */
  problems.push(...oauthConfigProblems(env));
  /*
   * La configuration Slack. Le refus qui compte : un webhook Slack SANS secret de
   * signature ferait poster des boutons d'approbation sans pouvoir vérifier qui clique,
   * c'est-à-dire une route publique qui relâche des actions d'agents.
   */
  problems.push(...slackConfigProblems(env));
  /*
   * Les configurations de signature AWS. Une région mal écrite produit une signature
   * qu'AWS refuse avec « signature mismatch », sans dire que la cause est la région :
   * c'est exactement le genre de faute qui doit refuser au démarrage.
   */
  problems.push(...sigv4ConfigProblems(env));
  /*
   * La configuration SSO. Un SSO à moitié configuré qui démarre est un bouton « se
   * connecter » qui échoue chez le client, au pire moment — et son message viendra du
   * fournisseur, donc il ne nommera pas la cause.
   */
  problems.push(...oidcConfigProblems(env));
  /*
   * Les plafonds du limiteur. Validés ICI, au démarrage, et non à la première requête :
   * c'est le défaut D3 de la Phase 13 — `RATE_LIMIT_FAIL_MODE=opn` démarrait et
   * n'échouait qu'au premier client, avec un 500 sans rapport apparent avec la
   * configuration.
   */
  problems.push(...rateLimitConfigProblems(env));

  /*
   * RATE_LIMIT_FAIL_MODE. `resolveFailMode` refuses an unknown value, but it used to
   * be called lazily — on the first rate-limited request — so `RATE_LIMIT_FAIL_MODE=opn`
   * BOOTED, answered /api/ready with 200, and surfaced as a 500 on a customer request.
   * Found by `npm run verify:prod-config`. Validated here so the typo stops the deploy.
   */
  try {
    resolveFailMode(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  /*
   * OATHRION_METRICS_TOKEN. Validé ici, et seulement s'il est POSÉ : ne pas superviser est
   * une décision d'exploitant, pas une erreur. Un jeton trop court, en revanche, fait
   * croire la page fermée alors qu'elle est devinable — voir
   * `server/observability/scrape-token.ts` pour le raisonnement complet.
   */
  const scrape = scrapeTokenProblem(env);
  if (scrape) problems.push(scrape);

  return problems;
}

/**
 * Security postures that are worth stating out loud at boot, not just enforcing.
 *
 * Phase 9. These are not problems and they never stop the process — every one of
 * them is a legal, supported configuration. They are printed because they are
 * the settings whose *silent* value determines whether a deployment is closed or
 * open, and an operator should be able to answer "is agent binding on here?" by
 * reading the first ten lines of the log rather than by re-deriving the defaults
 * from documentation.
 *
 * The rule for what belongs here: a setting qualifies if a reasonable operator
 * could believe it has one value while it has the other, AND the difference is a
 * security one. That is why `OATHRION_REQUIRE_AGENT_BINDING` is the first entry — its
 * default changed in Phase 9 and now depends on `NODE_ENV`, so it is precisely a
 * setting nobody can be sure about without being told.
 *
 * Pure: returns the lines, prints nothing, so it is testable without capturing
 * stdout.
 */
/**
 * Le plafond du corps d'une requête entrante, en octets.
 *
 * Oathrion BUFFÉRISE le corps en entier : il lui faut la requête complète pour en extraire
 * la cible, la hacher quand une signature AWS la couvre, et la garer si un humain doit
 * approuver. Ce n'est donc pas un réglage de confort — c'est la borne de ce qu'un appelant
 * authentifié peut faire allouer au processus.
 *
 * 10 Mio par défaut : largement au-dessus d'un corps JSON ou form-encoded, assez pour un
 * téléversement courant, et assez bas pour qu'un plan de contrôle ne tombe pas sur une
 * poignée de requêtes. Un exploitant qui a besoin de plus le règle en connaissance de
 * cause.
 */
export function maxBodyBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.OATHRION_MAX_BODY_BYTES ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return 10 * 1024 * 1024;
  /*
   * Un plancher ET un plafond. Le plancher évite qu'une valeur absurde (« 10 ») refuse
   * toute requête de la console ; le plafond évite qu'un zéro de trop transforme la borne
   * en absence de borne.
   */
  return Math.min(Math.max(raw, 4096), 256 * 1024 * 1024);
}

export function securityPostureNotices(
  env: NodeJS.ProcessEnv = process.env,
  posture: () => { required: boolean; reason: string } = agentBindingPosture,
): string[] {
  const notices: string[] = [];
  const production = env.NODE_ENV?.trim() === "production";
  const binding = env.OATHRION_REQUIRE_AGENT_BINDING;

  /*
   * LE PLAFOND FAUX DE CENT FOIS, DANS LE SENS PERMISSIF.
   *
   * Une règle d'interception qui lit un montant SANS `amountScale` est peut-être
   * correcte : certaines API comptent en unités. Mais les API financières comptent en
   * centimes — Stripe envoie 7500 pour 75 — et un exploitant qui écrit un plafond de 500
   * veut dire 500 dollars. Sans diviseur déclaré, ce plafond laisse passer 500 000.
   *
   * C'est le pire type de défaut : silencieux, permissif, et invisible dans l'audit, qui
   * affichera fièrement « 500 — autorisé ». Oathrion ne peut pas le DÉTECTER — il ne sait
   * pas en quoi compte l'API d'en face — donc ce n'est pas un refus de démarrage, qui
   * bloquerait les intégrations légitimes. C'est un avis, affiché au démarrage, à côté
   * des autres postures de sécurité.
   */
  try {
    for (const rule of parseInterceptRules(env)) {
      if (rule.amount !== undefined && rule.amountScale === undefined) {
        notices.push(
          `OATHRION_INTERCEPTS: rule "${rule.id}" reads an amount from "${rule.amount}" without ` +
            `"amountScale". If this API counts in CENTS — as Stripe and most ` +
            `payment APIs do — your caps are off by a factor of 100 in the ` +
            `PERMISSIVE direction: a cap of 500 would let 500,000 through. Add "amountScale": 100, ` +
            `or confirm that this API counts in units.`,
        );
      }
    }
  } catch {
    /* Une déclaration illisible est déjà un refus de démarrage : `interceptRuleProblems`. */
  }

  /*
   * ASKS the enforcer rather than mirroring it.
   *
   * This used to re-derive the posture from `env` and describe that. Under `tsx` the two
   * agreed and every test passed; in the shipped bundle they did not. `script/build.ts`
   * compiles with `define: { "process.env.NODE_ENV": '"production"' }`, so the enforcer's
   * read of NODE_ENV becomes the literal `"production"` and the requirement is
   * permanently ON in `dist/index.cjs` — while this banner, reading a real environment
   * object, announced "not required". An operator running the bundle outside production
   * was told the opposite of what `/api/evaluate` would do to their credentials.
   *
   * A mirrored security posture is only as good as the thing it mirrors, and nothing
   * could have caught the drift: `agent-binding-production-default.test.ts` pinned that
   * the two agree, but it tests the SOURCE, where they always did.
   *
   * `posture` is injectable so a test can still describe a hypothetical deployment, which
   * is what the duplication used to buy. The default is the real enforcer.
   */
  const { required, reason } = posture();
  if (required) {
    notices.push(
      `agent binding: REQUIRED (${reason}). Unbound machine credentials cannot act as any agent.` +
        (reason === "production default"
          ? " Set OATHRION_REQUIRE_AGENT_BINDING=false to relax this during a migration."
          : ""),
    );
  } else if (binding === "false" && production) {
    notices.push(
      "agent binding: NOT REQUIRED — the production default has been explicitly " +
        "relaxed with OATHRION_REQUIRE_AGENT_BINDING=false. An unbound machine credential " +
        "can name any agent in its own organisation. This is intended only as a " +
        "migration step; remove the variable once every key is bound.",
    );
  } else {
    notices.push(
      `agent binding: NOT REQUIRED (${reason}). ` +
        "An unbound machine credential can name any agent in its own organisation. " +
        "In production this is required by default.",
    );
  }

  /*
   * The two other settings with the same property: legal either way, security
   * relevant, and easy to be wrong about because the safe value is the default.
   */
  const undeclared = env.OATHRION_UNDECLARED_ACTION?.trim().toLowerCase();
  if (undeclared !== undefined && undeclared !== "" && undeclared !== "block") {
    notices.push(
      `undeclared actions: ${undeclared.toUpperCase()} (OATHRION_UNDECLARED_ACTION). ` +
        "An action no policy declares is not blocked. The default is block.",
    );
  }

  /*
   * La page de métriques. Annoncée au démarrage parce que son absence est SILENCIEUSE :
   * un exploitant qui a oublié la variable obtient un 404 depuis son collecteur et
   * cherchera un problème de réseau ou de proxy avant de soupçonner une variable
   * d'environnement. La ligne de démarrage répond à la question.
   */
  notices.push(describeScrapeToken(env));

  /*
   * LE LIMITEUR EST-IL PARTAGÉ ?
   *
   * `RATE_LIMIT_STORE` vide vaut « memory », donc un compteur LOCAL AU PROCESSUS :
   * derrière N instances, chacune accorde le plafond entier et le plafond effectif est
   * multiplié par N.
   *
   * CE N'EST PAS UN TROU EN PRODUCTION, et il faut le dire ici pour que personne ne
   * l'ajoute à une liste de risques : `database-config.ts` REFUSE de démarrer si
   * `NODE_ENV=production` sans `RATE_LIMIT_STORE=postgres`. Le compteur local est donc
   * inatteignable là où il ferait des dégâts.
   *
   * Cet avis vise ce qui reste : une installation hors production montée à plusieurs
   * instances — une préproduction, une démonstration derrière un répartiteur. Là, le
   * plafond double sans que rien ne le dise, et seul l'exploitant sait combien
   * d'instances il fait tourner.
   *
   * Le store n'est pas déduit de `DATABASE_URL` : voir `resolveStore`, où ce choix est
   * argumenté.
   */
  const store = env.RATE_LIMIT_STORE?.trim().toLowerCase();
  if ((store === undefined || store === "" || store === "memory") && isLocalMode()) {
    /*
     * En mode local (`oathrion wrap`), la phrase ci-dessous serait fausse : ce mode EST la
     * production compilée, et il tourne sur un compteur en mémoire — un seul processus, sur
     * la boucle locale, c'est le bon réglage. Le dire tel quel plutôt que de laisser croire
     * que la production ne peut pas l'atteindre.
     */
    notices.push("rate limit sharing: PROCESS-LOCAL counter — Oathrion local mode, a single process: this is the right setting.");
  } else if (store === undefined || store === "" || store === "memory") {
    notices.push(
      /*
       * Le préfixe est « rate limit sharing: » et non « rate limiting: », qui est celui
       * de l'avertissement FAIL OPEN juste en dessous. Deux avis sur le limiteur qui
       * commencent pareil, c'est un test qui en trouve un en croyant lire l'autre — et
       * c'est exactement ce qui vient d'arriver : `agent-binding-production-default`
       * sélectionne la ligne du mode de panne par son préfixe.
       */
      "rate limit sharing: PROCESS-LOCAL counter (RATE_LIMIT_STORE is unset or \"memory\"). " +
        "Behind N instances the effective limit is N times what you configured, because " +
        "each process grants the whole quota. Correct for a single instance. Production " +
        "cannot reach this mode — NODE_ENV=production refuses to start without " +
        "RATE_LIMIT_STORE=postgres — so this line is about a multi-instance setup " +
        "outside production.",
    );
  }

  const failMode = env.RATE_LIMIT_FAIL_MODE?.trim().toLowerCase();
  if (failMode === "open") {
    notices.push(
      "rate limiting: FAIL OPEN (RATE_LIMIT_FAIL_MODE=open). " +
        "If the quota store is unreachable, requests are allowed — including sign-in " +
        "attempts. The default is closed.",
    );
  }

  /*
   * LE SSO EXIGE UNE SEULE INSTANCE, ET IL FAUT LE DIRE AU DÉMARRAGE.
   *
   * Les tentatives de connexion en cours (`state` et `nonce`) vivent dans une `Map` du
   * PROCESSUS. Derrière plusieurs instances, une connexion ouverte sur l'instance A dont
   * le rappel atterrit sur l'instance B ne trouve pas son `state`.
   *
   * CE N'EST PAS UN CONTOURNEMENT, et la distinction importe pour qui lit une liste de
   * risques : l'instance qui reçoit REFUSE. Le mode de panne est fermé — c'est une panne
   * de DISPONIBILITÉ, pas une faille. Avec deux instances et un répartiteur sans
   * affinité, une connexion sur deux échoue, et le symptôme est le pire des symptômes :
   * intermittent, et il désigne le fournisseur d'identité plutôt qu'Oathrion.
   *
   * Pourquoi un avis et pas un refus : Oathrion ne peut pas savoir combien d'instances
   * tournent devant lui — seul l'exploitant le sait. Le `docker-compose.yml` livré lance
   * une seule instance `placet`, donc la configuration livrée est correcte ; cet avis
   * vise celui qui la fera grossir.
   */
  if (env.OATHRION_OIDC !== undefined && env.OATHRION_OIDC.trim() !== "") {
    notices.push(
      "sso instance affinity: in-progress SSO sign-in attempts are kept IN " +
        "PROCESS MEMORY. Behind several instances, a callback that lands on " +
        "an instance other than the one that opened the attempt is REFUSED — fail-closed, " +
        "so a failed sign-in and not a hijacked session. Correct " +
        "for a single instance, which is what the shipped docker-compose runs. Beyond that, require " +
        "session affinity on /api/auth/sso from the load balancer.",
    );
  }

  return notices;
}
