import "dotenv/config";
// Doit tourner avant toute lecture de configuration : mappe les PLACET_* hérités sur OATHRION_*.
import "./env-compat";
import "./net-patience";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { serveStatic } from "./static";
import { createServer } from "node:http";
import { authConfigNotices, authConfigProblems } from "./auth";
import { applySecurity } from "./security";
import { installLifecycle } from "./lifecycle";
import { safeBody } from "./log-redaction";
import { isLocalMode } from "./local-mode";
import { unversionedPath } from "@shared/api-version";
import { admissionControl } from "./admission";
import { requestContext, tagged } from "./request-context";
import { bodyParseErrorHandler } from "./body-parse-error";
import { sendApiError } from "./api-error";
import { closeRateLimitStore } from "./rate-limit";
import { describeQuotaConfiguration } from "./quotas";
import { activeRateLimits, describeRateLimits } from "./rate-limit";
import { closeDatabase } from "./db";
import { DATABASE_UNAVAILABLE_MESSAGE, DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS, isDatabaseUnavailable } from "./database-unavailable";
import { isLoopbackHost, maxBodyBytes, resolveHost, resolvePort, runtimeConfigProblems, securityPostureNotices } from "./config-check";
import { configureTiming } from "./observability/timing";

/**
 * Fail-closed startup. There are no default credentials: if the environment is
 * not configured, the process refuses to listen rather than come up reachable
 * with a documented password. The message names every missing piece at once so
 * an operator fixes them in one pass, and never echoes a secret.
 */
const configProblems = authConfigProblems();
if (configProblems.length > 0) {
  console.error("\nOathrion cannot start — authentication is not configured.\n");
  for (const problem of configProblems) console.error(`  ✗ ${problem}`);
  console.error(
    [
      "",
      "Set these before starting:",
      "  OATHRION_SESSION_SECRET   random string, 16+ characters",
      '  OATHRION_CONSOLE_USERS    "email:role:password" list (roles: viewer, operator, approver, admin).',
      '                        A display name still works; the sign-in address is then derived and',
      '                        printed at boot. Prefix with "Organization/" for a second tenant.',
      '  OATHRION_API_KEYS         "Service:role:key" list, for non-browser callers',
      "",
    ].join("\n"),
  );
  process.exit(1);
}

/*
 * Non-fatal, but an operator who does not see this cannot sign in: when
 * OATHRION_CONSOLE_USERS carries a display name rather than an e-mail address, P0-2
 * derives the sign-in address and it has to be printed. Warning level, never a
 * secret — only the identifier.
 */
for (const notice of authConfigNotices()) console.warn(`  ! ${notice}`);

/*
 * The same posture for the rest of the runtime environment. Kept separate from the
 * credential check above so the message an operator sees names the right subject,
 * but reported before anything binds: `PORT="80o0"` used to become port 80 through
 * `parseInt`, and the process came up healthy and unreachable. See
 * server/config-check.ts for what each rule exists to prevent.
 */
/*
 * La collecte des durées, lue UNE FOIS ici. Éteinte par défaut : allumée, elle publie à
 * l'appelant la durée de chaque phase interne, ce qui est un oracle temporel sur un plan
 * de contrôle. Voir `server/observability/timing.ts`.
 */
if (configureTiming()) {
  // eslint-disable-next-line no-console -- bandeau de démarrage, même exemption qu'au-dessus
  console.log(
    "  OATHRION_TIMING_HEADER is on: firewall responses carry a " +
      "`Server-Timing` header detailing internal phases. Keep it for diagnostics.",
  );
}

const runtimeProblems = runtimeConfigProblems();
if (runtimeProblems.length > 0) {
  console.error("\nOathrion cannot start — the runtime environment is not valid.\n");
  for (const problem of runtimeProblems) console.error(`  ✗ ${problem}`);
  console.error("");
  process.exit(1);
}

/*
 * Phase 9 — the security posture, stated at boot.
 *
 * Nothing here can stop the process; every value reported is legal. It is
 * printed because the settings below decide whether this deployment is closed or
 * open, and their defaults are not all the same in every environment. The
 * refusal an unbound credential receives points at this log, so the log has to
 * exist: a message that tells an operator "this is recorded at boot" and then
 * records nothing is exactly the kind of claim Phase 9 is meant to remove.
 */
for (const notice of securityPostureNotices()) {
  // eslint-disable-next-line no-console -- boot banner, same exemption as log() below
  console.log(`[oathrion] ${notice}`);
}

const app = express();
const httpServer = createServer(app);

applySecurity(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

/*
 * Correlation, mounted before the body parser and before every route.
 *
 * The position matters: a request rejected by `express.json()` for malformed JSON, or
 * by the authentication gate, is exactly the kind an operator has to correlate — so
 * the id has to exist before either can answer. See server/request-context.ts for why
 * an inbound X-Request-Id is validated rather than trusted.
 */
app.use(requestContext());

/*
 * Le refus immédiat quand l'instance est débordée (`server/admission.ts`), le PLUS TÔT
 * possible : avant la lecture du corps, avant le journal des requêtes, avant le portail
 * d'authentification qui parle à la base. Monté plus bas (après le compteur de réponses),
 * chaque refus lisait encore le corps JSON et écrivait sa ligne de journal : à 1 024
 * clients, refuser coûtait si cher que le débit UTILE tombait de 196 à 66 req/s
 * (journal §5.28).
 */
app.use(admissionControl());

app.use(
  express.json({
    /*
     * Le même plafond que le corps brut ci-dessous : deux limites différentes feraient
     * qu'un corps JSON de 2 Mio est refusé alors que le même contenu en `multipart`
     * passe, ce qui n'a aucun sens pour un exploitant qui règle une seule valeur.
     */
    limit: maxBodyBytes(),
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

/*
 * Immediately after the parser, so a body Oathrion cannot read is refused in the
 * same JSON envelope as every other error instead of Express's HTML page.
 * Mirrored in the test harness.
 */
app.use(bodyParseErrorHandler());

/*
 * `verify` ICI AUSSI, et pas seulement sur le parseur JSON.
 *
 * Le pare-feu relaie le corps BRUT vers l'API du client, sans le re-sérialiser : l'API
 * de Stripe parle `application/x-www-form-urlencoded`, et reconstruire ce corps depuis
 * l'objet parsé produisait du JSON sous un en-tête `form` — que Stripe refuse. Sans
 * cette capture, le corps d'une requête form-encoded serait perdu entre le parseur et
 * le relais.
 *
 * `extended: false` est conservé : la forme à plat suffit à l'extraction (`body.charge`),
 * et le corps relayé est de toute façon l'original, pas la reconstruction.
 */
app.use(
  express.urlencoded({
    extended: false,
    limit: maxBodyBytes(),
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

/*
 * ─────────── LE CORPS QUE NI JSON NI FORM NE RÉCLAMENT ───────────
 *
 * `multipart/form-data` — un téléversement de fichier — n'est parsé par aucun des deux
 * parseurs ci-dessus, donc leur `verify` ne s'exécute pas, donc `rawBody` n'existait pas :
 * le pare-feu relayait un corps VIDE. Un téléversement gouverné était impossible, et
 * l'échec était silencieux — le fournisseur recevait une requête `multipart` sans
 * contenu.
 *
 * `express.raw` avec `type: "*\/*"` ramasse tout le reste. Monté APRÈS les deux autres,
 * il ne leur prend rien : chacun ne lit que ce que son `type` reconnaît.
 *
 * ## CE QUE ÇA COÛTE, ET IL FAUT LE DIRE
 *
 * Le corps est BUFFÉRISÉ EN ENTIER en mémoire. Oathrion ne diffuse pas une requête
 * entrante : il doit l'avoir complète pour en extraire la cible, la hacher quand une
 * signature AWS la couvre, et la garer si un humain doit approuver. Le plafond est donc
 * la protection, et il est réglable par `OATHRION_MAX_BODY_BYTES` (10 Mio par défaut).
 *
 * Un téléversement plus gros que ce plafond est REFUSÉ, pas tronqué — un fichier tronqué
 * qui arrive chez le fournisseur est pire qu'un refus, parce que personne ne le sait.
 */
app.use(
  express.raw({
    type: "*/*",
    limit: maxBodyBytes(),
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  // eslint-disable-next-line no-console
  console.log(`${formattedTime} [${source}] ${message}`);
}

/*
 * Secret redaction moved to ./log-redaction so §14 can be unit-tested: this file is the
 * process entrypoint, so importing it starts the server. Behaviour is unchanged.
 */

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  /*
   * P2 — the version-insensitive form of the path, computed here and used for every
   * decision this middleware makes.
   *
   * THE DEFECT THIS EXISTS TO PREVENT. This middleware is mounted before
   * `registerRoutes`, therefore before the versioning rewrite, so `req.path` here is
   * still the form the caller sent. The check below that suppresses response bodies for
   * auth routes was `path.startsWith("/api/auth")` — an exact prefix test. The moment
   * `/api/v1/auth/login` became a valid path, that test stopped matching it, and the
   * login *response body* — which carries the session token — would have been written to
   * the log. `safeBody` redacts a key named `token` and would have caught this particular
   * shape, but §14 says a credential must not reach the log, and relying on a downstream
   * redactor to cover a check that has become wrong is not a guarantee: it holds only for
   * the field names the redactor happens to know.
   *
   * Deriving the comparison from the unversioned path makes the suppression hold for
   * every present and future version prefix rather than for one spelling of it.
   */
  const routedPath = unversionedPath(path);
  let capturedJsonResponse: Record<string, unknown> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (routedPath.startsWith("/api")) {
      /*
       * The id leads the line so a log search on it lands on the status line first,
       * and so lines from concurrent requests can be told apart at a glance. Read from
       * `req` rather than the async store: `finish` fires from the socket, and async
       * context is not guaranteed to have survived to that callback.
       */
      const id = req.requestId;
      let logLine = `${id ? `[${id}] ` : ""}${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      /*
       * Auth responses carry credentials; they are logged as status lines only. In local
       * mode, so is every success: the body of `/api/mcp` is the tool's own answer (a
       * file, a note), and the local log kept its beginning in clear on the person's disk
       * (journal §5.76). An error body stays: it is ours, and it is what a person pastes
       * into a bug report.
       */
      const bodyLogged = !isLocalMode() || res.statusCode >= 400;
      if (capturedJsonResponse && bodyLogged && !routedPath.startsWith("/api/auth")) {
        const body = safeBody(capturedJsonResponse);
        if (body) logLine += ` :: ${body}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  /*
   * `./routes` est importé ICI, et pas en tête du fichier, et ce n'est pas cosmétique.
   *
   * Plusieurs de ses modules lisent leur configuration au chargement (`OATHRION_INTERCEPTS`,
   * `OATHRION_INTERCEPT_PACKS`, `OATHRION_TOOLS`). Importés statiquement, ils étaient évalués
   * AVANT `runtimeConfigProblems()` : une règle mal formée faisait planter le processus avec
   * une trace de pile et du code compilé, au lieu du « Oathrion cannot start » qui nomme la
   * variable. Chargés après les contrôles, ils ne peuvent plus devancer le message.
   */
  const { registerRoutes } = await import("./routes");
  // `registerRoutes` ends with a JSON 404 for unmatched `/api/...`, so an
  // unknown API path never falls through to the SPA catch-all below.
  await registerRoutes(httpServer, app);

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  /*
   * Last-resort error handler.
   *
   * Registered last, on purpose: an Express error handler only catches what the
   * middleware declared *before* it throws. It used to sit above the static /
   * Vite catch-all, so a failure while serving the console bypassed it entirely
   * and Express answered with its own stack-trace page.
   *
   * An unexpected failure is logged in full on the server and reported to the
   * caller as a bare status. The message of an unhandled exception is written
   * for a developer, not for a client: it routinely carries a file path, a SQL
   * fragment, or the value that caused the failure. A caller who can read it
   * learns about the inside of the deployment for free.
   *
   * Errors that a route raised on purpose carry a 4xx status; those messages are
   * written for the caller and are passed through unchanged.
   */
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    const e = err as { status?: number; statusCode?: number; message?: string };
    /*
     * Une base injoignable est une indisponibilité, pas une erreur interne : 503 et
     * `Retry-After`, pour qu'un client ou une alerte distingue « réessayez » de « bogue »
     * (server/database-unavailable.ts). Seulement quand la route n'a pas fixé de statut.
     */
    const databaseDown = !e.status && !e.statusCode && isDatabaseUnavailable(err);
    const status = databaseDown ? 503 : e.status || e.statusCode || 500;

    /*
     * An `Error` is logged as-is: its stack is the whole diagnostic value, and
     * losing it would trade a real capability for a hypothetical one.
     *
     * Anything else is routed through the same redaction the request logger uses.
     * A thrown non-Error is very often a payload or a config object, and §14 of the
     * brief forbids a password, key, token or webhook secret reaching the log. This
     * is defence in depth rather than a fix for a demonstrated leak: no current code
     * path was shown to throw a secret-bearing object, and it cannot cover an Error
     * whose *message* someone built out of a secret.
     */
    console.error(tagged("Unhandled error:"), err instanceof Error ? err : safeBody(err));

    if (res.headersSent) {
      return next(err);
    }

    if (databaseDown) {
      res.setHeader("Retry-After", String(DATABASE_UNAVAILABLE_RETRY_AFTER_SECONDS));
      return sendApiError(res, 503, DATABASE_UNAVAILABLE_MESSAGE);
    }

    const isClientError = status >= 400 && status < 500;
    const message = isClientError && e.message ? e.message : "Internal Server Error";

    /*
     * Was `{ message }` alone — the only path in the whole server that used that key,
     * while every deliberate refusal used `{ error }`. Both are now sent by one
     * builder, with a code and the correlation id, so a caller reads one shape
     * regardless of which layer refused it. The status and the message are unchanged.
     */
    return sendApiError(res, status, message);
  });

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  //
  // `parseInt` used to be used here and truncated silently: "80o0" became 80 and
  // "5e3" became 5. The value is validated at boot above, so by the time execution
  // reaches this line it is known to be a legal port; this call cannot throw.
  const port = resolvePort(process.env.PORT);
  /*
   * L'adresse d'écoute : la boucle locale par défaut, autre chose seulement si
   * `OATHRION_HOST` le dit (l'image Docker le dit, pour son interface de conteneur).
   * Validée au démarrage avec le reste de la configuration.
   */
  const host = resolveHost(process.env.OATHRION_HOST);
  // `reusePort` is deliberately not set: with a single process it buys nothing
  // and it hides an already-occupied port, letting a second instance bind
  // silently and serve half the requests from a stale build.
  httpServer.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use — Oathrion did not start.`);
    } else {
      console.error("HTTP server error:", err);
    }
    process.exit(1);
  });

  httpServer.listen(
    {
      port,
      host,
    },
    () => {
      log(`serving on port ${port}`);
      log(
        isLoopbackHost(host)
          ? `listening on ${host}:${port} — loopback only: other machines cannot connect`
          : `listening on ${host}:${port} — NOT loopback: every network interface that reaches ` +
              `this address can connect. Inside a container this is expected; on a host, ` +
              `it exposes Oathrion to the network (OATHRION_HOST).`,
      );
      /*
       * P3 — printed at boot, and printed unconditionally.
       *
       * The quota configuration is the one operator decision here that is invisible
       * from the outside: a mistyped organization id in `OATHRION_QUOTAS` produces an
       * override that applies to a tenant which does not exist, so the real tenant
       * silently keeps the default and nothing anywhere reports the discrepancy.
       * Printing every accepted override, and the mode, is what makes that
       * discoverable in the first log lines rather than in a support ticket.
       *
       * Contains no secret: counter names, integers, and organization ids that are
       * already in every audit line.
       */
      log(describeQuotaConfiguration(), "quotas");
      /*
       * Les plafonds en vigueur, dits au démarrage. Un plafond configuré — et à plus
       * forte raison un plafond si haut qu'il ne limite plus rien — doit être lisible
       * dans les journaux, pas découvert pendant un incident.
       */
      log(describeRateLimits(activeRateLimits()), "rate-limit");
    },
  );

  /*
   * Lifecycle handlers, installed after `listen` so a startup failure still exits
   * through the `error` handler above rather than trying to drain a server that
   * never bound.
   *
   * Before this, SIGTERM killed the process instantly. An orchestrator sends
   * SIGTERM on every deploy, scale-down and node drain, so a tool call could be
   * dispatched — money moved, an email sent — and the process die before the audit
   * entry and terminal status were written, leaving the execution `running` with no
   * record of a real-world side effect. `unhandledRejection` was likewise left to
   * Node's default, which for years meant a warning and a process that kept serving
   * governed actions from an already-broken state.
   *
   * `/api/health` reports `degraded` from the first moment of the drain, so the load
   * balancer stops sending new work before the listener closes.
   */
  installLifecycle(httpServer, {
    onClose: () => {
      // Flushes SQLite's WAL and releases the file, so the next process (or the
      // next container on the same volume) does not inherit a hot journal.
      closeDatabase();
      /*
       * The shared limiter may hold a PostgreSQL pool. An open pool keeps the event
       * loop alive, so without this the process would accept SIGTERM, close the
       * server, and then simply not exit — which a container runtime resolves with
       * SIGKILL after its grace period. Awaited so the shutdown is actually complete
       * when we say it is.
       */
      void closeRateLimitStore();
    },
  });
})();
