import { describe, expect, it } from "vitest";

import { LOCAL_LOGIN_TICKET_MS, checkLocalLoginTicket, mintLocalLoginTicket } from "./local-login-ticket";

const SECRET = "un-secret-de-session-assez-long-pour-le-test-0123456789";

describe("le ticket de connexion de la console locale", () => {
  it("un ticket neuf est accepté, avec son nonce", () => {
    const now = 1_800_000_000_000;
    const ticket = mintLocalLoginTicket(SECRET, now);
    expect(checkLocalLoginTicket(SECRET, ticket, now + 1_000)).toMatchObject({ ok: true, expiresAt: now + LOCAL_LOGIN_TICKET_MS });
  });

  it("échu, signé d'un autre secret, retouché ou mal formé : refusé", () => {
    const now = 1_800_000_000_000;
    const ticket = mintLocalLoginTicket(SECRET, now);
    expect(checkLocalLoginTicket(SECRET, ticket, now + LOCAL_LOGIN_TICKET_MS)).toEqual({ ok: false, reason: "expired" });
    expect(checkLocalLoginTicket(`${SECRET}x`, ticket, now)).toEqual({ ok: false, reason: "bad_signature" });
    const [v, , nonce, sig] = ticket.split(".");
    /* Repousser l'échéance invalide la signature ; la repousser au-delà de deux minutes est refusé d'emblée. */
    expect(checkLocalLoginTicket(SECRET, [v, String(now + 60_000), nonce, sig].join("."), now)).toEqual({ ok: false, reason: "bad_signature" });
    expect(checkLocalLoginTicket(SECRET, [v, String(now + 3_600_000), nonce, sig].join("."), now)).toEqual({ ok: false, reason: "expired" });
    for (const bad of ["", "v1", "v2.1.2.3", `v1.abc.${String(nonce)}.${String(sig)}`, ticket.slice(0, -5)]) {
      expect(checkLocalLoginTicket(SECRET, bad, now).ok).toBe(false);
    }
  });
});
