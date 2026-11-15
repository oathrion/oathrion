/**
 * `oathrion retour` : un ticket PRÉREMPLI que la personne relit et envoie elle-même. On vérifie
 * ce qu'il contient (version, système, Node, le message) et surtout ce qu'il ne contient pas ; et
 * qu'avant la publication, sans dépôt public, la commande le dit au lieu d'ouvrir un faux lien.
 */
import { describe, expect, it } from "vitest";

import { contactReady } from "@shared/contact";

import { feedbackUrl, runRetour } from "./retour";

describe("oathrion retour", () => {
  it("le ticket : titre, message, version, Node, système ; l'étiquette « retour » ; rien d'autre", () => {
    const url = new URL(feedbackUrl("0.1.0-preview.1", "la notification n'arrive pas"));
    expect(url.pathname).toMatch(/\/issues\/new$/);
    expect(url.searchParams.get("title")).toBe("Feedback: la notification n'arrive pas");
    expect(url.searchParams.get("labels")).toBe("feedback");
    const body = url.searchParams.get("body")!;
    expect(body).toContain("la notification n'arrive pas");
    expect(body).toContain(`oathrion 0.1.0-preview.1 · Node ${process.version} · ${process.platform}`);
    expect(body).not.toContain(process.env.HOME ?? "/home/");
    expect([...url.searchParams.keys()].sort()).toEqual(["body", "labels", "title"]);
  });

  it("sans message : un modèle à remplir", () => {
    const body = new URL(feedbackUrl("0.1.0-preview.1", "")).searchParams.get("body")!;
    expect(body).toContain("What happened");
    expect(body).toContain("What you expected");
  });

  it.skipIf(contactReady())("avant la publication : il le dit, sans lien ni navigateur", () => {
    const lines: string[] = [];
    expect(runRetour(["ça", "marche"], "0.1.0-preview.1", (l) => lines.push(l))).toBe(0);
    expect(lines.join("\n")).toMatch(/not open yet/);
    expect(lines.join("\n")).not.toMatch(/https?:\/\//);
  });
});
