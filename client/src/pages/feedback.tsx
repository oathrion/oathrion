/**
 * L'écran des retours produit.
 *
 * ## Ce qu'il doit faire, et dans quel ordre
 *
 * Deux publics se croisent sur cette page, et le cahier des charges demande de servir
 * les deux sans les mélanger. Quelqu'un qui vient **déposer** un avis veut un formulaire
 * court et partir ; quelqu'un qui vient **trier** veut une liste filtrable et un moyen
 * d'avancer chaque élément. Le formulaire est donc repliable et fermé par défaut : la
 * liste est ce qu'on voit en arrivant, et déposer est une action explicite.
 *
 * ## Trois choses que cet écran refuse de faire
 *
 * **Il n'invente aucun compteur.** Les chiffres des onglets sont comptés sur ce que le
 * serveur a rendu, jamais estimés. Une page vide affiche zéro et le dit.
 *
 * **Il ne révèle pas les auteurs.** Le serveur ne rend qu'un booléen `mine`, et cet
 * écran n'affiche rien de plus. Montrer qui a écrit quoi à l'intérieur d'une
 * organisation décourage les retours honnêtes.
 *
 * **Il ne rend jamais un commentaire comme du balisage.** React échappe le texte qu'on
 * lui passe en enfant ; aucun `dangerouslySetInnerHTML` n'apparaît ici, et c'est
 * délibéré — un commentaire est une donnée non fiable, écrite par un tiers.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquare, ThumbsDown, ThumbsUp } from "lucide-react";
import {
  EmptyState,
  ErrorState,
  FilterTabs,
  PageHeader,
  Surface,
  TableSkeleton,
} from "@/components/common/primitives";
import { useAuth } from "@/lib/auth";
import { useToast } from "@/hooks/use-toast";
import { relativeTime } from "@/lib/format";
import {
  FEEDBACK_CATEGORY_LABELS,
  FEEDBACK_STATUS_LABELS,
  listFeedback,
  setFeedbackStatus,
  submitFeedback,
  type FeedbackCategory,
  type FeedbackItem,
  type FeedbackStatus,
} from "@/lib/api";

const QUERY_KEY = ["/api/feedback"];

/*
 * Les trois groupes de l'onglet, et pourquoi ce découpage plutôt qu'un onglet par
 * statut. Six onglets obligent à cliquer partout pour savoir s'il reste du travail ;
 * « ouverts » répond à la seule question qu'on se pose en arrivant.
 */
type Tab = "open" | "closed" | "all";
const OPEN: FeedbackStatus[] = ["received", "triaging", "planned", "in_progress"];

/** Le pastillage du statut. Les couleurs viennent des jetons, jamais en dur. */
function StatusBadge({ status }: { status: FeedbackStatus }) {
  const tone =
    status === "resolved"
      ? "border-success/30 bg-success-soft text-success"
      : status === "declined"
        ? "border-border bg-muted text-muted-foreground"
        : "border-primary/25 bg-primary/10 text-primary";
  return (
    <span className={`inline-flex rounded-md border px-2 py-0.5 text-xs font-medium ${tone}`}>
      {FEEDBACK_STATUS_LABELS[status]}
    </span>
  );
}

function VoteMark({ vote }: { vote: -1 | 0 | 1 }) {
  if (vote === 0) {
    // Un signalement n'est pas un avis : il ne doit pas compter comme un mécontentement.
    return <span className="text-xs text-muted-foreground" title="Report, no vote">—</span>;
  }
  return vote === 1 ? (
    <ThumbsUp className="h-4 w-4 text-success" aria-label="Positive" />
  ) : (
    <ThumbsDown className="h-4 w-4 text-danger" aria-label="Negative" />
  );
}

export default function FeedbackPage() {
  const { can } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>("open");
  const [composing, setComposing] = useState(false);

  const canTriage = can("manage");

  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: listFeedback,
  });
  const items = useMemo(() => data?.feedback ?? [], [data]);

  const counts = useMemo(
    () => ({
      all: items.length,
      open: items.filter((f) => OPEN.includes(f.status)).length,
      closed: items.filter((f) => !OPEN.includes(f.status)).length,
    }),
    [items],
  );

  const shown = useMemo(() => {
    if (tab === "all") return items;
    const open = tab === "open";
    return items.filter((f) => OPEN.includes(f.status) === open);
  }, [items, tab]);

  const triage = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeedbackStatus }) =>
      setFeedbackStatus(id, status),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
    },
    onError: (e: Error) => toast({ title: "Could not update", description: e.message }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title="Feedback"
        subtitle="What your team says about Oathrion, and what has been done about it."
        actions={
          <button
            type="button"
            onClick={() => setComposing((v) => !v)}
            data-testid="button-compose-feedback"
            className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {composing ? "Close" : "Give feedback"}
          </button>
        }
      />

      {composing && (
        <ComposeForm
          onDone={() => {
            setComposing(false);
            void queryClient.invalidateQueries({ queryKey: QUERY_KEY });
          }}
        />
      )}

      <FilterTabs
        value={tab}
        onChange={setTab}
        options={[
          { value: "open", label: "Open", count: counts.open },
          { value: "closed", label: "Closed", count: counts.closed },
          { value: "all", label: "All", count: counts.all },
        ]}
      />

      {isLoading && <TableSkeleton rows={5} cols={4} />}

      {isError && (
        <ErrorState
          message={error instanceof Error ? error.message : "Could not load feedback."}
          onRetry={() => void refetch()}
        />
      )}

      {!isLoading && !isError && shown.length === 0 && (
        <EmptyState
          icon={MessageSquare}
          /*
           * « Rien d'ouvert » et « rien du tout » ne sont pas la même phrase, et c'est
           * l'écran qui me l'a appris : sur une base vierge l'onglet « Open » annonçait
           * « tout a été résolu ou écarté » alors qu'aucun retour n'avait jamais existé.
           * Un état vide qui laisse croire à du travail fait est un petit mensonge
           * d'interface — exactement ce que ce produit refuse ailleurs.
           */
          title={counts.all === 0 ? "No feedback yet" : tab === "open" ? "Nothing open" : "Nothing closed"}
          description={
            counts.all === 0
              ? "When someone on your team sends feedback, it appears here — and nowhere else."
              : tab === "open"
                ? "Every item has been resolved or set aside."
                : "Nothing has been resolved or set aside yet."
          }
        />
      )}

      {!isLoading && !isError && shown.length > 0 && (
        <div className="space-y-3">
          {shown.map((item) => (
            <FeedbackRow
              key={item.id}
              item={item}
              canTriage={canTriage}
              busy={triage.isPending && triage.variables?.id === item.id}
              onStatus={(status) => triage.mutate({ id: item.id, status })}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FeedbackRow({
  item,
  canTriage,
  busy,
  onStatus,
}: {
  item: FeedbackItem;
  canTriage: boolean;
  busy: boolean;
  onStatus: (status: FeedbackStatus) => void;
}) {
  return (
    <Surface className="p-4" data-testid={`feedback-${item.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <VoteMark vote={item.vote} />
            <span className="text-sm font-medium">{FEEDBACK_CATEGORY_LABELS[item.category]}</span>
            <span className="text-xs text-muted-foreground">·</span>
            <span className="font-mono text-xs text-muted-foreground">{item.feature}</span>
            {item.mine && (
              <span className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground">
                yours
              </span>
            )}
          </div>

          {/* Texte, jamais du balisage. Un commentaire est une donnée non fiable. */}
          {item.comment && (
            <p className="whitespace-pre-wrap text-sm text-muted-foreground">{item.comment}</p>
          )}

          <p className="text-xs text-muted-foreground">
            {relativeTime(item.createdAt)} · version{" "}
            <span className="font-mono">{item.productVersion}</span>
            {item.contextRef && (
              <>
                {" · "}
                <span className="font-mono">{item.contextRef}</span>
              </>
            )}
          </p>

          {item.resolutionNote && (
            <p className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
              {item.resolutionNote}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge status={item.status} />
          {canTriage && (
            <select
              aria-label={`Status of feedback on ${item.feature}`}
              disabled={busy}
              value={item.status}
              onChange={(e) => onStatus(e.target.value as FeedbackStatus)}
              data-testid={`status-${item.id}`}
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
            >
              {Object.entries(FEEDBACK_STATUS_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </Surface>
  );
}

function ComposeForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const [vote, setVote] = useState<-1 | 0 | 1>(0);
  const [category, setCategory] = useState<FeedbackCategory>("experience");
  const [feature, setFeature] = useState("");
  const [comment, setComment] = useState("");

  const send = useMutation({
    mutationFn: () =>
      submitFeedback({
        vote,
        category,
        feature: feature.trim(),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      }),
    onSuccess: () => {
      toast({ title: "Thank you", description: "Your feedback was recorded." });
      onDone();
    },
    /*
     * Le message du serveur, pas un message générique. Il nomme le champ en défaut —
     * « String must contain at most 4000 character(s) » — et une personne qui vient
     * d'écrire un long commentaire a besoin de savoir lequel, pas d'un « erreur ».
     */
    onError: (e: Error) => toast({ title: "Not recorded", description: e.message }),
  });

  const ready = feature.trim().length > 0 && !send.isPending;

  return (
    <Surface className="p-4">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) send.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Where in Oathrion?</span>
            <input
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              placeholder="policies, agents, approvals…"
              maxLength={120}
              required
              data-testid="input-feedback-feature"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            />
          </label>

          <label className="space-y-1.5 text-sm">
            <span className="font-medium">Category</span>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as FeedbackCategory)}
              data-testid="select-feedback-category"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              {Object.entries(FEEDBACK_CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <fieldset className="space-y-1.5 text-sm">
          <legend className="font-medium">Your view</legend>
          <div className="flex gap-2">
            {(
              [
                { v: 1 as const, label: "Works well" },
                { v: 0 as const, label: "Just reporting" },
                { v: -1 as const, label: "Does not work" },
              ]
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setVote(o.v)}
                aria-pressed={vote === o.v}
                data-testid={`vote-${o.v}`}
                className={`rounded-lg border px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${
                  vote === o.v
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border hover:bg-muted"
                }`}
              >
                {o.label}
              </button>
            ))}
          </div>
        </fieldset>

        <label className="space-y-1.5 text-sm">
          <span className="font-medium">
            Anything else <span className="text-muted-foreground">— optional</span>
          </span>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={3}
            maxLength={4000}
            data-testid="input-feedback-comment"
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          />
          {/*
            * Dit avant l'envoi, pas après. Quelqu'un qui s'apprête à coller une trace
            * d'erreur doit savoir que ce champ n'est pas l'endroit pour cela.
            */}
          <span className="block text-xs text-muted-foreground">
            Visible to your organisation only. Do not paste credentials, tokens or
            customer data.
          </span>
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={!ready}
            data-testid="button-send-feedback"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:opacity-50"
          >
            {send.isPending ? "Sending…" : "Send feedback"}
          </button>
          <span className="text-xs text-muted-foreground">
            Sending again for the same place replaces your previous note.
          </span>
        </div>
      </form>
    </Surface>
  );
}
