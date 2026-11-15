/**
 * Un mandat, dit en une phrase : ce que l'agent peut faire, dans quelles limites. C'est ce que lit
 * la personne qui va le signer — elle doit comprendre ce qu'elle délègue, pas le JSON.
 */
import type { Mandate, MandateGrant } from "@shared/mandate";

const PERIOD: Record<string, string> = { P1D: "per day", P7D: "per 7 days", P1M: "per 30 days" };
const money = (m: { value: number; currency: string }) => `${m.value.toLocaleString("en-US")} ${m.currency}`;

export function describeGrant(grant: MandateGrant): string {
  const c = grant.constraints ?? {};
  return [
    grant.actions.join(", "),
    c.maxAmount ? `up to ${money(c.maxAmount)} each` : null,
    c.periodCap ? `up to ${money(c.periodCap)} ${PERIOD[c.periodCap.period] ?? c.periodCap.period}` : null,
    c.beneficiaries ? `to ${c.beneficiaries.length === 1 ? "1 beneficiary" : `${String(c.beneficiaries.length)} beneficiaries`}` : null,
    c.purpose ? `for « ${c.purpose} »` : null,
    grant.destinations ? `at ${grant.destinations.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function describeMandate(mandate: Mandate): string {
  return `${mandate.agent.name} may ${mandate.grants.map(describeGrant).join("; or ")}.`;
}
