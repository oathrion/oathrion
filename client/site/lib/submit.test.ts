/**
 * L'envoi natif vers le collecteur (17 novembre, essai sur un téléphone : la candidature au
 * pilote partait en `mailto` et se perdait). Ce qui part vraiment : les champs remplis, sous le
 * nom du collecteur, et les champs constants (l'étiquette « pilot »).
 */
import { afterEach, describe, expect, it } from "vitest";

import { redirectTransport } from "./submit";

/* Un faux `document` : le formulaire construit, et sa soumission. */
function fakeDocument() {
  const submitted: { action: string; method: string; fields: Record<string, string> }[] = [];
  const doc = {
    body: { appendChild: () => undefined },
    createElement: (tag: string) => {
      if (tag === "input") return { type: "", name: "", value: "" };
      const inputs: { name: string; value: string }[] = [];
      const form = {
        method: "",
        action: "",
        style: {},
        appendChild: (input: { name: string; value: string }) => inputs.push(input),
        submit: () => submitted.push({ action: form.action, method: form.method, fields: Object.fromEntries(inputs.map((i) => [i.name, i.value])) }),
      };
      return form;
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  return submitted;
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

describe("la candidature au pilote, envoyée au collecteur", () => {
  it("chaque réponse sous son nom de métadonnée, l'étiquette, et rien de vide", async () => {
    const submitted = fakeDocument();
    const transport = redirectTransport("https://buttondown.com/api/emails/embed-subscribe/x", { email: "email", company: "metadata__company", wants: "metadata__wants" }, { tag: "pilot", embed: "1" });
    const outcome = await transport.send({ kind: "pilot", name: "Awa", email: " awa@example.com ", company: "Kaay", role: "", country: "", building: "", workflow: "", agents: "", problem: "", wants: "  " });
    expect(outcome).toEqual({ ok: true, via: "redirect" });
    expect(submitted).toEqual([
      { action: "https://buttondown.com/api/emails/embed-subscribe/x", method: "post", fields: { email: "awa@example.com", metadata__company: "Kaay", tag: "pilot", embed: "1" } },
    ]);
  });
});
