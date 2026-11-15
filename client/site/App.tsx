/**
 * Le routage du site public.
 *
 * **Par chemin, et non par hash**, ce qui est l'inverse de la console — et c'est ce qui
 * rend les deux surfaces compatibles sur un même domaine. La console vit derrière
 * `/console#/dashboard` ; le site possède tous les vrais chemins. Aucune des deux ne peut
 * intercepter l'autre, et aucune ligne de la console n'a été modifiée.
 *
 * Une page = une question, et la réponse tient dans son titre. C'est aussi ce qui décide
 * du découpage : il n'y a pas de page sans question à laquelle elle répond.
 */

import { useEffect } from "react";
import { Route, Switch, useLocation } from "wouter";
import { Footer, Nav } from "./components/Shell";
import { pageView } from "./lib/analytics";

import HomePage from "./pages/home";
import PilotPage from "./pages/pilot";
import WaitlistPage from "./pages/waitlist";
import ProductPage from "./pages/product";
import HowItWorksPage from "./pages/how-it-works";
import UseCasesPage from "./pages/use-cases";
import AgentPaymentsPage from "./pages/agent-payments";
import DevelopersPage from "./pages/developers";
import PricingPage from "./pages/pricing";
import AboutPage from "./pages/about";
import RoadmapPage from "./pages/roadmap";
import SecurityPage from "./pages/security";
import ContactPage from "./pages/contact";
import TermsPage from "./pages/terms";
import PrivacyPage from "./pages/privacy";
import NotFoundPage from "./pages/not-found";

/**
 * Remonte en haut à chaque changement de page, et annonce la page.
 *
 * Un routeur à chemin conserve la position de défilement, donc arriver au milieu d'une
 * page après avoir cliqué dans le pied de page est le comportement par défaut — et il
 * passe pour un bug. L'ancre `#...` est préservée : un lien vers une section doit encore
 * viser sa section.
 */
function Navigation(): null {
  const [location] = useLocation();

  useEffect(() => {
    if (window.location.hash) return;
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [location]);

  useEffect(() => {
    pageView(location);
  }, [location]);

  return null;
}

export function App(): JSX.Element {
  return (
    <>
      <Navigation />
      <Nav />
      <main id="main">
        <Switch>
          <Route path="/" component={HomePage} />
          <Route path="/product" component={ProductPage} />
          <Route path="/how-it-works" component={HowItWorksPage} />
          <Route path="/use-cases" component={UseCasesPage} />
          <Route path="/agent-payments" component={AgentPaymentsPage} />
          <Route path="/developers" component={DevelopersPage} />
          <Route path="/pricing" component={PricingPage} />
          <Route path="/pilot" component={PilotPage} />
          <Route path="/waitlist" component={WaitlistPage} />
          <Route path="/about" component={AboutPage} />
          <Route path="/roadmap" component={RoadmapPage} />
          <Route path="/security" component={SecurityPage} />
          <Route path="/contact" component={ContactPage} />
          <Route path="/terms" component={TermsPage} />
          <Route path="/privacy" component={PrivacyPage} />
          <Route component={NotFoundPage} />
        </Switch>
      </main>
      <Footer />
    </>
  );
}
