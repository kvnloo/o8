import { describe, expect, it } from "vitest";
import {
  shadowBesideControl,
  type ShadowDecisionRequest,
} from "../../../src/lib/lab/z0int/shadow-decision";

function request(overrides: Partial<ShadowDecisionRequest> = {}): ShadowDecisionRequest {
  return {
    opportunityId: "opp-1",
    intentRevision: "intent-r1",
    stateRevision: "state-r1",
    stateOk: true,
    decisionKind: "worker-route",
    legalActions: ["codex", "claude", "grok"],
    controlAction: "codex",
    ...overrides,
  };
}

describe("shadow_never_replaces_control", () => {
  it("returns the o8 control action when the candidate disagrees", () => {
    const result = shadowBesideControl(request(), "candidate", () => ({
      prediction: "grok",
      confidence: 0.99,
    }));
    expect(result.action).toBe("codex");
    expect(result.receipt.acted).toBe(false);
    expect(result.receipt.prediction).toBe("grok");
    expect(result.receipt.rejectedReason).toBe("none");
  });

  it("matches shadow-disabled behavior: action is the control action", () => {
    const control = request().controlAction;
    const enabled = shadowBesideControl(request(), "candidate", () => ({
      prediction: "claude",
      confidence: 1,
    }));
    expect(enabled.action).toBe(control);
  });

  it("keeps the control action when the candidate throws", () => {
    const result = shadowBesideControl(request(), "boom", () => {
      throw new Error("backend down");
    });
    expect(result.action).toBe("codex");
    expect(result.receipt.acted).toBe(false);
    expect(result.receipt.prediction).toBeNull();
    expect(result.receipt.rejectedReason).toBe("candidate-error");
  });

  it("drops a prediction outside the legal action set and does not act", () => {
    const result = shadowBesideControl(request(), "candidate", () => ({
      prediction: "authority.expand",
      confidence: 1,
    }));
    expect(result.action).toBe("codex");
    expect(result.receipt.acted).toBe(false);
    expect(result.receipt.prediction).toBeNull();
    expect(result.receipt.rejectedReason).toBe("illegal-action");
  });

  it("refuses to record a prediction when state identity is malformed", () => {
    const result = shadowBesideControl(
      request({ stateOk: false, stateRevision: "" }),
      "candidate",
      () => ({ prediction: "grok", confidence: 1 }),
    );
    expect(result.action).toBe("codex");
    expect(result.receipt.acted).toBe(false);
    expect(result.receipt.prediction).toBeNull();
    expect(result.receipt.rejectedReason).toBe("malformed-state");
    expect(result.receipt.intentRevision).toBe("intent-r1");
  });

  it("records latency separately from the control decision", () => {
    let tick = 10;
    const result = shadowBesideControl(
      request(),
      "candidate",
      () => ({ prediction: "codex", confidence: 0.2 }),
      () => {
        tick += 4;
        return tick;
      },
    );
    expect(result.receipt.latencyMs).toBe(4);
    expect(result.receipt.schema).toBe("o8.z0int.shadow-decision/v0");
  });
});
