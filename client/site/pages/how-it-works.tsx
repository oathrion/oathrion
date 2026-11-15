/** `/how-it-works` — une action, suivie de bout en bout. */
import { CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

const STEPS = [
  { n: "01", t: "The agent asks", d: "Your agent calls the gateway, or your code calls evaluate. The request carries the intent — a verb, its arguments, a destination — and nothing about identity or verdicts. Fields that would assert those are refused outright, not ignored." },
  { n: "02", t: "Oathrion derives who is asking", d: "The acting agent comes from the credential presented, never from the body. A credential bound to an agent that names a different one is refused rather than silently corrected — an integration that believes it is pinning the agent should be told it is not." },
  { n: "03", t: "The rules are evaluated", d: "The tenant's own policies, by priority. A verb no policy declares is blocked by default. Amounts are compared in the tenant's currency, as integer minor units — no implicit conversion, no floating-point rounding." },
  { n: "04", t: "A decision is recorded", d: "Allow, hold, or block — written down before anything else happens, with the canonical form of the action and the hash Oathrion computed itself. The record of what was decided is the record of what it was decided about." },
  { n: "05", t: "A human decides, if the rules say so", d: "A held action waits. The approver approves the exact action they were shown, named by its hash: an approval cannot be applied to a grant whose action changed underneath it. An administrator from another tenant cannot approve it." },
  { n: "06", t: "Oathrion makes the call", d: "Not your code. The grant is consumed in a single conditional update, so two concurrent presenters cannot both win, and the credential that reaches your tool lives in Oathrion's destination configuration — never in the response to the agent." },
  { n: "07", t: "A receipt is written", d: "Whether the downstream succeeded or failed. An unrecorded consumed grant would be a gap in the account of what Oathrion did, so the receipt is written either way, and chained to the one before it." },
];

export default function HowItWorksPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>How it works</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">One action, from intent to receipt.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Seven steps, in this order. Each one can refuse on its own, and each refusal names
                itself — so an operator reading an incident at 3am knows which gate closed.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      {/*
        * Le schéma d'ensemble AVANT les sept étapes.
        *
        * Il porte le même trajet que le texte qui suit — demande, contrôles, décision,
        * outil — et il le porte d'un seul coup d'oeil. Mis après la liste il ne servirait
        * qu'à décorer ce que le lecteur a déjà compris.
        *
        * Il y a du texte DANS l'image, donc l'`alt` le répète en entier : sans cela, un
        * lecteur d'écran perd les sept contrôles nommés et la décision rendue.
        */}
      <Section line tight>
        <Reveal>
          <figure className="figure">
            <div className="figure__frame">
              <img
                src="/img/flow.jpg"
                width={1376}
                height={768}
                /*
                 * Immédiate, pas différée. C'est la deuxième chose de la page et son
                 * seul visuel : la laisser arriver après coup ferait sauter la mise en
                 * page sous les yeux du lecteur au moment où il commence à lire.
                 */
                loading="eager"
                decoding="async"
                alt={
                  "An AI agent requests a payment of 4,800. The request passes through Oathrion, " +
                  "where seven named controls are evaluated around the core: identity, policy, " +
                  "mandate and risk, then execution, approval and audit. Oathrion returns the " +
                  "decision APPROVAL_REQUIRED, and the tools, APIs and databases on the far side " +
                  "stay closed until a human approves."
                }
              />
            </div>
            <figcaption className="figure__caption">
              One request, held. The agent asked; Oathrion evaluated the controls in order and
              answered <strong>APPROVAL_REQUIRED</strong> — so nothing reached the tool. The
              seven steps below are this picture, written out.
            </figcaption>
          </figure>
        </Reveal>
      </Section>

      <Section line>
        <ol className="steps">
          {STEPS.map((step, index) => (
            <Reveal key={step.n} as="li" delay={index * 50}>
              <div className="step">
                <span className="step__n mono">{step.n}</span>
                <div className="stack-3">
                  <h2 className="h3">{step.t}</h2>
                  <p className="body">{step.d}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">The same path, proved against a server we did not write.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              Everything above is measured by <code className="mono">npm run verify:mcp</code>, which runs the shipped
              bundle against a tool server that imports nothing from Oathrion — 37 checks, including
              that an allowed action reaches the tool exactly once, and a held one never does
              before a human approves.
            </p>
          </Reveal>
          <Reveal delay={120}><CTA href="/developers" from="hiw" large>Integrate it</CTA></Reveal>
        </div>
      </Section>
    </>
  );
}
