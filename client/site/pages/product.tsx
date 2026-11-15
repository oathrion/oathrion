/** `/product` — elle répond à : **comment ça marche ?** */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";
import { HeroScene } from "../components/HeroScene";

export default function ProductPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* l'action retenue, et quelqu'un qui decide : le coeur du produit */}
        <Backdrop src="/img/held.jpg" variant="soft" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="hero__grid">
            <div className="stack-5">
              <Rise><Eyebrow>Product</Eyebrow></Rise>
              <Rise delay={60}><h1 className="display">A decision, not a suggestion.</h1></Rise>
              <Rise delay={120}>
                <p className="lead measure">
                  Oathrion sits between an agent and the systems it acts on. Every action routed
                  through it is submitted for authorization before it reaches a tool, and the
                  answer is one of three — never a score, never a probability.
                </p>
              </Rise>
            </div>
            <Rise delay={180}><HeroScene /></Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>The three answers</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Three, not two — and the third is the one everyone gets wrong.</h2></Reveal>
        </div>
        <div className="grid grid--3">
          {[
            { v: "ALLOW", c: "allow", r: "stripe.refund · 180.00 USD", d: "Under the agent's mandate. A single-use grant is issued, bound to this agent, this action hash and this destination." },
            { v: "APPROVAL_REQUIRED", c: "hold", r: "stripe.refund · 48,000.00 USD", d: "Above the ceiling. Held until a human in that organization decides. An administrator from another tenant is refused." },
            { v: "BLOCK", c: "block", r: "customer.delete", d: "No policy allows it. Deny by default, and zero downstream calls. An undeclared verb is refused, never tolerated." },
          ].map((item, index) => (
            <Reveal key={item.v} as="article" delay={index * 70}>
              <div className="card">
                <span className={`chip chip--${item.c}`}><i />{item.v}</span>
                <p className="mono small">{item.r}</p>
                <p className="small">{item.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
        <Reveal delay={120}>
          <div className="form__status" style={{ background: "rgba(245,181,68,0.07)", border: "1px solid rgba(245,181,68,0.28)", color: "var(--fg-dim)", marginTop: "var(--s-5)" }}>
            <strong className="fg">APPROVAL_REQUIRED is not permission.</strong>
            <span>It is the most common integration bug, and it is almost always written <code className="mono">if (!blocked)</code>. Our SDKs derive <code className="mono">allowed</code> exhaustively from the decision string — never as the negation of something else.</span>
          </div>
        </Reveal>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>The grant</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Authorization is an object, not a yes.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              Deciding returns nothing you can act on. It returns a grant id, and a grant is only
              usable by handing it back for execution — which is where Oathrion makes the downstream
              call itself. A caller who gets ALLOW and then calls Stripe directly has left the
              governed path, and gains nothing by it.
            </p>
          </Reveal>
        </div>
        <Reveal>
          <ul className="list grid grid--2">
            <li><strong className="fg">Single use.</strong> Replaying a consumed grant is refused — proven under concurrency, across operating-system processes.</li>
            <li><strong className="fg">Bound to the action.</strong> Change the amount, the currency or the recipient and the hash differs; the grant no longer matches.</li>
            <li><strong className="fg">Bound to the agent.</strong> Authority is not transferable between agents, even inside one tenant.</li>
            <li><strong className="fg">Bound to the destination.</strong> A grant for one tool server cannot be spent against another.</li>
            <li><strong className="fg">Time-boxed.</strong> A grant expires. Authority does not outlive its window.</li>
            <li><strong className="fg">A refusal does not consume it.</strong> Someone who guesses a grant id cannot burn another agent's authorization.</li>
          </ul>
        </Reveal>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>The trace</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Every decision leaves a receipt, and the receipts form a chain.</h2></Reveal>
        </div>
        <div className="grid grid--2">
          <Reveal as="article">
            <div className="card">
              <h3 className="h3">What it detects</h3>
              <p className="small">Editing a receipt, removing one, reordering them, or inserting one. Sixteen fields enter the hash, including the human-readable summary an auditor reads first. The tenant verifies their own chain over HTTP; they do not have to take our word for it.</p>
            </div>
          </Reveal>
          <Reveal as="article" delay={80}>
            <div className="card">
              <h3 className="h3">What it does not</h3>
              <p className="small">It proves nothing to a third party: there is no signature and no external anchor. Someone with write access to the database and the code can recompute a consistent chain. It also does not detect a truncation at the very end of the chain — removing the last receipt leaves the rest coherent.</p>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">See it against your own stack.</h2></Reveal>
          <Reveal delay={60}><p className="lead">The pilot is five companies. The waitlist is everyone else.</p></Reveal>
          <Reveal delay={120}>
            <div className="row">
              <CTA href="/pilot" from="product" large>Become a Pilot</CTA>
              <CTA href="/developers" from="product" variant="ghost" large>Read the integration</CTA>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
