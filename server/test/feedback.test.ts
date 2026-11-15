/**
 * Le retour produit — ce que les routes garantissent, et ce qu'elles refusent.
 *
 * Trois familles d'assertions, dans l'ordre d'importance.
 *
 * **L'isolation**, d'abord, parce que c'est la seule qui soit irréparable : un retour
 * écrit chez A ne doit jamais apparaître chez B, et B ne doit pas pouvoir apprendre
 * qu'il existe. Le cas du 404 est le plus subtil — répondre « interdit » plutôt que
 * « inexistant » ferait de cette route un oracle d'existence inter-locataire, la classe
 * de défaut que la propriété C27 du kit de conformité interdit ailleurs.
 *
 * **L'autorisation** ensuite : déposer un avis est au niveau le plus bas, trier est au
 * niveau le plus haut. Un lecteur qui pourrait marquer un retour « résolu » effacerait
 * le travail de quelqu'un d'autre.
 *
 * **La validation et l'anti-abus** enfin, y compris le point qui compte le plus en
 * pratique : cent clics ne font pas cent lignes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OTHER_ORG_KEYS, ROLE_KEYS, startTestServer, type TestClient } from "./harness";

interface FeedbackView {
  id: string;
  vote: number;
  category: string;
  comment: string | null;
  feature: string;
  productVersion: string;
  contextRef: string | null;
  status: string;
  resolutionNote: string | null;
  mine: boolean;
}

let client: TestClient;

beforeAll(async () => {
  client = await startTestServer();
});
afterAll(async () => {
  await client.close();
});

const submit = (body: unknown, auth: string) =>
  client.post<{ feedback: FeedbackView; message?: string; code?: string }>("/api/feedback", body, { auth });

const list = (auth: string) =>
  client.get<{ feedback: FeedbackView[] }>("/api/feedback", { auth });

describe("feedback — dépôt et relecture", () => {
  it("accepte un avis et le rend tel qu'il a été enregistré", async () => {
    const reply = await submit(
      { vote: 1, category: "experience", comment: "The policy editor reads well.", feature: "policies" },
      ROLE_KEYS.admin,
    );
    expect(reply.status).toBe(201);
    expect(reply.body.feedback.vote).toBe(1);
    expect(reply.body.feedback.category).toBe("experience");
    expect(reply.body.feedback.status).toBe("received");
    expect(reply.body.feedback.mine).toBe(true);
  });

  it("date la version depuis le SERVEUR, même si le client en annonce une", async () => {
    /*
     * `strictObject` refuse le champ. C'est le comportement voulu : un client qui croit
     * pouvoir dater son retour doit l'apprendre tout de suite, pas découvrir plus tard
     * que sa valeur a été jetée en silence.
     */
    const reply = await submit(
      { vote: 0, category: "bug", feature: "agents", productVersion: "99.9.9" },
      ROLE_KEYS.admin,
    );
    expect(reply.status).toBe(400);

    const honest = await submit({ vote: 0, category: "bug", feature: "agents" }, ROLE_KEYS.admin);
    expect(honest.status).toBe(201);
    expect(honest.body.feedback.productVersion).not.toBe("99.9.9");
    expect(honest.body.feedback.productVersion.length).toBeGreaterThan(0);
  });

  it("révise au lieu d'empiler : cent clics ne font pas cent lignes", async () => {
    const feature = "repeat-guard";
    for (const vote of [1, -1, 1, -1] as const) {
      const reply = await submit({ vote, category: "suggestion", feature }, ROLE_KEYS.admin);
      expect(reply.status).toBe(201);
    }
    const all = await list(ROLE_KEYS.admin);
    const mine = all.body.feedback.filter((f) => f.feature === feature);
    expect(mine).toHaveLength(1);
    // Le dernier avis gagne : une révision remplace, elle n'ajoute pas.
    expect(mine[0]!.vote).toBe(-1);
  });

  it("refuse une catégorie inventée et un vote hors bornes", async () => {
    const badCategory = await submit({ vote: 1, category: "vibes", feature: "x" }, ROLE_KEYS.admin);
    expect(badCategory.status).toBe(400);

    const badVote = await submit({ vote: 7, category: "bug", feature: "x" }, ROLE_KEYS.admin);
    expect(badVote.status).toBe(400);
  });

  it("refuse un commentaire au-delà de la borne, avec un code nommé", async () => {
    const reply = await submit(
      { vote: 0, category: "bug", feature: "x", comment: "z".repeat(4001) },
      ROLE_KEYS.admin,
    );
    expect(reply.status).toBe(400);
    expect(reply.body.code).toBe("feedback_invalid");
  });
});

describe("feedback — autorisation", () => {
  it("un lecteur peut déposer un avis : c'est le niveau le plus bas", async () => {
    const reply = await submit(
      { vote: 1, category: "experience", feature: "dashboard" },
      ROLE_KEYS.viewer,
    );
    expect(reply.status).toBe(201);
  });

  it("un lecteur ne peut PAS changer un statut", async () => {
    const created = await submit({ vote: 0, category: "bug", feature: "triage-guard" }, ROLE_KEYS.admin);
    expect(created.status).toBe(201);

    const refused = await client.patch<{ code?: string }>(
      `/api/feedback/${created.body.feedback.id}`,
      { status: "resolved" },
      { auth: ROLE_KEYS.viewer },
    );
    expect(refused.status).toBe(403);
  });

  it("un administrateur trie, et la note de résolution est conservée", async () => {
    const created = await submit({ vote: -1, category: "performance", feature: "triage-ok" }, ROLE_KEYS.admin);
    const patched = await client.patch<{ feedback: FeedbackView }>(
      `/api/feedback/${created.body.feedback.id}`,
      { status: "planned", resolutionNote: "Queued behind the grant work." },
      { auth: ROLE_KEYS.admin },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.feedback.status).toBe("planned");
    expect(patched.body.feedback.resolutionNote).toBe("Queued behind the grant work.");
  });

  it("un statut inventé est refusé", async () => {
    const created = await submit({ vote: 0, category: "bug", feature: "status-guard" }, ROLE_KEYS.admin);
    const refused = await client.patch(
      `/api/feedback/${created.body.feedback.id}`,
      { status: "wontfix-ish" },
      { auth: ROLE_KEYS.admin },
    );
    expect(refused.status).toBe(400);
  });

  it("sans credential, rien ne passe", async () => {
    const reply = await client.post("/api/feedback", { vote: 1, category: "bug", feature: "x" }, { auth: null });
    expect(reply.status).toBe(401);
  });
});

describe("feedback — isolation entre organisations", () => {
  it("B ne voit pas les retours de A, et A ne voit pas ceux de B", async () => {
    const a = await submit({ vote: 1, category: "experience", feature: "iso-a" }, ROLE_KEYS.admin);
    const b = await submit({ vote: -1, category: "bug", feature: "iso-b" }, OTHER_ORG_KEYS.admin);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const seenByA = (await list(ROLE_KEYS.admin)).body.feedback.map((f) => f.feature);
    const seenByB = (await list(OTHER_ORG_KEYS.admin)).body.feedback.map((f) => f.feature);

    expect(seenByA).toContain("iso-a");
    expect(seenByA).not.toContain("iso-b");
    expect(seenByB).toContain("iso-b");
    expect(seenByB).not.toContain("iso-a");
  });

  it("B ne peut pas trier un retour de A, et n'apprend pas qu'il existe", async () => {
    const a = await submit({ vote: 0, category: "bug", feature: "iso-triage" }, ROLE_KEYS.admin);
    const id = a.body.feedback.id;

    const crossTenant = await client.patch<{ code?: string }>(
      `/api/feedback/${id}`,
      { status: "resolved" },
      { auth: OTHER_ORG_KEYS.admin },
    );
    const inexistent = await client.patch<{ code?: string }>(
      "/api/feedback/fb_0000000000000000000000000000dead",
      { status: "resolved" },
      { auth: OTHER_ORG_KEYS.admin },
    );

    /*
     * LA MÊME réponse dans les deux cas. Si le retour d'un autre locataire rendait 403
     * là où un identifiant inexistant rend 404, la route dirait « cet identifiant
     * existe ailleurs » — un oracle d'existence inter-locataire.
     */
    expect(crossTenant.status).toBe(404);
    expect(inexistent.status).toBe(404);
    expect(crossTenant.body.code).toBe(inexistent.body.code);

    // Et le retour de A n'a pas bougé.
    const stillA = (await list(ROLE_KEYS.admin)).body.feedback.find((f) => f.id === id);
    expect(stillA?.status).toBe("received");
  });

  it("l'auteur n'est pas divulgué : seul un booléen dit « c'est le mien »", async () => {
    const created = await submit({ vote: 1, category: "suggestion", feature: "author-privacy" }, ROLE_KEYS.admin);
    const body = JSON.stringify(created.body);
    expect(body).not.toContain("authorUserId");
    expect(body).not.toContain("author_user_id");
    expect(created.body.feedback.mine).toBe(true);
  });
});
