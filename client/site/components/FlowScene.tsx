/**
 * La scène du Hero : une action traverse l'infrastructure, et le contrôle décide.
 *
 * ## Pourquoi du SVG et pas de la 3D
 *
 * La consigne était d'employer la 3D « uniquement lorsque cela apporte une vraie valeur ».
 * Ce que cette scène doit faire comprendre est une **séquence** — une requête entre, huit
 * contrôles s'appliquent, une décision sort. C'est de la topologie et du temps, pas du
 * volume. Un moteur 3D coûterait ici 500 ko et une charge GPU pour dessiner ce qu'un
 * tracé vectoriel dit mieux : des lignes, des nœuds, et une lumière qui se déplace.
 *
 * Le gain est direct : la scène pèse quelques kilo-octets, elle est nette sur tout écran,
 * elle reste lisible sans JavaScript, et elle n'empêche jamais le texte de s'afficher.
 *
 * ## Les trois issues, et pourquoi elles défilent
 *
 * Le produit a trois réponses et c'est sa caractéristique la plus mal comprise — presque
 * toutes les intégrations traitent « en attente » comme un « oui ». La scène les montre
 * donc l'une après l'autre, dans l'ordre où elles coûtent de plus en plus cher à
 * confondre : autorisée, retenue, refusée.
 *
 * ## Au repos
 *
 * L'état initial est l'état ALLOW entièrement dessiné : une capture d'écran, un aperçu de
 * lien ou `prefers-reduced-motion` montrent une scène complète et juste. Rien n'attend un
 * observateur pour devenir visible.
 */

import { useEffect, useRef, useState } from "react";

type Outcome = "allow" | "hold" | "block";

interface Stage {
  readonly id: string;
  readonly label: string;
}

/*
 * Les huit contrôles, dans l'ordre réel du plan d'autorité. Ce ne sont pas des mots
 * choisis pour remplir un schéma : chacun correspond à une étape que le produit exécute.
 */
const STAGES: readonly Stage[] = [
  { id: "identity", label: "Identity" },
  { id: "policy", label: "Policy" },
  { id: "mandate", label: "Mandate" },
  { id: "risk", label: "Risk" },
  { id: "decision", label: "Decision" },
];

const OUTCOMES: Record<Outcome, { verdict: string; detail: string; action: string }> = {
  allow: {
    verdict: "ALLOW",
    detail: "Single-use grant issued · bound to this agent, this action hash, this destination",
    action: "stripe.refund · 180.00 USD",
  },
  hold: {
    verdict: "APPROVAL_REQUIRED",
    detail: "Held for a human in this organization · nothing reaches the tool",
    action: "stripe.refund · 48,000.00 USD",
  },
  block: {
    verdict: "BLOCK",
    detail: "No policy allows it · deny by default · zero downstream calls",
    action: "customer.delete",
  },
};

const CYCLE_MS = 5200;

export function FlowScene(): JSX.Element {
  const [outcome, setOutcome] = useState<Outcome>("allow");
  /*
   * Lu à l'initialisation plutôt que posé depuis l'effet.
   *
   * `setRunning(true)` dans le corps de l'effet déclenchait un second rendu immédiat —
   * et la règle de lint de React le refuse à juste titre : la préférence de mouvement
   * est connue avant le premier rendu, donc la demander à ce moment-là est à la fois
   * plus simple et plus juste. La scène peint directement son état définitif.
   */
  const [running] = useState(
    () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: no-preference)").matches,
  );
  const frame = useRef(0);

  useEffect(() => {
    if (!running) return;
    const order: Outcome[] = ["allow", "hold", "block"];
    const timer = window.setInterval(() => {
      frame.current = (frame.current + 1) % order.length;
      setOutcome(order[frame.current]!);
    }, CYCLE_MS);
    return () => window.clearInterval(timer);
  }, [running]);

  const current = OUTCOMES[outcome];

  return (
    <div className="flow" data-outcome={outcome} data-running={running ? "yes" : "no"}>
      <svg
        className="flow__svg"
        viewBox="0 0 520 300"
        role="img"
        aria-label={`An action from an agent passes through identity, policy, mandate, risk and decision. Outcome: ${current.verdict}.`}
      >
        <defs>
          <linearGradient id="rail" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#16213A" />
            <stop offset="50%" stopColor="#243355" />
            <stop offset="100%" stopColor="#16213A" />
          </linearGradient>
          <radialGradient id="core">
            <stop offset="0%" stopColor="#7FB0FF" stopOpacity="0.5" />
            <stop offset="60%" stopColor="#4D8DFF" stopOpacity="0.12" />
            <stop offset="100%" stopColor="#4D8DFF" stopOpacity="0" />
          </radialGradient>
          <filter id="soft" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" />
          </filter>
        </defs>

        {/* La halo du centre de contrôle. */}
        <ellipse cx="260" cy="150" rx="150" ry="110" fill="url(#core)" />

        {/* Le rail : le chemin que toute action emprunte. */}
        <line x1="22" y1="150" x2="498" y2="150" stroke="url(#rail)" strokeWidth="1" />

        {/* L'enceinte du plan de contrôle. */}
        <rect
          className="flow__vault"
          x="128" y="78" width="264" height="144" rx="10"
          fill="#080E1B" stroke="#1B2740" strokeWidth="1"
        />
        <text className="flow__vault-label" x="140" y="98">PLACET</text>

        {/* Les cinq contrôles. */}
        {STAGES.map((stage, index) => {
          const x = 158 + index * 51;
          return (
            <g key={stage.id} className="flow__stage" style={{ ["--i" as string]: String(index) }}>
              <line x1={x} y1="118" x2={x} y2="182" stroke="#16213A" strokeWidth="1" />
              <circle className="flow__node" cx={x} cy="150" r="4.5" />
              <text className="flow__stage-label" x={x} y="200" textAnchor="middle">
                {stage.label}
              </text>
            </g>
          );
        })}

        {/* L'origine : l'agent. */}
        <g className="flow__end">
          <circle cx="22" cy="150" r="7" fill="#0D1526" stroke="#243355" />
          <circle className="flow__pulse" cx="22" cy="150" r="7" />
          <text className="flow__end-label" x="22" y="176" textAnchor="middle">Agent</text>
        </g>

        {/* La sortie : le monde, ou son refus. */}
        <g className="flow__end flow__end--out">
          <circle cx="498" cy="150" r="7" fill="#0D1526" stroke="#243355" />
          <text className="flow__end-label" x="498" y="176" textAnchor="middle">Tool</text>
          {/* La croix du refus, dessinée en permanence et révélée par l'état. */}
          <g className="flow__cross">
            <line x1="492" y1="144" x2="504" y2="156" strokeWidth="1.6" strokeLinecap="round" />
            <line x1="504" y1="144" x2="492" y2="156" strokeWidth="1.6" strokeLinecap="round" />
          </g>
        </g>

        {/* L'approbation humaine : un détour, pas un arrêt. */}
        <g className="flow__human">
          <path d="M392 150 L430 150 L430 96 L470 96" fill="none" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx="470" cy="96" r="5.5" />
          <text className="flow__human-label" x="470" y="80" textAnchor="middle">Human</text>
        </g>

        {/* La lumière qui traverse. Un seul objet, dont la trajectoire dépend de l'issue. */}
        <g className="flow__spark" filter="url(#soft)">
          <circle r="5" />
        </g>
        <g className="flow__spark flow__spark--core">
          <circle r="2.4" />
        </g>
      </svg>

      <div className="flow__readout" aria-live="polite">
        <div className="flow__request mono">{current.action}</div>
        <div className={`flow__verdict flow__verdict--${outcome} mono`}>{current.verdict}</div>
        <p className="flow__detail">{current.detail}</p>
      </div>
    </div>
  );
}
