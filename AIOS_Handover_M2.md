# AIOS — Handover at the M2→M3 boundary

*Resume-here snapshot for a fresh **review session**. Start the fresh chat with `Be my review partner per AIOS_Review_Partner.md`, then read this. Everything critical is in the repo/issues — this just orients you fast. Written at M2 close.*

## Where the build is
- **M0 + M1 + M2 are COMPLETE.** Every milestone gate green; leak fixtures #36 green at every close (RBAC never regressed).
- **M2 closed (4):** #12 invalidate-don't-overwrite + history · #13 selectivity-aware filtered ANN + RRF (the fail-open closer + namespace authz — the keystone) · #14 reranker floor + honest abstention · #15 context assembly + token budgeting.
- **M2 milestone gate (QA Playbook L1/L2/L3) passed:** full core suite green on merged main (261 pass / 21 expected skips); #36 leak fixtures green on every axis; a **named Level-3 collective seam test** authored + probed for false-green (`tests/core/m2-seam.test.ts` — write → invalidate → fail-closed hybrid retrieve); 3 independent adversarial reviewers found **no BLOCKER / no MAJOR**.

## What you can now assume exists (the engine)
On top of M1's sealed core: **durable memory** (`memory/store.ts` — `invalidate` / `supersede` / `resolveDedup` / `getMemoryHistory`, all atomic + audited, history append-only) · **fail-closed hybrid retrieval** (`harness/retrieval.ts` — `retrieve()` derives the permission predicate from the asking `principal` INSIDE the trust boundary; dense + keyword RRF-fused; selectivity switch exact-perfect-recall ↔ HNSW; identical predicate on both legs/stores BEFORE ranking) · **calibrated reranker floor + honest abstention** (#14 — score = rerank MAX, never an RRF sum; reranker outage ⇒ abstain + alert, never a cosine fallback) · **budgeted context assembly** (`harness/context.ts` — `assembleContext()`, whole-item truncation preserving per-claim provenance, two-pronged leak guard, byte-stable cache prefix).

## Live seams — respect these (cross-issue wiring, half-built on purpose)
- 🟢 **`retrieve()` is now FAIL-CLOSED** (the M1 red caveat is resolved — #13 wired `getClearance` + namespace authz in). User-facing reads (API #37, chat) may now build on it.
- **Namespace RESOLUTION has no owner yet — it's #16's job.** retrieve() searches the **full AUTHORIZED** namespace set (`clearance.allowedNamespaces`). The **Identity Map (#16)** NARROWS a query to specific namespaces (resolution ≠ authorization). See the `NB authorization, not RESOLUTION` note in `migrations/0014`. Until #16, every authorized namespace is searched.
- **trust_level stamping is #17/#18's job.** `writeMemory` takes `provenance.trustLevel` from the caller today. The invariant — stamp `connection.trust_level → Provenance.trustLevel` **at routing time** — lands with the ingestion gates (#18 anti-poisoning depends on it; without it, provenance launders injected content).
- **Context assembly is NOT wired into synthesis.** `synthesis.answerQuestion` reads `retrieval.memories` directly; `assembleContext()` is standalone until #10/#5/#24 adopt it (recorded on #15). `system` is shaped to drop into `CallOptions.system` (prompt cache).
- **Thread authz forward-contract (recorded on #48).** `assembleContext` trusts a caller-supplied `authorizedThreadId` and enforces only no-cross-thread leakage. #48 must resolve `authorizedThreadId` from `threads.owner_id` + §7.1 sharing — NOT per-turn author (`messages.principal` is per-turn author/attribution per migration 0008).
- **Chunks ride the memory rerank decision (#24).** retrieve() reranks **memories only**; chunks are surfaced un-reranked when a memory clears, and starved when none does. Permission-safe (identical WHERE), but #24 owns wiring chunks into rerank/synthesis + a pinning regression test (noted on #24).

## Open follow-ups spun out of M2
- **#61** — rerank-REORDERING the surfaced set + per-candidate below-floor co-resident drop (memories only). Split off #15; `diagnostics.rerankerScores` is already stashed for it. retrieval.ts comments point here, not #15.
- **#60** — `embed()` / `callModel` still slice 200 chars of the provider error body (§11.10 hygiene). `rerank()` is already status-only (the real prior bug, fixed + regression-locked). Low risk; uniform-posture cleanup.
- **#24** — chunks into synthesis/rerank + the M-1 pinning test (above).
- **M2 NITs (optional hardening, no ticket yet):** invariant-comment on the fused re-join (`retrieval.ts`); chain-walk through-hidden-to-visible info-flow signal in `getMemoryHistory`; audit-action vs `review_queue` kind naming on the zone-conflict path; a wasted re-embed on the rare relabel race. Spin a single "M2 hardening" ticket only if you want them tracked.

## Deferred tripwires (full list in `AIOS_Operations.md`)
Embedding pin **provisional** (#1→#43, floor 0.608) — finalize on real client data at first onboarding. Reranker pin **provisional** (Voyage `rerank-2.5-lite`, ADR 0003 → #43) — recalibrate the floor (`retrieval_min_relevance`) on real data. FTS config **`'english'` pinned** in `migrations/0014` — a non-English corpus needs a conscious re-index, not a flag. `enforce_admins` still off on `main` (solo build) — re-enable at first client.

## M3 (ingestion + identity) — the next milestone, in dependency order
**M3 is 7 core issues + 1 late:** #16, #44, #17, #18, #19, #20, #21 (+ #49 meeting-bot, gated on #44/#20/#23 — likely the tail or just past M3). Recommended build order (deps verified on GitHub):
1. **#16 Identity Map** (entity resolution; deps #7) — 🧠 differentiator, security-critical (a silent mis-resolution leaks across entities). On the critical path to #17. Do it while fresh.
2. **#44 Connector adapter interface + registry** (deps #7) — the connector substrate; #17/#20 need it.
3. **#17 Routing gates 1–4** (deps #16, #10, #44) — 🔒🧠 **the operational heart of ingestion, the spine rule made executable.** The M3 keystone.
4. **#18 Anti-poisoning trust gate** (deps #17) — 🔒 stamps/guards trustLevel at routing.
5. **#19 Ingestion-decision log + sampled audit** (deps #17) — makes wrong-drops visible.
6. **#20 Connectors v1** (one structured + one unstructured; deps #44, #17) — ⚙️ proves the interface.
7. **#21 connector_schemas drift job** (deps #20) — ⚙️ stale registry = spine violation.
8. **#49 Meeting-bot connector** (deps #44, #16, #20; "M3+ after #23") — hides a **second resolver** (speaker attribution ≠ #16's text-mention resolver). Defer to the tail.

**Serial discipline:** #16 / #17 / #18 are all security-critical — never parallelize two 🔒 issues (see [[working-style-grounded-serial]]). Connector plumbing (#44/#20/#21) can interleave but build serially through the coupled security trio. Leak fixtures (#36) gate every close.

## How we work now (the primers carry the detail)
`AIOS_Review_Partner.md` (the role) + `AIOS_Workflow.md` (the loop). The non-obvious habits, all reconfirmed this milestone: **ground every review in the real code and RUN the gate yourself** — build summaries are untrustworthy at high context (the "dumbzone"); this milestone that discipline caught a real §11.10 leak (#14), a false-green leak test, a CI-masking local key, and a shipped-DDL conflict that killed a wrong reviewer instruction (#15 thread authz). **Fresh build session per issue**; **fix-now if it's the issue's own correctness, else note on the owning issue / open a ticket**; **the reviewer closes the issue after approval and verifies CI both lanes** (incl. that new `*.real.test.ts` actually run); **author the collective seam test yourself and probe it for false-green** (grant-all must turn it red). See [[m1-handover-and-refresh]] in memory.

## First action on resume
Start the fresh review chat → load `CLAUDE.md` + `AIOS_QA_Playbook.md` + skim `AIOS_Issues.md` → confirm the M3 issue set against GitHub (the M2 ordering drift lesson) → then: **"generate the build command for #16."** Boot `pnpm ask:sop` (no keys) or `pnpm ask` (real keys) once to feel M2 end-to-end before diving in — both now exercise the full fail-closed retrieve → rerank floor → per-claim-provenance path.
