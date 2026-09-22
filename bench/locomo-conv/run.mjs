// LoCoMo-Conv retrieval adapter for jev-memory.
//
// Mirrors LoCoMo-Conv's `retrieval/run_bm25.py --granularity turn`: one memory per
// turn (only sessions referenced by some QA evidence), top-K per query, same
// output layout, so the repo's `retrieval/compute_retrieval_metrics.py` can score
// the results directly. Recall@K is also computed inline from dia_ids.
//
// Cost control: ingestion writes straight to the store (no write-gate calls)
// unless --write-gate is passed, and the run refuses to start when the planned
// number of System One calls exceeds --max-calls. Use --dry-run to see the plan
// without making any network call.
//
// Usage (from the jev-memory root, after `npm run build`):
//   node bench/locomo-conv/run.mjs --data-dir <path to LoCoMo-Conv clone> --dry-run
//   node bench/locomo-conv/run.mjs --data-dir <...> --samples 0 --styles dialog --limit 2

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const STYLE_FIELDS = {
  question: { query: 'question', speaker: null, file: 'queries_solutions_question.json' },
  dialog: { query: 'dialog_query', speaker: 'subject_speaker_name', file: 'queries_solutions_dialog_query.json' },
  implicit: {
    query: 'implicit_query',
    speaker: 'implicit_subject_speaker_name',
    file: 'queries_solutions_implicit_query.json',
  },
  counterfactual: {
    query: 'counterfactual_query',
    speaker: 'counterfactual_subject_speaker_name',
    file: 'queries_solutions_counterfactual_query.json',
  },
  composed: { query: 'composed_query', speaker: 'subject_speaker_name', file: 'composed_solutions.json' },
};

const { values: args } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    out: { type: 'string', default: join(ROOT, 'bench/locomo-conv/outputs/jev-memory') },
    samples: { type: 'string', default: '0' },
    styles: { type: 'string', default: 'dialog' },
    limit: { type: 'string', default: '2' },
    'top-k': { type: 'string', default: '10' },
    'max-questions-per-call': { type: 'string', default: '50' },
    'max-calls': { type: 'string', default: '50' },
    'write-gate': { type: 'boolean', default: false },
    model: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});

if (!args['dry-run'] && !process.env.NODE_USE_ENV_PROXY) relaunchWithProxy();
else await main();

async function main() {
  if (!args['data-dir']) fail('--data-dir <path to a LoCoMo-Conv clone> is required.');
  const dataDir = resolve(args['data-dir']);
  const topK = toInt('top-k');
  const perCall = toInt('max-questions-per-call');
  const maxCalls = toInt('max-calls');
  const limit = args.limit === 'all' ? Number.POSITIVE_INFINITY : toInt('limit');
  const styles = args.styles.split(',').map((s) => s.trim()).filter(Boolean);
  for (const s of styles) if (!STYLE_FIELDS[s]) fail(`unknown style "${s}" (use ${Object.keys(STYLE_FIELDS).join(', ')})`);

  const data = JSON.parse(readFileSync(join(dataDir, 'data/locomo10_dialog.json'), 'utf8'));
  const clusters = styles.includes('composed')
    ? JSON.parse(readFileSync(join(dataDir, 'data/locomo10_multimem_full.json'), 'utf8'))
    : [];
  const sampleIdxs = args.samples === 'all' ? data.map((_, i) => i) : args.samples.split(',').map(Number);

  // Plan every sample first so the call budget is checked before spending anything.
  const plans = sampleIdxs.map((sIdx) => {
    const sample = data[sIdx];
    if (!sample) fail(`sample ${sIdx} does not exist (dataset has ${data.length}).`);
    const units = buildUnits(sample);
    const queries = styles.map((style) => ({ style, items: queriesFor(style, sample, sIdx, clusters).slice(0, limit) }));
    const nQueries = queries.reduce((n, q) => n + q.items.length, 0);
    const callsPerQuery = Math.ceil(units.length / perCall);
    const writeCalls = args['write-gate'] ? units.length : 0;
    return { sIdx, sample, units, queries, nQueries, calls: writeCalls + nQueries * callsPerQuery, callsPerQuery };
  });

  const totalCalls = plans.reduce((n, p) => n + p.calls, 0);
  for (const p of plans) {
    console.log(
      `[plan] sample ${p.sIdx}: ${p.units.length} memories, ${p.nQueries} queries, ` +
        `${p.callsPerQuery} calls/query${args['write-gate'] ? `, ${p.units.length} write-gate calls` : ''} -> ${p.calls} calls`,
    );
  }
  console.log(`[plan] total System One calls: ${totalCalls} (limit --max-calls ${maxCalls})`);
  if (args['dry-run']) return;
  if (totalCalls > maxCalls) fail(`planned ${totalCalls} calls exceeds --max-calls ${maxCalls}; narrow the run or raise the limit.`);

  const { createMemory, inMemoryStore } = await import(join(ROOT, 'dist/index.js')).catch(() =>
    fail('dist/ not found; run `npm run build` first.'),
  );

  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, ms: 0, queries: 0 };
  const recallByStyle = {};

  for (const plan of plans) {
    const store = inMemoryStore();
    const memory = createMemory({
      store,
      maxQuestionsPerCall: perCall,
      requestTimeoutMs: 30_000,
      ...(args.model ? { model: args.model } : {}),
    });

    let written = 0;
    for (const [i, unit] of plan.units.entries()) {
      const metadata = { dia_ids: unit.diaIds };
      if (args['write-gate']) {
        const r = await memory.remember(unit.text, { id: `u${i}`, state: unit.text, metadata });
        addUsage(totals, r.usage, r.ms);
        if (r.stored) written += 1;
      } else {
        // Direct store write: an unpinned memory, scored by the retrieve gate like any other.
        const now = Date.now();
        await store.add({ id: `u${i}`, text: unit.text, createdAt: now, updatedAt: now, metadata });
        written += 1;
      }
    }
    console.log(`[sample ${plan.sIdx}] stored ${written}/${plan.units.length} memories`);

    const sampleDir = join(resolve(args.out), `sample_${plan.sIdx}`);
    mkdirSync(sampleDir, { recursive: true });

    for (const { style, items } of plan.queries) {
      const entries = [];
      for (const item of items) {
        const state = item.speaker ? { speaker: item.speaker, message: item.query } : item.query;
        const result = await memory.select({ state });
        addUsage(totals, result.usage, result.ms);
        totals.queries += 1;

        // Unbounded budget, then top-K by score (the benchmark's protocol is top-K, not a token budget).
        const all = await store.list();
        const ranked = all
          .map((m) => ({ m, score: result.scores[m.id] ?? 0 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK);
        const retrievedDiaIds = ranked.map(({ m }) => m.metadata.dia_ids);
        const recall = recallAt(retrievedDiaIds.flat(), item.gold);
        (recallByStyle[style] ??= []).push(recall);

        entries.push({
          ...item.record,
          query: item.query,
          docs: ranked.map(({ m }) => m.text),
          retrieved_chunk_dia_ids: retrievedDiaIds,
          retrieved_metadata: retrievedDiaIds.map((ids) => ({ dia_ids: ids.join(',') })),
          scores: ranked.map(({ score }) => score),
          usage: result.usage,
          ms: Math.round(result.ms),
        });
        console.log(
          `[sample ${plan.sIdx}] ${style} #${entries.length}: recall@${topK}=${recall.toFixed(2)} ` +
            `calls=${result.usage.calls} tokens=${result.usage.totalTokens} ${Math.round(result.ms)}ms`,
        );
      }
      const outPath = join(sampleDir, STYLE_FIELDS[style].file);
      writeFileSync(outPath, JSON.stringify(entries, null, 2));
      console.log(`[sample ${plan.sIdx}] ${style}: wrote ${entries.length} -> ${outPath}`);
    }
  }

  const summary = {
    topK,
    recall: Object.fromEntries(
      Object.entries(recallByStyle).map(([s, rs]) => [s, { n: rs.length, macroRecall: mean(rs) }]),
    ),
    usage: { ...totals, ms: Math.round(totals.ms) },
  };
  writeFileSync(join(resolve(args.out), 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

/** One unit per turn, restricted to sessions referenced by QA evidence -- identical to run_bm25.py's "turn" mode. */
function buildUnits(sample) {
  const referenced = new Set();
  for (const qa of sample.qa ?? []) {
    for (const ev of qa.evidence ?? []) {
      if (typeof ev === 'string' && ev.startsWith('D') && ev.includes(':')) referenced.add(ev.split(':')[0]);
    }
  }
  const units = [];
  const conv = sample.conversation ?? {};
  for (const [key, turns] of Object.entries(conv)) {
    if (!key.startsWith('session_') || key.includes('date') || !Array.isArray(turns) || turns.length === 0) continue;
    const firstDia = String(turns[0].dia_id ?? '');
    const sessionId = firstDia.includes(':') ? firstDia.split(':')[0] : `D${key.split('_')[1]}`;
    if (!referenced.has(sessionId)) continue;
    const date = conv[`${key}_date_time`] ?? 'Unknown Date';
    for (const turn of turns) {
      const speaker = String(turn.speaker ?? '').trim();
      const text = String(turn.text ?? '').trim();
      if (!speaker || !text || !turn.dia_id) continue;
      let line = `DATE: ${date}\n${speaker} said, "${text}"`;
      if (turn.blip_caption) line += ` and shared ${turn.blip_caption}.`;
      units.push({ text: line, diaIds: [turn.dia_id] });
    }
  }
  return units;
}

/** Queries in the same order as the benchmark's select_qas_in_main_order (category 5 skipped for question/counterfactual). */
function queriesFor(style, sample, sIdx, clusters) {
  const f = STYLE_FIELDS[style];
  if (style === 'composed') {
    return clusters
      .filter((c) => c.sample_idx === sIdx && c.composed_query)
      .map((c) => ({
        query: c.composed_query,
        speaker: c[f.speaker] ?? null,
        gold: c.gold_dia_ids,
        record: {
          cluster_id: c.cluster_id,
          sample_idx: c.sample_idx,
          member_q_idxs: c.member_q_idxs,
          gold_dia_ids: c.gold_dia_ids,
          composed_query: c.composed_query,
        },
      }));
  }
  const out = [];
  (sample.qa ?? []).forEach((qa, qIdx) => {
    const category = Number(qa.category) || 0;
    if (category === 5 && (style === 'question' || style === 'counterfactual')) return;
    const query = qa[f.query];
    if (!query) return;
    out.push({
      query,
      speaker: f.speaker ? (qa[f.speaker] ?? null) : null,
      gold: qa.evidence ?? [],
      record: { q_idx: qIdx, question: qa.question ?? '', category, evidence: qa.evidence ?? [], answer: qa.answer },
    });
  });
  return out;
}

function recallAt(retrieved, gold) {
  if (!gold.length) return 0;
  const got = new Set(retrieved);
  return gold.filter((g) => got.has(g)).length / new Set(gold).size;
}

function addUsage(totals, usage, ms) {
  totals.calls += usage.calls;
  totals.inputTokens += usage.inputTokens;
  totals.outputTokens += usage.outputTokens;
  totals.ms += ms;
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function toInt(name) {
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < 1) fail(`--${name} must be a positive integer.`);
  return n;
}

function fail(message) {
  console.error(`locomo-conv: ${message}`);
  process.exit(1);
}

/** Loads .env and re-executes with Node's env-proxy support, like scripts/test-live.mjs. */
function relaunchWithProxy() {
  try {
    process.loadEnvFile(join(ROOT, '.env'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!process.env.AIHUBMIX_API_KEY) fail('set AIHUBMIX_API_KEY in .env or the environment.');
  const env = { ...process.env, NODE_USE_ENV_PROXY: '1' };
  if (!env.HTTPS_PROXY && !env.https_proxy && process.platform === 'darwin') {
    try {
      const settings = execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8' });
      const host = settings.match(/HTTPSProxy\s*:\s*(\S+)/)?.[1];
      const port = settings.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
      if (/HTTPSEnable\s*:\s*1/.test(settings) && host && port) env.HTTPS_PROXY = `http://${host}:${port}`;
    } catch {
      // Explicit proxy environment variables remain supported on all platforms.
    }
  }
  const result = spawnSync(process.execPath, process.argv.slice(1), { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
