/**
 * Regression tests for the agent lifecycle control.
 *
 * The bug these pin is not subtle: the console disabled the only button that can
 * take an agent out of `draft`, so a created agent could never be put into
 * service even though the store and the API both supported the transition. The
 * assertions below are written so that reintroducing `status === "draft"` into
 * the `disabled` expression turns them red.
 */

import { describe, it, expect } from "vitest";
import {
  agentToggleAffordance,
  agentToggleDisabled,
  agentTransitionMessage,
} from "./agent-presentation";
import type { AgentStatus } from "@/types";

const ALL_STATUSES: AgentStatus[] = ["active", "paused", "draft", "review"];

describe("agentToggleAffordance", () => {
  it("offers activation for a draft agent — the transition that was blocked", () => {
    const toggle = agentToggleAffordance("draft");
    expect(toggle.unavailable).toBe(false);
    expect(toggle.next).toBe("active");
    expect(toggle.icon).toBe("start");
  });

  it("calls a first activation 'Activate', not 'Resume'", () => {
    expect(agentToggleAffordance("draft").label).toBe("Activate agent");
    expect(agentToggleAffordance("paused").label).toBe("Resume agent");
  });

  it("pauses an active agent", () => {
    const toggle = agentToggleAffordance("active");
    expect(toggle.next).toBe("paused");
    expect(toggle.icon).toBe("pause");
    expect(toggle.unavailable).toBe(false);
  });

  it("resumes a paused agent", () => {
    expect(agentToggleAffordance("paused").next).toBe("active");
  });

  it("refuses to route around a held review, and says why", () => {
    const toggle = agentToggleAffordance("review");
    expect(toggle.unavailable).toBe(true);
    expect(toggle.unavailableReason).toMatch(/review/i);
  });

  it("returns a usable affordance for every declared status", () => {
    for (const status of ALL_STATUSES) {
      const toggle = agentToggleAffordance(status);
      expect(toggle.label.length).toBeGreaterThan(0);
      expect(["active", "paused"]).toContain(toggle.next);
    }
  });

  it("supplies a reason whenever it reports a status unavailable", () => {
    for (const status of ALL_STATUSES) {
      const toggle = agentToggleAffordance(status);
      if (toggle.unavailable) expect(toggle.unavailableReason).toBeTruthy();
    }
  });
});

describe("agentToggleDisabled", () => {
  it("does NOT disable a draft agent for a manager", () => {
    expect(agentToggleDisabled("draft", true)).toBe(false);
  });

  it("enables the control for every status except review", () => {
    expect(agentToggleDisabled("active", true)).toBe(false);
    expect(agentToggleDisabled("paused", true)).toBe(false);
    expect(agentToggleDisabled("draft", true)).toBe(false);
    expect(agentToggleDisabled("review", true)).toBe(true);
  });

  it("still refuses a caller without the manage capability — RBAC is not weakened", () => {
    for (const status of ALL_STATUSES) {
      expect(agentToggleDisabled(status, false)).toBe(true);
    }
  });
});

describe("agentTransitionMessage", () => {
  it("reports a first activation as an activation, not a resumption", () => {
    expect(agentTransitionMessage("draft", "active")).toBe("Agent activated by a person");
  });

  it("reports a real resumption as a resumption", () => {
    expect(agentTransitionMessage("paused", "active")).toBe("Agent resumed");
  });

  it("reports a pause the same way from any origin", () => {
    for (const status of ALL_STATUSES) {
      expect(agentTransitionMessage(status, "paused")).toBe("Agent paused by a person");
    }
  });
});
