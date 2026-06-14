# Bake-off corpus schema (Issue #1)

Two files drive the bake-off. **The real, de-identified files (`passages.jsonl`, `pairs.json`) are gitignored** — we do not commit client content to the repo, even de-identified. The `*.example.*` files show the shape only.

## `passages.jsonl` — one JSON object per line

A passage is a chunk **at the length we'll actually embed in production** (addition #4 — don't pick a model on the wrong granularity). Target the production chunk size (the chunker's window, ~`chunk_ttl_days` content). Span all four memory types (§4.1) and seed deliberate distractors.

```json
{ "id": "p001", "type": "semantic", "namespace": "client:acme", "zone": "general", "text": "Acme prefers monthly reporting, delivered async." }
```

| field | meaning |
|---|---|
| `id` | stable passage id (referenced by pairs) |
| `type` | `semantic` \| `episodic` \| `procedural` \| `working` (§4.1) — cover all four |
| `namespace` | `org` \| `client:{id}` \| `project:{id}` (§4.3) — used to build cross-namespace distractors |
| `zone` | functional label (§9.1) — for cross-zone distractors |
| `text` | the passage, at production chunk length |

**Deliberately include:** near-duplicate-but-opposite pairs ("prefers weekly" vs "prefers monthly", §4.5), cross-client distractors (Acme vs Northwind, §4.3), and paraphrase targets.

## `pairs.json` — the ~30 question→expected pairs (the arbiter)

```json
{
  "pairs": [
    { "name": "acme-reporting-cadence", "query": "How often does Acme want to be updated?", "gold": ["p001"] },
    { "name": "unknown-abstains", "query": "What is Acme's founder's dog's name?", "gold": [] }
  ]
}
```

| field | meaning |
|---|---|
| `name` | stable fixture name (becomes a permanent retrieval fixture) |
| `query` | the question, phrased ≠ the passage (paraphrase is the real job) |
| `gold` | passage ids that SHOULD be retrieved. **Empty `[]` = a no-answer / abstention pair** — these calibrate the floor (the separation score), they do not measure recall. |

Aim ~30 pairs: ~22 answerable (incl. paraphrase, near-duplicate-opposite, cross-namespace) + ~8 no-answer.
