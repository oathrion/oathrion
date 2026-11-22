/**
 * `/pilot` — elle répond à : **puis-je aider à le construire ?**
 *
 * La page la plus stratégique du site. Elle doit qualifier autant qu'elle recrute : un
 * pilote mal choisi coûte des semaines aux deux parties, donc le formulaire demande ce
 * qu'il faut pour dire non vite et avec respect.
 */

import { useState, type FormEvent } from "react";
import { Backdrop, Eyebrow, Reveal, Rise, Section } from "../components/Shell";
import { EVENTS, track } from "../lib/analytics";
import {
  activeTransport,
  isTrap,
  submit,
  validate,
  type Errors,
  type PilotApplication,
} from "../lib/submit";

const REQUIRED = ["name", "email", "company", "role", "country", "building", "problem"];

const EMPTY: Record<string, string> = {
  name: "", email: "", company: "", role: "", country: "",
  building: "", workflow: "", agents: "", problem: "", wants: "", website: "",
};

const ROLES = ["Founder / CEO", "CTO / VP Engineering", "Engineer", "Security / Compliance", "Product", "Other"];
const AGENT_COUNTS = ["Not in production yet", "1–5", "6–20", "21–100", "More than 100"];

export default function PilotPage(): JSX.Element {
  const [values, setValues] = useState(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  /* `?sent=1` : le retour du service de formulaire, la candidature est partie (`main.tsx`). */
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">(() =>
    typeof window !== "undefined" && new URLSearchParams(window.location.search).get("sent") === "1" ? "sent" : "idle",
  );
  const [failure, setFailure] = useState("");
  const [touched, setTouched] = useState(false);

  const set = (key: string) => (event: { target: { value: string } }) => {
    if (!touched) {
      setTouched(true);
      track(EVENTS.pilotFormStart);
    }
    setValues((previous) => ({ ...previous, [key]: event.target.value }));
    setErrors((previous) => {
      if (!previous[key]) return previous;
      const next = { ...previous };
      delete next[key];
      return next;
    });
  };

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();

    /*
     * Le piège d'abord. Rempli, on affiche le succès et on n'envoie rien : un robot qui
     * reçoit une erreur réessaie en s'adaptant, un robot qui reçoit un succès s'en va.
     */
    if (isTrap(values)) {
      setState("sent");
      return;
    }

    const found = validate(values, REQUIRED);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      track(EVENTS.pilotFormError, { fields: Object.keys(found).join(",") });
      // Le premier champ en défaut reçoit le focus : sinon la personne cherche
      // laquelle des dix lignes a échoué.
      document.getElementById(`pilot-${Object.keys(found)[0]}`)?.focus();
      return;
    }

    setState("sending");
    const application: PilotApplication = {
      kind: "pilot",
      name: values.name!, email: values.email!, company: values.company!,
      role: values.role!, country: values.country!, building: values.building!,
      workflow: values.workflow!, agents: values.agents!, problem: values.problem!,
      wants: values.wants!,
    };
    const outcome = await submit(application);
    if (outcome.ok) {
      track(EVENTS.pilotFormSubmit, { via: outcome.via });
      setState("sent");
    } else {
      track(EVENTS.pilotFormError, { reason: outcome.reason });
      setFailure(outcome.reason);
      setState("failed");
    }
  }

  if (state === "sent") {
    return (
      <Section>
        <div className="success measure">
          <svg className="success__mark" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M7.5 12.4l3 3 6-6.4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          {/*
            Comme sur la page waitlist : le titre suit le transport. « on its way »
            affirme un envoi, et avec le transport `mailto` rien n'est parti — le
            navigateur a ouvert un brouillon que la personne doit encore envoyer.
          */}
          <h1 className="h1">
            {activeTransport("pilot") === "mailto"
              ? "One last step: press send."
              : "Your application is on its way."}
          </h1>
          <p className="lead">
            {activeTransport("pilot") === "mailto"
              ? "Your mail client is open with the application filled in. It is not sent until you press send — we did not want to send anything on your behalf."
              : "We have it. You will hear from us within a few days."}
          </p>
          <p className="small">
            We read every application and reply to each one, including to say no when the case
            does not fit. Five places means five.
          </p>
        </div>
      </Section>
    );
  }

  return (
    <>
      <div className="hero">
        <Backdrop src="/img/sphere.jpg" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="shell rel">
          <div className="stack-5 measure">
            <Rise><Eyebrow>Founding Pilot · five places</Eyebrow></Rise>
            <Rise delay={60}><h1 className="display">Help build the layer that says no.</h1></Rise>
            <Rise delay={120}>
              <p className="lead">
                Oathrion is built and verified. What it has not yet met is your agents, your tools
                and your rules. That is what a pilot is for — and why there are five places and
                not fifty.
              </p>
            </Rise>
          </div>
        </div>
      </div>

      <Section line tight>
        <div className="grid grid--3">
          {[
            { t: "What you get", d: "The software and its source, self-hosted on your PostgreSQL. Your data never passes through us. Reading, running, auditing and publishing a vulnerability without notice are granted by the licence." },
            { t: "What we ask", d: "A real use case — an agent that touches something that matters — and one person who approves held actions. Not a mock-up." },
            { t: "What it costs", d: "To be agreed, and modest. A pilot exists to find out whether the tool holds for you; a price fixed before knowing would be an invented price." },
          ].map((item, index) => (
            <Reveal key={item.t} as="article" delay={index * 70}>
              <div className="card">
                <h2 className="h3">{item.t}</h2>
                <p className="small">{item.d}</p>
              </div>
            </Reveal>
          ))}
        </div>
      </Section>

      <Section line>
        <div className="page-head">
          <Reveal><Eyebrow>Who we are looking for</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Teams whose agents already touch something real.</h2></Reveal>
        </div>
        <Reveal>
          <ul className="list grid grid--2">
            <li>AI startups putting agents in front of customer money or customer data</li>
            <li>Fintech and payments teams that need a human in the loop above a threshold</li>
            <li>Enterprise teams deploying internal agents across more than one system</li>
            <li>Developer platforms that expose tools to someone else's agents</li>
            <li>Security and compliance teams who have been asked to govern agents</li>
            <li>Infrastructure teams who want the control plane self-hosted, not rented</li>
          </ul>
        </Reveal>
      </Section>

      <Section line id="apply">
        <div className="page-head">
          <Reveal><Eyebrow>Apply</Eyebrow></Reveal>
          <Reveal delay={60}><h2 className="h2 measure">Ten questions. They are the ones we would ask on a call.</h2></Reveal>
        </div>

        <Reveal>
          <form className="form measure" onSubmit={(event) => void onSubmit(event)} noValidate>
            <div className="form__row form__row--2">
              <Field id="pilot-name" label="Name" value={values.name!} error={errors.name} onChange={set("name")} autoComplete="name" />
              <Field id="pilot-email" label="Email" type="email" value={values.email!} error={errors.email} onChange={set("email")} autoComplete="email" />
            </div>
            <div className="form__row form__row--2">
              <Field id="pilot-company" label="Company" value={values.company!} error={errors.company} onChange={set("company")} autoComplete="organization" />
              <Field id="pilot-country" label="Country" value={values.country!} error={errors.country} onChange={set("country")} autoComplete="country-name" />
            </div>
            <div className="form__row form__row--2">
              <SelectField id="pilot-role" label="Role" value={values.role!} error={errors.role} onChange={set("role")} options={ROLES} />
              <SelectField id="pilot-agents" label="How many agents do you run?" value={values.agents!} onChange={set("agents")} options={AGENT_COUNTS} />
            </div>

            <TextField id="pilot-building" label="What are you building?" value={values.building!} error={errors.building} onChange={set("building")} />
            <TextField id="pilot-workflow" label="Your current AI-agent workflow" hint="Which framework, what the agents are allowed to do today, and what stops them." value={values.workflow!} onChange={set("workflow")} />
            <TextField id="pilot-problem" label="Your biggest governance problem" value={values.problem!} error={errors.problem} onChange={set("problem")} />
            <TextField id="pilot-wants" label="What would you want Oathrion to solve first?" value={values.wants!} onChange={set("wants")} />

            {/* Hors écran et hors lecture d'écran : seul un script le remplit. */}
            <div className="trap" aria-hidden="true">
              <label htmlFor="pilot-website">Website</label>
              <input id="pilot-website" name="website" tabIndex={-1} autoComplete="off" value={values.website} onChange={set("website")} />
            </div>

            {state === "failed" && (
              <div className="form__status form__status--error" role="alert">
                <strong>{failure}</strong>
                <span>Nothing was lost — press the button again, or write to us directly.</span>
              </div>
            )}

            <div className="row">
              <button className="btn btn--primary btn--lg" type="submit" disabled={state === "sending"}>
                {state === "sending" ? "Sending…" : "Submit application"}
              </button>
              <span className="micro">
                {activeTransport("pilot") === "mailto"
                  ? "Opens your mail client with everything filled in. Nothing is sent without you."
                  : "We reply to every application."}
              </span>
            </div>
          </form>
        </Reveal>
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ fields */

interface Base {
  id: string;
  label: string;
  value: string;
  error?: string;
  hint?: string;
  onChange: (event: { target: { value: string } }) => void;
}

function Field({ id, label, value, error, hint, onChange, type = "text", autoComplete }: Base & { type?: string; autoComplete?: string }): JSX.Element {
  return (
    <div className={`field${error ? " field--invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id} className="input" type={type} value={value} onChange={onChange}
        autoComplete={autoComplete}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
      />
      {hint && !error && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

function TextField({ id, label, value, error, hint, onChange }: Base): JSX.Element {
  return (
    <div className={`field${error ? " field--invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id} className="textarea" value={value} onChange={onChange}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : hint ? `${id}-hint` : undefined}
      />
      {hint && !error && <span className="hint" id={`${id}-hint`}>{hint}</span>}
      {error && <span className="error" id={`${id}-error`}>{error}</span>}
    </div>
  );
}

function SelectField({ id, label, value, error, onChange, options }: Base & { options: readonly string[] }): JSX.Element {
  return (
    <div className={`field${error ? " field--invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={onChange} aria-invalid={error ? true : undefined}>
        <option value="">Select…</option>
        {options.map((option) => <option key={option} value={option}>{option}</option>)}
      </select>
      {error && <span className="error">{error}</span>}
    </div>
  );
}
