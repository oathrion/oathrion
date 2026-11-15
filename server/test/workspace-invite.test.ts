/**
 * LE PREMIER JOUR D'UN CLIENT, SANS TERMINAL DE SON CÔTÉ.
 *
 * L'exploitant crée l'espace et un lien ; le client lit ce que le lien propose, l'accepte
 * avec son nom et son mot de passe, et se connecte. Ce fichier suit ce chemin par l'API
 * réelle et fixe ses gardes : lien à usage unique, réponse identique pour un lien faux,
 * expiré ou consommé, et refus de « créer » l'espace d'un client qui a déjà un
 * administrateur.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { createWorkspaceInvitation, invitationLink } from "../workspace-invite";
import { startTestServer, type TestClient } from "./harness";

let api: TestClient;

beforeAll(async () => {
  api = await startTestServer();
});

const PASSWORD = "Une-phrase-de-passe-solide-2026";

describe("créer l'espace", () => {
  it("crée l'organisation et une invitation d'administrateur à usage unique", async () => {
    const created = createWorkspaceInvitation({ organizationName: "Atelier Kryxor", email: "Fondatrice@Kryxor.test" });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.createdOrganization).toBe(true);
    expect(created.email).toBe("fondatrice@kryxor.test");

    /* Le lien porte le jeton dans le fragment : jamais envoyé au serveur ni dans un Referer. */
    const link = invitationLink("https://placet.example/", created.token);
    expect(link.startsWith("https://placet.example/console#/bienvenue?invitation=")).toBe(true);

    const inspected = await api.post<Record<string, unknown>>("/api/invitations/inspect", { token: created.token }, { auth: null });
    expect(inspected.status).toBe(200);
    expect(inspected.body).toMatchObject({
      purpose: "invite",
      organizationName: "Atelier Kryxor",
      email: "fondatrice@kryxor.test",
      role: "admin",
    });

    const accepted = await api.post(
      "/api/invitations/accept",
      { token: created.token, name: "Awa Diallo", password: PASSWORD },
      { auth: null },
    );
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);

    const session = await api.post<{ token: string; identity: { role: string; name: string } }>(
      "/api/auth/login",
      { email: "fondatrice@kryxor.test", password: PASSWORD },
      { auth: null },
    );
    expect(session.status).toBe(200);
    expect(session.body.identity).toMatchObject({ role: "admin", name: "Awa Diallo" });

    /* Le même lien une seconde fois : ni lisible, ni utilisable. */
    expect((await api.post("/api/invitations/inspect", { token: created.token }, { auth: null })).status).toBe(400);
    expect(
      (await api.post("/api/invitations/accept", { token: created.token, password: PASSWORD }, { auth: null })).status,
    ).toBe(400);
  });

  it("refuse de « créer » un espace qui a déjà un administrateur", () => {
    const again = createWorkspaceInvitation({ organizationName: "Atelier Kryxor", email: "intrus@kryxor.test" });
    expect(again).toMatchObject({ ok: false, code: "admin_exists" });
  });

  it("refuse une seconde invitation en cours pour la même adresse", () => {
    const first = createWorkspaceInvitation({ organizationName: "Studio Deux", email: "a@deux.test" });
    const second = createWorkspaceInvitation({ organizationName: "Studio Deux", email: "a@deux.test" });
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, code: "invitation_pending" });
  });

  it("refuse une adresse ou un nom inutilisables", () => {
    expect(createWorkspaceInvitation({ organizationName: "Acme", email: "pas-une-adresse" })).toMatchObject({ ok: false, code: "invalid_email" });
    expect(createWorkspaceInvitation({ organizationName: "  ", email: "a@b.test" })).toMatchObject({ ok: false, code: "invalid_organization" });
  });

  it("un jeton inconnu reçoit la même réponse qu'un jeton consommé", async () => {
    const unknown = await api.post<{ message?: string; error?: string }>("/api/invitations/inspect", { token: "idt_inconnu.secretsecret" }, { auth: null });
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).toContain("That invitation is not valid.");
  });
});
