/**
 * `oathrion retour [message…]` — dire à l'équipe d'Oathrion ce qui marche, ce qui casse, ce qui
 * manque. Volontaire, et rien ne part tout seul : la commande ouvre un ticket PRÉREMPLI dans le
 * navigateur (version, système, Node — aucune donnée de la personne, aucun contenu d'outil), que
 * la personne relit et envoie elle-même. Pas de télémétrie : Oathrion vend la confiance.
 *
 * C'est le seul canal par lequel un retour nous parvient : la page « Vos retours » de la console
 * locale reste sur la machine de la personne.
 */
import { spawn } from "node:child_process";
import { release } from "node:os";

import { CONTACT_EMAIL, REPOSITORY_URL, contactReady } from "@shared/contact";

export const RETOUR_USAGE = `
oathrion feedback [message…] [--no-browser]

  Opens a prefilled issue (version, system, Node) in your browser; you read it and send it
  yourself. Nothing leaves without you, and none of your data is put in it.
`;

export function feedbackUrl(version: string, message: string): string {
  const body = [
    message ? `${message}\n` : "**What happened:**\n\n**What you expected:**\n",
    "---",
    `oathrion ${version} · Node ${process.version} · ${process.platform} ${release()}`,
  ].join("\n");
  const title = message ? `Feedback: ${message.slice(0, 80)}` : "Feedback: ";
  return `${REPOSITORY_URL}/issues/new?${new URLSearchParams({ title, body, labels: "feedback" }).toString()}`;
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const opener = spawn(command, args as string[], { detached: true, stdio: "ignore" });
    opener.on("error", () => undefined);
    opener.unref();
  } catch {
    /* le lien est imprimé */
  }
}

export function runRetour(argv: readonly string[], version: string, out: (l: string) => void): number {
  const noBrowser = (a: string) => a === "--no-browser" || a === "--sans-navigateur";
  const browser = !argv.some(noBrowser);
  const message = argv.filter((a) => !noBrowser(a)).join(" ").trim();
  if (!contactReady()) {
    out("Thank you! Oathrion's public repository is not open yet: this feedback cannot reach us this way yet.");
    return 0;
  }
  const url = feedbackUrl(version, message);
  out("A prefilled issue opens: read it, then send it. Nothing leaves without you.");
  out(url);
  out(`Or by email: ${CONTACT_EMAIL}`);
  if (browser) openBrowser(url);
  return 0;
}
