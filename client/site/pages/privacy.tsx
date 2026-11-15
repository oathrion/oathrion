/**
 * `/privacy` — ce qui est collecté, et ce qui ne l'est pas.
 *
 * Elle décrit l'état RÉEL du site tel qu'il est livré : aucun fournisseur d'analytique
 * n'est branché, aucun cookie n'est posé, et les formulaires partent par le client de
 * messagerie du visiteur. Le jour où un point de collecte existe, cette page change en
 * même temps que le code — pas après.
 */
import { Eyebrow, Reveal, Section } from "../components/Shell";
import { CONTACT_EMAIL } from "../lib/submit";

export default function PrivacyPage(): JSX.Element {
  return (
    <>
      <Section>
        <div className="page-head">
          <Reveal><Eyebrow>Legal</Eyebrow></Reveal>
          <Reveal delay={60}><h1 className="h1">Privacy</h1></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              This describes the site as delivered today. It is short because the site collects
              very little, and we would rather say what is true now than write a policy for a
              future we have not built.
            </p>
          </Reveal>
        </div>

        <div className="stack-6 measure">
          <Reveal as="article">
            <div className="stack-2">
              <h2 className="h3">No cookies, no tracking scripts</h2>
              <p className="body">
                This site sets no cookies and loads no third-party analytics or advertising
                script. The analytics module in the codebase is an abstraction with no provider
                connected: events are queued in memory, bounded, and discarded. Nothing leaves
                your browser.
              </p>
            </div>
          </Reveal>

          <Reveal as="article">
            <div className="stack-2">
              <h2 className="h3">What the forms do</h2>
              <p className="body">
                The pilot and waitlist forms open <strong className="fg">your own mail client</strong> with the
                message filled in. Nothing is transmitted until you press send, and what you send
                arrives as an ordinary email. We store no database of prospects, because there is
                none: deliberately, the marketing site does not write into the control plane.
              </p>
            </div>
          </Reveal>

          <Reveal as="article">
            <div className="stack-2">
              <h2 className="h3">What we do with an email you send</h2>
              <p className="body">
                We read it and reply. We do not add you to a newsletter, we do not share or sell
                your address, and the waitlist means one message when the release opens. Ask us
                to delete your message and we will, by replying once.
              </p>
            </div>
          </Reveal>

          <Reveal as="article">
            <div className="stack-2">
              <h2 className="h3">If analytics is ever connected</h2>
              <p className="body">
                The module refuses to send identifying fields by construction: keys named email,
                name, phone, address, IP or user id are dropped before transmission, and a
                referrer is reduced to its origin. If a provider is ever connected, this page
                will name it before it is switched on.
              </p>
            </div>
          </Reveal>

          <Reveal as="article">
            <div className="stack-2">
              <h2 className="h3">The product is separate, and it has a known gap</h2>
              <p className="body">
                If you run Oathrion, your data stays on your own PostgreSQL and never passes
                through us. Stated plainly: the software has a tenant export but{" "}
                <strong className="fg">no erasure of an individual's data</strong>. If you must honour a right to
                erasure for your own users, that belongs in your contract today, and we say so on
                the security page rather than leaving you to find it.
              </p>
            </div>
          </Reveal>

          <Reveal>
            <p className="small">
              Questions, or a deletion request: <a href={`mailto:${CONTACT_EMAIL}`} style={{ color: "var(--flow)" }}>{CONTACT_EMAIL}</a>
            </p>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
