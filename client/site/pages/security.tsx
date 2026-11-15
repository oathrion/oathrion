/** `/security` — uniquement ce qui existe réellement. Aucune certification n'est citée. */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";

export default function SecurityPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* la chaine, et son maillon rompu */}
        <Backdrop src="/img/chain.jpg" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Security</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">What is guaranteed, and what is not.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Oathrion holds <strong className="fg">no certification</strong> — no SOC 2, no ISO 27001, no
                pen-test report. Claiming otherwise would be the first thing a buyer checks and
                the last time they trusted us. What follows is what the code does, and each line
                maps to a command you can run.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Properties that hold</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Eight guarantees, each with its proof.</h2></Reveal>
        </div>
        <Reveal>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Guarantee</th><th scope="col">Proof</th></tr></thead>
              <tbody>
                {[
                  ["No action without authorization", "verify:mcp — 37 checks against a tool server sharing no code with Oathrion"],
                  ["Exactly once", "phase11-multiprocess — four OS processes racing, one consumption, one downstream call"],
                  ["Nothing leaves before the human", "conformance C18–C22, each proved by a mutant that breaks it"],
                  ["Deny by default", "An undeclared verb is blocked, never tolerated"],
                  ["Tamper-evident trace", "Sixteen hashed fields; editing, deleting or reordering a receipt breaks the chain"],
                  ["Tenant isolation", "e2e:multitenant — a fully privileged admin attacks another tenant and is refused everywhere"],
                  ["Fail closed", "chaos:postgres — database stopped, nothing authorized, recovery without restart"],
                  ["Refuses dangerous configuration", "verify:prod-config — 38 settings refuse to boot, naming the variable"],
                ].map(([g, p]) => (
                  <tr key={g}><td style={{ color: "var(--fg)" }}>{g}</td><td className="mono" style={{ fontSize: "0.8125rem" }}>{p}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow mute>Stated plainly</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Where the guarantees stop.</h2></Reveal>
        </div>
        <div className="grid grid--2">
          {[
            { t: "No certification of any kind", d: "No SOC 2, no ISO 27001, no external audit report. If your procurement requires one, Oathrion does not clear it today." },
            { t: "Tamper-evident is the whole claim", d: "The chain proves it was not modified. It proves nothing to a third party — no signature, no external anchor — and someone with database write access and the code can recompute a consistent chain." },
            { t: "No end-of-chain truncation detection", d: "Removing the last receipt leaves the rest coherent. Closing this needs a persisted head per tenant, which does not exist yet." },
            { t: "Pattern B cannot stop a hostile client", d: "If your code asks for a decision and ignores it, only the gateway path is unavoidable. We will never sell the stronger claim for the weaker shape." },
            { t: "Prompt injection is not solved", d: "No authorization layer solves it. Oathrion bounds the damage: a ceiling holds whether or not the agent was fooled." },
            { t: "No erasure of one person's data", d: "Tenant export and permanent tenant purge exist. Erasing one person's data inside a tenant does not: if you must honour that right, it belongs in the contract today." },
          ].map((item, index) => (
            <Reveal key={item.t} as="article" delay={index * 50}>
              <div className="limit-item">
                <h3 className="h3">{item.t}</h3>
                <p className="small">{item.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">Publishing a vulnerability is granted, without notice.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              Section 1(c) of the licence grants it expressly. This product is sold on a
              verifiable claim; a licence forbidding publication of the refutation would empty
              the claim of meaning. Write to us and we will answer — but you are not required to
              wait for us.
            </p>
          </Reveal>
          <Reveal delay={120}><CTA href="/contact" from="security" large>Report something</CTA></Reveal>
        </div>
      </Section>
    </>
  );
}
