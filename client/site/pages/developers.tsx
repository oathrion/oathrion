/**
 * `/developers` — elle répond à : **puis-je l'intégrer ?**
 *
 * Tous les exemples sont tirés du dépôt livré : les routes existent, les noms de méthode
 * existent, les codes de refus existent. Rien n'est inventé pour que la page soit jolie —
 * un développeur qui copie une ligne d'ici et reçoit un 404 ne revient pas.
 */
import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";
import { EVENTS, track } from "../lib/analytics";

export default function DevelopersPage(): JSX.Element {
  return (
    <>
      <div className="hero">
        {/* l'agent qui emet -- c'est lui qu'on integre */}
        <Backdrop src="/img/core.jpg" variant="soft" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Developers</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">Change the endpoint, not your agent.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Two integration shapes, both small. The gateway is a configuration change. Asking
                first is one HTTP call. Neither asks you to rewrite how your agent is built.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Pattern B · ask first</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">One call, three possible answers.</h2></Reveal>
        </div>
        <div className="grid grid--2">
          <Reveal>
            <div className="code">
              <div className="code__bar">TypeScript · sdk/typescript</div>
              <pre>{`import { OathrionClient } from "./sdk/typescript/src";

const oathrion = new OathrionClient({
  baseUrl: process.env.OATHRION_URL!,
  apiKey:  process.env.OATHRION_API_KEY!,
});

const decision = await oathrion.evaluate({
  agentId: "agt_support_bot",
  action:  "stripe.refund",
  target:  "cus_123",
  input:   { amount: 75, currency: "USD" },
});

`}<span className="c">{`// allowed is true for ALLOW and nothing else.`}</span>{`
`}<span className="k">if</span>{` (decision.allowed) await stripe.refunds.create(…);`}</pre>
            </div>
          </Reveal>
          <Reveal delay={80}>
            <div className="code">
              <div className="code__bar">Python · oathrion</div>
              <pre>{`from oathrion import OathrionClient

oathrion = OathrionClient(
    base_url=os.environ["OATHRION_URL"],
    api_key=os.environ["OATHRION_API_KEY"],
)

decision = oathrion.evaluate(
    agent_id="agt_support_bot",
    action="stripe.refund",
    target="cus_123",
    input={"amount": 75, "currency": "USD"},
)

`}<span className="k">if</span>{` decision.allowed:
    stripe.Refund.create(…)`}</pre>
            </div>
          </Reveal>
        </div>
        <Reveal delay={120}>
          <div className="form__status" style={{ background: "rgba(245,181,68,0.07)", border: "1px solid rgba(245,181,68,0.28)", color: "var(--fg-dim)", marginTop: "var(--s-5)" }}>
            <strong className="fg">Never write <code className="mono">if (!decision.blocked)</code>.</strong>
            <span>That lets APPROVAL_REQUIRED through. Both SDKs derive <code className="mono">allowed</code> exhaustively from the decision string, which is why the positive test is the only one that is safe.</span>
          </div>
        </Reveal>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Any framework</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Wrap the tool you already have.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              The adapter imports no framework. It wraps whichever execute method it finds —
              <code className="mono">execute</code>, <code className="mono">invoke</code>, <code className="mono">call</code>,
              {" "}<code className="mono">func</code>, <code className="mono">run</code>, <code className="mono">_run</code> — or a bare
              function, and preserves the description, the schema and every argument.
            </p>
          </Reveal>
        </div>
        <Reveal>
          <div className="code">
            <div className="code__bar">examples/framework-adapter</div>
            <pre>{`import { withOathrion } from "./with-placet";

export const refund = withOathrion(myRefundTool, {
  client: oathrion,
  agentId: "agt_support_bot",
  action:  "stripe.refund",
  target:  (a) => a.customerId,
  input:   (a) => ({ amount: a.amount, currency: a.currency }),
});

`}<span className="c">{`// refund IS myRefundTool: same type, same name, same schema.`}</span>{`
`}<span className="c">{`// It simply does not run unless Oathrion returned ALLOW.`}</span></pre>
          </div>
        </Reveal>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Pattern A · the gateway</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Put Oathrion in the path.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              Your agent's MCP client points at Oathrion instead of your tool server. Oathrion
              decides, then dispatches to your server itself — which keeps your downstream
              credentials out of the agent entirely.
            </p>
          </Reveal>
        </div>
        <Reveal>
          <div className="code">
            <div className="code__bar">MCP · revision 2026-07-28</div>
            <pre>{`POST /api/mcp
Authorization: Bearer oathrion_…
MCP-Protocol-Version: 2026-07-28
X-Oathrion-Agent-Id: agt_support_bot

{ "jsonrpc": "2.0", "id": 1, "method": "tools/call",
  "params": { "name": "stripe.refund",
              "arguments": { "customer": "cus_123", "amount": 75 } } }`}</pre>
          </div>
        </Reveal>
        <Reveal delay={80}>
          <p className="small" style={{ marginTop: "var(--s-4)", maxWidth: "var(--measure)" }}>
            Your own tool server needs three methods — <code className="mono">initialize</code>,{" "}
            <code className="mono">tools/list</code>, <code className="mono">tools/call</code> — and nothing else. A complete
            working example that imports nothing from Oathrion ships in{" "}
            <code className="mono">examples/mcp-server/</code>.
          </p>
        </Reveal>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Refusals</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Every refusal names itself.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              One HTTP status for every refusal, with a machine-readable code. A 404 that
              appeared only for ids that do not exist would turn the endpoint into an oracle for
              probing another tenant.
            </p>
          </Reveal>
        </div>
        <Reveal>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th scope="col">Code</th><th scope="col">What happened</th></tr></thead>
              <tbody>
                {[
                  ["grant_not_found", "No such grant for this tenant — or it belongs to someone else. The two are deliberately indistinguishable."],
                  ["grant_not_issued", "Still awaiting approval, or revoked. It confers no authority yet."],
                  ["grant_already_consumed", "A grant authorizes one execution. Replaying it is refused."],
                  ["grant_expired", "Authority does not outlive its window."],
                  ["agent_mismatch", "Issued to another agent. Authority is not transferable."],
                  ["action_mismatch", "The presented action hashes differently — an argument changed since authorization."],
                  ["destination_unknown", "Not registered for this tenant. Oathrion has no default destination."],
                  ["race_lost", "Another request consumed this grant first. This attempt performed nothing."],
                ].map(([code, what]) => (
                  <tr key={code}><td className="mono">{code}</td><td>{what}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>
      </Section>

      <Section line>
        <div className="measure stack-5">
          <Reveal><h2 className="h2">Run the conformance kit against us.</h2></Reveal>
          <Reveal delay={60}>
            <p className="lead">
              It is MIT licensed, on purpose: a verification kit only its author can run verifies
              nothing. Twenty-one core properties, twenty mutants that prove the kit bites.
            </p>
          </Reveal>
          <Reveal delay={120}>
            <div className="row">
              <CTA href="/pilot" from="developers" large>Get access</CTA>
              <a className="btn btn--ghost btn--lg" href="/security" onClick={() => track(EVENTS.docsOpen, { from: "developers" })}>Security model</a>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
