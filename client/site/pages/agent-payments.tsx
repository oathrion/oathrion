/**
 * `/agent-payments` — elle répond à : **mon agent peut-il payer, et comment le prouver ?**
 *
 * Décidé le 9 novembre (idée d'un ami de l'utilisateur, « un Oathrion pour les transactions
 * agentiques ») : pas un deuxième produit, l'angle « paiements » du même Oathrion, le mandat
 * vérifiable (`notes/CONCEPTION-MANDAT.md`). Oathrion ne touche jamais l'argent : il autorise
 * et il prouve, du côté de l'entreprise ; les rails de paiement restent ceux de la banque.
 */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

const STEPS = [
  {
    t: "Two people sign a mandate",
    d: "Your CFO and your controller sign, from their browser, what the agent may pay: up to 5,000 EUR each time, 50,000 EUR a month, only to the suppliers listed, for three months. Their keys never leave their browser.",
  },
  {
    t: "Each payment gets its own authorization",
    d: "Before paying, the agent asks your Oathrion. It checks the mandate and the month's total, then signs an authorization for that exact payment: valid a few minutes, once. 7,000 EUR is not authorized; nobody had to be awake to say no.",
  },
  {
    t: "The bank checks it by itself",
    d: "The agent presents the mandate and the authorization. The bank verifies the signatures, your fingerprint, the revocation list and the amount with an open-source verifier — without calling Oathrion, and without trusting the agent.",
  },
  {
    t: "A receipt signed by both sides",
    d: "The bank signs what it did: executed, or refused and why. Your organization keeps it next to its own authorization, in a chain anyone can verify. Neither side can deny the payment afterwards.",
  },
];

const DEMO = `1. The agent pays invoice F-2026-114: 3,200 EUR.
   Acme's Oathrion: authorized (valid 5 minutes, for this payment only)
   Bank: EXECUTED · countersigned receipt ✓

2. The agent tries to pay 7,000 EUR.
   Acme's Oathrion: Not granted: above the mandate's 5,000 EUR per action.

3. The agent presents a valid 900 EUR authorization for a 7,000 EUR payment.
   Bank: REFUSED — the authorization is for another action

4. Awa revokes the mandate in Acme's console.
   Acme's Oathrion: Not granted: the mandate has been revoked.
   Bank: REFUSED — the mandate has been revoked

Acme's record: 3 receipts signed by both sides.`;

const NOT = [
  "Oathrion never holds, moves or routes money. The payment goes through your bank's rails, as today.",
  "It is not a payment network. It sits on your side: who allowed the agent, within what, signed by whom — and the proof.",
  "The mandate format is a preview (v0): it can still change. It has been verified with a test bank, not yet with a real one.",
  "The counterparty has to verify the mandate for the guarantee to hold. Until it does, Oathrion still enforces your limits before any payment leaves.",
];

export default function AgentPaymentsPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        <Backdrop src="/img/vault.jpg" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Oathrion Mandates · for agent payments · preview</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">Let your agent pay. Prove it was allowed.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                An agent that pays suppliers needs more than a confirmation button. It needs limits that
                hold when nobody is watching, people who signed them, and a proof your bank, your auditor
                and your insurer can check without trusting you — or the agent.
              </p>
            </Rise>
            <Rise delay={180}>
              <div className="row">
                <CTA href="/pilot" from="agent-payments-hero" large>Pilot it with your payments</CTA>
                <CTA href="/contact" from="agent-payments-hero" variant="ghost" large>Talk to us</CTA>
              </div>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">The question a bank will ask.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              « Your agent sent this payment. Who allowed it, up to how much, and can you prove it? »
              Your agent's own permission prompts answer whether someone clicked yes on one laptop.
              They do not answer for an amount, a supplier list, a monthly total, or two people's
              signatures — and nobody outside can verify them.
            </p>
          </Reveal>
        </div>
      </Section>

      <Section line>
        <div className="grid grid--2">
          {STEPS.map((step, index) => (
            <Reveal key={step.t} as="article" delay={(index % 2) * 60}>
              <div className="card">
                <p className="micro" style={{ color: "var(--flow)" }}>{`Step ${String(index + 1)}`}</p>
                <h2 className="h3">{step.t}</h2>
                <p className="small">{step.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line>
        <div className="stack-5">
          <Reveal><h2 className="h2">Run it yourself, in a minute.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead measure">
              A test company, a test bank, five moments. The bank refuses on its own what Acme did not
              allow; every answer it gives is a receipt it signed.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="code">
              <div className="code__bar">npx tsx examples/mandate-bank/demo.ts</div>
              <pre>{DEMO}</pre>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">What it is not.</h2></Reveal>
          {NOT.map((line, index) => (
            <Reveal key={line} delay={index * 40}>
              <p className="small">{line}</p>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">Looking for the first pilots.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              A company whose agent pays suppliers, or is about to. And one bank or payment provider
              willing to verify the mandate itself. Four weeks, hands-on, with us.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="row">
              <CTA href="/pilot" from="agent-payments" large>Apply to the pilot</CTA>
              <CTA href="/contact" from="agent-payments" variant="ghost" large>We are a bank or a PSP</CTA>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
