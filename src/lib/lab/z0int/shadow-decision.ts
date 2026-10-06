/**
 * Shadow decision adapter for hurttlocker/o8#3187.
 *
 * Sits beside o8's control decision (the normalized chokepoint is
 * resolveWorkerRouting in src/lib/agents/routing.ts). This module does not
 * import or call that function, and nothing in production imports this module.
 * Callers pass the control action o8 already chose. The returned action is
 * always that control action.
 */
export const SHADOW_DECISION_SCHEMA = "o8.z0int.shadow-decision/v0" as const;

export type ShadowDecisionRequest = {
  opportunityId: string;
  intentRevision: string;
  stateRevision: string;
  /** False when the state packet is missing, stale, or not the versioned projection. */
  stateOk: boolean;
  decisionKind: string;
  legalActions: readonly string[];
  /** What o8 will do. Opaque. Never replaced. */
  controlAction: string;
};

export type ShadowCandidateResult = {
  prediction: string | null;
  confidence: number | null;
};

export type ShadowCandidate = (request: ShadowDecisionRequest) => ShadowCandidateResult;

export type ShadowRejectedReason =
  | "none"
  | "illegal-action"
  | "malformed-state"
  | "candidate-error";

export type ShadowDecisionReceipt = {
  schema: typeof SHADOW_DECISION_SCHEMA;
  opportunityId: string;
  intentRevision: string;
  stateRevision: string;
  candidate: string;
  prediction: string | null;
  confidence: number | null;
  latencyMs: number;
  acted: false;
  rejectedReason: ShadowRejectedReason;
};

export type ShadowBesideResult = {
  action: string;
  receipt: ShadowDecisionReceipt;
};

function elapsedMs(start: number, end: number): number {
  return Number.isFinite(end - start) ? Math.max(0, end - start) : 0;
}

/**
 * Invariant shadow_never_replaces_control:
 * result.action === request.controlAction and receipt.acted === false,
 * including when the candidate disagrees, throws, proposes an illegal action,
 * or the state is malformed.
 */
export function shadowBesideControl(
  request: ShadowDecisionRequest,
  candidateName: string,
  candidate: ShadowCandidate,
  now: () => number = () => performance.now(),
): ShadowBesideResult {
  const start = now();
  let prediction: string | null = null;
  let confidence: number | null = null;
  let rejectedReason: ShadowRejectedReason = "none";

  const identityOk = request.opportunityId.trim() !== ""
    && request.intentRevision.trim() !== ""
    && request.stateRevision.trim() !== "";

  if (!request.stateOk || !identityOk) {
    rejectedReason = "malformed-state";
  } else {
    try {
      const out = candidate(request);
      const legal = out.prediction === null || request.legalActions.includes(out.prediction);
      if (!legal) {
        rejectedReason = "illegal-action";
      } else {
        prediction = out.prediction;
        confidence = out.confidence;
      }
    } catch {
      rejectedReason = "candidate-error";
    }
  }

  const receipt: ShadowDecisionReceipt = {
    schema: SHADOW_DECISION_SCHEMA,
    opportunityId: request.opportunityId,
    intentRevision: request.intentRevision,
    stateRevision: request.stateRevision,
    candidate: candidateName,
    prediction: rejectedReason === "none" ? prediction : null,
    confidence: rejectedReason === "none" ? confidence : null,
    latencyMs: elapsedMs(start, now()),
    acted: false,
    rejectedReason,
  };

  return { action: request.controlAction, receipt };
}
