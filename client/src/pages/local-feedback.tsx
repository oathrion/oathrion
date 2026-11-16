/**
 * « SEND FEEDBACK » en local (16 novembre, retour des premiers testeurs : « la qualité du logiciel
 * sera celle des retours qu'il nous apporte »). Ce que la personne veut voir corrigé, et ses
 * réponses à « Was Oathrion right? », gardées sur sa machine, dans un e-mail qu'elle relit et
 * envoie elle-même. Rien ne part sans elle ; ce qui a été partagé ne lui est plus redemandé.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "wouter";
import { Check, Copy, Mail, ThumbsDown, ThumbsUp } from "lucide-react";

import { PageHeader, Surface } from "@/components/common/primitives";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { getLocalFeedback, markLocalFeedbackShared, type LocalFeedback } from "@/lib/api";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";

export const FEEDBACK_ADDRESS = "contact@oathrion.com";
/* Un lien mailto trop long n'ouvre rien dans certains logiciels : les plus récentes seulement, raccourcies. */
const IN_MAIL = 20;
const short = (text: string) => (text.length > 160 ? `${text.slice(0, 159)}…` : text);

function mailBody(note: string, data: LocalFeedback): string {
  const answers = data.answers.slice(0, IN_MAIL).map((a) => `- ${a.right ? "Yes" : "No"} · ${short(a.about)}${a.decision ? ` · ${short(a.decision)}` : ""} · ${new Date(a.at).toLocaleString()}`);
  return [
    "What I would like you to fix or add:",
    note.trim() || "(nothing more)",
    "",
    ...(answers.length > 0 ? ['My answers to "Was Oathrion right?" (newest first):', ...answers, ""] : []),
    `Oathrion ${data.version} · ${data.platform}`,
  ].join("\n");
}

export default function LocalFeedbackPage() {
  const wrong = new URLSearchParams(useSearch()).get("wrong") === "1";
  const feedback = useQuery({ queryKey: ["/api/local/feedback"], queryFn: getLocalFeedback });
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  const shared = useMutation({
    mutationFn: () => markLocalFeedbackShared(new Date().toISOString()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["/api/local/feedback"] }),
  });
  const data = feedback.data;
  const fresh = (at: string) => !data?.sharedUntil || at > data.sharedUntil;

  const send = () => {
    if (!data) return;
    const subject = wrong ? "Oathrion got it wrong" : "Feedback on Oathrion";
    window.location.href = `mailto:${FEEDBACK_ADDRESS}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(mailBody(note, data))}`;
    shared.mutate();
  };
  const copy = () => {
    if (!data) return;
    void navigator.clipboard?.writeText(mailBody(note, data)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      shared.mutate();
    });
  };

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageHeader title="Send feedback" subtitle="What you tell us decides what we fix first. Nothing leaves your computer without you." />

      <Surface className="space-y-4 p-6">
        <label className="block space-y-2">
          <span className="text-[15px] font-medium">{wrong ? "What should Oathrion have done?" : "What should we fix or add?"}</span>
          <Textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
            autoFocus={wrong}
            placeholder={wrong ? "It stopped something I wanted, or let through something it should have asked about…" : "Something unclear, missing or annoying…"}
            data-testid="feedback-note"
          />
        </label>
        <div className="flex flex-wrap items-center gap-3">
          <Button onClick={send} disabled={!data} data-testid="feedback-send">
            <Mail className="mr-2 h-4 w-4" aria-hidden /> Write the e-mail
          </Button>
          <Button variant="outline" onClick={copy} disabled={!data} data-testid="feedback-copy">
            {copied ? <Check className="mr-2 h-4 w-4 text-success" aria-hidden /> : <Copy className="mr-2 h-4 w-4" aria-hidden />}
            {copied ? "Copied" : "Copy the text"}
          </Button>
        </div>
        <p className="text-[13px] text-muted-foreground">
          Your e-mail app opens with everything already written, to {FEEDBACK_ADDRESS}: read it, change anything, then send it. No e-mail app? Copy the text and paste it in any e-mail.
        </p>
      </Surface>

      <Surface className="p-6">
        <h2 className="text-[15px] font-medium">Your answers to « Was Oathrion right? »</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">Kept on this computer. They go in the e-mail, so we learn where Oathrion gets it wrong.</p>
        {!data ? (
          <p className="mt-4 text-[13px] text-muted-foreground">{feedback.isError ? "They could not be read." : "Reading…"}</p>
        ) : data.answers.length === 0 ? (
          <p className="mt-4 text-[13px] text-muted-foreground">None yet. After each decision, Oathrion asks whether it was right: your answers show up here.</p>
        ) : (
          <ul className="mt-3 divide-y divide-card-border" data-testid="feedback-answers">
            {data.answers.map((answer) => (
              <li key={`${answer.at}-${answer.about}`} className={cn("flex items-start gap-3 py-2.5", !fresh(answer.at) && "opacity-60")}>
                {answer.right ? <ThumbsUp className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Yes" /> : <ThumbsDown className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-label="No" />}
                <div className="min-w-0 flex-1">
                  <p className="text-[14px]">{answer.about}</p>
                  <p className="text-[12px] text-muted-foreground">
                    {answer.decision ? `${answer.decision} · ` : ""}
                    {relativeTime(answer.at)}
                    {fresh(answer.at) ? "" : " · already sent"}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
