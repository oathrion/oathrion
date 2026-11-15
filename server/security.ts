import type { Express, NextFunction, Request, Response } from "express";

/**
 * Browser-facing hardening for the console.
 *
 * These headers are written by hand rather than pulled from a middleware
 * package: the set below is small, the console is a single same-origin app, and
 * the content policy has to be tuned for the dev server anyway. One file with
 * one exported function is easier to audit than a dependency with defaults that
 * have to be overridden.
 *
 * What is deliberately *not* here:
 *
 *   - No CORS headers. The console is served by the same process that serves
 *     the API, so it never needs them. Their absence is the control: a page on
 *     another origin cannot read an API response, and any request carrying the
 *     `Authorization` header is preflighted and refused. Adding a permissive
 *     origin would open the API to every site the operator visits.
 *   - No CSRF token. There is no ambient credential to forge with — the session
 *     token is held in module memory only (never written to `localStorage`,
 *     `sessionStorage` or a cookie — see `client/src/lib/auth.tsx`) and is
 *     sent in an `Authorization` header, so a cross-site form post arrives
 *     unauthenticated.
 */

/** Directives for the built console. */
const PRODUCTION_CSP = [
  "default-src 'self'",
  // Tailwind ships utility classes, but Radix and Recharts set inline styles.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/**
 * Directives for the Vite dev server, which needs `eval` for hot reload and a
 * websocket for the client. This policy is looser on purpose and is never sent
 * in production.
 */
const DEVELOPMENT_CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
  "img-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");

/**
 * Installs the response headers and the proxy trust setting.
 *
 * Call before any route: a header set here applies to the API, the console and
 * the error handler alike.
 */
export function applySecurity(app: Express, env: NodeJS.ProcessEnv = process.env): void {
  const isProduction = env.NODE_ENV === "production";

  /*
   * Rate limiting keys on the client address. Behind a reverse proxy every
   * request arrives from the proxy, so without this the whole organisation
   * shares one bucket and ten bad logins lock everyone out. `OATHRION_TRUST_PROXY`
   * must be set only when a proxy is actually in front — trusting a header that
   * nobody rewrites lets a caller forge its own address and escape the limit.
   */
  const trustProxy = env.OATHRION_TRUST_PROXY;
  if (trustProxy && trustProxy !== "false") {
    // `1` (the common case: one proxy) or a subnet such as "10.0.0.0/8".
    app.set("trust proxy", /^\d+$/.test(trustProxy) ? Number(trustProxy) : trustProxy);
  } else {
    app.set("trust proxy", false);
  }

  // Express advertises itself by default; there is no reason to name the stack.
  app.disable("x-powered-by");

  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Content-Security-Policy", isProduction ? PRODUCTION_CSP : DEVELOPMENT_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

    /*
     * HSTS is only meaningful over TLS, and sending it over plain HTTP during a
     * local pilot would pin the operator's browser to a scheme the deployment
     * may not serve yet.
     */
    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    }

    next();
  });
}
