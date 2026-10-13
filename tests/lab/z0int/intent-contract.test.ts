import { describe, expect, it } from "vitest";
import {
  admitIntentRevision,
  bindWorkerContract,
  type IntentContractRef,
} from "../../../src/lib/lab/z0int/intent-contract";

const base = {
  id: "intent-1",
  documentPresent: true,
  sourceHash: "hash-r1",
  semanticFingerprint: "fp-r1",
  ripple: "none" as const,
  previous: null,
};

describe("authored_intent_fail_closed", () => {
  it("mints revision 1 when the document and fingerprint are present", () => {
    const admitted = admitIntentRevision(base);
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.ref.revision).toBe(1);
    expect(admitted.ref.semanticFingerprint).toBe("fp-r1");
  });

  it("fails closed when the fingerprint or document is missing", () => {
    expect(admitIntentRevision({ ...base, semanticFingerprint: "  " }).ok).toBe(false);
    expect(admitIntentRevision({ ...base, documentPresent: false }).ok).toBe(false);
  });

  it("does not mint a revision when Ripple is dismissed", () => {
    const admitted = admitIntentRevision({ ...base, ripple: "dismissed" });
    expect(admitted).toEqual({ ok: false, reason: "dismissed", ref: null });
  });

  it("rejects an authority patch and does not bump the revision", () => {
    const previous: IntentContractRef = {
      schema: "o8.z0int.intent-contract-ref/v0",
      id: "intent-1",
      revision: 1,
      sourceHash: "hash-r1",
      semanticFingerprint: "fp-r1",
    };
    const admitted = admitIntentRevision({
      ...base,
      previous,
      ripple: "accepted",
      patchPaths: ["authority.approve"],
      semanticFingerprint: "fp-r2",
    });
    expect(admitted).toEqual({ ok: false, reason: "authority-patch", ref: null });
  });

  it("bumps the revision for an allowlisted accepted patch", () => {
    const previous: IntentContractRef = {
      schema: "o8.z0int.intent-contract-ref/v0",
      id: "intent-1",
      revision: 1,
      sourceHash: "hash-r1",
      semanticFingerprint: "fp-r1",
    };
    const admitted = admitIntentRevision({
      ...base,
      previous,
      ripple: "accepted",
      patchPaths: ["constraints.latency"],
      sourceHash: "hash-r2",
      semanticFingerprint: "fp-r2",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.ref.revision).toBe(2);
    expect(admitted.ref.semanticFingerprint).toBe("fp-r2");
  });
});

describe("worker_cannot_rewrite_authored_intent", () => {
  it("keeps the authored fingerprint when the worker supplies another", () => {
    const authored: IntentContractRef = {
      schema: "o8.z0int.intent-contract-ref/v0",
      id: "intent-1",
      revision: 2,
      sourceHash: "hash-r2",
      semanticFingerprint: "fp-authored",
    };
    const bound = bindWorkerContract(authored, {
      interpretation: "rewrite the intent",
      intentContract: { ...authored, revision: 99, semanticFingerprint: "fp-worker" },
    });
    expect(bound.intentContract).toEqual(authored);
    expect(bound.interpretation).toBe("rewrite the intent");
  });
});
