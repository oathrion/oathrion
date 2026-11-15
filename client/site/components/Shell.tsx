/**
 * La coque : navigation, pied de page, et les primitives que toutes les pages partagent.
 *
 * Elles vivent ensemble parce qu'elles sont le vocabulaire du site. Un `Section`, un
 * `Eyebrow` et un `Reveal` employés partout de la même façon sont ce qui fait qu'une
 * quinzaine de pages se ressemblent sans être un gabarit.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { MARK_PATH, MARK_VIEWBOX } from "@shared/brand-mark";

import { EVENTS, track } from "../lib/analytics";

/* ------------------------------------------------------------------ reveal */

/**
 * L'apparition à l'entrée dans le champ.
 *
 * Observé une fois puis **désabonné** : la page ne rejoue rien quand on remonte. Une
 * section qui se ré-anime au retour est une page qui bouge au moment précis où le lecteur
 * veut relire.
 *
 * Sans JavaScript ou en mouvement réduit, `.reveal` est déjà à son état final — c'est la
 * classe `js` posée sur `<html>` par `main.tsx` qui arme l'effet, jamais l'inverse.
 */
export function Reveal({
  children,
  delay = 0,
  as: Tag = "div",
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  as?: "div" | "section" | "li" | "article";
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    if (!window.matchMedia("(prefers-reduced-motion: no-preference)").matches) {
      node.classList.add("is-in");
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          node.classList.add("is-in");
          observer.disconnect();
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.08 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    // @ts-expect-error -- Tag est une union étroite de balises connues
    <Tag ref={ref} className={`reveal ${className}`} style={{ transitionDelay: `${delay}ms` }}>
      {children}
    </Tag>
  );
}

/**
 * L'entrée du contenu au-dessus de la ligne de flottaison — **sans JavaScript**.
 *
 * `Reveal` attend un `IntersectionObserver`, donc il attend que le fil principal soit
 * libre. Mesuré : pendant que le fragment WebGL de 747 ko se compilait, le titre du Hero
 * est resté invisible plusieurs secondes sur une machine à deux cœurs — la page avait
 * fini de charger et il n'y avait rien à lire.
 *
 * Ce qui est déjà visible au chargement n'a donc rien à observer : une animation CSS
 * démarre toute seule, et son état final est l'état par défaut. Le texte ne dépend plus
 * d'aucun script, et surtout pas du plus lourd de la page.
 */
export function Rise({
  children,
  delay = 0,
  className = "",
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}): JSX.Element {
  return (
    <div className={`rise ${className}`} style={{ animationDelay: `${delay}ms` }}>
      {children}
    </div>
  );
}

/* ----------------------------------------------------------------- pieces */

export function Eyebrow({ children, mute }: { children: ReactNode; mute?: boolean }): JSX.Element {
  return <div className={`label${mute ? " label--mute" : ""}`}>{children}</div>;
}

/* --------------------------------------------------------------- backdrop */

/**
 * Une photographie posée DERRIÈRE une section, jamais à côté.
 *
 * Le brief écartait les illustrations génériques et les photos de banque d'images
 * employées comme sujet. Employées comme **matière** c'est autre chose : une surface
 * sombre, hors foyer, à vingt ou quarante pour cent, donne au fond une profondeur qu'un
 * dégradé CSS n'atteint pas — et ne raconte rien, donc ne peut rien promettre de faux.
 *
 * Trois propriétés la rendent inoffensive, et elles sont dans `shell.css` :
 * elle est en `position: absolute` sous le contenu, elle est voilée par un dégradé qui
 * va vers le fond de la page, et elle ne contribue à aucune hauteur. Si le fichier
 * manque ou que le réseau abandonne, la page est identique à la lettre.
 *
 * `decorative` au sens de l'accessibilité : `alt=""` ET `aria-hidden`, parce qu'une
 * image qui ne porte aucune information doit être absente de la lecture d'écran, pas
 * annoncée comme une image sans nom.
 */
export function Backdrop({
  src,
  variant,
  priority,
}: {
  src: string;
  variant?: "left" | "wide" | "soft";
  priority?: boolean;
}): JSX.Element {
  return (
    <div className={`backdrop${variant ? ` backdrop--${variant}` : ""}`} aria-hidden="true">
      <img
        src={src}
        alt=""
        /*
         * Au-dessus de la ligne de flottaison on la charge tout de suite ; ailleurs on la
         * laisse pour plus tard. `lazy` sur une image de Hero la fait arriver APRÈS le
         * premier rendu, ce qui produit exactement le clignotement qu'on veut éviter.
         */
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        draggable={false}
      />
    </div>
  );
}

export function Section({
  children,
  id,
  tight,
  line,
  className = "",
  backdrop,
  backdropVariant,
  wide,
}: {
  children: ReactNode;
  id?: string;
  tight?: boolean;
  line?: boolean;
  className?: string;
  /** Chemin d'une image de fond. Le fond est plein cadre, le contenu reste dans la coque. */
  backdrop?: string;
  backdropVariant?: "left" | "wide" | "soft";
  wide?: boolean;
}): JSX.Element {
  return (
    <section
      id={id}
      className={`section${tight ? " section--tight" : ""}${line ? " section--line" : ""}${backdrop ? " section--bg" : ""} ${className}`}
    >
      {backdrop && <Backdrop src={backdrop} variant={backdropVariant} />}
      <div className={`shell${wide ? " shell--wide" : ""} rel`}>{children}</div>
    </section>
  );
}

export function CTA({
  href,
  children,
  variant = "primary",
  from,
  large,
  external,
}: {
  href: string;
  children: ReactNode;
  variant?: "primary" | "ghost";
  from: string;
  large?: boolean;
  external?: boolean;
}): JSX.Element {
  const className = `btn btn--${variant}${large ? " btn--lg" : ""}`;
  const onClick = () => track(EVENTS.ctaClick, { from, to: href, label: String(children) });

  if (external) {
    return (
      <a className={className} href={href} onClick={onClick} rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

/* --------------------------------------------------------------------- nav */

const PRODUCT_LINKS = [
  { href: "/product", label: "Product", note: "What Oathrion does, end to end" },
  { href: "/how-it-works", label: "How it works", note: "One action, eight controls" },
  { href: "/security", label: "Security", note: "What is guaranteed, what is not" },
];
const SOLUTION_LINKS = [
  { href: "/use-cases", label: "Use cases", note: "Where Oathrion fits" },
  { href: "/agent-payments", label: "Agent payments", note: "Mandates your bank can verify" },
  { href: "/pilot", label: "Founding Pilot", note: "Five companies, hands-on" },
];
const COMPANY_LINKS = [
  { href: "/about", label: "About", note: "Why Oathrion exists" },
  { href: "/roadmap", label: "Roadmap", note: "What is built, what is next" },
  { href: "/contact", label: "Contact", note: "Reach a human" },
];

interface MenuGroup {
  readonly label: string;
  readonly links: readonly { href: string; label: string; note: string }[];
}

const MENUS: readonly MenuGroup[] = [
  { label: "Product", links: PRODUCT_LINKS },
  { label: "Solutions", links: SOLUTION_LINKS },
  { label: "Company", links: COMPANY_LINKS },
];

const FLAT = [
  { href: "/developers", label: "Developers" },
  { href: "/pricing", label: "Pricing" },
];

export function Nav(): JSX.Element {
  const [scrolled, setScrolled] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [location] = useLocation();

  /*
   * Le panneau mobile est DÉRIVÉ de l'adresse, pas synchronisé avec elle.
   *
   * Le premier jet gardait un booléen et le remettait à faux dans un effet écoutant
   * `location` — ce que la règle `set-state-in-effect` de React refuse, à raison : cela
   * provoque un second rendu immédiat à chaque navigation. En mémorisant plutôt l'adresse
   * À LAQUELLE le panneau a été ouvert, « ouvert » devient une comparaison : dès que
   * l'adresse change, il est fermé, sans effet ni rendu supplémentaire.
   *
   * Et le comportement est meilleur, pas seulement le code : un retour arrière du
   * navigateur ferme désormais le panneau lui aussi, ce que l'effet ne faisait pas.
   */
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const open = openedAt !== null && openedAt === location;

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <header className={`nav${scrolled ? " nav--scrolled" : ""}`}>
      <a className="skip" href="#main">Skip to content</a>
      <div className="shell shell--wide nav__bar">
        <Link href="/" className="nav__brand" aria-label="Oathrion — home">
          <OathrionMark />
          <span>Oathrion</span>
        </Link>

        <nav className="nav__links" aria-label="Main">
          {MENUS.map((group) => (
            <div
              key={group.label}
              className="nav__group"
              onMouseEnter={() => setMenu(group.label)}
              onMouseLeave={() => setMenu(null)}
            >
              <button
                className="nav__trigger"
                aria-expanded={menu === group.label}
                onClick={() => setMenu(menu === group.label ? null : group.label)}
              >
                {group.label}
                <Chevron />
              </button>
              {menu === group.label && (
                <div className="nav__menu">
                  {group.links.map((link) => (
                    <Link key={link.href} href={link.href} className="nav__item">
                      <span className="nav__item-label">{link.label}</span>
                      <span className="nav__item-note">{link.note}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ))}
          {FLAT.map((link) => (
            <Link key={link.href} href={link.href} className="nav__trigger">
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="nav__actions">
          <a className="btn btn--quiet nav__signin" href="/console">Sign in</a>
          <CTA href="/pilot" from="nav">Become a Pilot</CTA>
        </div>

        <button
          className="nav__burger"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpenedAt(open ? null : location)}
        >
          <span data-open={open ? "yes" : "no"} />
        </button>
      </div>

      {open && (
        <div className="nav__sheet">
          <div className="shell stack-5">
            {MENUS.map((group) => (
              <div key={group.label} className="stack-3">
                <div className="label label--mute">{group.label}</div>
                {group.links.map((link) => (
                  <Link key={link.href} href={link.href} className="nav__sheet-link">
                    {link.label}
                    <span className="nav__item-note">{link.note}</span>
                  </Link>
                ))}
              </div>
            ))}
            <div className="stack-3">
              <div className="label label--mute">More</div>
              {FLAT.map((link) => (
                <Link key={link.href} href={link.href} className="nav__sheet-link">
                  {link.label}
                </Link>
              ))}
            </div>
            <div className="stack-3">
              <CTA href="/pilot" from="nav-mobile" large>Become a Pilot</CTA>
              <CTA href="/waitlist" from="nav-mobile" variant="ghost" large>Join the waitlist</CTA>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}

/** La marque : l'anneau torsadé d'Oathrion, le même que dans la console (`shared/brand-mark.ts`). */
function OathrionMark(): JSX.Element {
  return (
    <svg className="nav__mark" viewBox={MARK_VIEWBOX} aria-hidden="true">
      <path fill="currentColor" fillRule="evenodd" d={MARK_PATH} />
    </svg>
  );
}

function Chevron(): JSX.Element {
  return (
    <svg className="nav__chevron" viewBox="0 0 10 6" aria-hidden="true">
      <path d="M1 1.5L5 5L9 1.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ footer */

const FOOTER: readonly { title: string; links: readonly { href: string; label: string }[] }[] = [
  {
    title: "Product",
    links: [
      { href: "/product", label: "Overview" },
      { href: "/how-it-works", label: "How it works" },
      { href: "/use-cases", label: "Use cases" },
      { href: "/agent-payments", label: "Agent payments" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    title: "Developers",
    links: [
      { href: "/developers", label: "Build with Oathrion" },
      { href: "/security", label: "Security" },
      { href: "/roadmap", label: "Roadmap" },
    ],
  },
  {
    title: "Join",
    links: [
      { href: "/pilot", label: "Founding Pilot" },
      { href: "/waitlist", label: "Global waitlist" },
      { href: "/contact", label: "Contact" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/terms", label: "Terms" },
      { href: "/privacy", label: "Privacy" },
    ],
  },
];

export function Footer(): JSX.Element {
  return (
    <footer className="foot">
      <div className="shell shell--wide">
        <div className="foot__top">
          <div className="foot__brand stack-4">
            <Link href="/" className="nav__brand">
              <OathrionMark />
              <span>Oathrion</span>
            </Link>
            <p className="small measure">
              The control plane between autonomous agents and the systems they act on.
              Self-hosted, verifiable, tamper-evident.
            </p>
          </div>

          <div className="foot__cols">
            {FOOTER.map((column) => (
              <div key={column.title} className="stack-3">
                <div className="label label--mute">{column.title}</div>
                {column.links.map((link) => (
                  <Link key={link.href} href={link.href} className="foot__link">
                    {link.label}
                  </Link>
                ))}
              </div>
            ))}
          </div>
        </div>

        <hr className="hairline" />

        <div className="foot__base">
          <span className="micro">© {new Date().getFullYear()} Oathrion. Abdoulaye Diallo.</span>
          <span className="micro">
            Pilot stage — the limits are published, not discovered in production.
          </span>
        </div>
      </div>
    </footer>
  );
}
