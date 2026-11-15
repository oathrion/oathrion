/**
 * Process lifecycle: graceful shutdown and last-resort fault handlers.
 *
 * WHY THIS EXISTS
 * ---------------
 * Before this module, the process had no lifecycle at all:
 *
 *  - SIGTERM killed it instantly. An orchestrator sends SIGTERM on every deploy,
 *    scale-down and node drain. Any request in flight was cut mid-response. For
 *    Oathrion specifically that means a tool call could be dispatched — money moved,
 *    an email sent — and the process die before the audit entry and the terminal
 *    status were written. The execution is then left `running`, and the record of a
 *    real-world side effect is simply missing. Losing the record of a governed
 *    action is the one failure this product cannot afford.
 *
 *  - An `unhandledRejection` or `uncaughtException` was left to Node's default. In
 *    current Node an uncaught exception exits, but an unhandled rejection had been
 *    warn-only for years and the code was written under that assumption: a promise
 *    rejecting in a background path would print a warning and leave the process
 *    running in an unknown state, serving traffic while some invariant was already
 *    broken. Silent corruption outranks a restart.
 *
 * DESIGN
 * ------
 *  - `/api/health` starts answering `degraded` (503) the moment shutdown begins, so
 *    the load balancer stops sending new work *before* the socket closes. Without
 *    this window, closing the listener races the probe and clients see connection
 *    resets instead of being routed elsewhere.
 *  - `server.close()` stops accepting new connections and waits for in-flight
 *    responses. Keep-alive sockets that are idle are closed explicitly, otherwise
 *    they hold the process open for the full keep-alive timeout on every deploy.
 *  - A hard deadline. A graceful shutdown that never finishes is a hung deploy, and
 *    an orchestrator will SIGKILL anyway — better to exit deliberately, with a log
 *    line saying why, than to be killed without one.
 *  - `uncaughtException` exits without attempting graceful drain of *new* work but
 *    still lets in-flight responses finish if it can. The process state is by
 *    definition untrusted at that point, so it must not keep serving.
 *  - Handlers are idempotent: a second SIGTERM (or a SIGINT following a SIGTERM)
 *    must not start a second drain, and must not reset the deadline.
 */

import type { Server } from "node:http";

/** How long a drain may take before the process exits anyway. */
const SHUTDOWN_TIMEOUT_MS = readTimeout();

function readTimeout(): number {
  const raw = process.env.OATHRION_SHUTDOWN_TIMEOUT_MS;
  if (!raw) return 15_000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `OATHRION_SHUTDOWN_TIMEOUT_MS is not a positive number; using the 15000ms default.`,
    );
    return 15_000;
  }
  // A drain longer than a typical orchestrator grace period is worse than none:
  // the process would still be draining when SIGKILL lands, so the deadline would
  // never be the thing that fires.
  return Math.min(parsed, 120_000);
}

/**
 * True once shutdown has begun.
 *
 * Read by `/api/health` so readiness flips before the listener closes. Deliberately
 * a module-level flag rather than something threaded through every layer: it is
 * process-wide state, and pretending otherwise would mean passing a shutdown token
 * into code that has no other reason to know about the process.
 */
let shuttingDown = false;

export function isShuttingDown(): boolean {
  return shuttingDown;
}

let installed = false;

/** Vrai quand les gestionnaires de signaux sont posés : un SIGTERM sera drainé, pas brutal. */
export function lifecycleInstalled(): boolean {
  return installed;
}

/** Test seam: resets the flag so one suite's shutdown does not leak into the next. */
export function resetLifecycle(): void {
  shuttingDown = false;
}

export interface LifecycleOptions {
  /** Called after the listener closes, to release resources (database handles…). */
  onClose?: () => void | Promise<void>;
  /** Overridden in tests so a shutdown assertion does not kill the test runner. */
  exit?: (code: number) => void;
  /** Overridden in tests to avoid a real 15s wait. */
  timeoutMs?: number;
}

/**
 * Drains the server and resolves with the exit code that should be used.
 *
 * Exported separately from the signal wiring so a test can drive a real drain
 * without installing process-wide handlers or actually exiting.
 */
export async function shutdown(
  server: Server,
  reason: string,
  options: LifecycleOptions = {},
): Promise<number> {
  if (shuttingDown) {
    // A second signal during a drain is normal (impatient operator, or SIGINT
    // after SIGTERM). It must not start a second drain or reset the deadline.
    console.warn(`[lifecycle] already shutting down; ignoring ${reason}.`);
    return 0;
  }
  shuttingDown = true;

  // eslint-disable-next-line no-console
  console.log(`[lifecycle] ${reason} received — draining (health now reports degraded).`);

  const timeoutMs = options.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;

  const closed = new Promise<boolean>((resolve) => {
    server.close((err) => {
      if (err) console.error("[lifecycle] error while closing the listener:", err);
      resolve(true);
    });

    /*
     * Idle keep-alive sockets do not belong to any in-flight request, but they keep
     * `close()` from completing. Node exposes this only from 18.2, so it is called
     * defensively: on an older runtime the deadline below still bounds the wait.
     */
    const closeIdle = (server as Server & { closeIdleConnections?: () => void })
      .closeIdleConnections;
    if (typeof closeIdle === "function") closeIdle.call(server);
  });

  const timedOut = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    // Do not let the deadline itself be the reason the process stays alive.
    timer.unref?.();
  });

  const drained = await Promise.race([closed, timedOut]);
  if (!drained) {
    console.error(
      `[lifecycle] requests still in flight after ${timeoutMs}ms — exiting anyway. ` +
        `An unbounded drain is a hung deploy, and would be SIGKILLed without a log line.`,
    );
  }

  try {
    await options.onClose?.();
  } catch (error) {
    console.error("[lifecycle] error while releasing resources:", error);
  }

  // eslint-disable-next-line no-console
  console.log(`[lifecycle] shutdown complete (${drained ? "drained" : "timed out"}).`);
  return drained ? 0 : 1;
}

/**
 * Installs the signal and fault handlers. Call once, after `listen`.
 *
 * Returns a disposer so a test can install and remove them without leaking
 * listeners across suites.
 */
export function installLifecycle(server: Server, options: LifecycleOptions = {}): () => void {
  const exit = options.exit ?? ((code: number) => process.exit(code));

  const onSignal = (signal: "SIGTERM" | "SIGINT") => {
    void shutdown(server, signal, options).then(exit);
  };

  const sigterm = () => onSignal("SIGTERM");
  const sigint = () => onSignal("SIGINT");

  /**
   * A rejection nobody handled means a code path failed and no one noticed. The
   * process is in an unknown state; continuing to serve governed actions from an
   * unknown state is worse than a restart, so this drains and exits non-zero rather
   * than logging and carrying on.
   */
  const onRejection = (reason: unknown) => {
    /*
     * Pendant l'arrêt, une faute de plus ne relance rien et ne s'écrit pas : écrire peut
     * être justement ce qui échoue (une sortie dont le lecteur est mort), et chaque échec
     * en relancerait un autre. Trouvé le 28 octobre 2026 : un Oathrion local dont le
     * relais était mort tournait sans fin à 84 % d'un cœur, d'EPIPE en EPIPE, et l'arrêt
     * qu'il venait de commencer n'arrivait jamais (STRESS-TEST-LOG §5.49).
     */
    if (shuttingDown) return;
    console.error("[lifecycle] unhandled promise rejection — shutting down:", reason);
    void shutdown(server, "unhandledRejection", options).then(() => exit(1));
  };

  const onException = (error: unknown) => {
    if (shuttingDown) return;
    console.error("[lifecycle] uncaught exception — shutting down:", error);
    void shutdown(server, "uncaughtException", options).then(() => exit(1));
  };

  /*
   * Une sortie standard dont le lecteur a disparu (le relais d'`oathrion wrap` tué, un
   * collecteur de journaux arrêté) ne doit ni faire tomber le serveur ni le faire boucler :
   * sans écouteur, chaque EPIPE devient une exception non rattrapée. L'erreur est avalée ;
   * c'est au processus qui a lancé le serveur de dire s'il doit s'arrêter.
   */
  const onStdioError = (error: NodeJS.ErrnoException) => {
    if (error.code !== "EPIPE" && error.code !== "ERR_STREAM_DESTROYED") onException(error);
  };

  process.on("SIGTERM", sigterm);
  process.on("SIGINT", sigint);
  process.on("unhandledRejection", onRejection);
  process.on("uncaughtException", onException);
  process.stdout.on("error", onStdioError);
  process.stderr.on("error", onStdioError);
  installed = true;

  return () => {
    installed = false;
    process.stdout.off("error", onStdioError);
    process.stderr.off("error", onStdioError);
    process.off("SIGTERM", sigterm);
    process.off("SIGINT", sigint);
    process.off("unhandledRejection", onRejection);
    process.off("uncaughtException", onException);
  };
}
