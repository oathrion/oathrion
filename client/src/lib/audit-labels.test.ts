import { describe, expect, it } from "vitest";

import { auditEventLabel } from "./audit-labels";

describe("les événements du journal", () => {
  it("s'affichent tels que le serveur les écrit", () => {
    expect(auditEventLabel("Approval granted")).toBe("Approval granted");
  });
});
