/**
 * La page d'accueil. Elle répond à : **qu'est-ce qu'Oathrion ?**
 *
 * L'ordre est celui d'une conversation avec quelqu'un qui n'a pas le temps : le problème,
 * la réponse montrée avant d'être expliquée, ce qui est mesurable, où ça se place, ce que
 * ça ne fait pas, puis les deux portes. Un visiteur peut s'arrêter à n'importe quelle
 * marche et repartir avec quelque chose de vrai.
 */

import { Backdrop, CTA, Eyebrow, Reveal, Rise, Section } from "../components/Shell";
import { HeroScene } from "../components/HeroScene";

/*
 * LES CHIFFRES DE CETTE PAGE, ET CE QUI LES TIENT HONNÊTES.
 *
 * Ils sont MESURÉS, jamais estimés, et chacun vient d'une commande qu'un lecteur peut
 * relancer. `MEASURED_AT` nomme le commit et la date : sans cette référence, un chiffre
 * sur une page de vente est une affirmation invérifiable.
 *
 * ## Ce commentaire disait quelque chose de faux
 *
 * Il affirmait que les chiffres étaient « scellés dans le commit cité en bas de page ».
 * **Aucun commit n'était cité nulle part.** Sur la page dont l'objet entier est de montrer
 * des preuves vérifiables, c'était le défaut le plus gênant du lot — et il était invisible
 * parce que personne ne relit un commentaire.
 *
 * ## Trois chiffres avaient dérivé
 *
 * `npm test` annonçait 2 115 (réel : 2 634), `verify:prod-config` 38 (réel : 41), et
 * `e2e:multitenant` « 73 · 12 blocked ».
 *
 * Ce dernier mérite d'être raconté : les douze contrôles bloqués l'étaient parce que
 * `pg_dump` manquait sur la machine de release. Cette page le disait honnêtement. Mais
 * ces douze contrôles contenaient la purge de locataire — et cette purge ÉCHOUAIT, avec
 * une violation de clé étrangère, dès qu'un locataire avait des reçus. Le trou annoncé
 * sur cette page cachait un vrai défaut pendant tout ce temps.
 *
 * La leçon n'est pas « il fallait mieux annoncer le trou » : c'était déjà fait. C'est
 * qu'un contrôle qu'on ne peut pas exécuter ne protège de rien, et qu'un « bloqué »
 * toléré trop longtemps devient un « passé » dans la tête de tout le monde.
 */
const MEASURED_AT = { commit: "8a49b30", on: "19 octobre 2026" };

const PROOF = [
  { cmd: "npm test", score: "2 891 · 0 failed", ok: true, what: "The full suite: tenant isolation, deny-by-default, the receipt chain, currency handling, SSO. 81 skipped without a database — all PostgreSQL tests, run separately against a throwaway database (113 / 113, including a real database restart and a connection cut mid-transaction). Local tests, not a proof against real GitHub, Slack or Linear accounts." },
  { cmd: "conformance", score: "CONFORME", ok: true, what: "21 core properties, 6 extended. The kit is MIT: run it against Oathrion, against a modified build, against a competitor." },
  { cmd: "… --mutants", score: "23 · 25", ok: false, what: "Each property is deliberately broken to confirm the test fails. 23 are caught by the property they target, 1 is a declared limit, and 1 (a BLOCK made executable) is caught — but by a prerequisite property, so the kit counts it as a miss. Published as measured." },
  { cmd: "verify:mcp", score: "37 · 37", ok: true, what: "The whole path against a tool server that shares no line of code with Oathrion." },
  { cmd: "e2e:multitenant", score: "98 · 98", ok: true, what: "Two real tenants, full adversarial campaign, backup and restore included. Previously 12 checks could not run for want of pg_dump — and they were hiding a real defect in tenant erasure." },
  { cmd: "chaos:postgres", score: "15 · 15", ok: true, what: "PostgreSQL genuinely stopped under a live instance: nothing authorized, no SQLite fallback opened, recovery without restart." },
  { cmd: "verify:dr", score: "28 · 28", ok: true, what: "Restore onto another machine: the chain returns with the same head, a consumed grant stays consumed." },
  { cmd: "verify:erasure", score: "20 · 20", ok: true, what: "Right to erasure against a real PostgreSQL: everything of one tenant, nothing of the other, and a record that survives the data." },
  { cmd: "verify:prod-config", score: "41 · 41", ok: true, what: "Forty-one dangerous configurations refuse to boot, naming the variable responsible." },
];

const CONTROLS = [
  { name: "Identity", text: "Which agent is asking, derived from the credential presented — never from a field in the request body." },
  { name: "Policy", text: "The rules this tenant wrote. First match by priority decides; an undeclared verb is refused." },
  { name: "Mandate", text: "What this agent may spend, in the tenant's own currency. Integer minor units, no silent conversion." },
  { name: "Risk", text: "The shape of the action itself: destination, arguments, how far it sits from what was authorized." },
  { name: "Decision", text: "Allow, hold for a human, or block. Deterministic and explainable — no model on the authorization path." },
  { name: "Approval", text: "A person in that organization approves the exact action they were shown, named by its hash." },
  { name: "Execution", text: "A single-use grant, bound to agent, action hash and destination. Exactly once, proven under concurrency." },
  { name: "Audit", text: "Every decision leaves a receipt, hash-chained. Editing, removing or reordering one breaks the chain." },
];

export default function HomePage(): JSX.Element {
  return (
    <>
      {/* ------------------------------------------------------------- hero */}
      <div className="hero">
        <Backdrop src="/img/ribs.jpg" variant="soft" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="glow hero__glow--low" aria-hidden="true" />
        <div className="glow hero__glow--spark" aria-hidden="true" />
        <div className="shell shell--wide rel">
          <div className="hero__grid">
            <div className="stack-5">
              <Rise><Eyebrow>Control plane for autonomous AI</Eyebrow></Rise>
              <Rise delay={60}>
                <h1 className="display">
                  An agent with an API key can spend your money.
                </h1>
              </Rise>
              <Rise delay={120}>
                <p className="lead measure">
                  The usual control is an instruction in the prompt — inside the very component
                  you do not trust. An instruction is not a barrier. It is a wish.
                </p>
              </Rise>
              <Rise delay={180}>
                <p className="lead measure">
                  Oathrion puts the decision <strong className="fg">outside the agent</strong>. Every
                  action that goes through Oathrion is authorized before it reaches a tool, and
                  every decision leaves a tamper-evident trace.
                </p>
              </Rise>
              <Rise delay={240}>
                <div className="row">
                  <CTA href="/pilot" from="hero" large>Become a Founding Pilot</CTA>
                  <CTA href="/waitlist" from="hero" variant="ghost" large>Join the waitlist</CTA>
                </div>
              </Rise>
            </div>

            <Rise delay={300}>
              <HeroScene />
            </Rise>
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------- the problem */}
      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>The gap</Eyebrow></Reveal>
          <Reveal delay={60}>
            <h2 className="h2 measure">Agents got the ability to act before anyone built the layer that says no.</h2>
          </Reveal>
        </div>
        <div className="grid grid--3">
          {[
            { t: "The credential is the permission", d: "An agent holding an API key has every right that key has. Nothing between the model's output and the money." },
            { t: "Prompt rules are advisory", d: "A system prompt asking an agent to stay under a limit is enforced by the thing being limited. Injection does not have to beat a barrier that is not there." },
            { t: "Logs are written after", d: "Most systems record what happened. A control plane decides whether it may happen — and the difference only matters once." },
          ].map((item, index) => (
            <Reveal key={item.t} delay={index * 70} as="article">
              <div className="card">
                <h3 className="h3">{item.t}</h3>
                <p className="small">{item.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------- the eight gates */}
      <Section line id="lifecycle" backdrop="/img/mesh.jpg" backdropVariant="wide">
        <div className="page-head">
          <Reveal><Eyebrow>Governance lifecycle</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Eight controls, in this order, on every action.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              Not a diagram drawn for a website. This is the order the authority plane actually
              executes, and each step can refuse on its own.
            </p>
          </Reveal>
        </div>

        <ol className="lifecycle">
          {CONTROLS.map((control, index) => (
            <Reveal key={control.name} as="li" delay={index * 40}>
              <div className="lifecycle__item">
                <span className="lifecycle__n mono">{String(index + 1).padStart(2, "0")}</span>
                <div className="stack-2">
                  <h3 className="h3">{control.name}</h3>
                  <p className="small">{control.text}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </ol>
      </Section>

      {/* -------------------------------------------------------- the proof */}
      <Section line id="proof">
        <div className="page-head">
          <Reveal><Eyebrow>Verifiable, not declarative</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Do not believe us. Run them yourself.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              Every row is a command in the delivered repository, with the result it returned on
              the release machine. You re-run them on your own PostgreSQL. For a control product,
              this is the only kind of promise worth making.
            </p>
          </Reveal>
        </div>

        <Reveal>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th scope="col">Command</th><th scope="col">Result</th><th scope="col">What it establishes</th></tr>
              </thead>
              <tbody>
                {PROOF.map((row) => (
                  <tr key={row.cmd}>
                    <td className="mono">{row.cmd}</td>
                    <td className={row.ok ? "ok mono" : "part mono"}>{row.score}</td>
                    <td>{row.what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Reveal>

        <Reveal delay={80}>
          <div className="code" style={{ marginTop: "var(--s-5)" }}>
            <div className="code__bar">
              your machine · your PostgreSQL · measured at {MEASURED_AT.commit} on {MEASURED_AT.on}
            </div>
            <pre>
{`git checkout ${MEASURED_AT.commit}
npm ci `}<span className="k">&&</span>{` npm run build
DATABASE_URL=postgres://… npm run verify:mcp
npm run conformance -- --mutants
npm run demo`}
            </pre>
          </div>
        </Reveal>
      </Section>

      {/* --------------------------------------------------------- two paths */}
      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Two shapes, two different promises</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">In the path, or beside it.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              This distinction must never be blurred in a sales conversation. It decides what is
              actually guaranteed.
            </p>
          </Reveal>
        </div>

        <div className="grid grid--2">
          <Reveal as="article">
            <div className="card">
              <Eyebrow>Pattern A · the gateway</Eyebrow>
              <h3 className="h3">Your tools are only reachable through Oathrion</h3>
              <p className="small">
                Your agent's MCP client points at Oathrion instead of your tool server. A
                configuration change, not a code change.
              </p>
              <p className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s-3)" }}>
                <strong className="fg">Guaranteed:</strong> Oathrion is physically in the path. An
                action it refuses cannot happen, because the call never reaches the tool.
              </p>
            </div>
          </Reveal>
          <Reveal as="article" delay={80}>
            <div className="card">
              <Eyebrow>Pattern B · ask first</Eyebrow>
              <h3 className="h3">Your code asks, then acts on the answer</h3>
              <p className="small">
                One call to <code className="mono">/api/evaluate</code>, directly or through an
                SDK. Any language, any framework, no change to how your agent is built.
              </p>
              <p className="small" style={{ borderTop: "1px solid var(--line)", paddingTop: "var(--s-3)" }}>
                <strong className="fg">Guaranteed:</strong> the decision is authoritative, recorded
                and tamper-evident — but Oathrion cannot stop a program that ignores the answer it
                was given.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ------------------------------------------------------------ limits */}
      <Section line id="limits">
        <div className="page-head">
          <Reveal><Eyebrow mute>The page nobody writes</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">What it does not do.</h2></Reveal>
          <Reveal delay={120}>
            <p className="lead">
              A control product that hides its limits is not one. These are published in the
              delivered documentation, not discovered in production.
            </p>
          </Reveal>
        </div>

        <div className="grid grid--2">
          {[
            { t: "It only governs what goes through it", d: "Actions sent through its connectors (GitHub, Slack, Linear), its MCP gateway, its API or its firewall. An agent that keeps its own credentials and calls a service directly is neither seen nor stopped. The built-in payment and e-mail tools are simulated." },
            { t: "It does not solve prompt injection", d: "No authorization layer does. It bounds the damage: a ceiling holds whether or not the agent was fooled." },
            { t: "The trace is tamper-evident, and that is less than it sounds", d: "It proves it has not been modified. It proves nothing to a third party: no signature, no external anchor, so someone with database write access and the code can recompute a consistent chain." },
            { t: "No SLO, and no distant numbers", d: "One instance reaches roughly 90–190 requests per second. No measurement exists beyond a single machine, so no tail latency is published." },
            { t: "No risk score", d: "Decisions are deterministic and explainable to an auditor. No model sits on the authorization path." },
            { t: "No billing, no SAML, no erasure of one person", d: "Tenant export and permanent tenant purge exist, and SSO speaks OIDC. Erasing one person's data inside a tenant does not exist: if you must honour that right, it belongs in the contract today." },
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

      {/* ------------------------------------------------------------ doors */}
      <Section line id="join" backdrop="/img/sphere.jpg" backdropVariant="left">
        <div className="grid grid--2 doors">
          <Reveal as="article">
            <div className="door door--now">
              <Eyebrow>Now · five places</Eyebrow>
              <h2 className="h2">Founding Pilot</h2>
              <p className="body">
                We set the rules up with you and you connect your tools behind the gateway. Not
                manufactured scarcity: nobody does that work for fifty companies at once.
              </p>
              <div className="row" style={{ marginTop: "var(--s-4)" }}>
                <CTA href="/pilot" from="home-doors" large>Apply to the pilot</CTA>
              </div>
            </div>
          </Reveal>
          <Reveal as="article" delay={80}>
            <div className="door">
              <Eyebrow mute>At launch · no limit</Eyebrow>
              <h2 className="h2">Global waitlist</h2>
              <p className="body">
                For the commercial release, open to everyone, everywhere. One message when it
                opens — no newsletter, no follow-ups in between.
              </p>
              <div className="row" style={{ marginTop: "var(--s-4)" }}>
                <CTA href="/waitlist" from="home-doors" variant="ghost" large>Join the waitlist</CTA>
              </div>
            </div>
          </Reveal>
        </div>
      </Section>
    </>
  );
}
