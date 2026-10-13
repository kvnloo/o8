/**
 * Compaction identity for hurttlocker/o8#3186.
 *
 * Compaction may drop the narrative body. It must keep the narrative
 * reference plus the authored intent and state revisions when those were
 * present. This module does not edit handoff-packet.ts and does not act.
 */
export const COMPACTION_IDENTITY_SCHEMA = "o8.z0int.compaction-identity/v0" as const;

export type CompactionInput = {
  narrativeRef: string;
  narrativeBody: string;
  intentRevision: string | null;
  stateRevision: string | null;
  /** False for legacy handoffs that never carried an authored intent. */
  hadAuthoredIntent: boolean;
};

export type CompactionIdentity = {
  schema: typeof COMPACTION_IDENTITY_SCHEMA;
  narrativeRef: string;
  intentRevision: string | null;
  stateRevision: string | null;
  narrativeBodyDropped: true;
};

export type CompactionFailure = "dropped-narrative-ref" | "dropped-intent" | "dropped-state";

export type CompactionResult =
  | { ok: true; identity: CompactionIdentity }
  | { ok: false; reason: CompactionFailure };

function blank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

/**
 * Invariant compaction_preserves_intent_identity:
 * a blank narrative ref fails closed. An authored handoff that loses its
 * intent revision or state revision fails closed. A legacy handoff with
 * neither field stays valid. The narrative body is never copied out.
 */
export function compactHandoffIdentity(input: CompactionInput): CompactionResult {
  if (blank(input.narrativeRef)) {
    return { ok: false, reason: "dropped-narrative-ref" };
  }
  if (input.hadAuthoredIntent && blank(input.intentRevision)) {
    return { ok: false, reason: "dropped-intent" };
  }
  if (input.hadAuthoredIntent && blank(input.stateRevision)) {
    return { ok: false, reason: "dropped-state" };
  }
  const identity: CompactionIdentity = {
    schema: COMPACTION_IDENTITY_SCHEMA,
    narrativeRef: input.narrativeRef,
    intentRevision: input.hadAuthoredIntent ? input.intentRevision : null,
    stateRevision: input.hadAuthoredIntent ? input.stateRevision : null,
    narrativeBodyDropped: true,
  };
  return { ok: true, identity };
}
