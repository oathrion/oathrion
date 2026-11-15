/**
 * L'écran des connecteurs.
 *
 * ## Ce qu'il remplace, et pourquoi c'est le même écran en apparence seulement
 *
 * `integrations.tsx` affichait une liste de services avec une pastille « Connected » et
 * un bouton qui basculait un booléen. Aucun credential, aucun appel, aucun test. Un
 * exploitant pouvait lire « Slack · Connected » sur un déploiement où rien n'avait jamais
 * joint Slack.
 *
 * Ici, chaque état vient d'un APPEL RÉEL au service. « Connecté » signifie que le
 * fournisseur a répondu, qu'il a nommé un compte, et qu'on sait quand. Un jeton refusé
 * ne produit aucune ligne : le serveur vérifie avant de stocker.
 *
 * ## Cinq états, et pas un booléen
 *
 * Les cinq demandent des gestes différents : rien n'est configuré · le service a refusé ·
 * tout va bien · le dernier appel a échoué · quelqu'un a déconnecté. Un booléen écrase
 * « en erreur » et « révoqué » sur « non connecté », qui sont trois situations et une
 * seule action possible.
 *
 * ## Le jeton n'est ni réaffiché ni conservé en mémoire
 *
 * Le champ est vidé dès l'envoi, dans les deux cas. Ce qui revient du serveur est une
 * empreinte de six caractères — assez pour reconnaître le jeton, inutilisable pour le
 * reconstituer. L'habitude de montrer les quatre derniers caractères du secret en
 * divulgue un fragment.
 */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plug, RefreshCw, ShieldAlert, Unplug } from "lucide-react";

import { Pill } from "@/components/common/badges";
import { ReconcilePanel } from "@/components/connectors/ReconcilePanel";
import { EmptyState, ErrorState, PageHeader, Surface } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import {
  CONNECTOR_STATE_LABELS,
  connectConnector,
  connectorCapabilities,
  disconnectConnector,
  listConnectors,
  testConnector,
  type ConnectorCapability,
  type ConnectorDescription,
  type ConnectorState,
} from "@/lib/api";

const QUERY_KEY = ["/api/connectors"] as const;

/** La teinte de la pastille. Dérivée de l'état, jamais écrite deux fois. */
const STATE_TONE: Record<ConnectorState, "success" | "warning" | "danger" | "neutral"> = {
  connected: "success",
  error: "danger",
  revoked: "warning",
  not_configured: "neutral",
};

/**
 * Ce que l'exploitant doit faire, par état.
 *
 * Écrit ici et non dans le serveur : c'est une phrase d'interface, et le serveur rend
 * déjà le motif technique du fournisseur dans `detail`. Les deux se complètent — le
 * motif dit ce qui s'est passé, celle-ci dit quoi faire.
 */
const STATE_ACTION: Record<ConnectorState, string> = {
  not_configured: "Paste a token to connect this service.",
  connected: "Nothing to do. Test the connection if an agent reports an error.",
  error: "The last call failed. Test again, then reconnect if the token is dead.",
  revoked: "Oathrion forgot the token. Reconnect with a new token to resume.",
};

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export default function ConnectorsPage() {
  const { can } = useAuth();
  const canManage = can("manage");
  const { toast } = useToast();

  const queryClient = useQueryClient();
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<Record<string, ConnectorCapability[]>>({});
  const [guideOpen, setGuideOpen] = useState<Record<string, boolean>>({});

  /*
   * React Query, comme le reste de la console. Un `useEffect` qui appelle `setState`
   * déclenche des rendus en cascade et le lint du dépôt le refuse — à juste titre : la
   * liste des connecteurs est une donnée du serveur, pas un état local à synchroniser.
   */
  const { data, isLoading, isError, error } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listConnectors,
  });
  const connectors = data ?? null;
  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  };

  const handleConnect = async (connector: ConnectorDescription) => {
    const secret = (secrets[connector.id] ?? "").trim();
    if (secret === "") return;
    setBusy(connector.id);
    try {
      const result = await connectConnector(connector.id, secret);
      /*
       * Vidé dans les DEUX cas, succès comme échec. Un jeton refusé reste un jeton : le
       * garder dans l'état du composant le laisserait dans la mémoire de l'onglet et
       * dans un éventuel instantané de l'outil de développement.
       */
      setSecrets((previous) => ({ ...previous, [connector.id]: "" }));
      toast({
        title: result.connected ? `${connector.label} connected` : `${connector.label} refused`,
        /* Le message du FOURNISSEUR, pas une phrase rassurante de notre cru. */
        description: result.detail,
        variant: result.connected ? undefined : "destructive",
      });
      await reload();
    } catch (cause) {
      toast({
        title: "The connection failed",
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async (connector: ConnectorDescription) => {
    setBusy(connector.id);
    try {
      const result = await testConnector(connector.id);
      toast({
        title: result.ok ? `${connector.label} is answering` : `${connector.label} is not answering`,
        description: result.detail,
        variant: result.ok ? undefined : "destructive",
      });
      await reload();
    } catch (cause) {
      toast({
        title: "The test failed",
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleCapabilities = async (connector: ConnectorDescription) => {
    setBusy(connector.id);
    try {
      const result = await connectorCapabilities(connector.id);
      setCapabilities((previous) => ({ ...previous, [connector.id]: result.capabilities }));
    } catch (cause) {
      toast({
        title: "Could not read the capabilities",
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  const handleDisconnect = async (connector: ConnectorDescription) => {
    setBusy(connector.id);
    try {
      const result = await disconnectConnector(connector.id);
      toast({
        /*
         * `remoteStillValid` est la raison d'être de ce toast. Écrire « déconnecté » tout
         * court laisserait croire que le jeton est mort, alors que GitHub le considère
         * valide jusqu'à ce que son propriétaire le supprime.
         */
        title: result.remoteStillValid
          ? `${connector.label} disconnected — the token stays valid at the provider`
          : `${connector.label} disconnected`,
        description: result.detail,
        variant: result.remoteStillValid ? "destructive" : undefined,
      });
      setCapabilities((previous) => ({ ...previous, [connector.id]: [] }));
      await reload();
    } catch (cause) {
      toast({
        title: "The disconnection failed",
        description: cause instanceof Error ? cause.message : String(cause),
        variant: "destructive",
      });
    } finally {
      setBusy(null);
    }
  };

  if (isError) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : "Could not read the connectors."}
        onRetry={() => void reload()}
      />
    );
  }

  if (isLoading || connectors === null) {
    return (
      <div className="space-y-6">
        <PageHeader title="Connectors" subtitle="Services Oathrion really reaches." />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connectors"
        subtitle="Services Oathrion really reaches. Each state comes from a call to the provider."
      />

      {connectors.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connector in this build"
          description="The catalogue is empty. An MCP server can be plugged in by configuration with OATHRION_TOOLS."
        />
      ) : null}

      {connectors.map((connector) => {
        const state = connector.status.state;
        const caps = capabilities[connector.id] ?? [];
        const working = busy === connector.id;

        return (
          <Surface key={connector.id} className="space-y-4 p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <h3 className="text-base font-semibold">{connector.label}</h3>
                  <Pill tone={STATE_TONE[state]} dot>
                    {CONNECTOR_STATE_LABELS[state]}
                  </Pill>
                </div>
                <p className="text-sm text-muted-foreground">{connector.description}</p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <div>Governed verbs</div>
                <div className="font-mono">{connector.actions.join(" · ")}</div>
              </div>
            </div>

            <p className="text-sm">{STATE_ACTION[state]}</p>

            {/*
              Le détail du fournisseur, affiché tel quel. C'est lui qui distingue
              « jeton révoqué » de « quota dépassé », et Oathrion ne le reformule pas.
            */}
            {connector.status.detail ? (
              <p className="rounded-md bg-muted/50 p-3 text-xs font-mono">{connector.status.detail}</p>
            ) : null}

            {state !== "not_configured" ? (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-4">
                <div>
                  <dt className="text-muted-foreground">Account</dt>
                  <dd className="font-mono">{connector.status.account || "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Token fingerprint</dt>
                  <dd className="font-mono">{connector.status.fingerprint || "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Connected by</dt>
                  <dd>{connector.status.connectedBy || "—"}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Last test</dt>
                  <dd>{formatDate(connector.status.lastCheckedAt)}</dd>
                </div>
                {(connector.status.scopes ?? []).length > 0 ? (
                  <div className="col-span-2 sm:col-span-4">
                    <dt className="text-muted-foreground">Scopes announced by the service</dt>
                    <dd className="font-mono">{(connector.status.scopes ?? []).join(", ")}</dd>
                  </div>
                ) : null}
              </dl>
            ) : null}

            {caps.length > 0 ? (
              <ul className="space-y-1 text-xs">
                {caps.map((capability) => (
                  <li key={capability.action} className="flex flex-wrap items-baseline gap-2">
                    <Pill tone={capability.available ? "success" : "neutral"}>
                      {capability.available ? "available" : "not confirmed"}
                    </Pill>
                    <span className="font-medium">{capability.label}</span>
                    <span className="font-mono text-muted-foreground">{capability.action}</span>
                    {/* Le motif, quand elle ne l'est pas. Jamais `available: true` par défaut. */}
                    {capability.reason ? (
                      <span className="text-muted-foreground">— {capability.reason}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}

            {canManage ? (
              <div className="space-y-3 border-t pt-4">
                <button
                  type="button"
                  className="text-xs underline"
                  onClick={() =>
                    setGuideOpen((previous) => ({ ...previous, [connector.id]: !previous[connector.id] }))
                  }
                >
                  {guideOpen[connector.id] ? "Hide" : "How to create the credential"}
                </button>
                {guideOpen[connector.id] ? (
                  /*
                   * La procédure vient du SERVEUR (`credentialGuide`), pas de cet écran :
                   * c'est le connecteur qui sait quelles permissions demander, et une
                   * copie ici prendrait du retard sur lui.
                   */
                  <p className="rounded-md border p-3 text-xs leading-relaxed">
                    {connector.credentialGuide}
                  </p>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    /*
                     * `type="password"` : le jeton ne doit pas rester lisible à l'écran
                     * pendant qu'on partage sa fenêtre. `autoComplete="off"` pour que le
                     * navigateur ne le propose pas ailleurs.
                     */
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="Paste the token"
                    className="max-w-xs font-mono"
                    value={secrets[connector.id] ?? ""}
                    onChange={(event) =>
                      setSecrets((previous) => ({ ...previous, [connector.id]: event.target.value }))
                    }
                    data-testid={`input-connector-secret-${connector.id}`}
                  />
                  <Button
                    size="sm"
                    disabled={working || (secrets[connector.id] ?? "").trim() === ""}
                    onClick={() => void handleConnect(connector)}
                    data-testid={`button-connect-${connector.id}`}
                  >
                    <KeyRound className="mr-1 h-3.5 w-3.5" />
                    {state === "connected" ? "Replace the token" : "Connect"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working || state === "not_configured"}
                    onClick={() => void handleTest(connector)}
                    data-testid={`button-test-${connector.id}`}
                  >
                    <RefreshCw className="mr-1 h-3.5 w-3.5" />
                    Test the connection
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={working || state !== "connected"}
                    onClick={() => void handleCapabilities(connector)}
                    data-testid={`button-capabilities-${connector.id}`}
                  >
                    <ShieldAlert className="mr-1 h-3.5 w-3.5" />
                    Real permissions
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={working || state === "not_configured" || state === "revoked"}
                    onClick={() => void handleDisconnect(connector)}
                    data-testid={`button-disconnect-${connector.id}`}
                  >
                    <Unplug className="mr-1 h-3.5 w-3.5" />
                    Disconnect
                  </Button>
                </div>
              </div>
            ) : (
              <p className="border-t pt-4 text-xs text-muted-foreground">
                Connecting, testing and disconnecting require the "manage" capability.
              </p>
            )}

            {/* La réconciliation : relire chez le service ce qui s'est fait sans Oathrion. */}
            {canManage && connector.reconcilable && state === "connected" ? (
              <ReconcilePanel connectorId={connector.id} label={connector.label} />
            ) : null}
          </Surface>
        );
      })}
    </div>
  );
}
