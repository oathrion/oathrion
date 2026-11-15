/** `/use-cases` — elle répond à : **est-ce utile pour moi ?** */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

const CASES = [
  { t: "AI startups", d: "Your agent touches customer money or customer data, and your buyer asks who approves what. A control plane is the answer that survives the security review.", need: "A ceiling that holds, and a trail you can show." },
  { t: "Autonomous agents", d: "Long-running agents that act without a person watching. The question is not whether they will do something unexpected; it is what happens when they do.", need: "Deny by default, and a human above a threshold." },
  { t: "Enterprise AI", d: "Agents deployed across several internal systems, each with its own credentials. One place to say what each agent may do, instead of a policy per integration.", need: "One authority, many destinations." },
  { t: "Fintech and payments", d: "Movement of money is where an unreviewed action costs the most. Amounts are compared in the tenant's own currency, as integers — XOF and XAF are distinct, despite parity.", need: "A mandate per agent, and approval above it.", href: "/agent-payments" },
  { t: "SaaS platforms", d: "You expose tools to someone else's agents. You need to prove, per tenant, that one customer's agent cannot reach another customer's destination.", need: "Tenant isolation, adversarially tested." },
  { t: "Developer platforms", d: "Your users bring their own agents. Oathrion sits in front of the tools you expose, so a bad caller cannot reach them even if your API key leaks.", need: "The gateway pattern, in the path." },
  { t: "Security teams", d: "You have been asked to govern agents and given no tooling. Deterministic decisions, explainable to an auditor, with no model on the authorization path.", need: "Evidence, not a dashboard." },
  { t: "AI infrastructure", d: "You run the platform others build on. Oathrion is self-hosted on your PostgreSQL, so the control plane does not become someone else's dependency.", need: "Self-hosted, auditable, yours." },
];

export default function UseCasesPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* ce qui est protege, de l'autre cote */}
        <Backdrop src="/img/vault.jpg" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Use cases</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">If an agent can act, something has to decide.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                The shape is the same everywhere: an agent, a tool that matters, and no layer in
                between. What changes is what it costs when nothing says no.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="grid grid--2">
          {CASES.map((item, index) => (
            <Reveal key={item.t} as="article" delay={(index % 2) * 60}>
              <div className="card">
                <h2 className="h3">{item.t}</h2>
                <p className="small">{item.d}</p>
                <p className="micro" style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s-3)", color: "var(--flow)" }}>{item.need}</p>
                {"href" in item && item.href ? <a className="micro" href={item.href}>Mandates for agent payments →</a> : null}
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">Your case is not on this list.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              It usually is not. Tell us what your agents touch and we will say plainly whether
              Oathrion helps — including when it does not.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="row">
              <CTA href="/pilot" from="use-cases" large>Apply to the pilot</CTA>
              <CTA href="/contact" from="use-cases" variant="ghost" large>Just ask</CTA>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
