/**
 * `/waitlist` — elle répond à : **puis-je avoir un accès anticipé ?**
 *
 * Deux décisions tiennent cette page.
 *
 * **Un seul champ est obligatoire.** Une liste d'attente n'a pas à qualifier : plus on
 * demande, moins on reçoit, et les trois autres champs servent à nous, pas au visiteur.
 * Ils sont donc marqués facultatifs et le disent.
 *
 * **Aucune position, aucun parrainage affiché.** L'architecture les prévoit
 * (`lib/submit.ts` rend une `reference` quand un point de collecte existe), mais tant
 * qu'aucun backend ne les calcule, afficher « vous êtes 1 247e » serait un chiffre
 * inventé — exactement ce que ce produit refuse de faire ailleurs.
 */

import { useState, type FormEvent } from "react";
import { Backdrop, Eyebrow, Reveal, Rise, Section } from "../components/Shell";
import { EVENTS, track } from "../lib/analytics";
import { activeTransport, isTrap, submit, validate, type Errors, type WaitlistSignup } from "../lib/submit";

const ROLES = ["Developer", "Founder", "Enterprise", "Investor", "Researcher", "Other"];

export default function WaitlistPage(): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({
    email: "", name: "", country: "", role: "", useCase: "", website: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  const [state, setState] = useState<"idle" | "sending" | "sent" | "failed">("idle");
  const [failure, setFailure] = useState("");
  const [touched, setTouched] = useState(false);

  const set = (key: string) => (event: { target: { value: string } }) => {
    if (!touched) { setTouched(true); track(EVENTS.waitlistStart); }
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
    if (isTrap(values)) { setState("sent"); return; }

    const found = validate(values, ["email"]);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      track(EVENTS.waitlistError, { fields: Object.keys(found).join(",") });
      document.getElementById("wl-email")?.focus();
      return;
    }

    setState("sending");
    const signup: WaitlistSignup = {
      kind: "waitlist",
      email: values.email!, name: values.name!, country: values.country!,
      role: values.role!, useCase: values.useCase!,
    };
    const outcome = await submit(signup);
    if (outcome.ok) {
      track(EVENTS.waitlistSubmit, { via: outcome.via });
      setState("sent");
    } else {
      track(EVENTS.waitlistError, { reason: outcome.reason });
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
            LE TITRE SUIT LE TRANSPORT, et c'est une correction.
            Il disait « You are on the list. » dans les trois cas. Avec le transport
            `mailto`, rien n'a ete envoye : le navigateur a ouvert un brouillon, et la
            personne doit encore appuyer sur « envoyer ». Le corps du texte le disait
            deja ; le titre, lui, affirmait un etat accompli qui ne l'etait pas — et un
            titre se lit, un paragraphe se survole.
          */}
          <h1 className="h1">
            {activeTransport("waitlist") === "mailto"
              ? "One last step: press send."
              : "You are on the list."}
          </h1>
          <p className="lead">
            {activeTransport("waitlist") === "mailto"
              ? "Your mail client is open with the message ready. Nothing has been sent yet — we did not want to send anything on your behalf. Press send and you are in."
              : "One message when the commercial release opens. Nothing before that."}
          </p>
          <p className="small">
            No newsletter, no follow-ups, no sharing your address. If you want to move faster
            than the queue, the <a href="/pilot" style={{ color: "var(--flow)" }}>Founding Pilot</a> is open to five companies.
          </p>
        </div>
      </Section>
    );
  }

  return (
    <>
      <div className="hero">
        <Backdrop src="/img/field.jpg" variant="soft" priority />
        <div className="glow hero__glow" aria-hidden="true" />
        <div className="glow hero__glow--low" aria-hidden="true" />
        <div className="shell rel">
          <div className="hero__grid">
            <div className="stack-5">
              <Rise><Eyebrow>Global launch</Eyebrow></Rise>
              <Rise delay={60}><h1 className="display">Be there when it opens.</h1></Rise>
              <Rise delay={120}>
                <p className="lead measure">
                  The commercial release is still being built. Join the list and you will hear
                  once, the day it opens — in signup order, wherever you are.
                </p>
              </Rise>
              <Rise delay={180}>
                <ul className="list">
                  <li><strong className="fg">One message, ever.</strong> No newsletter, no drip campaign, no reminders.</li>
                  <li><strong className="fg">One required field.</strong> The rest helps us decide which regions open first.</li>
                  <li><strong className="fg">Your address stays here.</strong> It is never shared, and never sent to an analytics provider.</li>
                </ul>
              </Rise>
            </div>

            <Rise delay={240}>
              <form className="form panel" style={{ padding: "clamp(1.5rem, 3vw, 2rem)" }} onSubmit={(event) => void onSubmit(event)} noValidate>
                <div className={`field${errors.email ? " field--invalid" : ""}`}>
                  <label htmlFor="wl-email">Email</label>
                  <input
                    id="wl-email" className="input" type="email" autoComplete="email"
                    placeholder="you@company.com"
                    value={values.email} onChange={set("email")}
                    aria-invalid={errors.email ? true : undefined}
                    aria-describedby={errors.email ? "wl-email-error" : undefined}
                  />
                  {errors.email && <span className="error" id="wl-email-error">{errors.email}</span>}
                </div>

                <div className="form__row form__row--2">
                  <div className="field">
                    <label htmlFor="wl-name">Name <span className="hint" style={{ display: "inline" }}>— optional</span></label>
                    <input id="wl-name" className="input" autoComplete="name" value={values.name} onChange={set("name")} />
                  </div>
                  <div className="field">
                    <label htmlFor="wl-country">Country <span className="hint" style={{ display: "inline" }}>— optional</span></label>
                    <input id="wl-country" className="input" autoComplete="country-name" value={values.country} onChange={set("country")} />
                  </div>
                </div>

                <div className="field">
                  <label htmlFor="wl-role">I am a <span className="hint" style={{ display: "inline" }}>— optional</span></label>
                  <select id="wl-role" className="select" value={values.role} onChange={set("role")}>
                    <option value="">Select…</option>
                    {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                  </select>
                </div>

                <div className="field">
                  <label htmlFor="wl-use">What would you use it for? <span className="hint" style={{ display: "inline" }}>— optional</span></label>
                  <textarea id="wl-use" className="textarea" style={{ minHeight: "4.5rem" }} value={values.useCase} onChange={set("useCase")} />
                </div>

                <div className="trap" aria-hidden="true">
                  <label htmlFor="wl-website">Website</label>
                  <input id="wl-website" name="website" tabIndex={-1} autoComplete="off" value={values.website} onChange={set("website")} />
                </div>

                {state === "failed" && (
                  <div className="form__status form__status--error" role="alert">
                    <strong>{failure}</strong>
                  </div>
                )}

                <button className="btn btn--primary btn--lg" type="submit" disabled={state === "sending"}>
                  {state === "sending" ? "Joining…" : "Join the waitlist"}
                </button>
                {/*
                  * Trois transports, trois phrases vraies. Le `redirect` emmene la
                  * personne sur la page de confirmation du collecteur : le lui dire
                  * AVANT evite qu'elle croie avoir quitte le site par erreur.
                  */}
                <span className="micro">
                  {activeTransport("waitlist") === "mailto"
                    ? "Opens your mail client, already filled in. Nothing is sent without you."
                    : activeTransport("waitlist") === "redirect"
                      ? "Takes you to our list provider to confirm. We will only write once, when it opens."
                      : "We will only write once, when it opens."}
                </span>
              </form>
            </Rise>
          </div>
        </div>
      </div>

      <Section line tight>
        <div className="grid grid--3">
          {[
            { t: "Early access", d: "The list opens before the public release, in signup order." },
            { t: "A say in what ships", d: "Early users shape what the first commercial version covers — the roadmap is published and it moves." },
            { t: "No commitment", d: "Joining the list is not a purchase, a trial, or a contract. Leave at any time by replying once." },
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
    </>
  );
}
