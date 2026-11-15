/**
 * Console authentication.
 *
 * The browser never holds an API key. It exchanges a password for a
 * short-lived, server-signed session token, which is kept in module memory
 * (see `setAuthToken` in `queryClient.ts`) and never written to localStorage or
 * sessionStorage.
 *
 * Depuis le 27 octobre 2026, le serveur pose AUSSI ce jeton dans un cookie protégé
 * (HttpOnly, SameSite=Strict, `server/session-cookie.ts`) : aucun script de la page ne
 * peut le lire, et un rechargement de page reprend la session au lieu de déconnecter.
 * Le cookie expire avec la session, et la déconnexion l'efface.
 *
 * Nothing else in the app knows about credentials: every request picks the
 * token up from the HTTP layer.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Building2, Loader2, Lock } from "lucide-react";
import {
  claimLocalLogin,
  localConsoleInfo,
  claimSso,
  login as loginRequest,
  logout as logoutRequest,
  ssoStatus,
  type Identity,
} from "@/lib/api";
import { queryClient, restoreSession, setAuthToken, setUnauthorizedHandler } from "@/lib/queryClient";
import { can, type Capability, type Role } from "@shared/roles";
import WelcomePage, { isWelcomeRoute } from "@/pages/welcome";

interface AuthValue {
  identity: Identity | null;
  role: Role | null;
  /** Mirrors the server matrix. The UI hides what the API would refuse anyway. */
  can: (capability: Capability) => boolean;
  signOut: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error("useAuth must be used inside <AuthProvider>.");
  return value;
}

/**
 * The query parameter the SSO callback sends the browser back with.
 *
 * It carries a TICKET, never a session token: a URL ends up in browser history, in
 * proxy logs and in the next navigation's `Referer`. The ticket is opaque, single-use
 * and expires in 60 seconds, so one left behind in history is already spent.
 */
const SSO_PARAM = "sso_handoff";

/*
 * Le lien d'`oathrion console` : `#/connexion-locale?ticket=…`. Un ticket signé, de deux
 * minutes, à usage unique (`shared/local-login-ticket.ts`) — la console locale s'ouvre sans
 * mot de passe. Retiré de l'adresse dès qu'il est échangé, comme le ticket du SSO.
 */
const LOCAL_ROUTE = "#/connexion-locale";

function localTicketInHash(): string | null {
  const hash = window.location.hash;
  if (!hash.startsWith(LOCAL_ROUTE)) return null;
  return new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "").get("ticket");
}

const hasTicket = () => new URLSearchParams(window.location.search).has(SSO_PARAM) || localTicketInHash() !== null;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  /*
   * Starts as `true` when the URL carries a ticket, so the sign-in form never flashes
   * on screen in front of someone who has just authenticated with their provider.
   */
  const [claiming, setClaiming] = useState<boolean>(hasTicket);
  const [ssoFailed, setSsoFailed] = useState(false);
  const [localFailed, setLocalFailed] = useState(false);
  /*
   * Au chargement, la session portée par le cookie protégé est reprise, s'il y en a une :
   * un rechargement de page ne déconnecte plus (`server/session-cookie.ts`). Le formulaire
   * n'apparaît pas pendant ce bref instant, pour ne pas demander un mot de passe à
   * quelqu'un qui est déjà connecté.
   */
  const [restoring, setRestoring] = useState<boolean>(() => !hasTicket());
  useEffect(() => {
    if (!restoring) return;
    let cancelled = false;
    void restoreSession<{ identity: Identity }>().then((found) => {
      if (cancelled) return;
      if (found?.identity) setIdentity(found.identity);
      setRestoring(false);
    });
    return () => {
      cancelled = true;
    };
  }, [restoring]);

  const signOut = useCallback(() => {
    // Revoke server-side first: dropping the token locally would leave a valid
    // session alive until it expired. Local state is cleared either way.
    void logoutRequest().catch(() => undefined);
    setAuthToken(null);
    setIdentity(null);
    /*
     * Le cache des requêtes ne survit pas à la session. Il garde ses réponses sans
     * échéance (`staleTime: Infinity`) et vit au-dessus de l'authentification : sans ce
     * vidage, une seconde personne qui se connecte dans le même onglet voyait, jusqu'à
     * la première relecture, ce que le cache tenait de l'espace précédent (connecteurs,
     * agents, résultats du scénario). Le serveur, lui, refusait déjà ces données.
     */
    queryClient.clear();
  }, []);

  // Any request anywhere in the app hitting a 401 means this session is dead
  // server-side (expired, revoked, or the server restarted) — not that this
  // one request was malformed. Falling back to the sign-in screen here is
  // what makes that recoverable instead of leaving the app stuck showing
  // private data it can no longer actually fetch.
  useEffect(() => {
    setUnauthorizedHandler(signOut);
    return () => setUnauthorizedHandler(null);
  }, [signOut]);

  /*
   * THE RETURN FROM THE IDENTITY PROVIDER.
   *
   * The ticket is read, exchanged for a session token, and REMOVED FROM THE URL by
   * `replaceState` — in that order, and the removal happens whether the exchange
   * succeeded or not. A ticket left in the address bar would be copied into a chat
   * message by the first person asked to "send me the link", and would survive in the
   * browser's history entry for this page.
   *
   * `replaceState` rather than a navigation: this component is mounted, and a
   * navigation here would restart the app and lose the token it just obtained.
   */
  useEffect(() => {
    const url = new URL(window.location.href);
    const ticket = url.searchParams.get(SSO_PARAM);
    if (ticket === null) return;

    let cancelled = false;
    const strip = () => {
      url.searchParams.delete(SSO_PARAM);
      window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    };

    void claimSso(ticket)
      .then((session) => {
        strip();
        if (cancelled) return;
        setAuthToken(session.token);
        setIdentity(session.identity);
      })
      .catch(() => {
        /*
         * An expired, already-spent or unknown ticket. The sign-in form is shown with
         * no message beyond the generic one: the server deliberately refuses to say
         * which of the three it was, and repeating a guess here would invent detail
         * the server withheld on purpose.
         */
        strip();
        if (!cancelled) setSsoFailed(true);
      })
      .finally(() => {
        if (!cancelled) setClaiming(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  /* Le lien d'`oathrion console` : même principe que le retour du SSO, ci-dessus. */
  useEffect(() => {
    const ticket = localTicketInHash();
    if (ticket === null) return;
    let cancelled = false;
    /*
     * `next` : la page où mener après la connexion (le bouton « Share » d'une notification ouvre
     * l'élément du fil, 11 novembre). Une page de la console seulement, jamais une autre adresse.
     */
    const hash = window.location.hash;
    const next = new URLSearchParams(hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "").get("next");
    const target = next && /^\/[\w/?=&.-]*$/.test(next) ? next : "/";
    const strip = () => window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#${target}`);
    void claimLocalLogin(ticket)
      .then((session) => {
        strip();
        if (cancelled) return;
        setAuthToken(session.token);
        setIdentity(session.identity);
      })
      .catch(() => {
        strip();
        if (cancelled) return;
        /* Un lien déjà servi n'efface pas une session déjà ouverte : on la reprend, s'il y en a une. */
        setLocalFailed(true);
        setRestoring(true);
      })
      .finally(() => {
        if (!cancelled) setClaiming(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /*
   * Un lien ouvert dans un onglet déjà chargé ne change que le fragment : la page ne se
   * recharge pas, et le ticket arriverait sur une route inconnue. On recharge, pour qu'il
   * suive le même chemin qu'au chargement.
   */
  useEffect(() => {
    const onHash = () => {
      if (localTicketInHash() !== null) window.location.reload();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      identity,
      role: identity?.role ?? null,
      can: (capability: Capability) => (identity ? can(identity.role, capability) : false),
      signOut,
    }),
    [identity, signOut],
  );

  if (claiming || restoring) {
    /*
     * The window between landing back from the provider and holding a token. Showing
     * the sign-in form here would ask someone to type a password they have just been
     * told they do not need.
     */
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          <span>Connexion en cours…</span>
        </div>
      </div>
    );
  }

  if (!identity) {
    /*
     * Un lien d'invitation s'ouvre AVANT la connexion : la personne n'a pas encore de
     * compte, c'est précisément ce que la page lui fait créer.
     */
    if (isWelcomeRoute()) {
      return (
        <WelcomePage
          onSignedIn={(token, who) => {
            setAuthToken(token);
            setIdentity(who);
          }}
        />
      );
    }
    return (
      <SignIn
        ssoFailed={ssoFailed}
        localFailed={localFailed}
        onSuccess={(token, who) => {
          setAuthToken(token);
          setIdentity(who);
        }}
      />
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function SignIn({
  onSuccess,
  ssoFailed = false,
  localFailed = false,
}: {
  onSuccess: (token: string, identity: Identity) => void;
  ssoFailed?: boolean;
  localFailed?: boolean;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  /*
   * `null` while unknown, and the button is NOT drawn in that state.
   *
   * A button that appears a moment after the form, or one that appears and leads to a
   * 404, is worse than no button: the first makes the screen jump under the cursor,
   * the second tells someone their company has SSO when it does not. The password
   * field is usable the whole time either way.
   */
  const [sso, setSso] = useState<boolean | null>(null);

  /* En local, on n'entre pas par un mot de passe : la page dit comment entrer. */
  const [local, setLocal] = useState<{ name: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    void localConsoleInfo().then((info) => {
      if (!cancelled) setLocal(info);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void ssoStatus()
      .then((status) => {
        if (!cancelled) setSso(status.configured);
      })
      .catch(() => {
        /*
         * The deployment is unreachable, or this build has no SSO route at all. Either
         * way the answer for this screen is the same: do not offer a door that may not
         * open. The password path is unaffected — that is the point of failing this
         * way round.
         */
        if (!cancelled) setSso(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!email || !password || pending) return;
    setPending(true);
    setError(null);
    try {
      const session = await loginRequest(email, password);
      onSuccess(session.token, session.identity);
    } catch {
      /*
       * One message for every failure, matching the server exactly. The server also
       * refuses a suspended account and an account with no active organization with
       * the same 401, so a more specific message here would either be wrong or would
       * answer "does this address have an account?" to anyone who asks.
       */
      setError("Incorrect address or password.");
      setPending(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Lock className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-tight">Oathrion</h1>
            <p className="text-xs text-muted-foreground">Sign in to continue</p>
          </div>
        </div>

        {local && (
          <section className="mb-6 rounded-lg border border-primary/30 bg-primary/5 p-4 text-sm" data-testid="local-signin-help">
            <p className="font-medium">Oathrion runs on your machine.</p>
            <p className="mt-1.5 text-muted-foreground">
              No password to remember: in a terminal, this command opens the console already signed in.
            </p>
            <code className="mt-3 block overflow-x-auto rounded bg-muted px-2.5 py-2 font-mono text-xs">
              oathrion console{local.name ? ` --name ${local.name}` : ""}
            </code>
          </section>
        )}

        <form onSubmit={submit} className="space-y-3" data-testid="form-signin">
          <div className="space-y-1.5">
            <label htmlFor="console-email" className="text-xs font-medium text-muted-foreground">
              Email address
            </label>
            <input
              id="console-email"
              type="email"
              autoFocus
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary"
              placeholder="you@company.com"
              data-testid="input-console-email"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="console-password"
              className="text-xs font-medium text-muted-foreground"
            >
              Password
            </label>
            <input
              id="console-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary"
              placeholder="••••••••"
              data-testid="input-console-password"
            />
          </div>

          {error && (
            <p className="text-xs text-destructive" data-testid="text-signin-error">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={pending || email.length === 0 || password.length === 0}
            className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
            data-testid="button-signin"
          >
            <Loader2
              className={`h-3.5 w-3.5 animate-spin ${pending ? "" : "hidden"}`}
              aria-hidden="true"
            />
            Sign in
          </button>
        </form>

        {sso === true && (
          <>
            <div className="my-5 flex items-center gap-3" aria-hidden="true">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">or</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            {/*
              A LINK, not a fetch. The provider has to receive a real browser
              navigation — it may show its own screens, ask for a second factor, or
              bounce through a corporate portal. An XHR would be blocked by the
              provider's framing rules and would strip the user of any chance to see
              where they are being sent.

              `returnTo` is the path currently open, so someone deep-linked into an
              approval comes back to that approval. The server forces it to a relative
              path, which is what closes the open-redirect this parameter would
              otherwise be.
            */}
            <a
              href={`/api/auth/sso/start?returnTo=${encodeURIComponent(
                `${window.location.pathname}${window.location.search}`,
              )}`}
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card text-sm font-medium transition-colors hover:border-primary"
              data-testid="link-signin-sso"
            >
              <Building2 className="h-3.5 w-3.5" aria-hidden="true" />
              Sign in with your company account
            </a>
          </>
        )}

        {ssoFailed && (
          <p className="mt-4 text-xs text-destructive" data-testid="text-sso-error">
            {/*
              One message, matching the server. The ticket was unknown, expired or
              already spent, and the server refuses to say which — inventing the
              distinction here would hand back exactly what it withheld.
            */}
            Company sign-in did not go through. Try again, or sign in with your password.
          </p>
        )}

        {localFailed && (
          <p className="mt-4 text-xs text-destructive" data-testid="text-local-login-error">
            This sign-in link is no longer valid: it works once, for two minutes. Run
            "oathrion console" again in your terminal to get a new one.
          </p>
        )}

        <p className="mt-6 text-[11px] leading-relaxed text-muted-foreground">
          Your session is kept only in this tab, never stored in the browser: closing the tab signs
          you out. Your agents use an API key.
        </p>
      </div>
    </div>
  );
}
