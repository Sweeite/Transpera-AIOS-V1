# AIOS — Build Issues

*The build broken into GitHub-ready issues, mapped to the tech-stack build order. Each issue is implementation-ready: context, concrete tasks, testable acceptance criteria, out-of-scope, and a watch-out. Vertical slices first so something demoable exists early.*

**Labels:** `core` (sealed engine), `harness`, `memory`, `ingestion`, `agents`, `rbac`, `ops`, `frontend`, `infra`, `eval`.
**Criticality:** 🔒 fail-closed / security-critical · 🧠 differentiator · ⚙️ plumbing.
**Conventions (apply to every issue, not repeated):** every migration is **expand/contract**; every run carries a **principal**; nothing calls a model except through the **gateway**; permissions are **fail-closed**; references-not-content in the audit log.

**Issue anatomy:** `Context` (why/where) → `Tasks` (the checklist) → `Acceptance` (testable done) → `Out of scope` (what NOT to do here) → `Watch` (the trap).

---

## Audit remediation (read before any milestone)

A five-way independent audit found ~20 thin issues, ~7 missing tables, and gaps owned by no issue. **None are architecture changes** — every fix is "add the table / name the owner / specify the algorithm." The structural fixes are already encoded in `db/schema.ts`, `@aios/shared` types, and `config/system-config.ts`; the per-issue fixes are listed below. Tier 1 = fix before building that issue; T2/T3 = name it as you build.

**New schema tables (now in #7):** `memory_links` (typed edges — replaces flat `source_refs`), `threads` + `messages` (conversation state), `feedback`, `suggestions`, `review_queue`, `monitors` (heartbeat), `metrics_rollup`, `standing_approvals`. Plus `task_state` gains `paused_awaiting_confirmation` + `version`/`lease_until` (idempotent resume) + a typed pause payload; `audit_log` gains `prev_hash` (tamper-evidence); `user_clearance` keyed on `principal_id` with **missing-row ⇒ deny**.

**New config keys (now in `system-config.ts`):** `rrf_k`, `exact_search_max_rows`, `entity_resolution_min_confidence`, `gate3_preclassifier_threshold`, `corroboration_similarity_threshold`, `intent_min_confidence`, `verify_sensitivity_threshold`, `trust_constrain_threshold`, `trust_quarantine_threshold`, `embedding_canary_drift_threshold`.

**Cross-cutting primitives now owned:** (1) **one** human-in-the-loop interrupt primitive backs clarification (#27) + confirmation (#26) + trust-approval (#29) — idempotent resume via queue, principal preserved; (2) **eval-fixture corpus** has an owner (#32) — schema + validator + per-tenant starter + intent/routing/contradiction suites; (3) **floor recalibration** is owned across #1→#4→#14 — `retrieval_min_relevance` is rescaled per scorer, `reranker_model` pinned, fixtures bake a floor value.

**New issues:** #47 auth/onboarding · #48 conversation state · #49 meeting-bot · #50 dashboards + rollup · #51 CI/test infra.

**Per-issue fixes:**

| # | Tier | Fix |
|---|---|---|
| 1 | T2 | Calibrate the *v1 dense-cosine* floor explicitly; re-derive `retrieval_min_relevance` when #14 lands (different scale — a recalibration, not a reuse). |
| 2 | T3 | `vector(N)` is fixed by #1's model; a dimension change is a full re-embed (not expand/contract). Block on #1. |
| 4 | T2 | Abstention score = **top-1 pre-fusion dense cosine** in v1, never the RRF sum; mark the seam #14 swaps. |
| 5 | T3 | Add a structural citation guard: reject/relabel any claim whose `sourceId ∉ retrieved set` (semantic support-check is #24). |
| 7 | **T1** | Add the 8 tables above; **worker uses `DATABASE_URL_SESSION` (session-mode)** — transaction-mode pooling breaks pgmq/LISTEN/advisory-locks; define `content_hash` over normalized text **+ namespace**. |
| 8 | T3 | Pending changes don't take effect; one open proposal per key; bounds live in `KNOWN_KEYS` (single source, DB stores only values). |
| 9 | **T1** | Empty `allowed_zones` → `WHERE false` (the `denyAll` flag), never empty `IN`; test it; co-verify "applied in SQL" with #13. |
| 10 | T3 | Repair loop bounded (1 attempt → escalate to fallback model → fail); prompt-cache is a per-provider adapter concern, not one flag. |
| 11 | T3 | Tamper-evidence = hash chain (`prev_hash`) + `verifyChain()`, or explicitly descope and soften the acceptance. |
| 13 | **T1** | Use `rrf_k` + `exact_search_max_rows`; name the selectivity-estimation method; write the **v1 pre-reranker** floor path into `retrieval.ts` (not just §6.4 prose). |
| 14 | T2 | Name the calibration procedure (held-out labelled set + target metric); pin `reranker_model`+`version` the floor binds to. |
| 16 | **T1** | `resolveEntity({mention, namespaceHint}) → {entity, confidence}|null`; use `entity_resolution_min_confidence`; seed-time cross-SoR merge uses the **same** similarity+floor primitive. |
| 17 | **T1** | Stamp `connection.trust_level → Provenance.trustLevel` in the after-write block; Gate-3 pre-classifier is its own sub-task (labelled set, `gate3_preclassifier_threshold`, false-negative audit via #19). |
| 18 | **T1** | `corroborate()` is **computed** (shared with consolidation dedup, `corroboration_similarity_threshold`), not a boolean input; name the injection-scan approach (LLM classifier + denylist v1). |
| 19 | T2 | Miss↔ingestion cross-check: embed the miss → ANN over `chunks` + re-fetch flagged decision-log refs. |
| 20 | T2 | Define the `fetchLive` field-name normalization contract shared by `schema()`, `fetchLive()`, and `connector_schemas`. |
| 22 | **T1** | Symmetric confidence on both arms; `intent_min_confidence` → clarify-back; needs `recentThread` (#48); intent fixtures (#32); destructive stop delegated to #26. |
| 24 | T3 | Add `Claim.confidence`; verify-trigger = `sensitivity ≥ verify_sensitivity_threshold OR forAction OR confidence < t`. |
| 26 | **T1** | Confirmation reuses the interrupt primitive (`paused_awaiting_confirmation` + preview payload); add the `standing_approvals` store. |
| 27 | **T1** | Idempotent resume (`version`/`lease_until`, resume-via-queue, answer-already-applied guard); add a routing-accuracy fixture suite (goal → expected agent). |
| 28 | **T1** | Resume keeps the **original** `task_state.principal`; answerer-authz check; treat the injected answer as low-trust (can unblock, not escalate). |
| 29 | T2 | Trust formula (window + event taxonomy + weights) mirroring §4.6 decay; cold-start default = start **constrained**; route "constrained" through #26's gate. |
| 30 | **T1** | Per-tenant **advisory lock** (no overlapping runs); the contradiction classifier ships with its **own** labelled fixture set (precision target on supersede). |
| 31 | **T1** | "Active semantic child" queried via `memory_links` (typed), not a `source_refs` string; the feedback/retrieval-stat capture is a **dependency** (write `retrieval_count`/`last_retrieved_at` on retrieve; thumbs → `feedback`). |
| 32 | **T1** | Owns the **fixture corpus**: schema + validator + per-tenant starter + "permanent obligation" rule (like #36). |
| 33 | T2 | Typed `Suggestion`/`Evidence` schema (fixture-score before/after via #32); map the 6 Rs to concrete generators. |
| 34 | T2 | Bounded resolver: variable scope (`trigger.*`, `<step>.output`), whitelisted condition grammar (comparisons only, no `eval`); webhook/system-event principal binding lives in #47. |
| 35 | **T1** | In-process isolation: try/catch plugin load/register → boot **core-only + alert** on failure; forbidden-surface enforcement = static import-graph check extending #46. |
| 36 | T2 | Build the leak **harness** first: seeded fixture tenant + per-user ground-truth visibility matrix; assertion = `result ⊆ visible`; define ranking/timing leaks as "same query, two clearances, restricted ⊂ full". |
| 37 | **T1** | `auth.users.id → user_clearance` mapping; **missing row ⇒ deny**; service-principal minting for non-JWT triggers (shared with #47). |
| 39 | T2 | Non-idempotent create reconciliation: deterministic project name + list-before-create on resume (no orphaned paid project). |
| 41 | T3 | Name env-vs-Vault secret classes (env-key rotation = a redeploy; only Vault rotates hot); single-flight refresh-token rotation. |
| 43 | T2 | Split into mechanical seeding+backfill vs the **guided-interview engine** (own design); name the #39/#43 seeding-ownership boundary. |
| 45 | T2 | Watchdog runs **externally** (control-plane), not an in-tenant job; `monitors` table carries per-monitor cadence; pin the canary metric + threshold + probe set. |
| 46 | T3 | Add embedding-provider SDKs to the forbidden list; catch `import()`/`require()`, not just static `import`; note hostname-level enforcement as a known gap. |

---

## Milestone 0 — Tracer-bullet vertical slice (demoable first)

> Upload an SOP → embed → retrieve → provenance answer → abstention, end to end. Validates the #1 one-way door (embedding model) and the riskiest core before the machinery exists. (tech-stack build step 0, §5.5)

### #1 — Spike & pin the embedding model 🧠 `harness` `eval`
**M0** · **deps:** none · **Spec:** Brief §4.7, tech-stack §5.5
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Calibrate the *v1 dense-cosine* floor explicitly; re-derive `retrieval_min_relevance` when #14 lands (different scale — a recalibration, not a reuse).
**✅ Status (2026-06-14): DONE — with a deferred real pin.** A **provisional** development default is pinned so M0+ can build: OpenAI `text-embedding-3-large` @ **dim 1024** / float, `EMBEDDING_VERSION = "0-provisional"` (`gateway.ts`); `retrieval_min_relevance = 0.608` (`system-config.ts`). Chosen from a **synthetic** dry-run bake-off that validated the harness, **not** the model. The **real** model/dim/dtype/floor decision is **deferred to first-client onboarding (#43)** — synthetic data saturates ranking and the one-way door only closes once a client's data accumulates. Rationale + dry-run table: `docs/adr/0001-embedding-model-pin.md` (Status: *Provisional*). Bake-off harness: `tests/eval/embedding-bakeoff/`.
**Context.** Changing the embedding model later means re-embedding every client's corpus and re-calibrating the floor — the single most expensive decision to reverse. Get it right before anything sits on top.
**Tasks.**
- [ ] Assemble a sample of real agency content (emails, SOPs, meeting notes, client facts) + ~30 question→expected pairs.
- [ ] Evaluate 2–3 candidate models (e.g. Voyage, OpenAI, Cohere) on retrieval quality, cost/1M tokens, latency, and vendor stability.
- [ ] Record results in a short decision doc; pick one model + version.
- [ ] Set `EMBEDDING_MODEL`/`EMBEDDING_VERSION` in `gateway.ts`; derive a starting `retrieval_min_relevance`.
**Acceptance.**
- [ ] One model+version pinned with a written rationale committed to the repo.
- [ ] The mini fixture set retrieves the right doc above the chosen floor for ≥90% of pairs.
**Out of scope.** The reranker (#14); production embedding throughput/GPU service (note it, build later).
**Watch.** This is a one-way door — bias toward a stable, well-priced provider over a marginally-better-today one.

### #2 — Minimal `memories` + `chunks` tables with pgvector ⚙️ `infra` `memory`
**M0** · **deps:** #1 · **Spec:** Brief §4.2, §4.7
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 3):** `vector(N)` is fixed by #1's model; a dimension change is a full re-embed (not expand/contract). Block on #1.
**Context.** A thin slice of the full schema (#7) — just enough to store and search vectors for the demo.
**Tasks.**
- [ ] `memories` + `chunks` with `zone`, `sensitivity_level`, `namespace`, `embedding_model/version`, `content_hash`, vector column.
- [ ] HNSW index on the vector; a partial index on `zone = 'general'`.
- [ ] Seed a handful of rows via a script.
**Acceptance.**
- [ ] A row with an embedding inserts; a `<=>` vector search returns it ordered by distance.
**Out of scope.** Lifecycle columns (utility, valid_to), full table set (#7).
**Watch.** Stamp `embedding_model/version` on every row from row one — retrofitting it later is painful.

### #3 — `embed()` + `writeMemory()` happy path ⚙️ `harness` `memory`
**M0** · **deps:** #1, #2 · **Spec:** Brief §4, §5 (after-write)
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** The write half of the slice: text in → embedded, hashed, stored memory with provenance.
**Tasks.**
- [ ] Implement `gateway.embed()` against the pinned model (batch-capable).
- [ ] Implement `memoryStore.writeMemory()` happy path: embed, compute `content_hash`, set sensitivity/zone from input, insert.
- [ ] A `POST /ingest` (or script) that turns an uploaded SOP into a `procedural` memory.
**Acceptance.**
- [ ] Uploading an SOP produces one `procedural` memory with an embedding, content-hash, and provenance refs.
- [ ] Re-uploading identical content is deduped by `content_hash`.
**Out of scope.** Invalidation/supersession (#12); the routing gates (#17) — this is a direct write.
**Watch.** Don't let raw content leak into logs — provenance carries refs, not content.

### #4 — `retrieve()` + abstention (no permissions yet) 🧠 `harness`
**M0** · **deps:** #3 · **Spec:** Brief §4.7, §6
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Abstention score = **top-1 pre-fusion dense cosine** in v1, never the RRF sum; mark the seam #14 swaps.
**Context.** The read half: find relevant memory or abstain. Permission filtering arrives in #13 — keep the seam.
**Tasks.**
- [ ] Implement `retrieve()` (dense-only is fine here) returning candidates + a score.
- [ ] Apply the floor; below it → abstain.
- [ ] Log every abstention as a miss.
**Acceptance.**
- [ ] Asking about the uploaded SOP returns it above the floor; asking about something absent abstains and logs a miss.
**Out of scope.** Hybrid RRF + reranker (#13, #14); permission predicate (#13).
**Watch.** Keep the floor decision behind one interface so the reranker (#14) drops in without touching callers.

### #5 — `labelAnswer()` per-claim provenance (minimal) — THE DEMO 🧠 `harness`
**M0** · **deps:** #4 · **Spec:** Brief §6, PRD §6.5
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 3):** Add a structural citation guard: reject/relabel any claim whose `sourceId ∉ retrieved set` (semantic support-check is #24).
**Context.** Render an honest answer: cite the retrieved memory per claim; mark uncited text as inference; show the abstention copy when nothing clears the floor.
**Tasks.**
- [ ] Generate an answer that cites source ids per claim (structured output).
- [ ] Map labels: memory → "I know this" + source + as-of; uncited → "general inference".
- [ ] Render the abstention message path.
**Acceptance.**
- [ ] The SOP answer shows "I know this" + source + as-of date; an unknown question renders the abstention copy. Demoable end to end.
**Out of scope.** Live/federation labels (#23); the verification pass (#24).
**Watch.** Per-claim, not per-span — don't try to attribute fluent prose span-by-span.

---

## Milestone 1 — Foundations (fail-closed from day one)

### #6 — Provider abstraction (Supabase Mgmt + Railway APIs) ⚙️ `infra` `ops`
**M1** · **deps:** none · **Spec:** tech-stack §5.2 (#1), §8.1a
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** The provisioning keystone rests on two young-vendor secondary APIs. Wrapping them de-risks vendor changes and serves the "portable later" promise.
**Tasks.**
- [ ] Define `InfraProvider` interface: `createProject(region)`, `runMigration(project)`, `deployService(project, image)`, `teardown(project)`.
- [ ] Implement the Supabase Management + Railway backends behind it.
- [ ] Make every call idempotent + retried with backoff.
**Acceptance.**
- [ ] A second provider backend could be added without touching call sites.
- [ ] Each operation is safely retryable.
**Out of scope.** The provisioning state machine (#39) — that orchestrates these calls.
**Watch.** Treat rate limits + non-instant project creation as normal, not exceptional.

### #7 — Full Drizzle schema + per-tenant connection 🔒 `infra` `core`
**M1** · **deps:** #2 · **Spec:** tech-stack §2, §5.4; Brief §4, §9
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Add the 8 audit tables; **worker uses `DATABASE_URL_SESSION` (session-mode)** — transaction-mode pooling breaks pgmq/LISTEN/advisory-locks; define `content_hash` over normalized text **+ namespace**.
**🛠 Setup prerequisite (FIRST needed here):** real Supabase via the **Supabase CLI + local stack**. M0 ran hermetically on pglite, but `getDb()` + the real `DATABASE_URL` need real Supabase — and applying the migration against it here is the **second test lane** that catches pglite-vs-real divergence (pglite's pgvector ≠ Supabase's; the HNSW/extension-version trap from #2).
> **YOU do these 3 one-time, machine/account-level steps first — Claude Code can't (they need Docker + your account):**
> 1. **Install Docker Desktop** and have it *running* (the local Supabase stack runs in Docker; `supabase start` needs it).
> 2. **Install the Supabase CLI** — `brew install supabase/tap/supabase`.
> 3. **`supabase login`** — one browser click-through.
>
> After that, **Claude Code drives everything else**: `supabase start`, create/apply migrations, `db reset`, `gen types`, run the real-Supabase test lane.

(Also required by #37 Auth, #39 provisioning. Recommend doing the 3 steps a bit earlier so the real-Supabase lane exists before you need it.)
**Context.** Everything sits on this. One Postgres per client; the engine connects to exactly one tenant.
**Tasks.**
- [ ] Set up Supabase CLI + `supabase start` (local Postgres+pgvector+Auth); confirm the migration applies cleanly on it, not just pglite.
- [ ] Define all tables in `db/schema.ts`: memories(+slots), chunks, connector_schemas, connections(+trust_level), identity_map, ingestion_log, inbox_items, task_state, user_clearance, roles, system_config, traces, audit_log.
- [ ] Align columns 1:1 with `@aios/shared` types.
- [ ] `getDb()` reads `DATABASE_URL` (Supavisor-pooled); engine refuses to boot without `TENANT_ID`.
- [ ] First migration documented as expand/contract; write the migration README.
**Acceptance.**
- [ ] Schema migrates clean on a fresh Supabase project (local `supabase start` and/or cloud); `pnpm typecheck` passes with types flowing end-to-end.
- [ ] Booting without `TENANT_ID` fails fast (fail-closed).
**Out of scope.** RLS (we use physical isolation, not RLS); data seeding (#39/#43).
**Watch.** Connection-pool gotchas with pgmq — verify LISTEN/advisory-lock behaviour under Supavisor transaction mode.

### #8 — `system_config` service (gated/scoped/bounded/audited) ⚙️ `core`
**M1** · **deps:** #7 · **Spec:** Brief §4.8, PRD §6.11
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 3):** Pending changes don't take effect; one open proposal per key; bounds live in `KNOWN_KEYS` (single source, DB stores only values).
**Context.** The config *is* the system's correctness; a fat-fingered floor of 0.99 is a self-inflicted silent failure.
**Tasks.**
- [ ] `getConfig(key, namespace?)` with client→org resolution and range clamping.
- [ ] `proposeConfigChange()` → approval queue for quality-affecting keys; cosmetic keys apply instantly.
- [ ] Every change writes an audit event (who/what/old→new/when) and is reversible.
**Acceptance.**
- [ ] An out-of-range value is rejected; a quality-affecting change requires approval before taking effect; any change rolls back from the audit log.
**Out of scope.** The self-improvement loop that proposes changes (#33).
**Watch.** Bounds (`min`/`max`) are correctness, not UX — enforce them server-side, not just in the UI.

### #9 — RBAC clearance model + fail-closed filter 🔒🧠 `rbac` `core`
**M1** · **deps:** #7 · **Spec:** Brief §9.1, PRD; tech-stack §5.5
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Empty `allowed_zones` → `WHERE false` (the `denyAll` flag), never empty `IN`; test it; co-verify "applied in SQL" with #13.
**Context.** The highest-stakes correctness property in the system (principle #2). Define the data model concretely, not "filter somehow."
**Tasks.**
- [ ] `user_clearance` (`{allowed_zones[], max_sensitivity}`) + `roles` (default clearance per role, per-user overrides).
- [ ] `getClearance(principal)` in the engine authz layer (NOT Supabase Auth).
- [ ] `buildRetrievalPredicate()` → `zone ∈ allowed ∧ sensitivity ≤ max ∧ namespace ∈ ns`.
**Acceptance.**
- [ ] Empty `allowed_zones` ⇒ sees nothing; the predicate is applied in SQL before ranking; #36 leak fixtures pass.
**Out of scope.** The selectivity-aware ANN mechanics (#13); action authz (#26).
**Watch.** Authentication (Supabase Auth) ≠ authorization (this). Keep them deliberately separate.

### #10 — LLM gateway: routing, fallback, structured output, caching, cost 🧠 `harness` `core`
**M1** · **deps:** #1 · **Spec:** PRD §6.1, tech-stack §5.3
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 3):** Repair loop bounded (1 attempt → escalate to fallback model → fail); prompt-cache is a per-provider adapter concern, not one flag.
**Context.** The single chokepoint every model call passes through. Core, never plugins.
**Tasks.**
- [ ] `callModel()`: route by `TaskClass` across providers; fallback chain + bounded retries with backoff.
- [ ] Zod structured-output validation with repair-or-fail (never silent malformed output).
- [ ] Prompt caching of stable prefixes; per-client BYO keys from env; streaming support.
- [ ] Emit per-call tokens + cost + a trace span.
**Acceptance.**
- [ ] A structured call validates-or-repairs; a provider timeout transparently falls back; every call records cost + a span; a cached prefix shows reduced input-token cost.
**Out of scope.** Embedding routing (embeddings are pinned, never routed — #1).
**Watch.** Quality-gate cheap routes against fixtures (#32) — a cheap model bad at JSON burns the saving in repairs.

### #11 — Tracing + audit (two stores) 🔒 `core` `ops`
**M1** · **deps:** #7 · **Spec:** PRD §6.9, Brief §11.10
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 3):** Tamper-evidence = hash chain (`prev_hash`) + `verifyChain()`, or explicitly descope and soften the acceptance.
**Context.** Debuggability vs privacy: traces may hold content but ephemerally; the audit log never holds content.
**Tasks.**
- [ ] `emitSpan()` → `traces` with TTL + clearance tag; auto-prune job.
- [ ] `auditEvent()` → `audit_log`, append-only, references-only, tamper-evident.
**Acceptance.**
- [ ] A model/tool/retrieval call emits a span; an audit event stores refs not content; traces past TTL are pruned; permission-change events are recorded as the highest-value class.
**Out of scope.** The dashboards reading these (#32, #37).
**Watch.** Don't let a trace become a permanent shadow copy that bypasses the permission model.

### #46 — Architecture test: enforce the gateway chokepoint 🔒 `eval` `core`
**M1** · **deps:** #10 · **Spec:** Brief §11.8 (watching the watchers)
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 3):** Add embedding-provider SDKs to the forbidden list; catch `import()`/`require()`, not just static `import`; note hostname-level enforcement as a known gap.
**Context.** Cost/trace completeness depends on "nothing calls a model directly." A rogue `import Anthropic` somewhere = untracked cost + untraced calls — a silent failure of the observability layer itself.
**Tasks.**
- [ ] Implement `tests/core/no-direct-model-calls.test.ts`: walk `packages/**/*.ts`, fail on any provider-SDK import outside `gateway.ts`.
- [ ] Wire into CI as a required check.
**Acceptance.**
- [ ] Adding a direct provider import anywhere but the gateway fails CI.
**Out of scope.** Runtime enforcement (this is a static/CI guard).
**Watch.** Keep the forbidden-imports list updated as providers are added.

---

## Milestone 2 — Memory & retrieval (the moat)

### #12 — Invalidate-don't-overwrite + history 🔒 `memory`
**M2** · **deps:** #7 · **Spec:** Brief §4.4
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** When a fact changes, never overwrite — preserve history so "what did we believe in March, and when did it change" is queryable.
**Tasks.**
- [ ] `invalidate(id, reason)` sets `valid_to = now()`, `status = 'invalidated'`, writes the new record, links via `source_refs`.
- [ ] Retrieval defaults to `status = 'active'` (`valid_to IS NULL`).
- [ ] Inspector query exposes full history including invalidated.
**Acceptance.**
- [ ] An invalidated fact never appears in an answer but is visible in the inspector with its supersession chain.
**Out of scope.** Auto-detecting supersession (that's consolidation, #30).
**Watch.** A 👎 meaning "wrong" routes here (invalidate); a 👎 meaning "not useful" feeds decay (#31) — don't conflate.

### #13 — Selectivity-aware filtered ANN + RRF 🔒🧠 `harness` `memory`
**M2** · **deps:** #9, #10 · **Spec:** Brief §4.7, §9.1
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Use `rrf_k` + `exact_search_max_rows`; name the selectivity-estimation method; write the **v1 pre-reranker** floor path into `retrieval.ts` (not just §6.4 prose).
**Context.** "Fail-closed at the vector layer" is one of the hard problems in vector search; pgvector HNSW + a selective filter silently collapses recall. Solve it explicitly.
**Tasks.**
- [ ] Apply the permission predicate in SQL before ranking.
- [ ] If the filtered candidate set is small → exact/flat search; else → HNSW iterative scan.
- [ ] RRF-fuse keyword (tsvector) + dense legs; cap at `retrieval_max_results`.
- [ ] Apply the same filter to `chunks`.
**Acceptance.**
- [ ] A restricted user gets perfect-recall results (exact path) with no row they can't see; an org-wide query uses HNSW; chunks are filtered identically.
**Out of scope.** The reranker floor (#14) — RRF only orders here.
**Watch.** Never retrieve-then-filter; the floor is not the RRF sum.

### #14 — Reranker floor 🧠 `harness` `eval`
**M2** · **deps:** #13 · **Spec:** Brief §4.7
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Name the calibration procedure (held-out labelled set + target metric); pin `reranker_model`+`version` the floor binds to.
**Context.** RRF discards score magnitude, so the abstention decision must be made on a calibrated score.
**Tasks.**
- [ ] Add a cross-encoder reranker over the top-N fused candidates (hosted API or service behind the gateway).
- [ ] Make its score the abstention floor (`retrieval_min_relevance`).
- [ ] Calibrate the floor on real data + fixtures.
**Acceptance.**
- [ ] The floor is the reranker score; "wrong memory ranked above the floor" cases drop; fixtures (#32) pass at the calibrated floor.
**Out of scope.** Self-hosting the reranker on GPU (note for scale).
**Watch.** Adds a model call per query — keep it cheap; it also protects the client's bill via tighter context (#15).

### #15 — Context assembly + token budgeting ⚙️ `harness`
**M2** · **deps:** #13 · **Spec:** PRD §6.2
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** Build the prompt for a turn without blowing the window or leaking.
**Tasks.**
- [ ] Pull retrieved memories (already permission-filtered) + persona + tool defs + recent thread.
- [ ] Rank and truncate to the token budget; log what was dropped.
- [ ] Mark the stable prefix for prompt caching (#10).
**Acceptance.**
- [ ] Over-budget context is truncated by relevance with drops logged; assembled context never contains a hidden-from-asker memory.
**Out of scope.** Federation content (#23).
**Watch.** The "what was dropped" log is a silent-failure guard — don't skip it.

---

## Milestone 3 — Ingestion & identity

### #44 — Connector adapter interface + registry 🧠 `ingestion` `core`
**M3** · **deps:** #7 · **Spec:** Brief §10, tech-stack §2
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** Make "add any integration" first-class: one `Connector` interface + a registry, so the 5th/20th connector is uniform, not bespoke.
**Tasks.**
- [ ] Finalize `connectors/adapter.ts`: `sync` / `fetchLive` / `schema` / `authFor(principal)` / `healthCheck` + `ConnectorMeta`.
- [ ] Implement `registerConnector` / `getConnector` / `listConnectors`.
- [ ] Expose registration via the plugin SDK (plugins may add connectors, §8.2).
**Acceptance.**
- [ ] A trivial fake connector registers and is discoverable; the gates (#17) and federation (#23) consume connectors only through this interface.
**Out of scope.** Real connector implementations (#20).
**Watch.** `ConnectorMeta` (structured/live/ownership/trust) must be complete — the rest of the system keys off it.

### #16 — Identity Map (entity resolution) 🧠 `ingestion` `memory`
**M3** · **deps:** #7 · **Spec:** Brief §4.10, PRD §6.12
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** `resolveEntity({mention, namespaceHint}) → {entity, confidence}|null`; use `entity_resolution_min_confidence`; seed-time cross-SoR merge uses the **same** similarity+floor primitive.
**Context.** Resolves a mention → canonical entity + per-SoR ids; needed on both write (namespacing) and read (federation). Canonical ids internal, SoR ids mirrored.
**Tasks.**
- [ ] `identity_map` table; `resolveEntity(mention)` (fuzzy match, `null` if unresolved).
- [ ] `seedFromConnectors()` mints canonical entities + mirrors external ids.
- [ ] Helper: entity → namespace.
**Acceptance.**
- [ ] A mention resolves to one canonical entity + namespace; an unresolved entity returns null so callers abstain; one entity can hold ids across ≥2 SoRs.
**Out of scope.** The live fetch itself (#23).
**Watch.** "SoR wins" governs field values, not identity — identity is owned internally.

### #17 — Routing gates 1–4 🔒🧠 `ingestion` `core`
**M3** · **deps:** #16, #10, #44 · **Spec:** Brief §5, PRD §6.3
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Stamp `connection.trust_level → Provenance.trustLevel` in the after-write block; Gate-3 pre-classifier is its own sub-task (labelled set, `gate3_preclassifier_threshold`, false-negative audit via #19).
**Context.** The operational heart of ingestion — the spine rule made executable. Cheap-to-expensive gate ordering keeps cost sane.
**Tasks.**
- [ ] Gate 1 drop (do-not-ingest + sensitivity labels) — deterministic.
- [ ] Gate 2 fetch-live (field ∈ connector_schemas) — deterministic, NO LLM; unknown structured field → review.
- [ ] Gate 3 interpretive value: cheap embedding pre-classifier → LLM only on ambiguous; NO/UNSURE → chunks.
- [ ] Gate 4 structured action → SoR + episodic; else → memory.
- [ ] After-write: provenance, sensitivity = max, zone = union, content_hash dedup, supersede if needed.
**Acceptance.**
- [ ] Do-not-ingest content is never stored; a CRM deal-stage field is fetched live, never copied; uncertain content lands in chunks; Gate 2 makes zero LLM calls; every item produces an `IngestionDecision` (#19).
**Out of scope.** Anti-poisoning promotion gate (#18); specific connectors (#20).
**Watch.** Gate 2 "no LLM, ever" is load-bearing for cost and for the spine — keep it deterministic.

### #18 — Anti-poisoning trust gate 🔒 `ingestion` `harness`
**M3** · **deps:** #17 · **Spec:** Brief §5, PRD §6.7
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** `corroborate()` is **computed** (shared with consolidation dedup, `corroboration_similarity_threshold`), not a boolean input; name the injection-scan approach (LLM classifier + denylist v1).
**Context.** Ingested content becomes memory later retrieved as trusted "I know this." Without a trust gate, provenance launders injected content.
**Tasks.**
- [ ] Use connection `trust_level`; low-trust content may index-in-place but not auto-promote to semantic without corroboration or human review.
- [ ] Flag/quarantine instruction-shaped content at Gate 1; never execute it.
**Acceptance.**
- [ ] An injected "fact" from an inbound external email cannot become a semantic memory unaided; a corroborated or human-reviewed one can.
**Out of scope.** Output-side injection in tool results (#26 guardrails).
**Watch.** The promotion rule is the line between "found this" and "know this" — keep it strict.

### #20 — Connectors v1 (one structured + one unstructured) ⚙️ `ingestion`
**M3** · **deps:** #44, #17 · **Spec:** Brief §10
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 2):** Define the `fetchLive` field-name normalization contract shared by `schema()`, `fetchLive()`, and `connector_schemas`.
**Context.** Prove the adapter interface with two real connectors of different kinds.
**Tasks.**
- [ ] Implement a structured connector (e.g. a CRM): `schema()`, field-tagged `sync()`, `fetchLive()`.
- [ ] Implement an unstructured connector (Gmail/Drive): interpretive `sync()`, empty `schema()`.
- [ ] Org + per-user tiers; principal-driven `authFor()`.
**Acceptance.**
- [ ] The structured connector's fields drive Gate 2; the unstructured one is interpretive by default; per-user tokens resolve from the principal and are unavailable to service principals.
**Out of scope.** Meeting-bot (cross-cutting); breadth of connectors (ongoing).
**Watch.** Scope ≠ visibility — an org connection ingests broadly but each user still sees only what they're cleared for.

### #19 — Ingestion-decision log + sampled audit 🧠 `ingestion` `eval`
**M3** · **deps:** #17 · **Spec:** Brief §5, §11.3, §11.8
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Miss↔ingestion cross-check: embed the miss → ANN over `chunks` + re-fetch flagged decision-log refs.
**Context.** You can't measure what you never ingested — this is the bridge that makes wrong-drops visible.
**Tasks.**
- [ ] Write an `IngestionDecision` (source-ref + content-hash + confidence) for every gate outcome.
- [ ] Sampled human audit of low-confidence DROP/INDEX decisions → false-drop rate.
- [ ] Miss↔ingestion cross-check: on a logged miss, search chunks + the decision log for matching content.
**Acceptance.**
- [ ] A DROP is auditable without storing content; a "had-it-but-didn't-promote" miss is detectable and surfaced on the Quality Monitor.
**Out of scope.** Acting on the audit (that's #33 self-improvement).
**Watch.** Sampling misses systematic patterns below the sample rate — raise the rate on flagged connectors.

### #21 — connector_schemas drift job ⚙️ `ingestion` `ops`
**M3** · **deps:** #20 · **Spec:** Brief §5
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** SoR schemas drift; a stale registry silently routes new structured fields into memory (a spine violation).
**Tasks.**
- [ ] Periodic job: introspect each structured connector's live schema, diff vs `connector_schemas`.
- [ ] New/changed fields → review queue, never auto-trusted.
**Acceptance.**
- [ ] A newly-added SoR field is flagged for review, never silently interpreted/stored.
**Out of scope.** Auto-adding fields (deliberately manual).
**Watch.** Pairs with Gate 2's unknown-field→review default (#17) — together they keep the spine fail-closed.

---

## Milestone 4 — Chat front door

### #22 — Intent router (query vs command) 🧠 `core`
**M4** · **deps:** #10 · **Spec:** Brief §7.1, PRD §4.1
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Symmetric confidence on both arms; `intent_min_confidence` → clarify-back; needs `recentThread` (#48); intent fixtures (#32); destructive stop delegated to #26.
**Context.** One box; the user never decides "asking vs commanding."
**Tasks.**
- [ ] `routeIntent(message)` — cheap model or heuristic+small model → `query` | `command`(+confidence).
- [ ] Route query → retrieval pipeline; command → agent/workflow runner.
- [ ] Low-confidence destructive command → confirm before acting.
**Acceptance.**
- [ ] A question retrieves and answers; a command fires an agent; an ambiguous destructive command asks first.
**Out of scope.** The agent/workflow execution (#26, #34).
**Watch.** A misclassified command can fire an unintended action — bias ambiguous destructive intents toward confirmation.

### #23 — Federation-on-read (hybrid live + memory) 🧠 `harness` `agents`
**M4** · **deps:** #16, #20, #13 · **Spec:** Brief §4.10, PRD §6.12
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** The flagship "what do we know about Client X" — resolve entity, fetch live, blend with memory, label provenance, all within a latency budget. **The hardest piece in the system** (entity resolution + live orchestration), so the design decisions are named below, not left to discover mid-build. Home file: `harness/federation.ts` (`answerWithFederation`).
**Tasks.**
- [ ] Resolve entity → look up external ids → fan out `fetchLive()` to holding connectors in parallel.
- [ ] Deadline per fetch; miss → "couldn't reach source" + last-known. Memory retrieval runs concurrently, never waits on a slow SoR.
- [ ] Blend live + namespace-scoped memory into one provenance-labelled answer; per-principal short cache.

**Design decisions (defaults chosen — confirm/adjust as you build):**
- [ ] **D1 Entity resolution** — deterministic (exact/alias) → embedding similarity with a confidence floor, context-boosted by namespace; **below floor → abstain** (wrong entity = cross-client leak risk).
- [ ] **D2 Query→fetch-plan** — deterministic planner + default field set per entity kind for common queries; LLM tool-loop fallback for open-ended.
- [ ] **D3 Conflict** — SoR wins on field values; memory shown beside it as the interpretive layer, never silently overridden.
- [ ] **D4 Latency** — parallel fetch, per-fetch deadline, memory concurrent; missed deadline → "couldn't reach source".
- [ ] **D5 Cache** — seconds-long per-principal TTL, still labelled "live"; **skipped when the answer drives an action**.

**Acceptance.**
- [ ] The query blends live + memory with correct per-claim provenance; a failed fetch shows last-known + timestamp, not a guess; an unresolved entity abstains; a value conflict resolves SoR-wins with memory shown beside it.
**Out of scope.** Caching strategy beyond a short TTL; resolver beyond similarity+floor (revisit if disambiguation proves hard).
**Watch.** This is your slowest query — parallelise and budget; don't let one slow SoR hang the answer. D1 is the crux — invest there first.

### #24 — Conditional provenance verification 🧠 `harness` `eval`
**M4** · **deps:** #5, #14 · **Spec:** PRD §6.5, tech-stack §5.3
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 3):** Add `Claim.confidence`; verify-trigger = `sensitivity ≥ verify_sensitivity_threshold OR forAction OR confidence < t`.
**Context.** Confirm cited claims are actually supported — but only when it's worth the cost.
**Tasks.**
- [ ] Verification pass that checks each cited claim against its cited source.
- [ ] Run it conditionally (low-confidence / high-stakes), not on every answer.
**Acceptance.**
- [ ] A cited claim is verifiably supported by its source; verification is skipped on routine high-confidence answers.
**Out of scope.** Verifying general-inference text (it's labelled, not verified).
**Watch.** "High-stakes" needs a definition — tie it to action side effects + sensitivity.

---

## Milestone 5 — Agents & workforce

### #25 — Durable `task_state` (pause/resume) 🧠 `agents` `core`
**M5** · **deps:** #7 · **Spec:** Brief §4.1
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** A multi-step task that pauses (stuck sub-agent) needs state that survives a worker restart — working memory never persists.
**Tasks.**
- [ ] `task_state` (status, principal, trigger, accumulated context, open question).
- [ ] Persist on each step; resume from `paused_awaiting_input`.
**Acceptance.**
- [ ] A task paused for human input survives a worker restart and resumes from the pause with full context.
**Out of scope.** The clarification UX (#27, #28).
**Watch.** This is the dependency that makes the clarification interrupt real — don't shortcut it with in-memory state.

### #26 — Single-agent runner + tool loop + action authz 🔒🧠 `agents` `harness`
**M5** · **deps:** #10, #9, #25 · **Spec:** Brief §7.2, §9.2, PRD §6.6
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Confirmation reuses the interrupt primitive (`paused_awaiting_confirmation` + preview payload); add the `standing_approvals` store.
**Context.** Agents act — the bigger blast radius than a leaked read. This also defines the **agent registry + capability manifest** that routing (#27) depends on.
**Tasks.**
- [ ] Define `AgentManifest` (`whenToUse`, `capabilities`, `inputs`/`outputs`, `exampleGoals`, `allowedTools`, `allowedRoles`) + the registry (`registerAgent`/`getAgent`/`listAgents`).
- [ ] `runAgent()`: assemble context → tool loop → provenance-labelled output; full step trace.
- [ ] `runToolLoop()` with turn cap + bounded retries; errors surfaced, not swallowed.
- [ ] Authz = intersection(allowed tools, principal); confirmation gate on external-irreversible actions.
**Acceptance.**
- [ ] An agent's manifest is structured (not free text) and registered; an agent can't exceed its principal's authority; sending an email previews→confirms; the full step trace (memory→tools→reasoning→output) is recorded.
**Out of scope.** Multi-agent delegation + the routing planner (#27).
**Watch.** Per-user tokens flow from the principal — never let a service-triggered run borrow a user token.

### #27 — Orchestrator + delegation tree + clarification interrupt 🧠 `agents`
**M5** · **deps:** #26 · **Spec:** Brief §7.3
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Idempotent resume (`version`/`lease_until`, resume-via-queue, answer-already-applied guard); add a routing-accuracy fixture suite (goal → expected agent).
**Context.** Multi-agent must be visible and real. Stuck sub-agents ask, not guess. **Routing quality depends entirely on the agent manifests (#26)** — this is the one agent-layer detail to nail.
**Tasks.**
- [ ] `candidatesFor(goal, principal, clearance)`: deterministic pre-filter by capability tags + RBAC → small candidate set; the LLM planner picks/sequences over those manifests (`whenToUse`/`exampleGoals`).
- [ ] `orchestrate()`: decompose → spawn sub-agents (which may sub-delegate); sub-agents inherit the principal.
- [ ] Enforce `orchestrator_max_depth` (default 3) — refuse to delegate deeper; keep trees shallow.
- [ ] Expose the live delegation tree + log.
- [ ] On `clarification_request`: try orchestrator-from-context → else escalate to Inbox → pause → resume on answer.
**Acceptance.**
- [ ] A sub-goal routes to the right specialist via manifest pre-filter + planner (not vibes); delegation beyond the depth cap is refused; the tree is observable live; a stuck sub-agent pauses to `task_state` and is answerable via the Inbox; answering resumes it.
**Out of scope.** Per-agent chat (deliberately not built).
**Watch.** Token scope + permissions are decided once at the top of the tree and never escalate mid-delegation. Vague manifests = flaky routing — invest in precise `whenToUse` lines.

### #28 — Inbox (the single push destination) 🧠 `agents` `frontend`
**M5** · **deps:** #25, #9 · **Spec:** Brief §7.5
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Resume keeps the **original** `task_state.principal`; answerer-authz check; treat the injected answer as low-trust (can unblock, not escalate).
**Context.** Everything the system pushes to a person lands here — briefs, clarification requests, alerts, suggestions.
**Tasks.**
- [ ] `inbox_items` (typed, permission-scoped); list/answer/approve/dismiss/open.
- [ ] Answering a clarification resumes its task.
- [ ] Digest: a cadence'd roll-up to an external channel (adapter).
**Acceptance.**
- [ ] A brief generated for a user contains only what they're cleared to see; answering a clarification resumes the paused task.
**Out of scope.** Full proactive-builder UI (cross-cutting dashboards).
**Watch.** Inbox content obeys the same fail-closed retrieval as answers.

### #29 — Trust scores ⚙️ `agents`
**M5** · **deps:** #26 · **Spec:** Brief §7.2
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 2):** Trust formula (window + event taxonomy + weights) mirroring §4.6 decay; cold-start default = start **constrained**; route "constrained" through #26's gate.
**Context.** Low-trust agents should be constrained, not silently shipping bad output.
**Tasks.**
- [ ] Compute trust = rolling success/rejection/error rate weighted by human feedback.
- [ ] Thresholds: below → constrained (approval before commit); lower → quarantined (disabled).
**Acceptance.**
- [ ] A constrained agent's outputs require approval; a quarantined agent can't run; thresholds live in `system_config`.
**Out of scope.** Self-improvement of prompts (#33).
**Watch.** Don't let "constrained" become a silent block — surface it in the Inbox/dashboards.

---

## Milestone 6 — Lifecycle & quality (self-maintenance)

### #30 — Consolidation cron + contradiction classifier 🧠 `memory` `eval`
**M6** · **deps:** #12, #16 · **Spec:** Brief §4.5, PRD §6.8
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Per-tenant **advisory lock** (no overlapping runs); the contradiction classifier ships with its **own** labelled fixture set (precision target on supersede).
**Context.** Distil episodic → semantic without over-generalising, duplicating, or mistaking contradictions for duplicates.
**Tasks.**
- [ ] Watermark (advance on success only); same-namespace similarity dedup; auto-merge ≥0.97, review 0.92–0.97.
- [ ] On high-similarity match: duplicate/entails/contradicts/unrelated classifier → contradicts ⇒ supersede.
- [ ] Slot-able `(entity, attribute, value)` facts supersede deterministically.
- [ ] Sensitivity inherits max/union but never auto-broadens (review flag instead).
**Acceptance.**
- [ ] "weekly" vs "monthly" reporting is detected as a contradiction → supersede (not dedup); cross-namespace never consolidates; cold-start throttles auto-merge toward review.
**Out of scope.** The 6-Rs framing beyond these jobs.
**Watch.** Dedup against *seen*, not *confirmed* — else review-rejected candidates reappear every run.

### #31 — Type-aware decay cron 🔒 `memory`
**M6** · **deps:** #12, #30 · **Spec:** Brief §4.6
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** "Active semantic child" queried via `memory_links` (typed), not a `source_refs` string; feedback/retrieval-stat capture is a **dependency** (write `retrieval_count`/`last_retrieved_at` on retrieve; thumbs → `feedback`).
**Context.** Uniform decay would silently delete high-value rarely-retrieved knowledge — a correctness bug.
**Tasks.**
- [ ] Compute `utility_score` (recency×0.4 + frequency×0.3 + feedback×0.3) on episodic + gently semantic.
- [ ] Procedural exempt; episodic reaped ONLY with a confirmed semantic child; wrong→invalidate.
- [ ] Prune chunks past `chunk_ttl_days`.
- [ ] Emit a consolidation-coverage metric (aging episodic with no semantic child).
**Acceptance.**
- [ ] An SOP never decays; an episodic with no consolidated child is not lost on age; the coverage metric surfaces on the Quality Monitor.
**Out of scope.** Decay thresholds approval (handled by #8 gating).
**Watch.** This is where "consolidation recall gap → permanent data loss" lives — the semantic-child check is the guard.

### #32 — Quality Monitor + eval harness 🧠 `eval` `ops`
**M6** · **deps:** #19, #14 · **Spec:** PRD §6.10, Brief §11.8
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** Owns the **fixture corpus**: schema + validator + per-tenant starter + "permanent obligation" rule (like #36).
**Context.** Silent-failure detection as a product surface; the fixtures are the arbiter of change.
**Tasks.**
- [ ] Dashboard metrics: abstention/miss/low-rated trends, utility distribution, retrieval quality, false-drop rate, coverage gap.
- [ ] Offline eval harness running the tenant fixtures on every core change.
- [ ] Thresholds in `system_config`; breaches raise alerts.
**Acceptance.**
- [ ] A config change is judged by fixtures, not the live metric it moves; a threshold breach alerts.
**Out of scope.** Watching-the-watchers guards (#45).
**Watch.** A falling abstention rate is ambiguous — disambiguate via fixtures + spot-check, not vibes.

### #45 — Watching the watchers (monitoring integrity) 🔒🧠 `eval` `ops`
**M6** · **deps:** #32 · **Spec:** Brief §11.8, §3.1
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Watchdog runs **externally** (control-plane), not an in-tenant job; `monitors` table carries per-monitor cadence; pin the canary metric + threshold + probe set.
**Context.** The detectors must not fail silently either. This shrinks the residual silent-failure surface to coverage gaps + novel modes.
**Tasks.**
- [ ] Dead-man's switch: each monitor/cron heartbeats; a watchdog (`checkOverdueMonitors`) alerts on overdue signal.
- [ ] Embedding canary: re-embed a fixed probe set on a cadence, alarm on drift past threshold.
- [ ] Completeness critic: mine recent misses for uncovered scenarios → propose new fixtures.
- [ ] (Gateway chokepoint test is #46.)
**Acceptance.**
- [ ] Stopping any monitor raises an alert (absence-of-signal); a simulated embedding-space shift trips the canary; the critic proposes ≥1 fixture from real misses.
**Out of scope.** The architecture test (#46).
**Watch.** Without this, "we monitor everything" is itself a silent-failure claim — the monitors can die quietly.

### #33 — Self-improvement loop ⚙️ `core` `eval`
**M6** · **deps:** #32, #8 · **Spec:** Brief §7.6, PRD §6.10
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 2):** Typed `Suggestion`/`Evidence` schema (fixture-score before/after via #32); map the 6 Rs to concrete generators.
**Context.** The engine proposes, an admin approves, the audit records, the monitor watches — one coherent loop.
**Tasks.**
- [ ] Generate evidence-backed suggestions (memory 6-Rs, prompts from rejection patterns, cost downgrades).
- [ ] Route through the config approval flow (#8); record outcomes.
- [ ] Judge "did it help" by fixtures, never the live metric the change moves.
**Acceptance.**
- [ ] A suggestion to lower the floor is evidence-backed, approved, audited, and its effect judged by fixtures.
**Out of scope.** Auto-applying changes (always admin-approved).
**Watch.** The loop must not optimise its own dashboard — fixtures are the arbiter.

---

## Milestone 7 — Workflows & extensibility

### #34 — Workflow runner (bounded DSL) ⚙️ `core` `agents`
**M7** · **deps:** #26 · **Spec:** Brief §7.4, PRD §4.5
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 2):** Bounded resolver: variable scope (`trigger.*`, `<step>.output`), whitelisted condition grammar (comparisons only, no `eval`); webhook/system-event principal binding lives in #47.
**Context.** Workflows are data, not code. The DSL orchestrates; agents compute.
**Tasks.**
- [ ] Interpret JSON workflows: sequential steps, conditions, parallel fan-out, human-approval step, retry policy.
- [ ] Steps invoke registered agents; real logic lives inside agent steps, not the DSL.
- [ ] Triggers: chat, schedule, webhook, system event (with principal).
**Acceptance.**
- [ ] The lead-qual example runs end to end; the DSL has no loops/Turing-complete control flow; a human-approval step pauses + resumes.
**Out of scope.** A visual no-code builder UI (later).
**Watch.** Resist DSL feature-creep — push complexity into agent steps or a plugin.

### #35 — Hook registry + plugin loader 🔒 `core`
**M7** · **deps:** #26, #34, #44 · **Spec:** Brief §8.2
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 1):** In-process isolation: try/catch plugin load/register → boot **core-only + alert** on failure; forbidden-surface enforcement = static import-graph check extending #46.
**Context.** The plugin boundary — extend without forking; never touch the sealed internals.
**Tasks.**
- [ ] `loadPluginForTenant(tenantId)` dynamic-imports `plugins/<tenantId>` at boot.
- [ ] Expose registerAgent/Step/Prompt/Scorer/Tool/Connector via the SDK.
- [ ] Enforce the forbidden surface (no auth/billing/gateway/rbac/db) — lint/type guard.
**Acceptance.**
- [ ] A sample plugin registers an agent for one tenant only; importing a forbidden module fails; one client's plugin failure can't affect another's runtime.
**Out of scope.** A plugin marketplace.
**Watch.** Plugin count is the health metric — if it grows ~1-per-client, the escalation ladder has failed.

---

## Milestone 8 — Surfaces, provisioning, observability

### #36 — RBAC adversarial leak fixtures 🔒🧠 `rbac` `eval`
**M8 (run from M1)** · **deps:** #9, #13 · **Spec:** Brief §9, tech-stack §5.5
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Build the leak **harness** first: seeded fixture tenant + per-user ground-truth visibility matrix; assertion = `result ⊆ visible`; define ranking/timing leaks as "same query, two clearances, restricted ⊂ full".
**Context.** A leak found late is reputation-ending. Build the leak suite the moment retrieval exists and keep growing it.
**Tasks.**
- [ ] Fixtures: restricted user, cross-namespace bleed, chunk leakage, sensitivity ceiling, ranking/timing leaks.
- [ ] Wire into CI as a required gate.
**Acceptance.**
- [ ] All leak fixtures pass; any introduced leak fails CI; the suite grows whenever a new leak shape is found.
**Out of scope.** Pen-testing (separate engagement).
**Watch.** This set is never "complete" — treat additions as permanent obligations.

### #37 — Fastify API + Supabase Auth → principal ⚙️ `core` `frontend`
**M8** · **deps:** #22, #13, #26 · **Spec:** tech-stack §2, Brief §8.1a
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 1):** `auth.users.id → user_clearance` mapping; **missing row ⇒ deny**; service-principal minting for non-JWT triggers (shared with #47).
**Context.** The HTTP surface; authentication via Supabase, authorization in the engine.
**Tasks.**
- [ ] Verify Supabase JWT → resolve a principal on every request.
- [ ] Routes: /chat (stream), /memories, /ingest, /inbox(+:id/answer), /traces, /audit, /dashboards/*, /healthz.
**Acceptance.**
- [ ] Every request carries a principal; chat streams tokens; /healthz returns for fleet alerting.
**Out of scope.** The frontend (#38).
**Watch.** Authn ≠ authz — the engine still owns the fail-closed filtering.

### #38 — Brain frontend (tracer-bullet UI → full) ⚙️ `frontend`
**M8** · **deps:** #37 · **Spec:** Brief §13, tech-stack §1
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** The staff-facing product. Stack is **locked**: Vite + React + TS SPA · Tailwind v4 · shadcn/ui + prompt-kit · TanStack Query/Table · Recharts · Supabase JS. Scaffold already exists in `apps/brain` (ChatView + ProvenanceMessage stubs).
**Tasks.**
- [ ] `npx shadcn init` + add base components (button, textarea, card, badge, table, dialog, tabs); add prompt-kit chat primitives (PromptInput, Message, ChatContainer, Markdown, Reasoning, Loader).
- [ ] Wire `ask()` to `POST /api/chat` (SSE stream); swap the stub textarea/bubble for prompt-kit `PromptInput`/`Message`; keep `ProvenanceMessage` as the renderer.
- [ ] Grow nav: Knowledge (memory inspector) / Work / Agents / Automate / Observe (the 12 dashboards) / Admin.
- [ ] Render provenance labels + abstention consistently everywhere the brain answers; RBAC-gate every view.
**Acceptance.**
- [ ] The demo slice works against the real API; provenance components are consistent across surfaces; no view renders data the principal can't see.
**Out of scope.** The operator console (deferred, §8.4).
**Watch.** Provenance/abstention/agent-trace components stay ours (not the kit's); the HTML prototype is superseded — don't maintain two.

### #39 — Idempotent provisioning state machine ⚙️ `ops` `infra`
**M8** · **deps:** #6, #7 · **Spec:** Brief §8.1a, tech-stack §5.4
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**⚠ Audit fix (Tier 2):** Non-idempotent create reconciliation: deterministic project name + list-before-create on resume (no orphaned paid project).
**Context.** Standing up a client in one command without orphaned paid projects.
**Tasks.**
- [ ] `provision-client`: pending→db_created→migrated→deployed→seeded, each step checkpointed + resumable.
- [ ] Teardown on failure; seed Identity Map (#16) + kick off bounded cold-start backfill (#43).
- [ ] Region selection for residency.
**Acceptance.**
- [ ] A half-failed onboard leaves no orphaned project and resumes from the last good step; one command stands up a working client.
**Out of scope.** The operator dashboard.
**Watch.** Non-instant project creation is normal — poll, don't assume.

### #40 — migrate-all + deploy-all (expand/contract safety) 🔒 `ops` `infra`
**M8** · **deps:** #39 · **Spec:** tech-stack §5.4
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** Fleet migrations without version skew breaking clients.
**Tasks.**
- [ ] `migrate-all`: run forward-only migration per project, report per-project status.
- [ ] `deploy-all`: skip un-migrated projects; track per-client version/rollout.
**Acceptance.**
- [ ] A partial migration failure halts deploy to the un-migrated clients; per-project status is reported; the image tolerates schema N and N-1 during rollout.
**Out of scope.** Blue/green per client (later).
**Watch.** Expand/contract is a discipline on every migration author — enforce in review.

### #41 — Secrets in client Supabase Vault + rotation 🔒 `ops` `infra`
**M8** · **deps:** #20, #39 · **Spec:** tech-stack §5.4
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 3):** Name env-vs-Vault secret classes (env-key rotation = a redeploy; only Vault rotates hot); single-flight refresh-token rotation.
**Context.** 25 clients × {Supabase keys, BYO LLM keys, SoR OAuth tokens with refresh}. Secrets are a layer-1 concern.
**Tasks.**
- [ ] Store per-client SoR creds + per-user OAuth tokens in the client's own Supabase Vault (encrypted).
- [ ] Refresh-token handling; a rotation runbook + tooling.
- [ ] Assert no secret lives in the shared image.
**Acceptance.**
- [ ] No secret is present in the image; a leaked key rotates without redeploying code; per-user tokens decrypt only for their principal.
**Out of scope.** A third-party vault product (Supabase Vault first).
**Watch.** A secrets leak is a data leak — treat with the same gravity as RBAC.

### #42 — Fleet alerting (day one) ⚙️ `ops`
**M8 (early)** · **deps:** #37 · **Spec:** tech-stack §5.4
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** Console UI is deferred; flying blind is not.
**Tasks.**
- [ ] Each engine + worker posts heartbeat + error rate to Sentry/uptime (health-without-data).
- [ ] Alert on dead worker, backed-up queue, connector failures, overdue monitors (#45).
**Acceptance.**
- [ ] A dead worker or backed-up queue raises an alert without the operator dashboard.
**Out of scope.** The full fleet-health dashboard (deferred).
**Watch.** This is the minimum operability bar — ship it with the first real deployment.

### #43 — Cold-start onboarding flow 🧠 `ingestion` `frontend`
**M8** · **deps:** #16, #17, #28 · **Spec:** Brief §10.3, PRD §4.8
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**⚠ Audit fix (Tier 2):** Split into mechanical seeding+backfill vs the **guided-interview engine** (own design); name the #39/#43 seeding-ownership boundary.
**Context.** A zero-memory brain abstains on everything; cold-start makes it useful day one.
**Tasks.**
- [ ] Entity seeding from connectors (live answers immediately).
- [ ] Guided knowledge-capture interview → procedural/semantic memory; miss log seeds the backlog.
- [ ] Bounded backfill (`coldstart_backfill_days`) → chunks/episodic only, no cold semantic auto-promote; throttle early consolidation.
- [ ] Cold-start abstention copy.
- [ ] **Finalise the embedding pin (from #1).** Before the first client's data accumulates, run the bake-off (`tests/eval/embedding-bakeoff/`) on **their de-identified real content**; decide model + **dim N** + **dtype** on real ranking + separation; derive `retrieval_min_relevance` on the **shipped representation** (int8 if quantised wins); bump `EMBEDDING_VERSION` off `0-provisional` and update ADR 0001 → *Accepted*. This is the **last moment a re-embed is cheap** (≤ one corpus). The reranker floor (#14) is still re-derived separately on its own scale.
**Acceptance.**
- [ ] A freshly provisioned brain answers live SoR questions about a seeded entity on day one; backfill never auto-mints semantic facts; abstention copy reflects cold-start mode.
- [ ] The embedding pin is finalised on real data (or the provisional default is explicitly confirmed) and `EMBEDDING_VERSION` is no longer `0-provisional`.
**Out of scope.** Importing arbitrary legacy archives beyond the bounded window.
**Watch.** Backfill cost — bound it under `backfill_cost_ceiling` and rate-limit.

---

## Cross-cutting (schedule alongside the feature that needs them)

- **Meeting-bot connector** (after #44/#20/#23): unstructured, episodic-first; speaker attribution via Identity Map; conservative sensitivity + calendar-driven exclusion (HR/1:1/legal) + consent flag; actions→SoR via Gate 4. (Brief §10.2)
- **The 12 observability dashboards** (alongside the features that populate them): each is a read over existing tables — query interface, memory inspector, ingestion+queue health, agent activity+traces, proactive builder, self-improvement, cost monitor, quality monitor, system health, audit log, connections, orchestration. (Brief §11)
- **Cost levers** (protect the client's pass-through bill): prompt caching (#10), Gate-3 pre-classifier (#17), conditional verify (#24), multi-model routing (#10). (tech-stack §5.3)

---

## Added in audit remediation (new issues)

### #47 — Tenant + admin onboarding & auth bootstrap 🔒🧠 `infra` `rbac` `core`
**M1 (with #9/#39)** · **deps:** #9, #39 · **Spec:** Brief §8.1a, §9.1, §10.3
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** Every issue assumes a resolved **principal** and a **clearance row** — and nothing creates the first one. Fail-closed RBAC means a freshly provisioned brain has *nobody who can see anything or grant access* (chicken-and-egg). This is the auth-axis equivalent of the federation gap.
**Tasks.**
- [ ] Map Supabase `auth.users.id` (JWT `sub`) → engine principal; `user_clearance.principal_id` join. Missing row ⇒ **deny** (distinct from empty-zones).
- [ ] Provisioning (#39) seeds the **first admin's** clearance (full zones) so the brain isn't locked out of itself.
- [ ] **Service principal** minting for non-JWT triggers (system crons/webhooks, §7.5) — a service identity the engine trusts, carried into runs.
- [ ] Invite/enrol flow: an admin creates users + assigns role-default clearance.
**Acceptance.**
- [ ] First admin can log into a fresh brain and grant access; a user with no clearance row sees nothing (not an error); a system cron runs under a service principal with no JWT.
**Out of scope.** SSO providers beyond Supabase Auth's built-ins (later).
**Watch.** A *missing* clearance row and an *empty-zones* row are different cases — both deny, but only the second is a deliberate "see nothing" grant.

### #48 — Conversation / thread state 🧠 `core` `frontend`
**M4 (before #22)** · **deps:** #7 · **Spec:** Brief §7.1, §4.1
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** `assembleContext` takes `recentThread` with no source; the intent router can't resolve "do it → do *what*?" without prior turns. Conversation state was specified nowhere — it is **not** working memory (which never persists).
**Tasks.**
- [ ] `threads` + `messages` tables/types; thread owned by a user, RBAC-shareable (§7.1).
- [ ] Persist each turn; expose `recentThread` to context assembly (#15) **and** the intent router (#22).
- [ ] Thread sharing honours the same fail-closed clearance as answers.
**Acceptance.**
- [ ] A follow-up "do it" resolves against the prior turn; a shared thread shows a viewer only what they're cleared to see.
**Out of scope.** Branching/edit-history of threads (later).
**Watch.** Thread content is permission-scoped like everything else — a shared thread is not a permission bypass.

### #49 — Meeting-bot connector 🧠 `ingestion`
**M3+ (after #44/#20/#23)** · **deps:** #44, #16, #20 · **Spec:** Brief §10.2
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** Promoted from a cross-cutting note because it hides a **second resolver**: speaker attribution is not #16's text-mention resolver.
**Tasks.**
- [ ] Unstructured, episodic-first connector implementing the `Connector` interface; conservative default sensitivity.
- [ ] **Speaker → person attribution** via the calendar **attendee list** (diarization label → attendee intersection), NOT #16's text resolver; unmapped speakers keep raw labels + flag.
- [ ] Calendar-driven exclusion (HR/1:1/legal do-not-ingest) — requires a calendar connector (add to #20's set).
- [ ] Consent/record-allowed flag per connection; action items → SoR via Gate 4.
**Acceptance.**
- [ ] A transcript becomes episodic memory with speakers attributed to people; an excluded meeting is dropped at Gate 1; an unmapped speaker is flagged, not guessed.
**Out of scope.** Voice-biometric speaker ID (attendee-list intersection only).
**Watch.** Recordings have consent/legal implications — exclusion + consent flag are not optional.

### #50 — Observability dashboards + metrics rollup 🧠 `frontend` `ops`
**M8** · **deps:** #32, #37 · **Spec:** Brief §11
**Model:** 🧠 Opus 4.8 — run `/fast` (security-critical / subtle; a silent miss here costs more than the tokens).
**Context.** "Each dashboard is just a read" is false for the important ones: trend lines need a **time-series rollup** store no issue created, and some actions ("broaden visibility") are *writes*. Twelve surfaces were smuggled into one bullet of #38.
**Tasks.**
- [ ] `metrics_rollup` store + a rollup job (abstention/miss/cost/utility over time) for Quality (#32) + Cost monitors.
- [ ] Build the 12 dashboards as real surfaces; the Orchestration view is a **live** read of in-flight `task_state`.
- [ ] Memory Inspector's invalidate/**broaden-visibility** are writes with the §4.5 human-approval semantics, not reads.
**Acceptance.**
- [ ] "Abstention rate over time" renders from the rollup, not a live scan; broadening sensitivity goes through approval + audit.
**Out of scope.** Custom/user-defined dashboards (later).
**Watch.** Don't budget 12 data-viz surfaces as zero work — this is a multi-week build, decoupled from #38.

### #51 — CI pipeline + test infrastructure ⚙️ `eval` `ops`
**M1 (early)** · **deps:** #7 · **Spec:** tech-stack §4, §5.5
**Model:** 🧠 Opus 4.8 — high effort (`/fast`); building the whole project on Opus. *(⚙️ plumbing — the conserve-to-Sonnet candidate if you ever ration Max limits.)*
**Context.** #32/#36/#46 all "wire into CI as a required gate" — but no issue creates the gate. Per-tenant fixtures need an ephemeral DB to run against.
**Tasks.**
- [ ] CI pipeline: typecheck, unit tests (incl. **`tests/core/`** — wire it into the default run; it isn't a workspace pkg, so `pnpm -r test` misses it today), the architecture test (#46), the leak fixtures (#36), the eval harness (#32) on every PR.
- [ ] Two DB lanes: **pglite** (fast, hermetic, in-process — what M0 uses) AND a **real Supabase Postgres** lane (`supabase start` / cloud) that applies every migration — pglite's pgvector ≠ Supabase's, so the real lane catches divergence (HNSW/extension-version trap, #2/#7). Seed `tests/tenant-fixtures` against it; migrations apply clean (expand/contract).
- [ ] An end-to-end **engine-boot** smoke test: assembled engine boots against a provisioned tenant (TENANT_ID + DB + plugin + clearance) — the path #39 produces, otherwise first exercised in prod.
**Acceptance.**
- [ ] A PR that introduces a leak, a direct model call, or a failing fixture is blocked; the engine-boot smoke test passes in CI.
**Out of scope.** Load/perf testing (later).
**Watch.** The leak + chokepoint guards are only real if CI actually runs them — this issue is what makes "wire into CI" true.

---

## Reading order & criticality

Build order: **M0 slice → M1 foundations → M2 memory → M3 ingestion+identity → M4 chat → M5 agents → M6 lifecycle → M7 workflows → M8 surfaces+ops.**
Give the most review to 🔒 (leak/data-loss risk) and 🧠 (differentiators); ⚙️ are plumbing. The two earliest one-way doors — **#1 (embedding model)** and **#9/#36 (RBAC + leak fixtures)** — deserve disproportionate care because they are the most expensive to get wrong.
