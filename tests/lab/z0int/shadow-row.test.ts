import { describe, expect, it } from "vitest";
import { classifyShadowRow, retainShadowRows } from "../../../src/lib/lab/z0int/shadow-row";

const legal = ["worker-a", "worker-b"] as const;

describe("agreement_is_not_gold", () => {
  it("records agreement without treating it as gold or promoting it", () => {
    const row = classifyShadowRow({
      controlAction: "worker-a",
      prediction: "worker-a",
      confidence: 0.99,
      rejectedReason: "none",
      legalActions: legal,
    });
    expect(row.kind).toBe("agreement");
    expect(row.agreementIsGold).toBe(false);
    expect(row.promoted).toBe(false);
    expect(row.acted).toBe(false);
    expect(row.kept).toBe(true);
  });

  it("keeps disagreement and inconclusive rows", () => {
    const kept = retainShadowRows([
      {
        controlAction: "worker-a",
        prediction: "worker-b",
        confidence: 0.2,
        rejectedReason: "none",
        legalActions: legal,
      },
      {
        controlAction: "worker-a",
        prediction: null,
        confidence: null,
        rejectedReason: "none",
        legalActions: legal,
      },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept.map((row) => row.kind)).toEqual(["disagreement", "inconclusive"]);
    expect(kept.every((row) => row.promoted === false && row.acted === false)).toBe(true);
  });

  it("does not let confidence 1 add an action to the legal set", () => {
    const row = classifyShadowRow({
      controlAction: "worker-a",
      prediction: "worker-z",
      confidence: 1,
      rejectedReason: "none",
      legalActions: legal,
    });
    expect(row.kind).toBe("rejected");
    expect(row.legalActions).toEqual(["worker-a", "worker-b"]);
    expect(row.legalActions).not.toContain("worker-z");
    expect(row.acted).toBe(false);
    expect(row.promoted).toBe(false);
  });
});
