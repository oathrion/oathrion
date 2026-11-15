/**
 * `/pricing` — elle répond à : **puis-je l'acheter ?**
 *
 * Le dépôt ne contient AUCUNE information tarifaire, et aucun compteur facturable :
 * `COMMERCIAL_READINESS.md` dit « Aucune facturation produit — ni plan, ni entitlement,
 * ni compteur facturable ». Inventer trois paliers avec des prix ronds serait donc une
 * fiction, et la première question d'un acheteur la ferait tomber.
 *
 * Cette page dit donc l'état réel, et le structure pour que des prix s'y posent le jour
 * où ils existent — sans refaire la page.
 */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

export default function PricingPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* sobre : une page de prix sans prix n'a pas a en rajouter */}
        <Backdrop src="/img/stage.jpg" variant="soft" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Pricing</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">There is no price list yet, and saying one would be inventing it.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Oathrion has no billing, no plans and no metered counters — the existing counters
                are technical and explicitly advisory. Publishing tiers before any of that exists
                would be a number we made up, and you would find out in the first call.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="grid grid--2">
          <Reveal as="article">
            <div className="door door--now">
              <Eyebrow>Available now</Eyebrow>
              <h2 className="h2">Founding Pilot</h2>
              <p className="body">
                Five companies, accompanied by hand. Self-hosted on your PostgreSQL, with the
                source. The price is agreed per pilot and it is modest — a pilot exists to find
                out whether the tool holds for you, and a price fixed before knowing that would
                be an invented price.
              </p>
              <ul className="list" style={{ marginTop: "var(--s-3)" }}>
                <li>The software and its source</li>
                <li>Rules installed with you</li>
                <li>Your data never passes through us</li>
                <li>Publishing a vulnerability without notice, granted by licence</li>
              </ul>
              <div className="row" style={{ marginTop: "var(--s-4)" }}>
                <CTA href="/pilot" from="pricing" large>Apply</CTA>
              </div>
            </div>
          </Reveal>
          <Reveal as="article" delay={80}>
            <div className="door">
              <Eyebrow mute>Later</Eyebrow>
              <h2 className="h2">Commercial release</h2>
              <p className="body">
                Pricing will be published when there is something to price: plans, entitlements
                and a metered counter that an invoice can stand on. Waitlist members hear first,
                and they hear the real number rather than a placeholder.
              </p>
              <ul className="list" style={{ marginTop: "var(--s-3)" }}>
                <li>Self-hosting stays an option — the control plane should not become someone else's dependency</li>
                <li>The SDKs, CLI, examples and conformance kit stay MIT, priced at nothing, forever</li>
              </ul>
              <div className="row" style={{ marginTop: "var(--s-4)" }}>
                <CTA href="/waitlist" from="pricing" variant="ghost" large>Join the waitlist</CTA>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Licence</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Open core, permissive edges.</h2></Reveal>
        </div>
        <Reveal>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Scope</th><th scope="col">Terms</th></tr></thead>
              <tbody>
                <tr>
                  <td className="mono">server/ shared/ client/ script/ deploy/</td>
                  <td><strong style={{ color: "var(--fg)" }}>Apache-2.0.</strong> Use, modify, host and redistribute under the terms of the license (LICENSE, NOTICE). Vulnerability reports are welcome — see SECURITY.md.</td>
                </tr>
                <tr>
                  <td className="mono">sdk/ cli/ examples/ conformance/</td>
                  <td><strong style={{ color: "var(--fg)" }}>MIT.</strong> These files enter your codebase. The conformance kit is MIT on purpose — a verification kit only its author can run verifies nothing.</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
