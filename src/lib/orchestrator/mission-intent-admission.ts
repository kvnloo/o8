/** Bind exact authored identity to the existing creation receipt, not a new ledger. */
import type { NextRequest } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { IntentContractError, type IntentContractRef } from '@/lib/orchestrator/aodl-validation';
import { parseIntentContractRef, resolveIntentContractRef } from '@/lib/orchestrator/intent-reference-resolution';

export interface AuthoredMissionInput {
  authoredIntentRef?: IntentContractRef;
  /** Host-owned live authorization check. Never deserialized from request JSON. */
  assertAuthoredIntentAdmission?: () => void;
}

interface IntentReceiptFields { authoredIntentRef?: IntentContractRef }

/** Snapshot all six fields before any asynchronous preflight or idempotency work. */
export function prepareMissionIntentRequest(request: NextRequest, value: unknown): AuthoredMissionInput {
  if (value === undefined) return {};
  const assertAuthoredIntentAdmission = () => {
    const denied = requirePanelAuth(request);
    if (denied) throw new IntentContractError('intent_operator_auth_required', denied.status);
    if (resolveRequestPrincipalContext(request).role !== 'operator') {
      throw new IntentContractError('operator_required', 403);
    }
  };
  assertAuthoredIntentAdmission();
  return {
    authoredIntentRef: Object.freeze(parseIntentContractRef(value)),
    assertAuthoredIntentAdmission,
  };
}

/** Runs at the service entry, before branch preparation or mission-store mutation.
 * Canonical validation records identity; it does not enforce runtime budgets or
 * grant dispatch authority. Existing dispatch choices are not changed here.
 */
export async function prepareAuthoredMissionIntent(input: AuthoredMissionInput): Promise<{
  receiptFields: IntentReceiptFields;
  assertAuthorized: () => void;
}> {
  if (input.authoredIntentRef === undefined) {
    return { receiptFields: {}, assertAuthorized: () => {} };
  }
  const assertAuthorized = input.assertAuthoredIntentAdmission;
  if (typeof assertAuthorized !== 'function') {
    throw new IntentContractError('intent_operator_context_required', 403);
  }
  assertAuthorized();
  const expected = parseIntentContractRef(input.authoredIntentRef);
  try {
    const record = await resolveIntentContractRef(expected);
    return {
      receiptFields: { authoredIntentRef: Object.freeze({ ...record.ref }) },
      assertAuthorized,
    };
  } finally {
    assertAuthorized();
  }
}

/** Reject a wrong or dropped binding in completed and crash-reconciled receipts.
 * The route keeps a missing crash receipt unresolved before calling this guard.
 */
export function assertMissionIntentReceipt(expected: IntentContractRef | undefined, receipt: unknown): void {
  const record = typeof receipt === 'object' && !Array.isArray(receipt)
    ? receipt as Record<string, unknown> : null;
  const actual = record?.authoredIntentRef;
  if (expected === undefined && actual === undefined) return;
  try {
    if (JSON.stringify(parseIntentContractRef(expected)) === JSON.stringify(parseIntentContractRef(actual))) return;
  } catch { /* Invalid historical identity must not become a successful replay. */ }
  throw new IntentContractError('intent_creation_receipt_mismatch', 409);
}
