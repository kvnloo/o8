import { describe, expect, it } from "vitest";
import {
  claimWithEvidence,
  decideContinuity,
  type StatePacketProjection,
} from "../../../src/lib/lab/z0int/state-continuity";

function carried(overrides: Partial<StatePacketProjection> = {}): StatePacketProjection {
  return {
    schema: "z0.state-packet-projection/v0",
    packetId: "pkt-1",
    intentRevision: "intent-r1",
    sourceRevisions: { "file:X": "abc" },
    claims: [{ key: "file:X", value: "slow-path", evidence: ["git:abc"], status: "current" }],
    contradictions: [],
    blockingUnknowns: [],
    ...overrides,
  };
}

describe("stale_state_cannot_act", () => {
  it("forces OBSERVE when a source revision changes and never acts", () => {
    const decision = decideContinuity(carried(), { "file:X": "def" });
    expect(decision.transition).toBe("OBSERVE");
    expect(decision.acted).toBe(false);
    expect(decision.mayAct).toBe(false);
    expect(decision.staleKeys).toEqual(["file:X"]);
    expect(decision.intentRevision).toBe("intent-r1");
  });

  it("CONTINUEs when source revisions are unchanged without granting act authority", () => {
    const decision = decideContinuity(carried(), { "file:X": "abc" });
    expect(decision.transition).toBe("CONTINUE");
    expect(decision.acted).toBe(false);
    expect(decision.mayAct).toBe(false);
    expect(decision.staleKeys).toEqual([]);
  });

  it("keeps a contradiction explicit and will not act through it", () => {
    const decision = decideContinuity(
      carried({ contradictions: ["file:X current vs deleted"] }),
      { "file:X": "abc" },
    );
    expect(decision.transition).toBe("OBSERVE");
    expect(decision.contradictions).toEqual(["file:X current vs deleted"]);
    expect(decision.mayAct).toBe(false);
  });

  it("does not coerce missing evidence to false", () => {
    const claim = claimWithEvidence({
      key: "gate",
      value: false,
      evidence: [],
      status: "current",
    });
    expect(claim.status).toBe("unknown");
    expect(claim.value).toBe(false);
    const verified = claim.evidence.length === 0 ? null : claim.value;
    expect(verified).toBeNull();
  });
});
