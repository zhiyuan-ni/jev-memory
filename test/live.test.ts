import { describe, it, expect } from 'vitest';
import { createMemory } from '../src/memory.js';
import { inMemoryStore } from '../src/store/memory-store.js';

// test/setup.ts supplies a fake key for unit tests; do not let it enable this
// explicitly opt-in live suite.
if (process.env.AIHUBMIX_API_KEY === 'test-aihubmix-key') {
  delete process.env.AIHUBMIX_API_KEY;
}

const hasCreds = Boolean(process.env.AIHUBMIX_API_KEY);

describe.skipIf(!hasCreds)('live Jev call (AIHubMix)', () => {
  it('writes a durable fact through the real write gate', async () => {
    const memory = createMemory({ store: inMemoryStore(), maxRetries: 0, requestTimeoutMs: 10_000 });
    const result = await memory.remember('For all coding projects, the user prefers TypeScript with strict mode enabled.', {
      // Synthetic conversation: no real user data is sent.
      state: 'User: Please remember my permanent coding preference: always use TypeScript with strict mode for all my projects, including future projects.',
    });
    expect(result.stored).toBe(true);
    expect(result.durability).toBeGreaterThan(0.5);
    expect(result.usage.calls).toBe(1);

    const selected = await memory.select({ state: 'Create a new TypeScript project following my coding preferences.' });
    expect(selected.memories.map((entry) => entry.id)).toContain(result.memory!.id);
    expect(selected.usage.calls).toBe(1);

    const compacted = await memory.compact({
      state: 'User: My old TypeScript preference is obsolete and must be forgotten. From now on, use only plain JavaScript and never TypeScript for any project.',
    });
    expect(compacted.evicted.map((entry) => entry.id)).toContain(result.memory!.id);
    expect(await memory.list()).toEqual([]);
  }, 35_000);

  it('rejects an ephemeral, non-durable statement', async () => {
    const memory = createMemory({ store: inMemoryStore(), maxRetries: 0, requestTimeoutMs: 10_000 });
    const result = await memory.remember('lol ok one sec', {
      state: { task: 'General assistant conversation.' },
    });
    expect(result.stored).toBe(false);
  }, 15_000);
});
