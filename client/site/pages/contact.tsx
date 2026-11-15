/** `/contact` — joindre une personne. */
import { Eyebrow, Reveal, Rise, Section } from "../components/Shell";
import { CONTACT_EMAIL } from "../lib/submit";

const ROUTES = [
  { t: "A pilot", d: "Ten questions, already written, on the pilot page. It is the fastest route — we read every application and reply to each one.", href: "/pilot", cta: "Apply" },
  { t: "Early access", d: "The waitlist takes one field. One message when the commercial release opens, nothing before.", href: "/waitlist", cta: "Join" },
  { t: "A vulnerability", d: "Write to us. You are also free to publish without notice — the licence grants it expressly, and we will not ask you to wait.", href: `mailto:${CONTACT_EMAIL}?subject=Security%20%E2%80%94%20Oathrion`, cta: "Email us" },
  { t: "Anything else", d: "Procurement, licensing, a question the documentation does not answer, or a case you are not sure fits.", href: `mailto:${CONTACT_EMAIL}?subject=Oathrion`, cta: "Email us" },
];

export default function ContactPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Contact</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">A person reads these.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Oathrion is small. There is no ticketing system and no autoresponder — which also
                means we answer slowly sometimes, and we would rather say that than pretend
                otherwise.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="grid grid--2">
          {ROUTES.map((route, index) => (
            <Reveal key={route.t} as="article" delay={(index % 2) * 60}>
              <a className="card card--link" href={route.href}>
                <h2 className="h3">{route.t}</h2>
                <p className="small">{route.d}</p>
                <span className="micro" style={{ color: "var(--flow)" }}>{route.cta} →</span>
              </a>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line tight>
        <Reveal>
          <div className="measure stack-3">
            <Eyebrow mute>Direct</Eyebrow>
            <a className="h3" href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--flow)" }}>{CONTACT_EMAIL}</a>
            <p className="small">Oathrion is operated by Abdoulaye Diallo. Pilot stage — the limits are published, not discovered in production.</p>
          </div>
        </Reveal>
      </Section>
    </>
  );
}
