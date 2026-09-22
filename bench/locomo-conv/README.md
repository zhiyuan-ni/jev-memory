# LoCoMo-Conv retrieval adapter

Runs jev-memory's retrieve gate on [LoCoMo-Conv](https://github.com/MiuLab/LoCoMo-Conv)
and writes results in the same layout as its `run_bm25.py`, so the benchmark's own
`retrieval/compute_retrieval_metrics.py` scores them directly.

- One memory per turn, only sessions referenced by QA evidence (same as BM25 `--granularity turn`).
- Memories are written straight to the store by default (no write-gate calls), so the
  retrieve gate is measured in isolation. `--write-gate` runs every turn through `remember()`.
- The subject speaker's name goes into the Jev state (`{ speaker, message }`), like the
  mem0 baseline routing each query to the subject speaker's user_id.
- Top-K by retrieve-gate score (default 10), not a token budget, to match the benchmark protocol.

## Cost

Every query scores every memory: `ceil(memories / 50)` calls per query, about 47k
tokens per query on sample 0 (419 memories). The full benchmark (10 samples, all 5
styles) comes to about 102k calls. The script prints the plan and refuses to run past
`--max-calls` (default 50). **Always `--dry-run` first.**

## Run

```sh
git clone --depth 1 https://github.com/MiuLab/LoCoMo-Conv.git ../LoCoMo-Conv
npm run build

# Plan only, no network
node bench/locomo-conv/run.mjs --data-dir ../LoCoMo-Conv --dry-run

# Smoke test: sample 0, dialog style, 2 queries = 18 calls
node bench/locomo-conv/run.mjs --data-dir ../LoCoMo-Conv --samples 0 --styles dialog --limit 2

# Official metrics (Python, stdlib only)
python3 ../LoCoMo-Conv/retrieval/compute_retrieval_metrics.py \
  --results_dir bench/locomo-conv/outputs/jev-memory --styles dialog
```

Options: `--samples 0,1|all`, `--styles question,dialog,implicit,counterfactual,composed`,
`--limit N|all` (queries per style per sample), `--top-k`, `--max-questions-per-call`,
`--max-calls`, `--write-gate`, `--model`, `--out`.

The API key and proxy are handled the same way as `npm run test:live` (`.env`, macOS HTTPS proxy).
