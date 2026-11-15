/**
 * Un passage de réconciliation — le même pour le bouton de la console et pour la tâche
 * périodique, pour qu'ils ne puissent pas dire deux choses différentes.
 *
 * Le connecteur liste ce que le service a enregistré depuis la connexion de l'outil ; ce
 * module classe (via Oathrion / marque inconnue / hors Oathrion / autre auteur), garde le
 * passage, garde chaque écriture problématique une seule fois, et rend celles qui sont
 * NOUVELLES — les seules qui donnent lieu à une alerte.
 */
import type { Policy } from "@shared/types";
import type { EmitInput } from "../notifications";
import { readSelection } from "./guardrails";
import type { ConnectorPlane } from "./index";
import type { FindingCategory, StoredFinding } from "./reconcile-store";
import type { Connector, ReconcileItem } from "./types";

export interface ReconcileReportBody {
  ok: true;
  connector: string;
  trigger: "manual" | "auto";
  since: string;
  until: string;
  identity: string;
  resources: string[];
  scanned: number;
  viaOathrion: number;
  outside: ReconcileItem[];
  unknownMarker: ReconcileItem[];
  others: number;
  truncated: boolean;
  verdict: "clean" | "alert" | "partial";
  limits: string[];
}

export type ReconcileOutcome =
  | { ok: true; report: ReconcileReportBody; fresh: StoredFinding[] }
  | { ok: false; status: number; code: string; detail: string };

export async function reconcileOnce(input: {
  connector: Connector;
  plane: ConnectorPlane;
  policies: Policy[];
  executionExists: (executionId: string) => Promise<boolean>;
  trigger: "manual" | "auto";
  now?: Date;
}): Promise<ReconcileOutcome> {
  const { connector, plane } = input;
  const now = input.now ?? new Date();
  if (!connector.reconcile) {
    return { ok: false, status: 422, code: "reconcile_unsupported", detail: `Reconciliation is not available yet for ${connector.label}.` };
  }
  const context = plane.contextFor(connector.id);
  const status = await plane.vault.describe(connector.id);
  if (!context || !status || status.state === "revoked" || !status.connectedAt) {
    return { ok: false, status: 422, code: "connector_not_connected", detail: `${connector.label} is not connected: there is nothing to reconcile.` };
  }
  /* La fenêtre commence à la connexion : avant, tout était hors Oathrion par construction. */
  const since = status.connectedAt;
  const resources = readSelection(connector.id, input.policies).resources ?? [];
  const listing = await connector.reconcile(context, { since, resources });
  if (!listing.ok) {
    await plane.reconciliations.recordRun(connector.id, {
      ranAt: now.toISOString(), trigger: input.trigger, ok: false, verdict: "failed", since, identity: "",
      scanned: 0, viaOathrion: 0, outsideCount: 0, unknownCount: 0, others: 0, truncated: false, detail: listing.detail,
    });
    return { ok: false, status: 502, code: listing.code, detail: listing.detail };
  }

  const viaOathrion: ReconcileItem[] = [];
  const unknownMarker: ReconcileItem[] = [];
  const outside: ReconcileItem[] = [];
  let others = 0;
  for (const item of listing.items) {
    if (item.marker) {
      if (await input.executionExists(item.marker)) viaOathrion.push(item);
      else unknownMarker.push(item);
    } else if (item.byOathrionIdentity) {
      outside.push(item);
    } else {
      others += 1;
    }
  }
  const verdict = outside.length > 0 || unknownMarker.length > 0 ? "alert" : listing.truncated ? "partial" : "clean";

  const flagged: { item: ReconcileItem; category: FindingCategory }[] = [
    ...outside.map((item) => ({ item, category: "outside" as const })),
    ...unknownMarker.map((item) => ({ item, category: "unknown_marker" as const })),
  ];
  const fresh = await plane.reconciliations.addFindings(connector.id, flagged, now);
  await plane.reconciliations.recordRun(connector.id, {
    ranAt: now.toISOString(), trigger: input.trigger, ok: true, verdict, since, identity: listing.identity,
    scanned: listing.items.length, viaOathrion: viaOathrion.length, outsideCount: outside.length,
    unknownCount: unknownMarker.length, others, truncated: listing.truncated, detail: "",
  });

  return {
    ok: true,
    fresh,
    report: {
      ok: true,
      connector: connector.id,
      trigger: input.trigger,
      since,
      until: now.toISOString(),
      identity: listing.identity,
      resources,
      scanned: listing.items.length,
      viaOathrion: viaOathrion.length,
      outside,
      unknownMarker,
      others,
      truncated: listing.truncated,
      verdict,
      limits: listing.limits,
    },
  };
}

/**
 * L'alerte pour les écritures NOUVELLES d'un passage. L'événement nomme l'organisation :
 * les canaux (webhook, Slack) sont ceux de l'exploitant, et un exploitant de plusieurs
 * locataires doit savoir lequel est concerné.
 */
export function reconcileAlert(organizationId: string, organizationName: string, connector: Connector, fresh: StoredFinding[]): EmitInput {
  const lines = fresh.slice(0, 10).map((f) => {
    const what = f.category === "unknown_marker" ? "unknown Oathrion marker" : "outside Oathrion";
    return `• ${f.id} — ${f.summary} (${what}${f.actor ? `, by ${f.actor}` : ""})${f.url ? ` ${f.url}` : ""}`;
  });
  if (fresh.length > 10) lines.push(`… and ${String(fresh.length - 10)} more.`);
  return {
    type: "reconciliation.alert",
    title: `Oathrion — ${String(fresh.length)} write(s) made outside Oathrion on ${connector.label} (${organizationName})`,
    summary: lines.join("\n"),
    risk: "high",
    agentId: "",
    agentName: "",
    executionId: null,
    approvalId: null,
    policyId: null,
    policyName: null,
    data: {
      organizationId,
      organizationName,
      connector: connector.id,
      findings: fresh.map((f) => ({ id: f.id, kind: f.kind, category: f.category, url: f.url, summary: f.summary, actor: f.actor, createdAt: f.createdAt })),
    },
  };
}
