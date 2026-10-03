/**
 * Authored-intent reference for hurttlocker/o8#3185.
 *
 * Does not reimplement AODL canonicalization. sourceHash and
 * semanticFingerprint are supplied by the pinned AODL contract and only
 * checked for presence. This module does not schedule work.
 */
export const INTENT_CONTRACT_SCHEMA = "o8.z0int.intent-contract-ref/v0" as const;

export type IntentContractRef = {
  schema: typeof INTENT_CONTRACT_SCHEMA;
  id: string;
  revision: number;
  sourceHash: string;
  semanticFingerprint: string;
};

const ALLOWED_PATCH_PREFIXES = [
  "intent.",
  "constraints.",
  "references.",
  "verification.",
] as const;

export type AdmitReason = "invalid-structure" | "authority-patch" | "dismissed";

export type AdmitResult =
  | { ok: true; ref: IntentContractRef }
  | { ok: false; reason: AdmitReason; ref: null };

export type AdmitIntentInput = {
  id: string;
  previous: IntentContractRef | null;
  /** Structural presence check only. Not an AODL parser. */
  documentPresent: boolean;
  sourceHash: string;
  semanticFingerprint: string;
  patchPaths?: readonly string[];
  ripple: "none" | "accepted" | "dismissed";
};

export function patchPathAllowed(path: string): boolean {
  return ALLOWED_PATCH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function nonEmpty(value: string): boolean {
  return value.trim() !== "";
}

/**
 * Invariant authored_intent_fail_closed:
 * a dismissed Ripple choice, a missing document, a missing fingerprint, or any
 * patch outside the allowlist yields no new ref. An accepted allowlisted patch
 * mints the next revision. The fingerprint is stored, never computed here.
 */
export function admitIntentRevision(input: AdmitIntentInput): AdmitResult {
  if (input.ripple === "dismissed") {
    return { ok: false, reason: "dismissed", ref: null };
  }
  const patches = input.patchPaths ?? [];
  if (patches.some((path) => !patchPathAllowed(path))) {
    return { ok: false, reason: "authority-patch", ref: null };
  }
  if (!input.documentPresent || !nonEmpty(input.id) || !nonEmpty(input.sourceHash) || !nonEmpty(input.semanticFingerprint)) {
    return { ok: false, reason: "invalid-structure", ref: null };
  }
  const revision = input.ripple === "accepted"
    ? (input.previous?.revision ?? 0) + 1
    : input.previous?.revision ?? 1;
  return {
    ok: true,
    ref: {
      schema: INTENT_CONTRACT_SCHEMA,
      id: input.id,
      revision,
      sourceHash: input.sourceHash,
      semanticFingerprint: input.semanticFingerprint,
    },
  };
}

export type WorkerContractAttempt = {
  interpretation: string;
  intentContract?: IntentContractRef | null;
};

/**
 * Invariant worker_cannot_rewrite_authored_intent:
 * the bound ref is the authored ref, even if the worker attempt carries a
 * different revision or fingerprint.
 */
export function bindWorkerContract(
  authored: IntentContractRef,
  worker: WorkerContractAttempt,
): { intentContract: IntentContractRef; interpretation: string } {
  return {
    intentContract: {
      schema: authored.schema,
      id: authored.id,
      revision: authored.revision,
      sourceHash: authored.sourceHash,
      semanticFingerprint: authored.semanticFingerprint,
    },
    interpretation: worker.interpretation,
  };
}
