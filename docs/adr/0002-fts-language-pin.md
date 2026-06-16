# ADR 0002 — Full-text-search language config pin (`'english'`)

- **Status:** **Provisional — pending first-client corpus.** (A conscious re-index, not a flag, to change.)
- **Date:** 2026-06-16
- **Issue:** #13 (the keyword leg of hybrid retrieval). First-client revisit tracked under #43, with the embedding pin.
- **Deciders:** Austin (owner), Claude (build).

## Context

#13 added a KEYWORD leg to retrieval (dense + keyword, RRF-fused, §4.7). The keyword leg is a Postgres
`tsvector` GENERATED column on `memories.statement` and `chunks.text`, with a GIN index, queried via
`websearch_to_tsquery`. The text-search **configuration** (the lexer/stemmer/stop-word set) is chosen at the
column's DDL:

```sql
ts tsvector GENERATED ALWAYS AS (to_tsvector('english', statement)) STORED
```

`to_tsvector(regconfig, text)` with an **explicit** config is `IMMUTABLE` — required for a generated column
(the 1-arg form is only `STABLE` and is rejected). So the config is **pinned in DDL**, exactly like the
embedding dimension is pinned in `vector(1024)` (ADR 0001).

## Why this is a one-way-ish door

A generated `STORED` column is materialised from its expression **at write time**. Changing `'english'` to
another configuration (or a per-row language column) does **not** retroactively re-tokenise existing rows — it
requires **dropping and recreating the column**, which re-tokenises the whole table. That is a **conscious
re-index**, parallel to the embedding re-embed (ADR 0001) — **never a runtime flag**.

It is **lower stakes** than the embedding pin: the keyword leg only *orders* (RRF), and the abstention floor is
the **pre-fusion dense cosine** (the keyword leg can neither create nor suppress an abstention). A wrong
language config degrades keyword *recall/ranking* (quality), never permissions (the WHERE filter is identical
across legs and language-independent). So it is **not** a leak risk — purely a retrieval-quality tripwire.

## Decision (provisional)

| Knob | Provisional value | Why |
|---|---|---|
| FTS config | **`'english'`** | The dev/synthetic corpus is English; lowest-churn default to carry through M2–M8. |

## First-client tripwire (the thing to check at #43)

- If the first client's corpus is **non-English or multilingual**, choose the real config **before** ingesting
  at scale (re-tokenising a populated table is the cost we're deferring while there is no corpus).
- Options when that day comes: a single non-English `regconfig`; a `'simple'` config (no stemming/stop-words)
  for mixed/code-like content; or a per-row `language` column feeding `to_tsvector(language_col, …)` (the column
  stops being a simple literal-config generated column then — a deliberate schema change).
- Pairs with the embedding re-pin (ADR 0001 / #43): both are corpus-shaped decisions deferred until real data.
