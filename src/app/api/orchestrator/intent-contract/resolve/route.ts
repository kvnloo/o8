import { NextRequest, NextResponse } from 'next/server';
import { requirePanelAuth } from '@/lib/panel/auth';
import { resolveRequestPrincipalContext } from '@/lib/auth/principal';
import { IntentContractError } from '@/lib/orchestrator/aodl-validation';
import { resolveIntentContractRef } from '@/lib/orchestrator/intent-reference-resolution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_REF_BYTES = 1024;
const headers = { 'Cache-Control': 'no-store, max-age=0' };

function denied(request: NextRequest) {
  const auth = requirePanelAuth(request);
  if (auth) return auth;
  return resolveRequestPrincipalContext(request).role === 'operator' ? null
    : NextResponse.json({ ok: false, error: 'operator_required' }, { status: 403, headers });
}

async function readReference(request: NextRequest): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) throw new IntentContractError('invalid_intent_ref', 400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REF_BYTES) {
        await reader.cancel();
        throw new IntentContractError('intent_ref_too_large', 413);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    } catch { throw new IntentContractError('invalid_intent_ref', 400); }
  } finally { reader.releaseLock(); }
}

/** Read-only exact-reference resolution. This is not a mission or dispatch endpoint. */
export async function POST(request: NextRequest) {
  const refusal = denied(request);
  if (refusal) return refusal;
  try {
    const record = await resolveIntentContractRef(await readReference(request));
    const changed = denied(request);
    if (changed) return changed;
    return NextResponse.json({ ok: true, record }, { headers });
  } catch (error) {
    const changed = denied(request);
    if (changed) return changed;
    return NextResponse.json({
      ok: false, error: error instanceof IntentContractError ? error.code : 'intent_resolution_unavailable',
    }, { status: error instanceof IntentContractError ? error.status : 503, headers });
  }
}
