import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { getDataDir } from '@/lib/data-dir-migration';
import type { JudgmentContext, JudgmentQuestionSet, JudgmentRoute } from '@/lib/judgment/types';
import { verifyBendShadowLaws, type BendShadowVerdict } from './bend-verifier';
import { callZ0ShadowBridge, type Z0ShadowCallResult, Z0_BRIDGE_PROTOCOL } from './z0-client';

const MAX_BRIDGE_BYTES = 44_000;
const MAX_IN_FLIGHT = 4;
const RECEIPT_SCHEMA = 'o8.z0-bend.shadow-receipt.v1';

const FORBIDDEN_KEYS = new Set([
  'user_id', 'userid', 'session_id', 'sessionid', 'session_key', 'sessionkey',
  'api_key', 'apikey', 'access_token', 'accesstoken', 'oauth_token', 'oauthtoken',
  'authorization', 'credential', 'credentials', 'password', 'secret',
]);

export interface JudgmentShadowInput {
  receiptId: string;
  state: unknown;
  questions: JudgmentQuestionSet;
  context: JudgmentContext;
  incumbent: {
    answers: Record<string, unknown>;
    model: string;
    route: JudgmentRoute | null;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
  };
}

export interface Z0BendShadowReceipt {
  schema: typeof RECEIPT_SCHEMA;
  observedAt: string;
  judgmentReceiptId: string;
  laneId: string;
  traceId: string;
  incumbent: {
    model: string;
    route: JudgmentRoute | null;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    answerSha256: string;
  };
  z0: Z0ShadowCallResult;
  bend: BendShadowVerdict;
  applied: false;
  verifiedSuccess: false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function boundedJson(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length <= 2_048 ? value : value.slice(0, 2_048) + '…';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return null;
  if (depth >= 6) return '[depth-limit]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.slice(0, 32).map((entry) => boundedJson(entry, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value).slice(0, 64)) {
    if (FORBIDDEN_KEYS.has(normalizeKey(key))) continue;
    out[key] = boundedJson(child, depth + 1, seen);
  }
  return out;
}

function boundedId(value: string | null | undefined, prefix: string): string | null {
  if (!value) return null;
  return value.length <= 200 ? value : prefix + ':' + sha256(value).slice(0, 32);
}

function stableInstance(dataDir: string): string {
  return 'o8-instance:' + sha256(dataDir).slice(0, 24);
}

function deriveTrace(instance: string, operationId: string): string {
  return sha256(instance + '\0' + operationId);
}

function compactQuestionTypes(questions: JudgmentQuestionSet): Record<string, string> {
  return Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, question.type]));
}

export function buildZ0ShadowRequest(
  input: JudgmentShadowInput,
  nowUnixMs = Date.now(),
  dataDir = getDataDir(),
): Record<string, unknown> {
  const instance = stableInstance(dataDir);
  const operationId = 'judgment:' + input.receiptId;
  const laneId = boundedId(input.context.laneId, 'lane')
    ?? 'judgment:' + sha256(input.receiptId).slice(0, 24);
  const packetId = boundedId(input.context.packetId, 'packet');
  const approvalId = boundedId(input.context.approvalId, 'approval');

  const state = boundedJson({
    o8_state: input.state,
    questions: input.questions,
    incumbent_answers: input.incumbent.answers,
    surface: input.context.surface ?? null,
    truncated: input.context.truncated ?? false,
    hidden_text: input.context.hiddenText ?? false,
  });

  const request: Record<string, any> = {
    protocol_version: Z0_BRIDGE_PROTOCOL,
    mode: 'shadow',
    operation_id: operationId,
    trace_id: deriveTrace(instance, operationId),
    integration_instance: instance,
    deadline_unix_ms: nowUnixMs + 10_000,
    lane: {
      id: laneId,
      packet_id: packetId,
      project_id: null,
      runtime: null,
      revision: 0,
    },
    capability: {
      function: 'o8.typed_judgment.shadow_route',
      task: ('Shadow-route o8 typed judgment: '
        + Object.entries(input.questions).map(([id, question]) => id + ':' + question.type).join(', ')).slice(0, 16_000),
      state,
      experimental: true,
      automatic: false,
      max_tokens: 128,
    },
    policy: {
      allow_remote_context: false,
      free_only: true,
      risk_class: 'read',
      approval_state: 'unknown',
    },
    evidence: [],
    correlation: {
      judgment_receipt_id: input.receiptId,
      ...(approvalId ? { approval_id: approvalId } : {}),
    },
  };

  let encoded = JSON.stringify(request);
  if (Buffer.byteLength(encoded) > MAX_BRIDGE_BYTES) {
    request.capability.state = {
      state_sha256: sha256(JSON.stringify(state)),
      question_types: compactQuestionTypes(input.questions),
      incumbent_answer_sha256: sha256(JSON.stringify(boundedJson(input.incumbent.answers))),
      truncated_for_bridge: true,
    };
    encoded = JSON.stringify(request);
  }
  if (Buffer.byteLength(encoded) > MAX_BRIDGE_BYTES) {
    throw new Error('z0 shadow request remains oversized after compaction');
  }
  return request;
}

async function persistReceipt(receipt: Z0BendShadowReceipt, dataDir = getDataDir()): Promise<void> {
  const path = join(dataDir, 'labs', 'z0-bend-shadow.jsonl');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await appendFile(path, JSON.stringify(receipt) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export async function observeZ0BendJudgmentShadow(
  input: JudgmentShadowInput,
  deps: {
    env?: Readonly<Record<string, string | undefined>>;
    dataDir?: string;
    callBridge?: typeof callZ0ShadowBridge;
    verifyBend?: typeof verifyBendShadowLaws;
    persist?: (receipt: Z0BendShadowReceipt) => Promise<void>;
  } = {},
): Promise<Z0BendShadowReceipt> {
  const dataDir = deps.dataDir ?? getDataDir();
  const request = buildZ0ShadowRequest(input, Date.now(), dataDir);
  const env = deps.env ?? process.env;
  const [z0, bend] = await Promise.all([
    (deps.callBridge ?? callZ0ShadowBridge)(request, { env }),
    (deps.verifyBend ?? verifyBendShadowLaws)({ env }),
  ]);

  const receipt: Z0BendShadowReceipt = {
    schema: RECEIPT_SCHEMA,
    observedAt: new Date().toISOString(),
    judgmentReceiptId: input.receiptId,
    laneId: String((request.lane as Record<string, unknown>).id),
    traceId: String(request.trace_id),
    incumbent: {
      model: input.incumbent.model,
      route: input.incumbent.route,
      latencyMs: input.incumbent.latencyMs,
      inputTokens: input.incumbent.inputTokens,
      outputTokens: input.incumbent.outputTokens,
      answerSha256: sha256(JSON.stringify(boundedJson(input.incumbent.answers))),
    },
    z0,
    bend,
    applied: false,
    verifiedSuccess: false,
  };

  try {
    if (deps.persist) await deps.persist(receipt);
    else await persistReceipt(receipt, dataDir);
  } catch {
    // Shadow evidence must never change the incumbent judgment result.
  }
  return receipt;
}

let inFlight = 0;

export function scheduleZ0BendJudgmentShadow(input: JudgmentShadowInput): void {
  try {
    if (process.env.O8_Z0_SHADOW !== '1' || inFlight >= MAX_IN_FLIGHT) return;
    inFlight += 1;
    void observeZ0BendJudgmentShadow(input).catch(() => undefined).finally(() => {
      inFlight -= 1;
    });
  } catch {
    // The shadow path is observational only and never allowed to fail the host judgment.
  }
}
