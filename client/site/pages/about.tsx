/** `/about` — pourquoi Oathrion existe. */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

export default function AboutPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* le mur, minuscule, dans beaucoup de vide */}
        <Backdrop src="/img/void.jpg" variant="soft" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>About</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">Agents got the ability to act before anyone built the layer that says no.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Every other kind of software that can move money acquired an authorization layer
                early — a payment system has one, a database has one, an operating system has
                one. Autonomous agents arrived without, and the gap was filled with instructions
                written in the prompt.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="grid grid--2">
          <Reveal as="article">
            <div className="stack-4">
              <Eyebrow>Mission</Eyebrow>
              <h2 className="h2">Make the decision to act something a machine can prove it was allowed to make.</h2>
              <p className="body">
                Not a log written afterwards. Not a probability. A decision taken before the
                action, by a component the agent does not control, recorded in a way that cannot
                be quietly rewritten.
              </p>
            </div>
          </Reveal>
          <Reveal as="article" delay={80}>
            <div className="stack-4">
              <Eyebrow>Vision</Eyebrow>
              <h2 className="h2">An authorization layer that is infrastructure, not a product feature.</h2>
              <p className="body">
                Self-hosted, auditable, and boring in the way that load balancers and databases
                are boring. The control plane should not become a dependency on us — which is
                why the source is readable and the conformance kit is MIT.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Philosophy</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Four rules the codebase actually enforces.</h2></Reveal>
        </div>
        <div className="grid grid--2">
          {[
            { t: "A claim without a command is a wish", d: "Every guarantee on this site names a command you can run. Where a check could not run, the number says so — e2e:multitenant is 73 passed and 12 blocked, and that is printed rather than rounded away." },
            { t: "A test is only worth its mutant", d: "A suite that passes against everything proves nothing. Twenty mutants deliberately break the product to confirm each property fails. Four of them survived at first, and each survivor taught us something we did not know." },
            { t: "Refuse rather than guess", d: "Thirty-eight dangerous configurations refuse to boot, naming the variable. A process that comes up on the wrong port is harder to diagnose than one that explains why it did not come up." },
            { t: "Publish the limits", d: "A control product that hides what it cannot do is not one. The limits page is written before the sales page, and it is longer." },
          ].map((item, index) => (
            <Reveal key={item.t} as="article" delay={index * 60}>
              <div className="card">
                <h3 className="h3">{item.t}</h3>
                <p className="small">{item.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><Eyebrow>Where it is built</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2">Built with West and Central Africa as a first-class case, not a localisation.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              XOF and XAF are distinct currencies — BCEAO and BEAC — despite parity, and Oathrion
              treats them as such. Amounts are integer minor units: no floating-point arithmetic,
              no silent rounding, no implicit conversion. A ceiling written in a tenant's currency
              is compared in that currency or it is refused.
            </p>
          </Reveal>
          <Reveal delay={180}><CTA href="/pilot" from="about" large>Work with us</CTA></Reveal>
        </div>
      </Section>
    </>
  );
}
