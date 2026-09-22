import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemory } from '../src/memory.js';
import { inMemoryStore } from '../src/store/memory-store.js';
import type { Memory } from '../src/types.js';

const fetchMock = vi.fn();

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return { id: overrides.id ?? 'mem-1', text: overrides.text ?? 'some fact', createdAt: 0, updatedAt: 0, ...overrides };
}

function mockSystemOne(options: { probabilities?: Record<string, number>; normalizedScores?: Record<string, number> } = {}) {
  const { probabilities = {}, normalizedScores = {} } = options;
  fetchMock.mockImplementation((_: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { questions: Record<string, { type: string; criteria?: unknown[] }> };
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type === 'noul') return [id, { type: 'noul', noul: probabilities[id] ?? 0 }];
      const levels = question.criteria?.length ?? 1;
      return [id, { type: 'score', score: (normalizedScores[id] ?? 0) * (levels - 1) }];
    }));
    return Promise.resolve(new Response(JSON.stringify({ answers, usage: { input_tokens: 5, output_tokens: 1 } }), { status: 200 }));
  });
}

beforeEach(() => {
  process.env.AIHUBMIX_API_KEY = 'test-aihubmix-key';
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('memory gates through AIHubMix System One', () => {
  it('stores a durable fact verbatim and sends a noul write gate', async () => {
    mockSystemOne({ probabilities: { durability: 0.9 } });
    const store = inMemoryStore();
    const result = await createMemory({ store }).remember('User prefers pnpm over npm', { state: 'conversation' });
    expect(result).toMatchObject({ stored: true, durability: 0.9 });
    expect((await store.list())[0]?.text).toBe('User prefers pnpm over npm');
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.questions.durability.type).toBe('noul');
  });

  it('does not call the API when pinning a fact', async () => {
    const store = inMemoryStore();
    const result = await createMemory({ store }).remember('Always keep this', { pin: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.usage.calls).toBe(0);
    expect((await store.list())[0]).toMatchObject({ pinned: true });
  });

  it('scores, chunks, and budget-selects unpinned memories', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'expensive', text: 'x'.repeat(400) }),
      makeMemory({ id: 'cheap-a', text: 'y'.repeat(40) }),
      makeMemory({ id: 'cheap-b', text: 'z'.repeat(40) }),
      makeMemory({ id: 'pinned', text: 'always included', pinned: true }),
    ]);
    mockSystemOne({ normalizedScores: { expensive: 0.9, 'cheap-a': 0.8, 'cheap-b': 0.8 } });
    const result = await createMemory({ store, maxQuestionsPerCall: 2 }).select({ state: 'turn', tokenBudget: 30 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.usage).toMatchObject({ calls: 2, inputTokens: 10 });
    expect(result.memories.map((memory) => memory.id).sort()).toEqual(['cheap-a', 'cheap-b', 'pinned']);
    expect(result.droppedForBudget.map((drop) => drop.memory.id)).toEqual(['expensive']);
  });

  it('evicts only the memories whose noul value meets the threshold', async () => {
    const store = inMemoryStore([
      makeMemory({ id: 'stale', text: 'old fact' }),
      makeMemory({ id: 'fresh', text: 'current fact' }),
      makeMemory({ id: 'pinned', text: 'never evict', pinned: true }),
    ]);
    mockSystemOne({ probabilities: { stale: 0.9, fresh: 0.1 } });
    const result = await createMemory({ store, evictThreshold: 0.6 }).compact({ state: 'turn' });
    expect(result.evicted.map((memory) => memory.id)).toEqual(['stale']);
    expect((await store.list()).map((memory) => memory.id).sort()).toEqual(['fresh', 'pinned']);
  });

  it('short-circuits without credentials when every memory is pinned', async () => {
    delete process.env.AIHUBMIX_API_KEY;
    const result = await createMemory({ store: inMemoryStore([makeMemory({ pinned: true })]) }).select({ state: 'turn' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.usage.calls).toBe(0);
  });
});
