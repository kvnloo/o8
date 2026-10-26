/** Authored admission data only; external validation belongs to the caller. */
import { createHash } from 'node:crypto';

export const MAX_INTENT_BYTES = 128 * 1024;
export class IntentContractError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
export interface IntentContractRef {
  id: string;
  revision: number;
  sourceHash: string;
  semanticFingerprint: string;
  validatorRevision: string;
  inputSha256: string;
}
export interface ValidatedIntent {
  ref: IntentContractRef;
  document: string;
}
export function requireIntentAdmission(): void {
  if (process.env.O8_AUTHORED_INTENT_ADMISSION !== '1') {
    throw new IntentContractError('intent_admission_disabled', 503);
  }
}
export function intentInputHash(document: string): string {
  return createHash('sha256').update(document, 'utf8').digest('hex');
}
export function isIntentIdentity(id: unknown, revision: unknown): boolean {
  return typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/.test(id)
    && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0;
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function readAuthoredDocument(document: string): Record<string, unknown> {
  if (!document || Buffer.byteLength(document, 'utf8') > MAX_INTENT_BYTES) {
    throw new IntentContractError('invalid_intent_size', 400);
  }
  let value: unknown;
  try { value = JSON.parse(document); } catch { throw new IntentContractError('invalid_intent_json', 400); }
  if (!isObject(value)) throw new IntentContractError('invalid_intent_document', 400);
  if (!isIntentIdentity(value.graphId, value.revision)) {
    throw new IntentContractError('invalid_intent_identity', 400);
  }
  if (['plan', 'eventLog', 'observedGraph'].some((key) => key in value)) {
    throw new IntentContractError('runtime_projection_not_authored_intent', 400);
  }
  return value;
}
