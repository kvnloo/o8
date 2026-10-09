/** Read-only prerequisite for mission admission; resolving a ref grants no authority. */
import {
  IntentContractError, isIntentIdentity, validateAodlIntent, type IntentContractRef,
} from '@/lib/orchestrator/aodl-validation';
import { readIntentContract, type IntentContractRecord } from '@/lib/orchestrator/intent-contract-store';

const REF_KEYS = ['id', 'revision', 'sourceHash', 'semanticFingerprint', 'validatorRevision', 'inputSha256'] as const;
const HASH = /^[a-f0-9]{64}$/;

/** Copy the complete reference before awaiting IO. No coercion or latest-revision lookup. */
export function parseIntentContractRef(value: unknown): IntentContractRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new IntentContractError('invalid_intent_ref', 400);
  }
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== REF_KEYS.length
    || !REF_KEYS.every((key) => Object.prototype.hasOwnProperty.call(raw, key))
    || !isIntentIdentity(raw.id, raw.revision)
    || typeof raw.sourceHash !== 'string' || !HASH.test(raw.sourceHash)
    || typeof raw.inputSha256 !== 'string' || !HASH.test(raw.inputSha256)
    || typeof raw.validatorRevision !== 'string' || !/^[a-f0-9]{16}$/.test(raw.validatorRevision)
    || typeof raw.semanticFingerprint !== 'string' || !/^aodl-canon-1:[a-f0-9]{64}$/.test(raw.semanticFingerprint)) {
    throw new IntentContractError('invalid_intent_ref', 400);
  }
  return {
    id: raw.id as string, revision: raw.revision as number,
    sourceHash: raw.sourceHash, semanticFingerprint: raw.semanticFingerprint,
    validatorRevision: raw.validatorRevision, inputSha256: raw.inputSha256,
  };
}

function sameRef(left: IntentContractRef, right: IntentContractRef): boolean {
  return REF_KEYS.every((key) => left[key] === right[key]);
}

/** Validate the stored snapshot again with the configured canonical AODL implementation.
 * This does not bind a mission, launch a worker, or authorize dispatch. Callers must
 * retain this exact ref in their own admission transaction rather than a "latest" alias.
 */
export async function resolveIntentContractRef(value: unknown): Promise<IntentContractRecord> {
  const expected = parseIntentContractRef(value);
  const stored = await readIntentContract(expected.id, expected.revision);
  if (!stored) throw new IntentContractError('intent_not_found', 404);
  if (!sameRef(expected, stored.ref)) {
    throw new IntentContractError('intent_ref_mismatch', 409);
  }
  // Stored hashes are assertions, not a substitute for canonical verification.
  const verified = await validateAodlIntent(stored.document);
  if (!sameRef(expected, verified.ref)) {
    throw new IntentContractError('intent_record_identity_mismatch', 500);
  }
  return { ...stored, ref: { ...verified.ref } };
}
