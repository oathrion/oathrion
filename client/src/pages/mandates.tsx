/**
 * « Mandates » — ce que les agents peuvent faire au nom de l'organisation, signé par les personnes
 * qui peuvent l'autoriser, et vérifié par la contrepartie avant qu'elle exécute
 * (`notes/CONCEPTION-MANDAT.md`, étape M2).
 *
 * Chaque personne a SA clé de signature, créée dans son navigateur et non exportable
 * (`lib/signing-key.ts`) : signer un mandat, c'est signer sa forme canonique ici même ; le serveur
 * ne reçoit que la signature, et la vérifie. Il ne peut pas signer à la place de quelqu'un.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Download, FileSignature, KeyRound, Plus, ShieldCheck, ShieldX } from "lucide-react";

import { EmptyState, ErrorState, PageHeader, Surface, TableSkeleton } from "@/components/common/primitives";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { relativeTime } from "@/lib/format";
import { createMandate, getMandateReceipts, listMandates, listMembers, registerSigningKey, revokeMandate, signMandate, type MandateView } from "@/lib/api";
import { describeGrant } from "@/lib/mandate-text";
import { browserPublicKey, createSigningKey, ed25519Supported, signCanonical } from "@/lib/signing-key";
import { useARIA } from "@/lib/store";

const STATE: Record<MandateView["state"], { label: string; tone: string }> = {
  pending: { label: "Waiting for signatures", tone: "bg-warning-soft text-warning" },
  active: { label: "In force", tone: "bg-success-soft text-success" },
  revoked: { label: "Revoked", tone: "bg-danger-soft text-danger" },
  expired: { label: "Expired", tone: "bg-muted text-muted-foreground" },
};

function download(name: string, body: string) {
  const url = URL.createObjectURL(new Blob([body], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

/** La clé de signature de la personne : dans CE navigateur, et enregistrée chez Oathrion. */
function SigningKey({ me, registered }: { me: string; registered: string | null }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const local = useQuery({ queryKey: ["signing-key", me], queryFn: () => browserPublicKey(me) });
  const setup = useMutation({
    mutationFn: async () => registerSigningKey(await createSigningKey(me)),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["signing-key", me] });
      void client.invalidateQueries({ queryKey: ["/api/mandates"] });
      toast({ title: "Your signing key is ready", description: "It lives in this browser only, and cannot be copied out of it." });
    },
    onError: (error) => toast({ title: "The key could not be created", description: error instanceof Error ? error.message : String(error), variant: "destructive" }),
  });
  if (!ed25519Supported()) {
    return <Surface className="p-5 text-[14px] text-muted-foreground">This browser cannot hold a signing key. Use a recent Chrome, Edge, Firefox or Safari to sign mandates.</Surface>;
  }
  const ready = local.data !== null && local.data !== undefined && local.data === registered;
  return (
    <Surface className="flex flex-wrap items-center gap-4 p-5" data-testid="signing-key">
      <span className={`flex h-10 w-10 items-center justify-center rounded-full ${ready ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`} aria-hidden>
        <KeyRound className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-[15px] font-medium">{ready ? "Your signing key is in this browser." : registered ? "This browser does not hold your signing key." : "You have no signing key yet."}</p>
        <p className="text-[13px] text-muted-foreground">
          {ready
            ? "When you sign a mandate, it is signed here. Oathrion only receives the signature, and cannot sign in your name."
            : "Created in this browser and impossible to copy out of it. Only its public half goes to Oathrion."}
        </p>
      </div>
      {!ready && (
        <button
          type="button"
          disabled={setup.isPending}
          onClick={() => setup.mutate()}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[14px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
        >
          <KeyRound className="h-4 w-4" aria-hidden /> {registered ? "Set up a new key here" : "Set up my signing key"}
        </button>
      )}
    </Surface>
  );
}

/**
 * Les reçus contresignés du mandat (étape M4) : combien la contrepartie a exécutés ou refusés, la
 * chaîne relue, et le téléchargement — chaque reçu porte le mandat, l'autorisation de
 * l'organisation et la signature de la contrepartie, et se vérifie sans Oathrion.
 */
function Receipts({ view }: { view: MandateView }) {
  const { data } = useQuery({ queryKey: ["/api/mandates", view.id, "receipts"], queryFn: () => getMandateReceipts(view.id) });
  if (!data || data.receipts.length === 0) return null;
  const executed = data.receipts.filter((r) => r.countersigned.statement.outcome === "executed").length;
  return (
    <div className="mx-6 mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-card-border px-4 py-3 text-[13px]" data-testid={`receipts-${view.id}`}>
      <p>
        <span className="font-medium">{data.receipts.length} countersigned receipt{data.receipts.length > 1 ? "s" : ""}</span>
        <span className="text-muted-foreground">
          {" "}
          · {executed} executed · {data.receipts.length - executed} refused by the counterparty ·{" "}
        </span>
        {data.chain.ok ? <span className="text-success">chain intact</span> : <span className="font-medium text-danger">chain broken — {data.chain.reason}</span>}
      </p>
      <button
        type="button"
        onClick={() => download(`${view.signed.mandate.id}-receipts.json`, JSON.stringify(data.receipts.map((r) => ({ mandate: view.signed, grant: r.grant, countersigned: r.countersigned })), null, 2))}
        className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium hover:bg-muted"
      >
        <Download className="h-4 w-4" aria-hidden /> Receipts
      </button>
    </div>
  );
}

function MandateCard({ view, me, canApprove, members }: { view: MandateView; me: string; canApprove: boolean; members: Map<string, string> }) {
  const client = useQueryClient();
  const { toast } = useToast();
  const { mandate } = view.signed;
  const state = STATE[view.state];
  const mine = mandate.approval.of.find((s) => s.id === me);
  const done = (title: string) => () => {
    void client.invalidateQueries({ queryKey: ["/api/mandates"] });
    toast({ title });
  };
  const failed = (error: unknown) => toast({ title: "Not done", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
  const sign = useMutation({ mutationFn: async () => signMandate(view.id, await signCanonical(me, mandate)), onSuccess: done("Signed"), onError: failed });
  const revoke = useMutation({ mutationFn: () => revokeMandate(view.id), onSuccess: done("Revoked — counterparties will refuse it"), onError: failed });
  return (
    <Surface className="overflow-hidden" data-testid={`mandate-${view.id}`}>
      <div className="flex flex-wrap items-start gap-4 px-6 pt-6">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary" aria-hidden>
          <FileSignature className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-muted-foreground">
            {mandate.id} · until {new Date(mandate.validity.notAfter).toLocaleDateString()} · created {relativeTime(view.createdAt)}
          </p>
          <h2 className="mt-0.5 text-[19px] font-semibold tracking-[-0.02em]">{mandate.agent.name} may act on your behalf</h2>
        </div>
        <span className={`rounded-full px-2.5 py-1 text-[12px] font-medium ${state.tone}`}>
          {state.label}
          {view.state === "pending" ? ` · ${String(view.signedBy.length)}/${String(view.required)}` : ""}
        </span>
      </div>
      <ul className="mx-6 mt-4 space-y-1.5 rounded-xl bg-muted/60 px-4 py-3 text-[14px]">
        {mandate.grants.map((grant, index) => (
          <li key={index}>{describeGrant(grant)}</li>
        ))}
      </ul>
      <div className="mx-6 mt-4 flex flex-wrap gap-2">
        {mandate.approval.of.map((signer) => {
          const signed = view.signedBy.includes(signer.id);
          return (
            <span key={signer.id} className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] ${signed ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>
              {signed ? <Check className="h-3.5 w-3.5" aria-hidden /> : null}
              {members.get(signer.id) ?? signer.id}
              {signer.role ? ` · ${signer.role}` : ""}
            </span>
          );
        })}
        <span className="text-[12px] text-muted-foreground">
          {String(view.required)} of {String(mandate.approval.of.length)} signatures needed
        </span>
      </div>
      <Receipts view={view} />
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-card-border bg-muted/30 px-6 py-4">
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          {view.state === "revoked" ? <ShieldX className="h-4 w-4 text-danger" aria-hidden /> : <ShieldCheck className="h-4 w-4 text-success" aria-hidden />}
          {view.state === "revoked" ? `Revoked ${view.revokedAt ? relativeTime(view.revokedAt) : ""}: counterparties refuse it.` : "Checked by the counterparty before it executes."}
        </p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => download(`${mandate.id}.json`, JSON.stringify(view.signed, null, 2))}
            className="inline-flex h-9 items-center gap-1.5 rounded-full px-4 text-[14px] font-medium hover:bg-muted"
          >
            <Download className="h-4 w-4" aria-hidden /> For the agent
          </button>
          {canApprove && view.state !== "revoked" && view.state !== "expired" && (
            <button
              type="button"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
              className="inline-flex h-9 items-center rounded-full px-4 text-[14px] font-medium text-danger hover:bg-danger-soft disabled:opacity-60"
            >
              Revoke
            </button>
          )}
          {mine && view.state === "pending" && !view.signedBy.includes(me) && (
            <button
              type="button"
              disabled={sign.isPending}
              onClick={() => sign.mutate()}
              className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
            >
              <FileSignature className="h-4 w-4" aria-hidden /> Sign
            </button>
          )}
        </div>
      </div>
    </Surface>
  );
}

/** Créer un mandat : l'agent, sa clé publique, ce qu'il peut faire, et qui doit signer. */
function CreateMandate({ members, onDone }: { members: { id: string; name: string }[]; onDone: () => void }) {
  const { agents } = useARIA();
  const { toast } = useToast();
  const [form, setForm] = useState({
    agentId: "",
    publicKey: "",
    action: "payment.transfer",
    maxAmount: "5000",
    currency: "EUR",
    periodCap: "",
    beneficiaries: "",
    purpose: "",
    days: "90",
    signers: [] as string[],
    required: "1",
  });
  const set = (key: keyof typeof form) => (event: { target: { value: string } }) => setForm({ ...form, [key]: event.target.value });
  const create = useMutation({
    mutationFn: () => {
      const agent = agents.find((a) => a.id === form.agentId);
      const amount = (value: string) => (value.trim() === "" ? undefined : { value: Number(value), currency: form.currency.trim().toUpperCase() });
      return createMandate({
        agent: { id: form.agentId, name: agent?.name ?? form.agentId, publicKey: form.publicKey.trim() },
        grants: [
          {
            actions: [form.action.trim()],
            constraints: {
              ...(amount(form.maxAmount) ? { maxAmount: amount(form.maxAmount) } : {}),
              ...(amount(form.periodCap) ? { periodCap: { ...amount(form.periodCap)!, period: "P1M" as const } } : {}),
              ...(form.beneficiaries.trim() ? { beneficiaries: form.beneficiaries.split(",").map((b) => b.trim()).filter(Boolean) } : {}),
              ...(form.purpose.trim() ? { purpose: form.purpose.trim() } : {}),
            },
          },
        ],
        notBefore: new Date().toISOString(),
        notAfter: new Date(Date.now() + Number(form.days) * 86_400_000).toISOString(),
        required: Number(form.required),
        signers: form.signers.map((userId) => ({ userId })),
      });
    },
    onSuccess: () => {
      toast({ title: "Mandate created", description: "It is in force once enough people have signed it." });
      onDone();
    },
    onError: (error) => toast({ title: "Not created", description: error instanceof Error ? error.message : String(error), variant: "destructive" }),
  });
  const field = "h-9 w-full rounded-lg border border-input bg-background px-3 text-[14px]";
  const label = "space-y-1 text-[13px] text-muted-foreground";
  return (
    <Surface className="space-y-4 p-6" data-testid="create-mandate">
      <h2 className="text-[17px] font-semibold">A new mandate</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={label}>
          Agent
          <select value={form.agentId} onChange={set("agentId")} className={field}>
            <option value="">Choose…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          The agent's public key (it keeps the private one)
          <input value={form.publicKey} onChange={set("publicKey")} placeholder="32 bytes, base64" className={`${field} font-mono`} />
        </label>
        <label className={label}>
          Action
          <input value={form.action} onChange={set("action")} className={`${field} font-mono`} />
        </label>
        <div className="grid grid-cols-[1fr_5rem] gap-2">
          <label className={label}>
            At most, each time
            <input value={form.maxAmount} onChange={set("maxAmount")} inputMode="decimal" className={field} />
          </label>
          <label className={label}>
            Currency
            <input value={form.currency} onChange={set("currency")} className={field} />
          </label>
        </div>
        <label className={label}>
          At most, per 30 days (optional)
          <input value={form.periodCap} onChange={set("periodCap")} inputMode="decimal" className={field} />
        </label>
        <label className={label}>
          Only to (optional, comma-separated)
          <input value={form.beneficiaries} onChange={set("beneficiaries")} className={field} />
        </label>
        <label className={label}>
          Only for (optional)
          <input value={form.purpose} onChange={set("purpose")} placeholder="supplier invoices" className={field} />
        </label>
        <label className={label}>
          In force for (days)
          <input value={form.days} onChange={set("days")} inputMode="numeric" className={field} />
        </label>
      </div>
      <fieldset className="space-y-2">
        <legend className="text-[13px] text-muted-foreground">Who must sign</legend>
        <div className="flex flex-wrap gap-2">
          {members.map((m) => {
            const on = form.signers.includes(m.id);
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => setForm({ ...form, signers: on ? form.signers.filter((s) => s !== m.id) : [...form.signers, m.id] })}
                className={`rounded-full px-3 py-1 text-[13px] ${on ? "bg-primary text-primary-foreground" : "bg-muted"}`}
              >
                {m.name}
              </button>
            );
          })}
        </div>
        <label className="flex items-center gap-2 text-[13px] text-muted-foreground">
          Signatures needed
          <input value={form.required} onChange={set("required")} inputMode="numeric" className="h-8 w-16 rounded-lg border border-input bg-background px-2 text-[14px]" />
          of {form.signers.length}
        </label>
      </fieldset>
      <div className="flex justify-end">
        <button
          type="button"
          disabled={create.isPending || !form.agentId || form.signers.length === 0}
          onClick={() => create.mutate()}
          className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-5 text-[14px] font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Create, then collect the signatures
        </button>
      </div>
    </Surface>
  );
}

export default function MandatesPage() {
  const { can } = useAuth();
  const client = useQueryClient();
  const [creating, setCreating] = useState(false);
  const { data, isLoading, isError, error, refetch } = useQuery({ queryKey: ["/api/mandates"], queryFn: listMandates });
  const team = useQuery({ queryKey: ["/api/members"], queryFn: listMembers });
  const members = useMemo(() => new Map((team.data?.members ?? []).map((m) => [m.id, m.name])), [team.data]);
  if (isError) return <ErrorState message={error instanceof Error ? error.message : "The mandates could not be read."} onRetry={() => void refetch()} />;
  return (
    <div className="space-y-6">
      <PageHeader
        title="Mandates"
        subtitle="What your agents may do on your behalf, signed by the people who can authorize it, and checked by the counterparty before it executes."
        actions={
          can("manage") && !creating ? (
            <button type="button" onClick={() => setCreating(true)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-[14px] font-semibold text-primary-foreground hover:bg-primary/90">
              <Plus className="h-4 w-4" aria-hidden /> New mandate
            </button>
          ) : undefined
        }
      />
      {isLoading || !data ? (
        <TableSkeleton rows={3} cols={2} />
      ) : (
        <>
          <SigningKey me={data.me} registered={data.signingKey} />
          {creating && (
            <CreateMandate
              members={(team.data?.members ?? []).map((m) => ({ id: m.id, name: m.name }))}
              onDone={() => {
                setCreating(false);
                void client.invalidateQueries({ queryKey: ["/api/mandates"] });
              }}
            />
          )}
          {data.mandates.length === 0 && !creating ? (
            <Surface>
              <EmptyState
                icon={FileSignature}
                title="No mandate yet"
                description="A mandate lets an agent act on your behalf — a payment, a refund, a filing — within limits that people sign, and that the counterparty checks."
              />
            </Surface>
          ) : (
            data.mandates.map((view) => <MandateCard key={view.id} view={view} me={data.me} canApprove={can("approve")} members={members} />)
          )}
        </>
      )}
    </div>
  );
}
