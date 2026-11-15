import { useState } from "react";
import { Check, Copy, Loader2, UserPlus } from "lucide-react";

import { createInvitation, invitationLink } from "@/lib/api";
import type { Role } from "@shared/roles";

import { StepShell, inputClass, primaryButton, secondaryButton } from "./shared";

const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: "approver", label: "Approver", hint: "approves or rejects held actions" },
  { value: "viewer", label: "Viewer", hint: "looks at activity, changes nothing" },
  { value: "admin", label: "Administrator", hint: "connects tools and sets the controls" },
];

export function WorkspaceStep({
  organizationName,
  memberCount,
  onNext,
}: {
  organizationName: string;
  memberCount: number | null;
  onNext: () => void;
}) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("approver");
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<{ email: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function invite(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    setLink(null);
    const result = await createInvitation(email.trim(), role);
    setPending(false);
    if (!result.ok) {
      setError(
        result.message.includes("already")
          ? "This address is already a member, or an invitation is already pending for it."
          : result.message,
      );
      return;
    }
    setLink({ email: email.trim(), url: invitationLink(result.token) });
    setEmail("");
  }

  async function copy() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <StepShell
      eyebrow="Step 1 of 5"
      title={`The ${organizationName || "team"} workspace is ready`}
      lead={
        <>
          {memberCount !== null && <>{memberCount} member{memberCount > 1 ? "s" : ""} so far. </>}
          Invite the person who will approve your agents' actions — you can also do it later, from
          Settings.
        </>
      }
    >
      <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_auto_auto] sm:items-end">
        <div className="space-y-1.5">
          <label htmlFor="invite-email" className="text-xs font-medium text-muted-foreground">
            Email address
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@company.com"
            className={inputClass}
          />
        </div>
        <div className="space-y-1.5">
          <label htmlFor="invite-role" className="text-xs font-medium text-muted-foreground">
            Role
          </label>
          <select id="invite-role" value={role} onChange={(e) => setRole(e.target.value as Role)} className={inputClass}>
            {ROLES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())} className={secondaryButton}>
          {pending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <UserPlus className="h-4 w-4" aria-hidden="true" />}
          Create the link
        </button>
      </form>
      <p className="mt-2 text-xs text-muted-foreground">{ROLES.find((r) => r.value === role)?.hint}.</p>

      {error && (
        <p className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {link && (
        <div className="mt-5 rounded-xl border border-border bg-card p-4" aria-live="polite">
          <p className="text-sm font-medium">Invitation link for {link.email}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Send it through a trusted channel. It works once, expires in 7 days, and will not be shown again
            after this page.
          </p>
          <div className="mt-3 flex gap-2">
            <input readOnly value={link.url} className={`${inputClass} font-mono text-xs`} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
            <button type="button" onClick={() => void copy()} className={secondaryButton}>
              {copied ? <Check className="h-4 w-4" aria-hidden="true" /> : <Copy className="h-4 w-4" aria-hidden="true" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      )}

      <div className="mt-10">
        <button type="button" onClick={onNext} className={primaryButton}>
          Connect your tools
        </button>
      </div>
    </StepShell>
  );
}
