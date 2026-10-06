/**
 * Handoff continuity check for hurttlocker/o8#3186.
 *
 * Compares a carried state projection to live source revisions. This module
 * never authorizes ACT. OBSERVE means the next worker must rebuild before any
 * later act. CONTINUE means the carried revisions still match; it is not
 * authority.
 */
export const STATE_CONTINUITY_SCHEMA = "o8.z0int.state-continuity/v0" as const;

export type StateClaim = {
  key: string;
  value: unknown;
  evidence: readonly string[];
  status: "current" | "unknown" | "contradiction";
};

export type StatePacketProjection = {
  schema: "z0.state-packet-projection/v0";
  packetId: string;
  intentRevision: string;
  sourceRevisions: Readonly<Record<string, string>>;
  claims: readonly StateClaim[];
  contradictions: readonly string[];
  blockingUnknowns: readonly string[];
};

export type ContinuityDecision = {
  schema: typeof STATE_CONTINUITY_SCHEMA;
  intentRevision: string;
  transition: "CONTINUE" | "OBSERVE";
  acted: false;
  mayAct: false;
  staleKeys: string[];
  contradictions: readonly string[];
  blockingUnknowns: readonly string[];
};

/**
 * Missing evidence stays unknown. It is not coerced to false.
 */
export function claimWithEvidence(claim: StateClaim): StateClaim {
  if (claim.evidence.length === 0) {
    return { ...claim, status: "unknown" };
  }
  return claim;
}

/**
 * Invariant stale_state_cannot_act:
 * any carried source revision that differs from live forces OBSERVE and
 * mayAct false. Matching revisions CONTINUE with mayAct still false.
 * Contradictions and blocking unknowns stay explicit and also force OBSERVE.
 */
export function decideContinuity(
  carried: StatePacketProjection,
  liveRevisions: Readonly<Record<string, string>>,
): ContinuityDecision {
  const staleKeys = Object.keys(carried.sourceRevisions).filter(
    (key) => liveRevisions[key] !== carried.sourceRevisions[key],
  );
  const mustObserve = staleKeys.length > 0
    || carried.contradictions.length > 0
    || carried.blockingUnknowns.length > 0;
  return {
    schema: STATE_CONTINUITY_SCHEMA,
    intentRevision: carried.intentRevision,
    transition: mustObserve ? "OBSERVE" : "CONTINUE",
    acted: false,
    mayAct: false,
    staleKeys,
    contradictions: carried.contradictions,
    blockingUnknowns: carried.blockingUnknowns,
  };
}
