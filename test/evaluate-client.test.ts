import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateInChunks } from '../src/evaluate-client.js';

function question(): { type: 'boolean'; instructions: string } {
  return { type: 'boolean', instructions: 'is this durable?' };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  process.env.AIHUBMIX_API_KEY = 'test-aihubmix-key';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evaluateInChunks', () => {
  it('makes no HTTP call and does not require auth for an empty question set', async () => {
    delete process.env.AIHUBMIX_API_KEY;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(evaluateInChunks({}, 'state', { model: 'jev-1.13', maxQuestionsPerCall: 50 })).resolves.toEqual({
      answers: {}, usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails clearly when AIHUBMIX_API_KEY is absent', async () => {
    delete process.env.AIHUBMIX_API_KEY;
    await expect(evaluateInChunks({ q1: question() }, 'state', { model: 'jev-1.13', maxQuestionsPerCall: 50 }))
      .rejects.toThrow(/AIHUBMIX_API_KEY/);
  });

  it('uses the System One wire format and maps noul responses to boolean answers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      answers: {
        durable: { type: 'noul', noul: 0.87 },
        relevance: { type: 'score', score: 3, probabilities: { 0: 0, 3: 1 } },
      },
      usage: { input_tokens: 10, output_tokens: 2 },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await evaluateInChunks({
      durable: { ...question(), criteria: { true: 'Reusable preference', false: 'Temporary chatter' } },
      relevance: { type: 'score', instructions: { task: 'score it' }, criteria: ['low', 'high'] },
    }, { turn: 'hello' }, { model: 'jev-1.13', maxQuestionsPerCall: 50 });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://aihubmix.com/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer test-aihubmix-key');
    expect(JSON.parse(init.body)).toEqual({
      model: 'jev-1.13',
      state: { turn: 'hello' },
      questions: {
        durable: {
          type: 'noul',
          instructions: 'is this durable?\nReturn the probability that the TRUE criterion applies.\nTRUE: Reusable preference\nFALSE: Temporary chatter',
        },
        relevance: { type: 'score', instructions: '{"task":"score it"}', criteria: ['low', 'high'] },
      },
    });
    expect(result).toEqual({
      answers: {
        durable: { type: 'boolean', probability: 0.87 },
        relevance: { type: 'score', score: 3, probabilities: { 0: 0, 3: 1 } },
      },
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12, calls: 1 },
    });
  });

  it('chunks requests and aggregates AIHubMix underscore-case usage fields', async () => {
    const fetchMock = vi.fn((_: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { questions: Record<string, unknown> };
      return Promise.resolve(response({
        answers: Object.fromEntries(Object.keys(body.questions).map((id) => [id, { type: 'noul', noul: 1 }])),
        usage: { input_tokens: 4, output_tokens: 1, total_tokens: 5 },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const questions = Object.fromEntries(['q1', 'q2', 'q3'].map((id) => [id, question()]));
    const result = await evaluateInChunks(questions, 'state', { model: 'jev-1.13', maxQuestionsPerCall: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 2, totalTokens: 10, calls: 2 });
    expect(result.answers).toEqual({
      q1: { type: 'boolean', probability: 1 },
      q2: { type: 'boolean', probability: 1 },
      q3: { type: 'boolean', probability: 1 },
    });
  });

  it('aborts a stalled System One request at the configured timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_: string, init: RequestInit) => new Promise((_, reject) => {
      (init.signal as AbortSignal).addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    await expect(evaluateInChunks(
      { q1: question() },
      'state',
      { model: 'jev-1.13', maxQuestionsPerCall: 50, maxRetries: 0, requestTimeoutMs: 10 },
    )).rejects.toThrow(/timed out after 10ms/);
  });
});
