/**
 * `/roadmap` — l'état réel du dépôt, pas une liste de souhaits.
 *
 * « Livré » signifie : mesuré par une commande citée. « En cours » signifie : commencé.
 * « Prévu » signifie : décidé, pas commencé. Rien n'est daté, parce qu'une date inventée
 * est la plus facile des promesses à ne pas tenir.
 */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

const SHIPPED = [
  "Authorization plane: identity, policy, mandate, risk, decision, approval, execution, audit",
  "Single-use grants, exactly once — proven across operating-system processes",
  "Hash-chained receipts, verifiable by the tenant over HTTP",
  "Multi-tenant isolation, tested adversarially with a fully privileged attacker",
  "MCP gateway, inbound and outbound, revision 2026-07-28",
  "Per-tenant currency with integer minor units — XOF and XAF distinct",
  "Fail-closed on database loss, recovery without restart",
  "Boot refuses 41 dangerous configurations, naming the variable",
  "Deployment kit: Docker Compose, TLS, read-only rootfs, one-shot migration",
  "Backup, restore, and restore onto a different machine",
  "Metrics endpoint and an on-call page with four alert signals",
  "Conformance kit: 21 core properties, 25 mutants, MIT licensed",
  "Native connectors GitHub, Slack, Linear — real calls, governed by the same gateway; tested end to end against simulated services, not yet against real accounts",
  "Guided start in the browser: a one-time link creates the workspace, five steps to a real governed action",
  "Tenant export and permanent tenant purge; OIDC single sign-on",
];

const PROGRESS = [
  "Nine conformance properties still lack a targeted mutant — they are verified, not proven",
  "A public TLS certificate has never been obtained end to end (it needs a real DNS name)",
  "Sustained-load testing beyond twelve minutes",
];

const PLANNED = [
  "Tenant administration API — creation, currency, suspension, without a restart",
  "Erasure of one person's data inside a tenant — tenant export and purge exist today",
  "An external anchor for receipt chains, so the trace becomes provable to a third party",
  "A persisted chain head per tenant, closing end-of-chain truncation",
  "Capacity beyond a single instance — today the identity plane serialises by design",
  "SAML, billing, and metered counters an invoice can stand on",
  "One-click GitHub App installation — today GitHub connects with a fine-grained token",
];

function Column({ title, note, items, tone }: { title: string; note: string; items: readonly string[]; tone: "ok" | "now" | "next" }): JSX.Element {
  return (
    <div className="card" style={{ gap: "var(--s-4)" }}>
      <div className="stack-2">
        <span className={`chip ${tone === "ok" ? "chip--allow" : tone === "now" ? "chip--hold" : ""}`}><i />{title}</span>
        <p className="micro">{note}</p>
      </div>
      <ul className="list">{items.map((item) => <li key={item}>{item}</li>)}</ul>
    </div>
  );
}

export default function RoadmapPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* une sequence qui avance, dont la fin n'est pas visible */}
        <Backdrop src="/img/horizon.jpg" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Roadmap</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">What is built, what is not, and nothing dated.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                A date we invented would be the easiest promise to break. This is the real state
                of the repository: delivered means measured by a command, planned means decided
                and not started.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="grid grid--3">
          <Reveal><Column title="DELIVERED" note="Measured by a command in the repository" items={SHIPPED} tone="ok" /></Reveal>
          <Reveal delay={70}><Column title="IN PROGRESS" note="Started, and honestly incomplete" items={PROGRESS} tone="now" /></Reveal>
          <Reveal delay={140}><Column title="PLANNED" note="Decided, not started" items={PLANNED} tone="next" /></Reveal>
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">Pilots move this list.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              The planned column is ordered by what we believe matters. A pilot that needs
              erasure before capacity will reorder it, and that is the point of running one.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="row">
              <CTA href="/pilot" from="roadmap" large>Become a Pilot</CTA>
              <CTA href="/waitlist" from="roadmap" variant="ghost" large>Follow along</CTA>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
