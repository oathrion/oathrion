/**
 * LES RÉPONSES « WAS OATHRION RIGHT? », RELUES (16 novembre, retour des premiers testeurs : « la
 * qualité du logiciel sera celle des retours qu'il nous apporte, et ce n'est pas dans le
 * parcours »). Elles sont gardées sur la machine (`feedback.jsonl`, `local-notifications.ts`) ;
 * la console les montre, et la personne les envoie ELLE-MÊME, par un e-mail qu'elle relit.
 * Rien ne part d'ici : ce fichier lit, et note seulement jusqu'où la personne a partagé, pour
 * ne plus lui redemander les mêmes.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FEEDBACK_FILE } from "./local-notifications";

export const FEEDBACK_SHARED_FILE = "feedback-shared.json";
/** Les plus récentes seulement : la page les montre en entier avant l'envoi. */
const KEPT = 50;

export interface FeedbackAnswer {
  at: string;
  about: string;
  decision: string;
  right: boolean;
}

export function readFeedback(dir: string): { answers: FeedbackAnswer[]; sharedUntil: string | null } {
  const file = join(dir, FEEDBACK_FILE);
  const answers: FeedbackAnswer[] = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const entry = JSON.parse(line) as Partial<FeedbackAnswer>;
        if (typeof entry.at === "string" && typeof entry.about === "string" && typeof entry.right === "boolean") {
          answers.push({ at: entry.at, about: entry.about, decision: typeof entry.decision === "string" ? entry.decision : "", right: entry.right });
        }
      } catch {
        /* Une ligne coupée (arrêt brutal) : ignorée, les autres restent lisibles. */
      }
    }
  }
  let sharedUntil: string | null = null;
  try {
    const shared = JSON.parse(readFileSync(join(dir, FEEDBACK_SHARED_FILE), "utf8")) as { until?: unknown };
    if (typeof shared.until === "string") sharedUntil = shared.until;
  } catch {
    /* Jamais partagé. */
  }
  return { answers: answers.slice(-KEPT).reverse(), sharedUntil };
}

/** La personne a ouvert l'e-mail : ce qui est antérieur à `until` ne lui est plus redemandé. */
export function markFeedbackShared(dir: string, until: string): void {
  if (Number.isNaN(Date.parse(until))) throw new Error("until must be a date");
  writeFileSync(join(dir, FEEDBACK_SHARED_FILE), `${JSON.stringify({ until })}\n`, { mode: 0o600 });
}
