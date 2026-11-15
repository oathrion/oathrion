/**
 * `/terms` — les conditions du site, pas la licence du logiciel.
 *
 * La licence du produit est un document distinct, livré avec l'archive, et cette page y
 * renvoie plutôt que de la paraphraser : deux textes qui disent la même chose avec des
 * mots différents finissent par ne plus dire la même chose.
 */
import { Eyebrow, Reveal, Section } from "../components/Shell";
import { CONTACT_EMAIL } from "../lib/submit";

const CLAUSES = [
  { t: "1. Who operates this", d: "Oathrion is operated by Abdoulaye Diallo. These terms cover this website. They do not cover the software, which is licensed separately — see clause 4." },
  { t: "2. What this site is", d: "Information about a product at pilot stage, and two ways to get in touch. Nothing on this site is an offer, a contract, or a commitment to deliver a feature by a date. The roadmap page says explicitly that nothing is dated." },
  { t: "3. The figures published here", d: "Every measurement on this site comes from commands in the delivered repository, run on a release machine, and the commands are named so you can re-run them. They describe that build on that machine. They are not a performance guarantee for your infrastructure, and no SLO is offered." },
  { t: "4. The software licence is separate", d: "The product ships with a LICENSE file: the core is licensed under Apache-2.0; the SDKs, CLI, examples and conformance kit are MIT. Both allow use, modification, hosting and redistribution under their terms. Vulnerability reports are welcome (SECURITY.md)." },
  { t: "5. Applying is not acceptance", d: "Submitting a pilot application or joining the waitlist creates no obligation on either side. We may decline, and we say so rather than going quiet. You may withdraw by replying once." },
  { t: "6. No warranty", d: "This site and the software are provided as is, without warranty of any kind. The known limits are published in the documentation and summarised on this site; they are not hidden, and they are not a basis for a claim that they were." },
  { t: "7. Changes", d: "These terms may change. The version in force is the one on this page, and a material change will be mentioned on the roadmap rather than applied quietly." },
];

export default function TermsPage(): JSX.Element {
  return (
    <>
      <Section>
        <div className="page-head">
          <Reveal><Eyebrow>Legal</Eyebrow></Reveal>
          <Reveal delay={60}><h1 className="h1">Terms of use</h1></Reveal>
          <Reveal delay={120}><p className="lead">Short, because a long one nobody reads protects nobody.</p></Reveal>
        </div>
        <div className="stack-6 measure">
          {CLAUSES.map((clause, index) => (
            <Reveal key={clause.t} as="article" delay={index * 40}>
              <div className="stack-2">
                <h2 className="h3">{clause.t}</h2>
                <p className="body">{clause.d}</p>
              </div>
            </Reveal>
          ))}
          <Reveal>
            <p className="small">Questions about any of this: <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--flow)" }}>{CONTACT_EMAIL}</a></p>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
