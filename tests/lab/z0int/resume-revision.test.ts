import { describe, expect, it } from "vitest";
import { resumeAuthoredRevision } from "../../../src/lib/lab/z0int/resume-revision";

describe("resume_preserves_revision", () => {
  it("keeps the revision when nobody asks to change it", () => {
    expect(resumeAuthoredRevision({
      currentRevision: 4,
      actor: "operator",
      explicitRevise: false,
      requestedRevision: null,
    })).toMatchObject({ revision: 4, changed: false, reason: "preserved" });
  });

  it("rejects a worker or compaction rewrite and keeps the current revision", () => {
    for (const actor of ["worker", "compaction"] as const) {
      expect(resumeAuthoredRevision({
        currentRevision: 4,
        actor,
        explicitRevise: true,
        requestedRevision: 9,
      })).toMatchObject({ revision: 4, changed: false, reason: "rejected-rewrite" });
    }
  });

  it("lets only an explicit operator revise move the revision", () => {
    expect(resumeAuthoredRevision({
      currentRevision: 4,
      actor: "operator",
      explicitRevise: true,
      requestedRevision: 5,
    })).toMatchObject({ revision: 5, changed: true, reason: "operator-revised" });
  });

  it("does not move the revision when the operator request is blank or the same", () => {
    expect(resumeAuthoredRevision({
      currentRevision: 4,
      actor: "operator",
      explicitRevise: true,
      requestedRevision: 4,
    })).toMatchObject({ revision: 4, changed: false, reason: "preserved" });
    expect(resumeAuthoredRevision({
      currentRevision: 4,
      actor: "operator",
      explicitRevise: true,
      requestedRevision: null,
    })).toMatchObject({ revision: 4, changed: false, reason: "preserved" });
  });

  it("fails closed on a non-positive current revision", () => {
    expect(resumeAuthoredRevision({
      currentRevision: 0,
      actor: "operator",
      explicitRevise: true,
      requestedRevision: 2,
    })).toMatchObject({ changed: false, reason: "invalid-current" });
  });
});
