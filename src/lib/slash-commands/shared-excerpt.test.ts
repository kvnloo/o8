import { describe, expect, it } from 'vitest';
import type { MobileTranscriptEntry } from '@/lib/mobile/types';
import { buildRecallPrelude, excerptTranscriptEntries } from './shared';

function entry(partial: Partial<MobileTranscriptEntry> & Pick<MobileTranscriptEntry, 'id' | 'role' | 'text'>): MobileTranscriptEntry {
  return partial;
}

/** Orchestrator-style reply: progress first, result in the last paragraph. */
function longReply(opening: string, conclusion: string) {
  // ~3.2k chars of progress so a single turn alone exceeds the 2600-char handoff budget.
  const progress = Array.from({ length: 120 }, (_, index) => `Progress line ${index}: still checking status.`).join(' ');
  return `${opening} ${progress} ${conclusion}`;
}

describe('excerptTranscriptEntries (#2959)', () => {
  it('keeps the newest turn and a long reply ending when preferNewest+preserveTurnEnding', () => {
    const conclusion = 'Retained conclusion: CI passed on all three runners.';
    const newest = 'Newest operator turn: ship the packet.';
    const window: MobileTranscriptEntry[] = [
      entry({
        id: 'a1',
        role: 'assistant',
        text: longReply('Starting the CI check.', conclusion),
      }),
      entry({ id: 'u2', role: 'user', text: 'mid turn filler that should not dominate' }),
      entry({ id: 'a2', role: 'assistant', text: 'mid assistant filler' }),
      entry({ id: 'u3', role: 'user', text: newest }),
    ];

    const redShape = excerptTranscriptEntries(window, 8, 2600);
    expect(redShape).toContain('Starting the CI check.');
    expect(redShape).not.toContain(conclusion);
    expect(redShape).not.toContain(newest);

    const green = excerptTranscriptEntries(window, 8, 2600, {
      preferNewest: true,
      preserveTurnEnding: true,
    });
    expect(green).toContain(newest);
    expect(green).toContain(conclusion);
    expect(green).toContain('Starting the CI check.');
  });

  it('drops the oldest turns first when the budget is exhausted under preferNewest', () => {
    const marker = (index: number) => `turn-marker-${String(index).padStart(3, '0')}`;
    const window: MobileTranscriptEntry[] = Array.from({ length: 8 }, (_, index) =>
      entry({
        id: `e${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        text: `${marker(index)} ${'x'.repeat(600)}`,
      }),
    );

    const excerpt = excerptTranscriptEntries(window, 8, 2600, {
      preferNewest: true,
      preserveTurnEnding: true,
    });
    expect(excerpt).toContain(marker(7));
    expect(excerpt).not.toContain(marker(0));
    const kept = window.map((_, index) => excerpt.includes(marker(index)));
    const firstKept = kept.indexOf(true);
    expect(firstKept).toBeGreaterThan(0);
    expect(kept.slice(firstKept).every(Boolean)).toBe(true);
  });

  it('leaves search-result preview oldest-first head-cut behavior unchanged', () => {
    const conclusion = 'Search hit conclusion should stay cut under default mode.';
    const previewEntries: MobileTranscriptEntry[] = [
      entry({
        id: 'hit',
        role: 'assistant',
        text: longReply('Match opening for search preview.', conclusion),
      }),
      entry({ id: 'later', role: 'user', text: 'later-turn-should-not-appear-under-default-budget' }),
    ];

    const preview = excerptTranscriptEntries(previewEntries, 4, 900);
    expect(preview).toContain('Match opening for search preview.');
    expect(preview).not.toContain(conclusion);
    expect(preview).not.toContain('later-turn-should-not-appear-under-default-budget');

    const recall = buildRecallPrelude('packet', [{
      source: 'thread',
      preview: 'fallback',
      entries: previewEntries,
    }]);
    expect(recall).toContain('Match opening for search preview.');
    expect(recall).not.toContain(conclusion);
  });
});
