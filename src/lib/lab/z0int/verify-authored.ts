/**
 * Verification against the authored intent for hurttlocker/o8#3184 and #3185.
 *
 * Worker completion is not verified success. This module does not schedule,
 * review, or merge. It only reports whether the authored checks passed.
 */
export const VERIFY_AUTHORED_SCHEMA = "o8.z0int.verify-authored/v0" as const;

export type IntentRef = {
  id: string;
  revision: number;
};

export type AuthoredCheck = {
  id: string;
  satisfied: boolean;
};

export type VerifyReason =
  | "missing-ref"
  | "missing-checks"
  | "authored-checks-failed"
  | "worker-not-done"
  | "verified";

export type VerifyResult = {
  schema: typeof VERIFY_AUTHORED_SCHEMA;
  passed: boolean;
  workerDone: boolean;
  reason: VerifyReason;
};

function refPresent(intentRef: IntentRef | null): intentRef is IntentRef {
  return intentRef !== null
    && intentRef.id.trim() !== ""
    && Number.isInteger(intentRef.revision)
    && intentRef.revision >= 1;
}

/**
 * Invariant verify_against_authored_intent:
 * a worker that is done still fails when any authored check fails.
 * A missing intent ref fails closed even if every supplied check passed.
 */
export function verifyAgainstAuthoredIntent(input: {
  intentRef: IntentRef | null;
  workerStatus: "done" | "running" | "failed";
  checks: readonly AuthoredCheck[] | null;
}): VerifyResult {
  const workerDone = input.workerStatus === "done";
  if (!refPresent(input.intentRef)) {
    return {
      schema: VERIFY_AUTHORED_SCHEMA,
      passed: false,
      workerDone,
      reason: "missing-ref",
    };
  }
  if (input.checks === null || input.checks.length === 0) {
    return {
      schema: VERIFY_AUTHORED_SCHEMA,
      passed: false,
      workerDone,
      reason: "missing-checks",
    };
  }
  if (input.checks.some((check) => check.satisfied !== true)) {
    return {
      schema: VERIFY_AUTHORED_SCHEMA,
      passed: false,
      workerDone,
      reason: "authored-checks-failed",
    };
  }
  if (!workerDone) {
    return {
      schema: VERIFY_AUTHORED_SCHEMA,
      passed: false,
      workerDone: false,
      reason: "worker-not-done",
    };
  }
  return {
    schema: VERIFY_AUTHORED_SCHEMA,
    passed: true,
    workerDone: true,
    reason: "verified",
  };
}
