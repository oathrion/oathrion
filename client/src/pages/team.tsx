/**
 * « Votre équipe » — le chemin d'un développeur qui gouverne SES agents (`oathrion wrap`) vers
 * son équipe. Dit ce que la version équipe ajoute, ce qui n'existe pas encore, et comment entrer
 * dans le programme pilote fondateur (`client/site/pages/pricing.tsx` : pas de grille de prix,
 * un prix convenu par pilote).
 *
 * Rien n'est envoyé d'ici : les boutons ouvrent un e-mail ou un ticket que la personne écrit.
 */
import { FileCheck2, KeyRound, Landmark, MessageSquare, Network, ShieldCheck, Smartphone, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { PageHeader, Surface } from "@/components/common/primitives";
import { CONTACT_EMAIL, REPOSITORY_URL, contactReady } from "@shared/contact";

const ADDS: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: Network, title: "One Oathrion for the whole team", text: "Everyone's agents go through the same Oathrion: one receipt chain, the same rules for all." },
  { icon: Smartphone, title: "Approve from Slack", text: "The request arrives in Slack with its Approve and Reject buttons, signed: decide from your phone." },
  { icon: Users, title: "Several approvers, roles", text: "Viewer, operator, approver, administrator: who sees what, who decides what." },
  { icon: KeyRound, title: "Company sign-in (SSO)", text: "OpenID Connect: your accounts, your leavers, no extra password." },
  { icon: ShieldCheck, title: "Verified connectors", text: "GitHub, Slack, Linear, Stripe: every token verified with the provider and kept sealed, never seen by the agent." },
  { icon: ShieldCheck, title: "An agent that can neither approve itself nor go around", text: "The approver is another person, on another machine; tokens sit in Oathrion's vault, not on the agent's machine." },
  { icon: FileCheck2, title: "Proof for your auditor, insurer or bank", text: "One signed receipt chain for the organization: hand over what your agents did, and who allowed it, for anyone to verify without trusting you." },
  { icon: Landmark, title: "Mandates for agents that pay", text: "Two people sign what an agent may pay; each payment gets its own authorization, and your bank can verify it itself. Oathrion never touches the money." },
];

export default function TeamPage() {
  const ready = contactReady();
  const pilotMail = `mailto:${CONTACT_EMAIL}?${new URLSearchParams({
    subject: "Oathrion pilot for my team",
    body: "Hello,\n\nWe are a team of … people, with … agents.\nWhat our agents act on (code, customers, payments…):\nWho should approve, and who will ask us for proof:\n\nThanks!",
  }).toString().replace(/\+/g, "%20")}`;

  return (
    <div className="space-y-6">
      <PageHeader title="Your team" subtitle="You govern your agents. Your team can govern theirs, with the same rules and a single proof." />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="What the team version adds">
        {ADDS.map(({ icon: Icon, title, text }) => (
          <Surface key={title} className="space-y-2 p-4">
            <Icon className="h-4 w-4 text-primary" aria-hidden="true" />
            <p className="text-sm font-medium">{title}</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{text}</p>
          </Surface>
        ))}
      </section>

      <Surface className="space-y-3 p-5" data-testid="team-pilot">
        <p className="text-sm font-medium">The founding pilot programme</p>
        <p className="text-sm leading-relaxed text-muted-foreground">
          Four weeks, with us, on your own infrastructure (PostgreSQL): there is no hosted service yet. Your rules, approvals
          by the people you choose, and at the end a written review and the receipts you choose to hand over. A fixed price,
          deducted from your first year if you continue: a pilot checks that Oathrion holds up for you before any talk of a
          subscription.
        </p>
        {ready ? (
          <div className="flex flex-wrap gap-2">
            <a href={pilotMail} className="inline-flex h-9 items-center rounded-lg bg-primary px-3.5 text-sm font-medium text-primary-foreground hover:bg-primary/90" data-testid="link-pilot-mail">
              Ask for a pilot for my team
            </a>
            <a href={`${REPOSITORY_URL}/issues/new?labels=feedback`} target="_blank" rel="noreferrer" className="inline-flex h-9 items-center gap-2 rounded-lg border border-border px-3.5 text-sm font-medium hover:border-primary">
              <MessageSquare className="h-4 w-4" aria-hidden="true" />
              Give feedback
            </a>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">The contact address will open at publication.</p>
        )}
      </Surface>
    </div>
  );
}
