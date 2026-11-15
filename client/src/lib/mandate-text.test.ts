import { describe, expect, it } from "vitest";

import type { Mandate } from "@shared/mandate";

import { describeGrant, describeMandate } from "./mandate-text";

describe("un mandat, en une phrase", () => {
  it("les limites dans l'ordre où on les lit", () => {
    expect(
      describeGrant({
        actions: ["payment.transfer"],
        destinations: ["bank:acme-main"],
        constraints: { maxAmount: { value: 5_000, currency: "EUR" }, periodCap: { value: 50_000, currency: "EUR", period: "P1M" }, beneficiaries: ["FR76"], purpose: "supplier invoices" },
      }),
    ).toBe("payment.transfer · up to 5,000 EUR each · up to 50,000 EUR per 30 days · to 1 beneficiary · for « supplier invoices » · at bank:acme-main");
    expect(describeMandate({ agent: { name: "Billing" }, grants: [{ actions: ["refund.*"] }] } as unknown as Mandate)).toBe("Billing may refund.*.");
  });
});
