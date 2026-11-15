/**
 * Settings — every surface on this page is now live.
 *
 * It used to be a mix: the org profile, the member roster, four security toggles and a
 * billing plan were fixtures wearing a "Demo data" badge. A badge does not redeem a
 * screen that looks like a feature and does nothing (§15), and by now the backend holds
 * real organizations (P0-1) and real users (P0-2) — so the fixtures were replaced by the
 * rows, and the two surfaces with no backend at all (SSO/2FA toggles, billing plan) were
 * removed rather than relabelled.
 *
 * What is left is the rule: every value here is read from the server, and every button
 * performs the action it names.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Loader2, Plus, ShieldOff, Trash2 } from "lucide-react";
import {
  changePassword,
  createApiKey,
  getOrganization,
  listApiKeys,
  listMembers,
  listSessions,
  revokeApiKey,
  revokeSession,
  type MemberSummary,
  type SessionSummary,
} from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { CAPABILITIES, capabilitiesOf, type Role } from "@shared/roles";
import { relativeTime } from "@/lib/format";
import { ErrorState, KeyValue, PageHeader, SectionCard, Surface } from "@/components/common/primitives";
import { Pill } from "@/components/common/badges";
import { DataTable, type Column } from "@/components/common/DataTable";
import { useToast } from "@/hooks/use-toast";
import { useARIA } from "@/lib/store";
import { computeDashboardMetrics, executionsInWindow } from "@shared/metrics";
import { currency, fullDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const TABS = ["Organization", "Members", "Security", "API Keys", "Billing", "Audit"] as const;
type Tab = (typeof TABS)[number];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("Organization");

  return (
    <div className="space-y-6">
      <PageHeader title="Settings" subtitle="Configure the control plane for your organization." />

      <div className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            data-testid={`button-tab-${t.toLowerCase().replace(" ", "-")}`}
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
              tab === t
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "Organization" && <OrganizationTab />}
      {tab === "Members" && <MembersTab />}
      {tab === "Security" && <SecurityTab />}
      {tab === "API Keys" && <ApiKeysTab />}
      {tab === "Billing" && <BillingTab />}
      {tab === "Audit" && <AuditTab />}
    </div>
  );
}

/* Bounded loading state: a labelled card, never a bare spinner on an empty page (§10). */
function LoadingCard({ title }: { title: string }) {
  return (
    <SectionCard title={title} description="Loading…">
      <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Reading from the server…
      </div>
    </SectionCard>
  );
}

/** Marks a surface computed from live server state. */
function LiveBadge() {
  return (
    <Pill tone="success" dot data-testid="badge-live-data">
      Live data
    </Pill>
  );
}

function OrganizationTab() {
  const org = useQuery({ queryKey: ["/api/organization"], queryFn: getOrganization });

  if (org.isLoading) return <LoadingCard title="Organization" />;
  if (org.isError || !org.data) {
    return (
      <SectionCard title="Organization" description="Your tenant, as the server holds it.">
        <div className="px-5 py-6">
          <ErrorState message="Could not load the organization." onRetry={() => void org.refetch()} />
        </div>
      </SectionCard>
    );
  }

  const data = org.data;
  return (
    <SectionCard
      title="Organization"
      description="Your tenant. Every agent, policy, execution and credential in Oathrion belongs to exactly one of these."
      action={<LiveBadge />}
      bodyClassName="grid gap-x-8 px-5 sm:grid-cols-2"
    >
      <KeyValue label="Name">{data.name}</KeyValue>
      <KeyValue label="Status">
        <Pill tone={data.active ? "success" : "danger"} dot>
          {data.active ? "Active" : "Suspended"}
        </Pill>
      </KeyValue>
      <KeyValue label="Members">
        <span data-testid="text-org-members">{data.memberCount}</span>
      </KeyValue>
      <KeyValue label="Administrators">{data.adminCount}</KeyValue>
      <KeyValue label="Organization ID">
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs" data-testid="text-org-id">
          {data.id}
        </code>
      </KeyValue>
      <KeyValue label="Created">{fullDate(data.createdAt)}</KeyValue>
    </SectionCard>
  );
}

function MembersTab() {
  const roster = useQuery({ queryKey: ["/api/members"], queryFn: listMembers });

  const columns: Column<MemberSummary>[] = [
    {
      key: "name",
      header: "Member",
      render: (m) => (
        <div className="flex items-center gap-3">
          <span className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-xs font-semibold">
            {(m.name || m.email).slice(0, 1).toUpperCase()}
          </span>
          <div>
            <p className="font-medium">{m.name}</p>
            <p className="text-xs text-muted-foreground">{m.email}</p>
          </div>
        </div>
      ),
    },
    { key: "role", header: "Role", render: (m) => <Pill tone="neutral">{m.role}</Pill> },
    {
      key: "status",
      header: "Status",
      render: (m) => (
        <Pill tone={m.status === "active" ? "success" : "warning"} dot>
          {m.status === "active" ? "Active" : "Suspended"}
        </Pill>
      ),
    },
    {
      key: "lastLoginAt",
      header: "Last sign-in",
      align: "right",
      render: (m) => (
        <span className="text-sm text-muted-foreground">
          {m.lastLoginAt ? relativeTime(m.lastLoginAt) : "never"}
        </span>
      ),
    },
  ];

  if (roster.isLoading) return <LoadingCard title="Members" />;
  if (roster.isError) {
    return (
      <SectionCard title="Members" description="Everyone who can sign in to this organization.">
        <div className="px-5 py-6">
          <ErrorState message="Could not load the roster." onRetry={() => void roster.refetch()} />
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title="Members"
      description="Everyone who can sign in to this organization. Accounts are provisioned by the operator through OATHRION_CONSOLE_USERS; each one holds a scrypt hash, never a password."
      action={<LiveBadge />}
    >
      <DataTable columns={columns} rows={roster.data?.members ?? []} />
    </SectionCard>
  );
}

/**
 * Live session inventory. This is the visible half of server-side revocation:
 * a token stays valid until someone kills it here (or it expires), and killing
 * it takes effect on the very next request, not at the next sign-in.
 */
function SessionsPanel() {
  const { identity, can } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["/api/auth/sessions"],
    queryFn: listSessions,
    refetchInterval: 15_000,
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeSession(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/auth/sessions"] });
      toast({ title: "Session revoked", description: "The token stops working immediately." });
    },
    onError: () => toast({ title: "Could not revoke session", variant: "destructive" }),
  });

  const sessions = data?.sessions ?? [];
  const capabilities = identity ? capabilitiesOf(identity.role) : [];

  return (
    <div className="space-y-6">
      <SectionCard
        title="Your access"
        description="Your role is assigned server-side from the credential you signed in with. It cannot be changed from this browser."
        action={<LiveBadge />}
        bodyClassName="divide-y divide-card-border"
      >
        <div className="flex items-center justify-between gap-4 px-5 py-4">
          <div>
            <p className="text-sm font-medium">Signed in as</p>
            <p className="text-xs text-muted-foreground">{identity?.name ?? "—"}</p>
          </div>
          <Pill tone="info" data-testid="pill-current-role">
            {identity?.role ?? "—"}
          </Pill>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
          <div>
            <p className="text-sm font-medium">Capabilities</p>
            <p className="text-xs text-muted-foreground">Granted by the role matrix, enforced by the API.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {CAPABILITIES.map((capability) => (
              <Pill
                key={capability}
                tone={capabilities.includes(capability) ? "success" : "neutral"}
                data-testid={`pill-capability-${capability}`}
              >
                {capability}
              </Pill>
            ))}
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Active sessions"
        description={
          can("manage")
            ? "Every console session issued by this server. Revoking one invalidates its token on the next request."
            : "Sessions issued to you. Revoking one signs that browser out immediately."
        }
        action={<LiveBadge />}
        bodyClassName="divide-y divide-card-border"
      >
        {isError ? (
          // An unavailable session inventory must not look like an empty inventory.
          <ErrorState message="Could not load sessions." onRetry={() => void refetch()} />
        ) : isLoading ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading sessions…
          </div>
        ) : sessions.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">No session on record.</p>
        ) : (
          sessions.map((session: SessionSummary) => (
          <div
            key={session.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4"
            data-testid={`row-session-${session.id}`}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {session.name}
                {session.current && (
                  <span className="ml-2 text-xs font-normal text-muted-foreground">this browser</span>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                Last seen {relativeTime(session.lastSeenAt)} · expires {fullDate(session.expiresAt)}
              </p>
            </div>
            <Pill tone="info">{session.role}</Pill>
            <Pill tone={session.active ? "success" : "neutral"} dot>
              {session.active ? "Active" : "Revoked"}
            </Pill>
            {session.active && (
              <button
                onClick={() => revoke.mutate(session.id)}
                disabled={revoke.isPending}
                data-testid={`button-revoke-session-${session.id}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-card-border px-2.5 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-50"
              >
                <ShieldOff className="h-3.5 w-3.5" />
                Revoke
              </button>
            )}
          </div>
          ))
        )}
      </SectionCard>
    </div>
  );
}

/**
 * Changing one's own password. Real, end to end: it calls `POST /api/auth/password`,
 * which verifies the current password server-side and revokes every other session the
 * account holds.
 *
 * A service caller has no password, so the card is not rendered for one — an input
 * that cannot succeed is worse than an absent input.
 */
function PasswordCard() {
  const { identity } = useAuth();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);

  const change = useMutation({
    mutationFn: () => changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      setError(null);
      toast({
        title: "Password changed",
        description: "Your other sessions have been signed out. This one stays open.",
      });
    },
    onError: (cause: unknown) => {
      // The server's message is shown as-is: it is either "Invalid credentials" or a
      // specific, non-revealing reason why the new password was refused.
      setError(cause instanceof Error ? cause.message : "The password could not be changed.");
    },
  });

  if (identity?.kind !== "user") return null;

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length > 0 && !mismatch && !change.isPending;

  return (
    <SectionCard
      title="Your password"
      description="Verified against a scrypt hash server-side. Changing it signs out every other browser you are signed in on."
      action={<LiveBadge />}
    >
      <form
        className="space-y-3 px-5 py-4"
        data-testid="form-change-password"
        onSubmit={(event) => {
          event.preventDefault();
          if (!ready) return;
          setError(null);
          change.mutate();
        }}
      >
        {[
          { id: "current-password", label: "Current password", value: current, set: setCurrent, autoComplete: "current-password" },
          { id: "new-password", label: "New password", value: next, set: setNext, autoComplete: "new-password" },
          { id: "confirm-password", label: "Confirm new password", value: confirm, set: setConfirm, autoComplete: "new-password" },
        ].map((field) => (
          <div key={field.id} className="space-y-1.5">
            <label htmlFor={field.id} className="text-xs font-medium text-muted-foreground">
              {field.label}
            </label>
            <input
              id={field.id}
              type="password"
              autoComplete={field.autoComplete}
              value={field.value}
              onChange={(event) => field.set(event.target.value)}
              className="h-10 w-full max-w-sm rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary"
              data-testid={`input-${field.id}`}
            />
          </div>
        ))}

        <p className="text-xs text-muted-foreground">
          At least 12 characters. Length is the only requirement — a passphrase of four
          ordinary words is stronger than a short password with symbols in it.
        </p>

        {mismatch && (
          <p className="text-xs text-destructive" data-testid="text-password-mismatch">
            The two new passwords do not match.
          </p>
        )}
        {error && (
          <p className="text-xs text-destructive" data-testid="text-password-error">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={!ready}
          className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-50"
          data-testid="button-change-password"
        >
          <Loader2
            className={cn("h-3.5 w-3.5 animate-spin", change.isPending ? "" : "hidden")}
            aria-hidden="true"
          />
          Change password
        </button>
      </form>
    </SectionCard>
  );
}

function SecurityTab() {
  /*
   * There were four toggles here — Enforce SSO, Two-factor, Block unapproved providers,
   * Session timeout — rendered as "Enabled"/"Disabled" pills behind a "Demo data" badge.
   * None of them was wired to anything, and three of them named a control Oathrion does not
   * have. A screen that reports "Enforce SSO: Enabled" while nothing enforces SSO is
   * worse than an absent screen, so they are gone rather than relabelled.
   *
   * What remains is what is actually enforced: server-side session revocation and the
   * password lifecycle. The role matrix is shown by the panel below, from `shared/roles`,
   * which is the same module the server checks against.
   */
  return (
    <div className="space-y-6">
      <SessionsPanel />
      <PasswordCard />
    </div>
  );
}

/**
 * The key inventory — real since P0-5.
 *
 * What was here before was three fabricated rows and a disabled "Create key — coming
 * soon" button, behind a "Demo data" badge. That is the pattern §15 forbids: a tab that
 * looks like a feature, is labelled as a feature, and does nothing. Every row below comes
 * from `GET /api/keys`, and every button performs the action it names.
 *
 * Two things this screen deliberately does NOT do:
 *
 *   - It never displays a credential except in the moment of creation. There is no "show
 *     key" affordance, because there is nothing to show: the server holds a digest.
 *   - It never offers to revoke a key managed in `OATHRION_API_KEYS`. The server would refuse
 *     nothing — an admin may revoke it — but the next restart re-adopts it from the
 *     environment, so the button would appear to work and then quietly undo itself. It is
 *     labelled as environment-managed instead, which is the truthful thing to say.
 */
function ApiKeysTab() {
  const { toast } = useToast();
  const { identity } = useAuth();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("operator");
  const [issued, setIssued] = useState<{ secret: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canManage = identity?.kind === "user" && identity.role === "admin";

  const keys = useQuery({
    queryKey: ["/api/keys"],
    queryFn: listApiKeys,
    // A viewer, or a machine caller, gets 403 from this route. Asking anyway would show
    // them an error where the honest answer is "this is not yours to see".
    enabled: canManage,
  });

  const create = useMutation({
    mutationFn: () => createApiKey({ name: name.trim(), role }),
    onSuccess: (result) => {
      setIssued({ secret: result.secret, name: result.key.name });
      setName("");
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
    },
    onError: (cause: unknown) =>
      setError(cause instanceof Error ? cause.message : "The key could not be issued."),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => revokeApiKey(id, "revoked from the console"),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      toast({
        title: result.alreadyRevoked ? "Key was already revoked" : "Key revoked",
        description: "Any request presenting it is refused from now on.",
      });
    },
    onError: (cause: unknown) =>
      toast({
        title: "Could not revoke the key",
        description: cause instanceof Error ? cause.message : undefined,
        variant: "destructive",
      }),
  });

  if (!canManage) {
    return (
      <SectionCard
        title="API keys"
        description="Machine credentials for agents and integrations."
      >
        <p className="px-5 py-6 text-sm text-muted-foreground" data-testid="text-keys-forbidden">
          Only an administrator signed in with a password can see or issue API keys. A
          machine credential cannot manage credentials — that would let a captured key
          issue itself a replacement and survive being rotated out.
        </p>
      </SectionCard>
    );
  }

  const rows = keys.data?.keys ?? [];

  return (
    <div className="space-y-4">
      {issued && (
        <SectionCard
          title="Copy this key now"
          description={`Issued for "${issued.name}". Only a hash is stored, so this is the last time it can be read — from anywhere, by anyone.`}
        >
          <div className="space-y-3 px-5 py-4">
            <div className="flex items-center gap-2">
              <code
                className="flex-1 overflow-x-auto rounded-lg border border-border bg-muted px-3 py-2 font-mono text-xs"
                data-testid="text-issued-secret"
              >
                {issued.secret}
              </code>
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(issued.secret);
                    toast({ title: "Key copied" });
                  } catch {
                    toast({ title: "Could not copy — select it and copy manually", variant: "destructive" });
                  }
                }}
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-card-border bg-background px-3 text-xs font-medium"
                data-testid="button-copy-issued-secret"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
              </button>
            </div>
            <button
              onClick={() => setIssued(null)}
              className="text-xs text-muted-foreground underline"
              data-testid="button-dismiss-issued-secret"
            >
              I have stored it — hide this
            </button>
          </div>
        </SectionCard>
      )}

      <SectionCard
        title="Issue a key"
        description="The role is the one the key acts with. Give it the narrowest role that lets the integration do its job."
        action={<LiveBadge />}
      >
        <form
          className="flex flex-wrap items-end gap-3 px-5 py-4"
          data-testid="form-create-key"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || create.isPending) return;
            setError(null);
            create.mutate();
          }}
        >
          <div className="space-y-1.5">
            <label htmlFor="key-name" className="text-xs font-medium text-muted-foreground">
              What will use it
            </label>
            <input
              id="key-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="CI policy checks"
              className="h-10 w-64 rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary"
              data-testid="input-key-name"
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="key-role" className="text-xs font-medium text-muted-foreground">
              Role
            </label>
            <select
              id="key-role"
              value={role}
              onChange={(event) => setRole(event.target.value as Role)}
              className="h-10 w-40 rounded-lg border border-border bg-card px-3 text-sm outline-none transition-colors focus:border-primary"
              data-testid="select-key-role"
            >
              {(["viewer", "operator", "approver", "admin"] as const).map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={!name.trim() || create.isPending}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground disabled:opacity-50"
            data-testid="button-create-key"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden /> Issue key
          </button>
          {error && (
            <p className="w-full text-xs text-destructive" data-testid="text-key-error">
              {error}
            </p>
          )}
        </form>
      </SectionCard>

      <SectionCard
        title="Keys"
        description="Revoked and expired keys are kept: the audit log names them as the actor of past decisions."
        action={<LiveBadge />}
      >
        {keys.isLoading ? (
          <p className="px-5 py-6 text-sm text-muted-foreground">Loading keys…</p>
        ) : keys.isError ? (
          <p className="px-5 py-6 text-sm text-destructive" data-testid="text-keys-error">
            The key inventory could not be loaded.
          </p>
        ) : rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted-foreground" data-testid="text-keys-empty">
            No keys yet. Issue one above, or configure OATHRION_API_KEYS on the server.
          </p>
        ) : (
          <div className="divide-y divide-border">
            {rows.map((k) => (
              <div key={k.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5" data-testid={`row-key-${k.id}`}>
                <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{k.name}</p>
                  <code className="font-mono text-xs text-muted-foreground">
                    {k.prefix === "env:" ? "managed in OATHRION_API_KEYS" : `${k.prefix}••••••••`}
                  </code>
                </div>
                <Pill tone="neutral">{k.role}</Pill>
                <Pill tone={k.status === "active" ? "success" : k.status === "revoked" ? "danger" : "warning"}>
                  {k.status}
                </Pill>
                <span className="w-40 text-right text-xs text-muted-foreground">
                  {k.lastUsedAt ? `used ${new Date(k.lastUsedAt).toLocaleString()}` : "never used"}
                </span>
                {k.status === "active" && k.source === "user" ? (
                  <button
                    onClick={() => revoke.mutate(k.id)}
                    disabled={revoke.isPending}
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-card-border bg-background px-2.5 text-xs font-medium text-destructive disabled:opacity-50"
                    data-testid={`button-revoke-key-${k.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" aria-hidden /> Revoke
                  </button>
                ) : (
                  <span className="w-[5.5rem] text-right text-xs text-muted-foreground">
                    {k.source === "config" ? "environment" : "—"}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </SectionCard>
    </div>
  );
}

function BillingTab() {
  const { agents, executions, policies, approvals } = useARIA();

  const rows = useMemo(() => {
    const metrics = computeDashboardMetrics({ agents, executions, policies, approvals });
    const spend = executions.reduce((sum, e) => sum + (e.cost || 0), 0);
    return [
      {
        label: "Agent executions",
        value: String(executions.length),
        unit: `${executionsInWindow(executions)} in the last 24 h`,
      },
      { label: "Provider spend passed through", value: currency(spend), unit: "at cost, from the ledger" },
      {
        label: "Policy evaluations",
        value: String(executions.length),
        unit: `${metrics.enabledPolicies} policies enabled`,
      },
      {
        label: "Audit coverage",
        value: `${Math.round(metrics.auditCoverage)}%`,
        unit: "executions carrying a full trail",
      },
    ];
  }, [agents, executions, policies, approvals]);

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <SectionCard title="Usage" description="Counted from the execution ledger." action={<LiveBadge />} bodyClassName="divide-y divide-card-border">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between px-5 py-4">
            <div>
              <p className="text-sm font-medium">{r.label}</p>
              <p className="text-xs text-muted-foreground">{r.unit}</p>
            </div>
            <span className="tabular text-sm font-medium">{r.value}</span>
          </div>
        ))}
      </SectionCard>
      <Surface className="p-5">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Billing
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Oathrion does not meter or invoice. The figures on the left are the raw counters an
          operator can reconcile against their provider bills, and they are read from the
          execution ledger — nothing here is an estimate.
        </p>
      </Surface>
    </div>
  );
}

function AuditTab() {
  const { executions } = useARIA();
  const entries = executions.slice(0, 12);
  return (
    <SectionCard
      title="Audit log"
      description="Hash-chained record of every decision made by the control plane. Tamper-evident within each execution trail; not anchored outside this deployment."
      action={<LiveBadge />}
      bodyClassName="divide-y divide-card-border"
    >
      {entries.map((e) => (
        <div key={e.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5">
          <span className="tabular text-xs text-muted-foreground">{fullDate(e.timestamp)}</span>
          <span className="font-mono text-xs">decision.{e.decision}</span>
          <span className="text-sm">{e.agentName}</span>
          <span className="text-sm text-muted-foreground">{e.action}</span>
          <code className="ml-auto rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground">
            {e.id}
          </code>
        </div>
      ))}
    </SectionCard>
  );
}
