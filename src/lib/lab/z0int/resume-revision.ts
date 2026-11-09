/**
 * Resume identity for hurttlocker/o8#3185.
 *
 * A rerun keeps the authored revision unless the operator explicitly revises
 * it. A worker or compaction pass cannot bump or replace that revision.
 * This module does not schedule and does not admit a new AODL document.
 */
export const RESUME_REVISION_SCHEMA = "o8.z0int.resume-revision/v0" as const;

export type ResumeActor = "operator" | "worker" | "compaction";

export type ResumeReason = "preserved" | "operator-revised" | "rejected-rewrite" | "invalid-current";

export type ResumeResult = {
  schema: typeof RESUME_REVISION_SCHEMA;
  revision: number;
  changed: boolean;
  reason: ResumeReason;
};

function positiveInt(value: number | null): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/**
 * Invariant resume_preserves_revision:
 * worker and compaction keep the current revision even when they request
 * another one. Only an operator with explicitRevise may change it.
 */
export function resumeAuthoredRevision(input: {
  currentRevision: number;
  actor: ResumeActor;
  explicitRevise: boolean;
  requestedRevision: number | null;
}): ResumeResult {
  if (!positiveInt(input.currentRevision)) {
    return {
      schema: RESUME_REVISION_SCHEMA,
      revision: Number.isFinite(input.currentRevision) ? input.currentRevision : 0,
      changed: false,
      reason: "invalid-current",
    };
  }
  const operatorRevise = input.actor === "operator" && input.explicitRevise === true;
  if (!operatorRevise) {
    return {
      schema: RESUME_REVISION_SCHEMA,
      revision: input.currentRevision,
      changed: false,
      reason: input.requestedRevision === input.currentRevision || input.requestedRevision === null
        ? "preserved"
        : "rejected-rewrite",
    };
  }
  if (!positiveInt(input.requestedRevision) || input.requestedRevision === input.currentRevision) {
    return {
      schema: RESUME_REVISION_SCHEMA,
      revision: input.currentRevision,
      changed: false,
      reason: "preserved",
    };
  }
  return {
    schema: RESUME_REVISION_SCHEMA,
    revision: input.requestedRevision,
    changed: true,
    reason: "operator-revised",
  };
}
