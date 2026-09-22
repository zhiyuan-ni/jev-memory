import type { AggregatedUsage, JevState, JSONValue } from './types.js';
import { assertAuthConfigured } from './env.js';

const SYSTEM_ONE_URL = 'https://aihubmix.com/v1/systemone';
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** The internal question shape mapped to AIHubMix's native System One endpoint. */
export type Question =
  | { type: 'boolean'; instructions: JSONValue; criteria?: Record<string, JSONValue> }
  | { type: 'choice'; instructions: JSONValue; criteria: Record<string, JSONValue> | JSONValue[] }
  | { type: 'score'; instructions: JSONValue; criteria: JSONValue[] };

export interface BooleanAnswer { type: 'boolean'; probability: number }
export interface ChoiceAnswer { type: 'choice'; choice: string; probabilities?: Record<string, number> }
export interface ScoreAnswer { type: 'score'; score: number; probabilities?: Record<string, number> }
export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;

export interface EvaluateInChunksOptions {
  /** AIHubMix Jev model id, such as `jev-1.13` or `jev-latest`. */
  model: string;
  maxQuestionsPerCall: number;
  abortSignal?: AbortSignal;
  /** Per-request timeout in milliseconds. Defaults to 10 seconds. */
  requestTimeoutMs?: number;
  /** Retries after the first request. Defaults to 2, matching the former SDK behavior. */
  maxRetries?: number;
}

export interface EvaluateInChunksResult { answers: Record<string, Answer>; usage: AggregatedUsage }

interface SystemOneResponse {
  answers?: Record<string, unknown>;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; total_tokens?: unknown };
  error?: { message?: unknown } | string;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('jev-memory: maxQuestionsPerCall must be >= 1');
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asProbabilities(value: unknown): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  return entries.length === Object.keys(value).length ? Object.fromEntries(entries) : undefined;
}

function parseAnswer(id: string, value: unknown): Answer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`jev-memory: AIHubMix returned an invalid answer for question "${id}".`);
  }
  const answer = value as Record<string, unknown>;
  const probabilities = asProbabilities(answer.probabilities);
  if (answer.type === 'noul' && asNumber(answer.noul) !== undefined) {
    return { type: 'boolean', probability: asNumber(answer.noul)! };
  }
  if (answer.type === 'choice' && typeof answer.choice === 'string') {
    return { type: 'choice', choice: answer.choice, ...(probabilities ? { probabilities } : {}) };
  }
  if (answer.type === 'score' && asNumber(answer.score) !== undefined) {
    return { type: 'score', score: asNumber(answer.score)!, ...(probabilities ? { probabilities } : {}) };
  }
  throw new Error(`jev-memory: AIHubMix returned an unsupported answer shape for question "${id}".`);
}

function serializeInstruction(value: JSONValue): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function toSystemOneQuestion(question: Question): Record<string, unknown> {
  return {
    type: question.type === 'boolean' ? 'noul' : question.type,
    instructions: question.type === 'boolean' && question.criteria
      ? `${serializeInstruction(question.instructions)}\nReturn the probability that the TRUE criterion applies.\nTRUE: ${serializeInstruction(question.criteria.true ?? '')}\nFALSE: ${serializeInstruction(question.criteria.false ?? '')}`
      : serializeInstruction(question.instructions),
    // AIHubMix's `noul` primitive accepts its probability question directly;
    // `criteria` only belongs to choice/score questions.
    ...(question.type === 'boolean' || question.criteria === undefined ? {} : { criteria: question.criteria }),
  };
}

function isRetryable(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) throw new Error('jev-memory: requestTimeoutMs must be greater than 0.');
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  if (abortSignal?.aborted) controller.abort();
  abortSignal?.addEventListener('abort', onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new Error(`jev-memory: AIHubMix System One request timed out after ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener('abort', onAbort);
  }
}

async function requestChunk(
  questions: Record<string, Question>, state: JevState, options: EvaluateInChunksOptions,
): Promise<SystemOneResponse> {
  const apiKey = assertAuthConfigured();
  const retries = options.maxRetries ?? 2;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchWithTimeout(SYSTEM_ONE_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: options.model,
          state,
          questions: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, toSystemOneQuestion(question)])),
        }),
      }, options.abortSignal, options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      const data = await response.json().catch(() => ({})) as SystemOneResponse;
      if (response.ok) return data;
      const detail = typeof data.error === 'string' ? data.error : typeof data.error?.message === 'string' ? data.error.message : response.statusText;
      const error = new Error(`jev-memory: AIHubMix System One request failed (${response.status}): ${detail}`);
      if (!isRetryable(response.status)) throw error;
      if (attempt === retries) throw error;
      lastError = error;
    } catch (error) {
      if (
        options.abortSignal?.aborted ||
        attempt === retries ||
        (error instanceof Error && error.message.startsWith('jev-memory: AIHubMix System One request failed (4'))
      ) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/**
 * Calls AIHubMix's native Jev System One API once per chunk. The wire format
 * differs from Vercel AI SDK's `experimental_evaluate`: boolean questions are
 * sent as `noul` and their probabilities return under `answer.noul`.
 */
export async function evaluateInChunks(
  questions: Record<string, Question>, state: JevState, options: EvaluateInChunksOptions,
): Promise<EvaluateInChunksResult> {
  const ids = Object.keys(questions);
  const usage: AggregatedUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0, calls: 0 };
  const answers: Record<string, Answer> = {};
  if (ids.length === 0) return { answers, usage };
  for (const idsInChunk of chunk(ids, options.maxQuestionsPerCall)) {
    const questionsInChunk = Object.fromEntries(idsInChunk.map((id) => [id, questions[id]!])) as Record<string, Question>;
    const result = await requestChunk(questionsInChunk, state, options);
    if (!result.answers) throw new Error('jev-memory: AIHubMix returned no answers map.');
    usage.calls += 1;
    const inputTokens = asNumber(result.usage?.input_tokens) ?? 0;
    const outputTokens = asNumber(result.usage?.output_tokens) ?? 0;
    usage.inputTokens += inputTokens;
    usage.outputTokens += outputTokens;
    usage.totalTokens += asNumber(result.usage?.total_tokens) ?? inputTokens + outputTokens;
    for (const id of idsInChunk) answers[id] = parseAnswer(id, result.answers[id]);
  }
  return { answers, usage };
}
