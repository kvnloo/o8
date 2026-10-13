import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { applyOrchestrationMode } from '@/lib/lane/orchestrator-backends/orchestration-mode';
import { composeComposerWireMessage, modelFacingComposerMessage, withSessionPrelude } from '@/lib/orchestrator/composer-wire';
import {
  consumeOrchestratorSessionPrelude,
  hasQueuedOrchestratorSessionPrelude,
  normalizeOrchestratorMissionState,
  queueOrchestratorSessionPrelude,
} from '@/lib/orchestrator/store';
import { executeOrchestratorSlashCommand } from './index';
import type { SlashCommandContext } from './types';

const repoPath = '/excerpt-regression';
const threadId = 'thoughts-excerpt-thread';
const marker = (index: number) => `turn-marker-${String(index).padStart(3, '0')}`;

function context(transcript: MobileTranscriptEntry[]): SlashCommandContext {
  return {
    repoPath,
    transcript,
    missionState: normalizeOrchestratorMissionState({
      version: 2,
      packets: [{ id: 'packet-one', referenceLabel: 'P1', title: 'excerpt-review' }],
    }),
    runningTotal: 0,
    currentModel: 'test-model',
    setCurrentModel: vi.fn(),
    appendEntries: vi.fn(),
    replaceTranscript: vi.fn(),
    compactNow: vi.fn(async () => null),
    resetRemoteSession: vi.fn(async () => true),
    queuePrelude: (prelude, mode) => queueOrchestratorSessionPrelude(repoPath, prelude, mode, threadId),
    searchArchive: vi.fn(async () => []),
    fetchTelemetry: vi.fn(async () => ({ totalTokens: null, estimatedCostUsd: null, model: null })),
    clearThread: vi.fn(async () => {}),
  };
}

function consumeModelMessage() {
  expect(hasQueuedOrchestratorSessionPrelude(repoPath, threadId)).toBe(true);
  // These are the production desktop send and server model-facing steps.
  const prelude = consumeOrchestratorSessionPrelude(repoPath, threadId);
  const { wireMessage } = composeComposerWireMessage('Continue P1', 'solo');
  const outbound = withSessionPrelude(wireMessage, prelude, 'single');
  const message = applyOrchestrationMode(modelFacingComposerMessage(outbound, 'single'), {
    orchestrationMode: 'single',
  }).message;
  expect(consumeOrchestratorSessionPrelude(repoPath, threadId)).toBeNull();
  expect(message).toContain('Operator message:\nContinue P1');
  return { prelude, message };
}

describe('slash excerpt session context (#2959)', () => {
  beforeEach(() => {
    const values = new Map<string, string>();
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      },
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('focus queues the newest of twelve matching turns and delivers it to model context', async () => {
    const transcript: MobileTranscriptEntry[] = Array.from({ length: 12 }, (_, index) => ({
      id: `turn-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      text: `P1 packet-one excerpt-review ${marker(index)} ${'x'.repeat(600)}`,
    }));
    const commandContext = context(transcript);
    expect(await executeOrchestratorSlashCommand('/focus P1', commandContext)).toEqual({ handled: true });
    const { prelude, message } = consumeModelMessage();
    expect(prelude).toContain(marker(11));
    expect(message).toContain(marker(11));
    for (let index = 0; index < 4; index += 1) {
      expect(prelude).not.toContain(marker(index));
      expect(message).not.toContain(marker(index));
    }
    const retained = transcript.map((_, index) => index).filter((index) => prelude!.includes(marker(index)));
    expect(retained.length).toBeGreaterThan(1);
    for (let index = 1; index < retained.length; index += 1) {
      expect(retained[index]).toBe(retained[index - 1]! + 1);
      expect(prelude!.indexOf(marker(retained[index - 1]!))).toBeLessThan(prelude!.indexOf(marker(retained[index]!)));
    }
    expect(commandContext.replaceTranscript).toHaveBeenCalledWith([...transcript, expect.objectContaining({ type: 'command' })]);
  });

  it.each(['/handoff', '/focus P1'])('%s retains the newest turn and long reply conclusion with four turns', async (command) => {
    const conclusion = 'Retained conclusion: all checks complete.';
    const transcript: MobileTranscriptEntry[] = [
      { id: 'long', role: 'assistant', text: `P1 packet-one excerpt-review opening ${'progress '.repeat(600)} ${conclusion}` },
      { id: 'middle-user', role: 'user', text: 'P1 packet-one excerpt-review middle user' },
      { id: 'middle-assistant', role: 'assistant', text: 'P1 packet-one excerpt-review middle assistant' },
      { id: 'newest', role: 'user', text: 'P1 packet-one excerpt-review newest operator turn' },
    ];
    await executeOrchestratorSlashCommand(command, context(transcript));
    const { message } = consumeModelMessage();
    expect(message).toContain(conclusion);
    expect(message).toContain('newest operator turn');
  });

  it('recall retains the search preview opening and excludes its over-budget ending', async () => {
    const commandContext = context([]);
    commandContext.searchArchive = vi.fn(async () => [{
      id: 'archive', score: 1, source: 'thread', tabId: null, archivedAt: null, preview: 'fallback',
      entries: [{ id: 'hit', role: 'assistant', text: `Search opening ${'filler '.repeat(600)} search-ending-obsolete` }],
    }]);
    await executeOrchestratorSlashCommand('/recall packet', commandContext);
    const { message } = consumeModelMessage();
    expect(message).toContain('Search opening');
    expect(message).not.toContain('search-ending-obsolete');
  });
});
