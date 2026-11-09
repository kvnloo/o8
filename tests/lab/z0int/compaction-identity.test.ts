import { describe, expect, it } from "vitest";
import { compactHandoffIdentity } from "../../../src/lib/lab/z0int/compaction-identity";

const body = "full private narrative that compaction must not keep";

describe("compaction_preserves_intent_identity", () => {
  it("keeps the narrative ref and both revisions and drops the body", () => {
    const result = compactHandoffIdentity({
      narrativeRef: "narrative:full:1",
      narrativeBody: body,
      intentRevision: "intent:7",
      stateRevision: "state:3",
      hadAuthoredIntent: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.narrativeRef).toBe("narrative:full:1");
    expect(result.identity.intentRevision).toBe("intent:7");
    expect(result.identity.stateRevision).toBe("state:3");
    expect(result.identity.narrativeBodyDropped).toBe(true);
    expect(JSON.stringify(result.identity)).not.toContain(body);
    expect("narrativeBody" in result.identity).toBe(false);
  });

  it("fails closed when compaction drops the authored intent or state revision", () => {
    expect(compactHandoffIdentity({
      narrativeRef: "narrative:full:1",
      narrativeBody: body,
      intentRevision: "  ",
      stateRevision: "state:3",
      hadAuthoredIntent: true,
    })).toEqual({ ok: false, reason: "dropped-intent" });
    expect(compactHandoffIdentity({
      narrativeRef: "narrative:full:1",
      narrativeBody: body,
      intentRevision: "intent:7",
      stateRevision: null,
      hadAuthoredIntent: true,
    })).toEqual({ ok: false, reason: "dropped-state" });
  });

  it("fails closed when the narrative reference itself is dropped", () => {
    expect(compactHandoffIdentity({
      narrativeRef: "",
      narrativeBody: body,
      intentRevision: "intent:7",
      stateRevision: "state:3",
      hadAuthoredIntent: true,
    })).toEqual({ ok: false, reason: "dropped-narrative-ref" });
  });

  it("keeps a legacy handoff that never had an authored intent", () => {
    const result = compactHandoffIdentity({
      narrativeRef: "narrative:legacy",
      narrativeBody: body,
      intentRevision: null,
      stateRevision: null,
      hadAuthoredIntent: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.intentRevision).toBeNull();
    expect(result.identity.stateRevision).toBeNull();
    expect(JSON.stringify(result.identity)).not.toContain(body);
  });
});
