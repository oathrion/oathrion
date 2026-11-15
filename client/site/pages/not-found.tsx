/**
 * La page 404.
 *
 * Minimale et mémorable, et elle dit la vérité dans le vocabulaire du produit : une
 * ressource qu'aucune règle ne nomme est refusée. C'est exactement ce qu'Oathrion fait
 * d'une action inconnue — le refus par défaut, appliqué à une URL.
 */
import { Backdrop, CTA, Eyebrow, Reveal } from "../components/Shell";

export default function NotFoundPage(): JSX.Element {
  return (
    <div className="fourohfour">
      {/* Perdu tres loin, dans beaucoup de vide : l'image dit la meme chose que le texte. */}
      <Backdrop src="/img/void.jpg" priority />
      <div className="glow hero__glow" aria-hidden="true" />
      <div className="shell rel">
        <div className="stack-5" style={{ alignItems: "center" }}>
          <Reveal><div className="fourohfour__n">404</div></Reveal>
          <Reveal delay={60}><Eyebrow>Deny by default</Eyebrow></Reveal>
          <Reveal delay={120}>
            <h1 className="h2" style={{ maxWidth: "26ch" }}>
              No route declares this path, so it is refused.
            </h1>
          </Reveal>
          <Reveal delay={180}>
            <p className="lead" style={{ maxWidth: "42ch" }}>
              Which is, more or less, what Oathrion does to an action no policy allows.
            </p>
          </Reveal>
          <Reveal delay={240}>
            <div className="row" style={{ justifyContent: "center" }}>
              <CTA href="/" from="404" large>Back to the start</CTA>
              <CTA href="/product" from="404" variant="ghost" large>See the product</CTA>
            </div>
          </Reveal>
        </div>
      </div>
    </div>
  );
}
