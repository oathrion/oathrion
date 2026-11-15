/**
 * La page d'accueil d'un lien d'invitation — le premier écran qu'un client voit.
 *
 * ## Ce qu'elle remplace
 *
 * Avant elle, une invitation (ou la création d'un espace) se terminait par un appel
 * `curl` à `/api/invitations/accept` : la console n'avait aucun écran pour l'accepter.
 * Une personne non technique ne pouvait donc ni créer son espace ni rejoindre celui de
 * son équipe sans aide.
 *
 * ## Le jeton
 *
 * Il arrive dans le FRAGMENT de l'URL (`#/bienvenue?invitation=…`), qu'aucun navigateur
 * n'envoie à un serveur ni dans un `Referer`. Il est lu une fois puis RETIRÉ de la barre
 * d'adresse : un lien copié depuis l'onglet ouvert ne doit pas emporter un accès.
 */

import { useEffect, useState } from "react";
import { CheckCircle2, KeyRound, Loader2, ShieldCheck } from "lucide-react";

import {
  acceptInvitation,
  inspectInvitation,
  login,
  resetPassword,
  type Identity,
  type InvitationPreview,
} from "@/lib/api";

const ROLE_LABEL: Record<string, string> = {
  admin: "administrator",
  approver: "approver",
  operator: "operator",
  viewer: "viewer",
};

/*
 * La forme d'une clé de lien (`identity-tokens.ts`) : `idt_` + 24 hexadécimaux, un point,
 * 32 octets en base64url (43 caractères). Un lien coupé au copier-coller n'a pas cette
 * forme : la page le dit, au lieu de « il a déjà servi » (essai réel, §5.50).
 */
const LINK_KEY_SHAPE = /^idt_[0-9a-f]{24}\.[A-Za-z0-9_-]{43}$/;

/** Le jeton du fragment, ou `null`. Retiré de l'URL au passage. */
function takeTokenFromHash(): string | null {
  const hash = window.location.hash;
  const query = hash.includes("?") ? hash.slice(hash.indexOf("?") + 1) : "";
  const token = new URLSearchParams(query).get("invitation");
  if (token) {
    window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#/bienvenue`);
  }
  return token;
}

/** Les règles du serveur, dites AVANT l'envoi. Le serveur reste juge. */
function passwordProblem(password: string, confirmation: string): string | null {
  if (password.length < 12) return "At least 12 characters.";
  if (password !== password.trim()) return "No space at the start or the end.";
  if (password.length > 256) return "256 characters at most.";
  if (confirmation !== password) return "The two entries do not match.";
  return null;
}

export function isWelcomeRoute(): boolean {
  return window.location.hash.startsWith("#/bienvenue");
}

export default function WelcomePage({ onSignedIn }: { onSignedIn: (token: string, identity: Identity) => void }) {
  const [token] = useState<string | null>(() => takeTokenFromHash());
  const incomplete = token === null || !LINK_KEY_SHAPE.test(token);
  const [preview, setPreview] = useState<InvitationPreview | null | "loading">(() => (incomplete ? null : "loading"));
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!token || incomplete) return;
    let cancelled = false;
    void inspectInvitation(token)
      .then((result) => !cancelled && setPreview(result))
      .catch(() => !cancelled && setPreview(null));
    return () => {
      cancelled = true;
    };
  }, [token, incomplete]);

  const problem = passwordProblem(password, confirmation);
  const isReset = preview !== "loading" && preview?.purpose === "reset";
  const ready = problem === null && (isReset || name.trim().length > 0) && !pending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!token || preview === "loading" || preview === null || !ready) return;
    setPending(true);
    setError(null);
    const accepted = isReset
      ? await resetPassword(token, password)
      : await acceptInvitation(token, name.trim(), password);
    if (!accepted.ok) {
      setError(accepted.message);
      setPending(false);
      return;
    }
    try {
      const session = await login(preview.email, password);
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#/`);
      onSignedIn(session.token, session.identity);
    } catch {
      /* Le compte existe : seule la connexion automatique a échoué. On le dit tel quel. */
      setError("Your account is ready, but the automatic sign-in failed. Sign in with your address and this password.");
      window.history.replaceState({}, "", `${window.location.pathname}${window.location.search}#/`);
      setPending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-8 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <ShieldCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <p className="text-sm font-semibold tracking-tight">Oathrion</p>
        </div>

        {preview === "loading" && (
          <div className="flex items-center gap-3 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Checking the link…
          </div>
        )}

        {preview === null && incomplete && (
          <section aria-labelledby="welcome-incomplete">
            <h1 id="welcome-incomplete" className="text-2xl font-semibold tracking-tight text-balance">
              This link is incomplete
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              It was probably cut when copied: the end, after "invitation=", is missing or truncated. Copy
              the whole link again. With oathrion wrap, it is kept in the invitation.url file of your
              server's folder.
            </p>
            <a
              href="/console"
              className="mt-6 inline-flex h-10 items-center rounded-lg border border-border px-4 text-sm font-medium hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              I already have an account
            </a>
          </section>
        )}

        {preview === null && !incomplete && (
          <section aria-labelledby="welcome-invalid">
            <h1 id="welcome-invalid" className="text-2xl font-semibold tracking-tight text-balance">
              This link is no longer valid
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              It was already used, it expired, or it was revoked. Ask the person who sent it for a new
              link — a link works only once.
            </p>
            <a
              href="/console"
              className="mt-6 inline-flex h-10 items-center rounded-lg border border-border px-4 text-sm font-medium hover:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              I already have an account
            </a>
          </section>
        )}

        {preview !== "loading" && preview !== null && (
          <section aria-labelledby="welcome-title">
            <h1 id="welcome-title" className="text-2xl font-semibold tracking-tight text-balance">
              {isReset
                ? "Choose a new password"
                : preview.role === "admin"
                  ? `Create the ${preview.organizationName} workspace`
                  : `Join ${preview.organizationName}`}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
              {isReset ? (
                <>For the account <strong className="text-foreground">{preview.email}</strong>.</>
              ) : (
                <>
                  You will join as <strong className="text-foreground">{ROLE_LABEL[preview.role] ?? preview.role}</strong>{" "}
                  with the address <strong className="text-foreground">{preview.email}</strong>. Then Oathrion guides
                  you to connect your tools and check the control on a real action.
                </>
              )}
            </p>

            <form onSubmit={submit} className="mt-8 space-y-4" data-testid="form-welcome">
              {!isReset && (
                <div className="space-y-1.5">
                  <label htmlFor="welcome-name" className="text-xs font-medium text-muted-foreground">
                    Your name
                  </label>
                  <input
                    id="welcome-name"
                    autoFocus
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
                    placeholder="Awa Diallo"
                  />
                  <p className="text-xs text-muted-foreground">This name signs your approvals in the log.</p>
                </div>
              )}
              <div className="space-y-1.5">
                <label htmlFor="welcome-password" className="text-xs font-medium text-muted-foreground">
                  Password
                </label>
                <input
                  id="welcome-password"
                  type="password"
                  autoFocus={isReset}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="welcome-password-hint"
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
                />
                <p id="welcome-password-hint" className="text-xs text-muted-foreground">
                  At least 12 characters. A short sentence is easier to remember than a complicated word.
                </p>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="welcome-confirmation" className="text-xs font-medium text-muted-foreground">
                  Confirm the password
                </label>
                <input
                  id="welcome-confirmation"
                  type="password"
                  autoComplete="new-password"
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                  className="h-11 w-full rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary focus-visible:ring-2 focus-visible:ring-primary/30"
                />
              </div>

              {password.length > 0 && problem && (
                <p className="text-xs text-muted-foreground" aria-live="polite">
                  {problem}
                </p>
              )}
              {password.length > 0 && !problem && (
                <p className="flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400" aria-live="polite">
                  <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" /> Valid password.
                </p>
              )}
              {error && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={!ready}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2"
              >
                {pending ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <KeyRound className="h-4 w-4" aria-hidden="true" />
                )}
                {isReset ? "Save and sign in" : preview.role === "admin" ? "Create the workspace" : "Join the team"}
              </button>
            </form>
          </section>
        )}
      </div>
    </main>
  );
}
