import { Switch, Route, Router, Redirect } from "wouter";
import { useHashPath, useHashSearch } from "@/lib/hash-location";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { sessionInfo } from "@/lib/api";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme";
import { ARIAProvider, useARIA } from "@/lib/store";
import { AuthProvider } from "@/lib/auth";
import { AppShell } from "@/components/layout/AppShell";

import DashboardPage from "@/pages/dashboard";
import HomePage from "@/pages/home";
import SharePage from "@/pages/share";
import DecidePage from "@/pages/decide";
import LocalSettingsPage from "@/pages/local-settings";
import { useLocalMode } from "@/lib/local-mode";
import OnboardingPage from "@/pages/onboarding";
import AgentsPage from "@/pages/agents";
import AgentNewPage from "@/pages/agent-new";
import AgentConnectPage from "@/pages/agent-connect";
import AgentDetailPage from "@/pages/agent-detail";
import ExecutionsPage from "@/pages/executions";
import ExecutionDetailPage from "@/pages/execution-detail";
import PoliciesPage from "@/pages/policies";
import ApprovalsPage from "@/pages/approvals";
import IntegrationsPage from "@/pages/integrations";
import AnalyticsPage from "@/pages/analytics";
import FeedbackPage from "@/pages/feedback";
import LocalFeedbackPage from "@/pages/local-feedback";
import ConnectorsPage from "@/pages/connectors";
import FirewallPage from "@/pages/firewall";
import CoveragePage from "@/pages/coverage";
import SettingsPage from "@/pages/settings";
import TeamPage from "@/pages/team";
import ServersPage from "@/pages/servers";
import ActivityPage from "@/pages/activity";
import ProtectionPage from "@/pages/protection";
import MandatesPage from "@/pages/mandates";
import NotFound from "@/pages/not-found";
import { ConsoleUpdater } from "@/components/ConsoleUpdater";

/**
 * Sous `oathrion wrap`, le parcours guidé (brancher GitHub, Slack…) ne concerne pas la
 * personne : elle vient approuver ce que son agent attend. Trouvé dans l'essai réel du
 * 28 octobre 2026 (STRESS-TEST-LOG §5.50).
 */
/*
 * L'entrée. Une équipe : le parcours guidé. En local (`oathrion wrap`) : ce qui attend une
 * décision s'il y en a (le bouton « Décider » d'une notification y mène), sinon le BILAN, en tête
 * d'« Activity » (priorité du 6 novembre : le reçu, moment « waouh ») ; vide, il mène à
 * « Serveurs » et « Protection », qui répondent à la première question — est-ce que ça marche ?
 */
function HomeRedirect() {
  const session = useQuery({ queryKey: ["/api/auth/session", "mode"], queryFn: sessionInfo });
  const { approvals, loading } = useARIA();
  if (session.isLoading) return null;
  if (!session.data?.localMode) return <Redirect to="/onboarding" />;
  if (loading) return null;
  /* Le fil d'actualité (11 novembre) ; une décision qui attend passe d'abord. */
  return <Redirect to={approvals.some((a) => a.status === "pending") ? "/approvals" : "/home"} />;
}

/* En local, le tableau de bord d'équipe (créer un agent, simuler un achat) n'a pas d'objet : l'accueil. */
function DashboardOrHome() {
  const local = useLocalMode();
  return local ? <Redirect to="/home" /> : <DashboardPage />;
}

/* En local, les réglages de la machine ; les réglages d'équipe sont sous « Details », « Advanced settings ». */
function SettingsOrLocal() {
  const local = useLocalMode();
  return local ? <LocalSettingsPage /> : <SettingsPage />;
}

/* En local, le retour part par un e-mail que la personne relit ; en équipe, par la base de l'organisation. */
function FeedbackOrLocal() {
  const local = useLocalMode();
  return local ? <LocalFeedbackPage /> : <FeedbackPage />;
}

function AppRouter() {
  return (
    <Switch>
      {/* L'entrée : le parcours guidé pour une équipe, les approbations sous `oathrion wrap`. */}
      <Route path="/" component={HomeRedirect} />
      <Route path="/onboarding" component={OnboardingPage} />
      <Route path="/home" component={HomePage} />
      <Route path="/share" component={SharePage} />
      <Route path="/decide" component={DecidePage} />
      <Route path="/dashboard" component={DashboardOrHome} />
      <Route path="/agents" component={AgentsPage} />
      <Route path="/agents/new" component={AgentNewPage} />
      {/* Avant `/agents/:id` : sinon « connect » serait lu comme un identifiant d'agent. */}
      <Route path="/agents/connect" component={AgentConnectPage} />
      <Route path="/agents/:id" component={AgentDetailPage} />
      <Route path="/executions" component={ExecutionsPage} />
      <Route path="/executions/:id" component={ExecutionDetailPage} />
      <Route path="/policies" component={PoliciesPage} />
      <Route path="/approvals" component={ApprovalsPage} />
      <Route path="/integrations" component={IntegrationsPage} />
      <Route path="/analytics" component={AnalyticsPage} />
      <Route path="/firewall" component={FirewallPage} />
      <Route path="/coverage" component={CoveragePage} />
      <Route path="/connectors" component={ConnectorsPage} />
      <Route path="/feedback" component={FeedbackOrLocal} />
      <Route path="/settings" component={SettingsOrLocal} />
      <Route path="/settings/advanced" component={SettingsPage} />
      <Route path="/team" component={TeamPage} />
      <Route path="/servers" component={ServersPage} />
      <Route path="/activity" component={ActivityPage} />
      <Route path="/protection" component={ProtectionPage} />
      <Route path="/mandates" component={MandatesPage} />
      {/* Les anciennes adresses françaises (préversion 0), gardées pour les liens déjà donnés. */}
      <Route path="/equipe" component={TeamPage} />
      <Route path="/serveurs" component={ServersPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider>
          {/*
            The auth gate sits outside the data provider on purpose: no query
            fires until a session token exists, so the app never renders a wall
            of 401s.
          */}
          <AuthProvider>
            <ARIAProvider>
              <Router hook={useHashPath} searchHook={useHashSearch} hrefs={(href) => `#${href}`}>
                <AppShell>
                  <AppRouter />
                </AppShell>
              </Router>
              <Toaster />
              <ConsoleUpdater />
            </ARIAProvider>
          </AuthProvider>
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
