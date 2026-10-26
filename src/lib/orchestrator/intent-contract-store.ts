/** Immutable authored-intent records; no current-pointer or dispatch mutation. */
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { getDataDir } from '@/lib/data-dir-migration';
import {
  IntentContractError, intentInputHash, isIntentIdentity, isObject, readAuthoredDocument, requireIntentAdmission,
  type ValidatedIntent,
} from '@/lib/orchestrator/intent-contract-schema';

export interface IntentContractRecord extends ValidatedIntent {
  schema: 'o8/intent-contract/v1';
  createdAt: string;
}

function recordPath(id: string, revision: number): string {
  if (!isIntentIdentity(id, revision)) throw new IntentContractError('invalid_intent_identity', 400);
  const key = createHash('sha256').update(id, 'utf8').digest('hex');
  return join(getDataDir(), 'intent-contracts', key, `${revision}.json`);
}

function checkRecord(value: unknown, id: string, revision: number): IntentContractRecord {
  if (!isObject(value)) throw new IntentContractError('invalid_intent_record', 500);
  const record = value;
  if (record.schema !== 'o8/intent-contract/v1' || !isObject(record.ref)
    || record.ref.id !== id || record.ref.revision !== revision
    || typeof record.document !== 'string'
    || record.ref.inputSha256 !== intentInputHash(record.document)
    || typeof record.ref.semanticFingerprint !== 'string' || !/^aodl-canon-1:[a-f0-9]{64}$/.test(record.ref.semanticFingerprint)
    || typeof record.ref.validatorRevision !== 'string' || !/^[a-f0-9]{16}$/.test(record.ref.validatorRevision)
    || typeof record.ref.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(record.ref.sourceHash)
    || typeof record.createdAt !== 'string' || !Number.isFinite(Date.parse(record.createdAt))) {
    throw new IntentContractError('invalid_intent_record', 500);
  }
  const doc = readAuthoredDocument(record.document);
  const provenance = isObject(doc.provenance) ? doc.provenance : undefined;
  if (doc.graphId !== id || doc.revision !== revision || provenance?.sourceHash !== record.ref.sourceHash) {
    throw new IntentContractError('invalid_intent_record', 500);
  }
  return { schema: 'o8/intent-contract/v1', document: record.document, createdAt: record.createdAt,
    ref: { id, revision, sourceHash: record.ref.sourceHash,
      semanticFingerprint: record.ref.semanticFingerprint, validatorRevision: record.ref.validatorRevision,
      inputSha256: intentInputHash(record.document) } };
}

export async function readIntentContract(id: string, revision: number): Promise<IntentContractRecord | null> {
  requireIntentAdmission();
  const path = recordPath(id, revision);
  try {
    return checkRecord(JSON.parse(await readFile(path, 'utf8')), id, revision);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new IntentContractError('invalid_intent_record', 500);
  }
}

export async function persistIntentContract(intent: ValidatedIntent): Promise<IntentContractRecord> {
  requireIntentAdmission();
  const record = checkRecord({
    schema: 'o8/intent-contract/v1', ...intent, createdAt: new Date().toISOString(),
  }, intent.ref.id, intent.ref.revision);
  const path = recordPath(record.ref.id, record.ref.revision);
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.pending-${randomUUID()}`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await file.sync();
    } finally {
      await file.close();
    }
    // Atomic create-only publication. A partial write never occupies the revision.
    try {
      await link(temporary, path);
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const previous = await readIntentContract(record.ref.id, record.ref.revision);
      if (previous?.ref.inputSha256 === record.ref.inputSha256
        && previous.ref.semanticFingerprint === record.ref.semanticFingerprint
        && previous.ref.validatorRevision === record.ref.validatorRevision) return previous;
      throw new IntentContractError('intent_revision_conflict', 409);
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}
