/**
 * Phase 10 — the notification channel.
 *
 * The claim this file has to substantiate is narrow and important: a webhook
 * receiver that is slow, broken or hostile changes nothing about what Oathrion
 * decides or records. Everything here uses a real HTTP server on a real
 * ephemeral port; nothing is mocked, because the failure modes worth testing
 * are transport failure modes.
 *
 * Every `WebhookChannel` here passes `allowPrivate: true`. That receiver listens on
 * 127.0.0.1, and the channel now refuses loopback destinations by default — it is a
 * signed server-side HTTP client, so an operator-supplied loopback URL is an SSRF
 * and exfiltration primitive (see `server/notifications/webhook-url.ts`). A local
 * receiver in a test is the one case where loopback is genuinely intended, so the
 * intent is stated explicitly rather than the guard being weakened for everyone.
 * These tests still exercise the real guarded transport, address checks included.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Notifier, WebhookChannel, type EmitInput } from "../notifications";
import { ROLE_KEYS, startTestServer, type TestClient } from "./harness";

const SECRET = "webhook-signing-secret-value-0123456789";

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
}

/** A receiver whose behaviour each test decides. */
class Receiver {
  readonly received: Received[] = [];
  private server!: Server;
  private behaviour: "ok" | "error" | "hang" = "ok";
  private hung: { res: import("node:http").ServerResponse }[] = [];

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        this.received.push({ headers: req.headers, body });
        if (this.behaviour === "hang") {
          // Accept the request and never answer, so the client must time out.
          this.hung.push({ res });
          return;
        }
        res.writeHead(this.behaviour === "ok" ? 200 : 500).end();
      });
    });

    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const { port } = this.server.address() as AddressInfo;
    return `http://127.0.0.1:${port}/hook`;
  }

  respondWith(behaviour: "ok" | "error" | "hang"): void {
    this.behaviour = behaviour;
  }

  async stop(): Promise<void> {
    for (const { res } of this.hung) res.destroy();
    this.hung.length = 0;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function event(overrides: Partial<EmitInput> = {}): EmitInput {
  return {
    type: "approval.requested",
    title: "Approval required — purchase 700 €",
    summary: "Above the autonomous limit.",
    risk: "medium",
    agentId: "agt_procurement",
    agentName: "Procurement Agent",
    executionId: "exe_test",
    approvalId: "apr_test",
    policyId: "pol_purchase_limit",
    policyName: "Maximum purchase amount",
    data: {},
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- *
 * Signature
 * -------------------------------------------------------------------------- */

describe("payload signing", () => {
  let receiver: Receiver;
  let url: string;

  beforeEach(async () => {
    receiver = new Receiver();
    url = await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it("signs the exact bytes that were sent", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    expect(receiver.received).toHaveLength(1);
    const { headers, body } = receiver.received[0]!;

    const expected =
      "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
    expect(headers["x-oathrion-signature"]).toBe(expected);
  });

  it("produces a signature a receiver can reject after one altered byte", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    const { headers, body } = receiver.received[0]!;
    const tampered = body.replace("700", "70000");
    expect(tampered).not.toBe(body);

    const forged = "sha256=" + crypto.createHmac("sha256", SECRET).update(tampered).digest("hex");
    expect(headers["x-oathrion-signature"]).not.toBe(forged);
  });

  it("cannot be signed by someone holding a different secret", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    const { headers, body } = receiver.received[0]!;
    const wrong = "sha256=" + crypto.createHmac("sha256", "another-secret").update(body).digest("hex");
    expect(headers["x-oathrion-signature"]).not.toBe(wrong);
  });

  it("sends no signature header when no secret is configured", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    // Absent, not empty: an empty signature is worse than none, because a naive
    // receiver may treat it as "verified".
    expect(receiver.received[0]!.headers["x-oathrion-signature"]).toBeUndefined();
  });

  it("carries the delivery and event identifiers for correlation", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    const emitted = notifier.emit(event());
    await notifier.drain();

    const { headers } = receiver.received[0]!;
    expect(headers["x-oathrion-event"]).toBe("approval.requested");
    expect(headers["x-oathrion-delivery"]).toBe(emitted.id);
  });
});

/* -------------------------------------------------------------------------- *
 * Secrecy
 * -------------------------------------------------------------------------- */

describe("the signing secret stays on the server", () => {
  let receiver: Receiver;
  let url: string;

  beforeEach(async () => {
    receiver = new Receiver();
    url = await receiver.start();
  });

  afterEach(async () => {
    await receiver.stop();
  });

  it("never appears in the payload or in any header", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    const { headers, body } = receiver.received[0]!;
    expect(body).not.toContain(SECRET);
    expect(JSON.stringify(headers)).not.toContain(SECRET);
  });

  it("never appears in a delivery record, success or failure", async () => {
    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    receiver.respondWith("error");
    notifier.emit(event());
    await notifier.drain();

    const trace = JSON.stringify(notifier.recentDeliveries());
    expect(trace).not.toContain(SECRET);
    // The endpoint itself is a credential when it embeds a token, as Slack's
    // do. It must not be echoed back either.
    expect(trace).not.toContain(url);
  });
});

/* -------------------------------------------------------------------------- *
 * Failure modes
 * -------------------------------------------------------------------------- */

describe("a receiver that misbehaves", () => {
  it("records a rejection when the receiver answers 500", async () => {
    const receiver = new Receiver();
    const url = await receiver.start();
    receiver.respondWith("error");

    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    const [delivery] = notifier.recentDeliveries();
    expect(delivery?.ok).toBe(false);
    expect(delivery?.detail).toBe("HTTP 500");

    await receiver.stop();
  });

  it("gives up on a receiver that never answers, within the configured timeout", async () => {
    const receiver = new Receiver();
    const url = await receiver.start();
    receiver.respondWith("hang");

    const notifier = new Notifier().register(
      new WebhookChannel({ url, secret: SECRET, timeoutMs: 300, allowPrivate: true }),
    );

    const started = Date.now();
    notifier.emit(event());
    await notifier.drain();
    const elapsed = Date.now() - started;

    const [delivery] = notifier.recentDeliveries();
    expect(delivery?.ok).toBe(false);
    // Bounded by the timeout, with room for scheduling noise.
    expect(elapsed).toBeLessThan(3_000);
    expect(elapsed).toBeGreaterThanOrEqual(250);

    await receiver.stop();
  });

  it("records a failure when nothing is listening at all", async () => {
    const receiver = new Receiver();
    const url = await receiver.start();
    await receiver.stop(); // the port is now closed

    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));
    notifier.emit(event());
    await notifier.drain();

    const [delivery] = notifier.recentDeliveries();
    expect(delivery?.ok).toBe(false);
    expect(delivery?.detail).toBeTruthy();
  });

  it("does not throw out of emit, whatever the channel does", async () => {
    const notifier = new Notifier();
    notifier.register({
      id: "exploding",
      handles: () => true,
      deliver: () => Promise.reject(new Error("channel exploded")),
    });

    expect(() => notifier.emit(event())).not.toThrow();
    await expect(notifier.drain()).resolves.toBeUndefined();

    const [delivery] = notifier.recentDeliveries();
    expect(delivery?.ok).toBe(false);
    expect(delivery?.detail).toContain("channel exploded");
  });

  it("keeps delivering to a healthy channel when a sibling is broken", async () => {
    const receiver = new Receiver();
    const url = await receiver.start();

    const notifier = new Notifier();
    notifier.register({
      id: "exploding",
      handles: () => true,
      deliver: () => Promise.reject(new Error("channel exploded")),
    });
    notifier.register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));

    notifier.emit(event());
    await notifier.drain();

    expect(receiver.received).toHaveLength(1);
    await receiver.stop();
  });
});

/* -------------------------------------------------------------------------- *
 * Traceability
 * -------------------------------------------------------------------------- */

describe("delivery traceability", () => {
  it("records every attempt, newest first, with its outcome", async () => {
    const receiver = new Receiver();
    const url = await receiver.start();

    const notifier = new Notifier().register(new WebhookChannel({ url, secret: SECRET, allowPrivate: true }));

    const first = notifier.emit(event({ title: "first" }));
    await notifier.drain();
    receiver.respondWith("error");
    const second = notifier.emit(event({ title: "second" }));
    await notifier.drain();

    const deliveries = notifier.recentDeliveries();
    expect(deliveries[0]?.eventId).toBe(second.id);
    expect(deliveries[0]?.ok).toBe(false);
    expect(deliveries[1]?.eventId).toBe(first.id);
    expect(deliveries[1]?.ok).toBe(true);

    await receiver.stop();
  });

  it("keeps the buffer bounded so it cannot grow without limit", async () => {
    const receiver = new Receiver();
    const url = await receiver.start();
    const notifier = new Notifier().register(new WebhookChannel({ url, allowPrivate: true }));

    for (let i = 0; i < 60; i += 1) notifier.emit(event({ title: `event ${i}` }));
    await notifier.drain();

    expect(notifier.recentDeliveries().length).toBeLessThanOrEqual(50);
    await receiver.stop();
  });
});

/* -------------------------------------------------------------------------- *
 * Independence from the decision path
 * -------------------------------------------------------------------------- */

describe("a broken webhook does not affect a decision", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("still records an approval when the receiver is down", async () => {
    /*
     * The notifier used by the running server is the module-level singleton.
     * Registering a channel pointed at a closed port reproduces the outage the
     * pilot will eventually have.
     */
    const { notifier } = await import("../notifications");
    const receiver = new Receiver();
    const deadUrl = await receiver.start();
    await receiver.stop();

    notifier.register(new WebhookChannel({ url: deadUrl, secret: SECRET, timeoutMs: 500, allowPrivate: true }));

    try {
      const started = Date.now();
      const res = await api.post<{ decision: string; approvalId: string | null }>(
        "/api/executions",
        {
          agentId: "agt_procurement",
          action: "purchase",
          target: "supplier-x.com",
          amount: 700,
          category: "Software",
        },
      );
      const elapsed = Date.now() - started;

      expect(res.status).toBe(201);
      expect(res.body.decision).toBe("APPROVAL_REQUIRED");
      expect(res.body.approvalId).toBeTruthy();

      /*
       * CE QUI ÉTAIT MESURÉ ICI, ET POURQUOI CE N'ÉTAIT PAS LA BONNE CHOSE.
       *
       * L'assertion était `elapsed < 500`, avec le commentaire « la requête ne doit pas
       * attendre le receveur mort ». Elle avait deux défauts, et ils sont opposés.
       *
       * FRAGILE : sur cette machine à deux cœurs, chargée par le lanceur de suite (charge
       * moyenne mesurée à 6,6), la requête a pris 704 ms et le fichier a été rapporté en
       * échec. Rien n'était cassé.
       *
       * FAIBLE, ce qui est plus grave : un port FERMÉ refuse la connexion en une
       * milliseconde. Même si `emit` devenait bloquant, cette assertion passerait — elle
       * ne pouvait donc pas attraper la régression qu'elle prétendait garder.
       *
       * La propriété est désormais éprouvée là où elle est observable : avec un receveur
       * qui ACCEPTE et ne répond jamais (test suivant). Ici la borne est large et ne
       * distingue plus que la panne franche.
       */
      expect(elapsed).toBeLessThan(10_000);

      // The approval is queryable regardless of whether anyone was paged.
      const approvals = await api.get<{ id: string }[]>("/api/approvals");
      expect(approvals.body.some((a) => a.id === res.body.approvalId)).toBe(true);

      await notifier.drain();
      expect(notifier.recentDeliveries().some((d) => !d.ok)).toBe(true);
    } finally {
      notifier.clear();
    }
  });

  it("ne paie PAS le délai d'attente du webhook — la propriété, mesurée", async () => {
    /*
     * LE TEST QUE L'ANCIENNE BORNE NE POUVAIT PAS ÊTRE.
     *
     * Le receveur ACCEPTE la connexion et ne répond jamais. Le canal est configuré avec
     * un délai de dix secondes. La séparation est alors nette et ne dépend plus de la
     * vitesse de la machine :
     *
     *   · `emit` non bloquant → la requête rend en quelques dizaines ou centaines de
     *     millisecondes, selon la charge ;
     *   · `emit` bloquant → la requête rend après DIX SECONDES, sur n'importe quelle
     *     machine.
     *
     * La borne à cinq secondes est donc à mi-chemin entre les deux régimes, et non à la
     * frontière du temps de réponse normal. C'est ce qui la rend à la fois insensible à
     * la charge et capable d'attraper la régression.
     */
    const { notifier } = await import("../notifications");
    const receiver = new Receiver();
    const url = await receiver.start();
    receiver.respondWith("hang");

    notifier.register(
      new WebhookChannel({ url, secret: SECRET, timeoutMs: 10_000, allowPrivate: true }),
    );

    try {
      const started = Date.now();
      const res = await api.post<{ decision: string; approvalId: string | null }>(
        "/api/executions",
        {
          /*
           * UN BLOCK DÉTERMINISTE : le domaine n'est pas au mandat, donc le verdict ne
           * dépend ni du budget journalier de l'agent, ni de l'ordre des cas de ce
           * fichier.
           *
           * Ce choix est une correction. Écrit d'abord avec un achat de 700 attendant
           * `APPROVAL_REQUIRED`, ce test recevait `BLOCK` — le cas précédent avait déjà
           * dépensé le budget. J'avais alors accepté les deux verdicts, et un mutant m'a
           * montré que c'était faux : en tolérant les deux branches, le test n'éprouvait
           * de façon fiable NI l'une NI l'autre. Un mutant qui ajoutait une attente dans
           * la branche d'approbation a survécu.
           */
          agentId: "agt_procurement",
          action: "purchase",
          target: "evil.com",
          amount: 10,
          category: "Software",
        },
      );
      const elapsed = Date.now() - started;

      expect(res.status).toBe(201);
      expect(res.body.decision).toBe("BLOCK");
      /* La décision est rendue sans attendre le webhook. C'est tout l'objet du test. */
      expect(elapsed).toBeLessThan(5_000);

      /*
       * ET LE RECEVEUR A BIEN ÉTÉ SOLLICITÉ. Sans cette assertion, un canal qui
       * n'enverrait rien du tout passerait le test avec un temps parfait.
       *
       * Il faut l'ATTENDRE, et c'est en soi la démonstration la plus nette de la
       * propriété : au retour de la requête, le receveur n'avait encore RIEN reçu. La
       * décision n'a donc pas seulement évité d'attendre la réponse du webhook — elle
       * est partie avant même que l'appel soit émis.
       *
       * On attend par sondage, et non par `drain()` : `drain()` attendrait les dix
       * secondes du délai, puisque ce receveur ne répond jamais.
       */
      const limite = Date.now() + 3_000;
      while (receiver.received.length === 0 && Date.now() < limite) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(receiver.received.length).toBeGreaterThan(0);
    } finally {
      notifier.clear();
      await receiver.stop();
    }
  }, 30_000);

  it("still blocks an action when the receiver is down", async () => {
    const { notifier } = await import("../notifications");
    const receiver = new Receiver();
    const deadUrl = await receiver.start();
    await receiver.stop();

    notifier.register(new WebhookChannel({ url: deadUrl, timeoutMs: 500, allowPrivate: true }));

    try {
      const res = await api.post<{ decision: string; execution: { toolId?: string | null } | null }>(
        "/api/executions",
        {
          agentId: "agt_procurement",
          action: "purchase",
          target: "evil.com",
          amount: 10,
          category: "Software",
        },
      );

      expect(res.body.decision).toBe("BLOCK");
      expect(res.body.execution?.toolId).toBeFalsy();
    } finally {
      notifier.clear();
    }
  });
});

/* ---------------------------------------------------------------------------
 * The API must not leak internal topology through delivery detail
 * -------------------------------------------------------------------------- */

describe("GET /api/notifications does not expose internal addressing", () => {
  let api: TestClient;

  beforeAll(async () => {
    api = await startTestServer();
  });

  afterAll(async () => {
    await api.close();
  });

  it("withholds the receiver's address and port from a viewer", async () => {
    /*
     * This endpoint needs only the `read` capability, so `viewer` — the least
     * privileged role — sees every recent delivery. The raw transport error for a
     * closed port is `connect ECONNREFUSED 127.0.0.1:<port>`, which handed that
     * viewer the receiver's address and port. In a real deployment that is the
     * internal hostname or RFC1918 address of an internal service, which is exactly
     * what someone holding a low-privilege credential wants to learn next.
     */
    const { notifier } = await import("../notifications");
    const receiver = new Receiver();
    const deadUrl = await receiver.start();
    await receiver.stop();
    const deadPort = new URL(deadUrl).port;

    notifier.register(new WebhookChannel({ url: deadUrl, timeoutMs: 500, allowPrivate: true }));

    try {
      await api.post("/api/executions", {
        agentId: "agt_procurement",
        action: "purchase",
        target: "supplier-x.com",
        amount: 700,
        category: "Software",
      });
      await notifier.drain();

      const res = await api.get<{ deliveries: { ok: boolean; detail: string }[] }>(
        "/api/notifications",
        { auth: ROLE_KEYS.viewer },
      );
      expect(res.status).toBe(200);

      const failed = res.body.deliveries.filter((d) => !d.ok);
      expect(failed.length).toBeGreaterThan(0);

      const exposed = failed.map((d) => d.detail).join("\n");
      expect(exposed).not.toContain("127.0.0.1");
      expect(exposed).not.toContain(deadPort);

      // Redaction must not destroy the diagnostic. An operator still has to be able
      // to tell "nothing is listening" from "the receiver returned 500".
      expect(exposed).toMatch(/ECONNREFUSED|refused|failed/i);

      // The unredacted message is still available server-side, where the operator
      // who owns the deployment can act on it.
      expect(
        notifier.recentDeliveries().some((d) => !d.ok && d.detail.includes("127.0.0.1")),
      ).toBe(true);
    } finally {
      notifier.clear();
    }
  });

  it("passes an HTTP status verdict through unchanged", async () => {
    // The common case must stay readable: `HTTP 500` contains no topology and is
    // the single most useful thing on the screen.
    const { notifier } = await import("../notifications");
    const receiver = new Receiver();
    const url = await receiver.start();
    receiver.respondWith("error");

    notifier.register(new WebhookChannel({ url, timeoutMs: 1_000, allowPrivate: true }));

    try {
      await api.post("/api/executions", {
        agentId: "agt_procurement",
        action: "purchase",
        target: "supplier-x.com",
        amount: 700,
        category: "Software",
      });
      await notifier.drain();

      const res = await api.get<{ deliveries: { ok: boolean; detail: string }[] }>(
        "/api/notifications",
        { auth: ROLE_KEYS.viewer },
      );
      expect(res.body.deliveries.some((d) => d.detail === "HTTP 500")).toBe(true);
    } finally {
      notifier.clear();
      await receiver.stop();
    }
  });
});
