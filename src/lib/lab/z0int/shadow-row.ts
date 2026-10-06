/**
 * Shadow-row classification for hurttlocker/o8#3187.
 *
 * Agreement with the o8 control action is not gold and does not promote.
 * Inconclusive and disagreement rows stay in the cohort. Confidence cannot
 * add an action to the legal set. This module does not execute or delegate.
 */
export const SHADOW_ROW_SCHEMA = "o8.z0int.shadow-row/v0" as const;

export type ShadowRejectedReason = "none" | "illegal-action" | "malformed-state" | "candidate-error";

export type ShadowRow = {
  controlAction: string;
  prediction: string | null;
  confidence: number | null;
  rejectedReason: ShadowRejectedReason;
  legalActions: readonly string[];
};

export type ShadowRowKind = "agreement" | "disagreement" | "inconclusive" | "rejected";

export type ClassifiedShadowRow = {
  schema: typeof SHADOW_ROW_SCHEMA;
  kept: true;
  kind: ShadowRowKind;
  agreementIsGold: false;
  promoted: false;
  acted: false;
  legalActions: string[];
};

/**
 * Invariant agreement_is_not_gold:
 * every input row is kept. Agreement does not set gold, promoted, or acted.
 * A prediction outside the legal set is rejected and is not appended, even
 * when confidence is 1. A null prediction stays inconclusive.
 */
export function classifyShadowRow(row: ShadowRow): ClassifiedShadowRow {
  const legalActions = [...row.legalActions];
  let kind: ShadowRowKind;
  if (row.rejectedReason !== "none") {
    kind = "rejected";
  } else if (row.prediction === null || row.prediction.trim() === "") {
    kind = "inconclusive";
  } else if (!legalActions.includes(row.prediction)) {
    kind = "rejected";
  } else if (row.prediction === row.controlAction) {
    kind = "agreement";
  } else {
    kind = "disagreement";
  }
  return {
    schema: SHADOW_ROW_SCHEMA,
    kept: true,
    kind,
    agreementIsGold: false,
    promoted: false,
    acted: false,
    legalActions,
  };
}

/** Keeps every row, including inconclusive and negative ones. */
export function retainShadowRows(rows: readonly ShadowRow[]): ClassifiedShadowRow[] {
  return rows.map(classifyShadowRow);
}
