# AIOS — Product Requirements Document

*Derived from `AIOS_Brief.md` (the spine) and the reshaped prototype. Where this PRD and the brief disagree, the brief wins and this doc gets corrected. Section refs like §4.3 point at the brief.*

Version 0.1 — 13 June 2026

---

## 1. Purpose & scope

This PRD turns the vision and architecture in the brief into buildable requirements: what the system must do, how each piece behaves, and what "done" means. It covers the **client brain** (the single-tenant product an agency's staff use) and the **agency control plane** — now scoped down to provisioning/migration *scripts*, with the operator *dashboard* deferred (§5) — and it specifies the **AI harness** — the engine's AI runtime — in depth, since that is the hardest and most differentiating part.

Out of scope for v0.1: marketing site, billing integration specifics, mobile apps, the meeting-bot connector (flagged open in brief §14), and the **agency-console operator dashboard UI** (deferred — only the provisioning/migration scripts are in scope; see §5).

## 2. Users & roles

| Role | Who | Primary surface |
|---|---|---|
| Admin | Agency owner/ops lead | Everything incl. settings, RBAC, security |
| Operator | Senior staff running the system | Agents, workflows, approvals, dashboards |
| Member | Day-to-day staff | Chat, their tasks, their inbox |
| Viewer | Limited/external | Read-only dashboards |
| **Agency operator (you)** | The selling agency | Provisioning/migration scripts now; the operator dashboard (a separate surface above all tenants) is deferred — §5 |

RBAC is pervasive (§9): it governs features, individual memories (sensitivity + zone), agents, and connections. Fail-closed everywhere.

## 3. Product pillars (what we are building)

1. **The brain** — durable, queryable, permission-safe organisational memory (§4).
2. **Honest answering** — provenance-labelled responses, abstention over confabulation (§6).
3. **The workforce** — configurable agents, multi-agent orchestration, workflows-as-data (§7).
4. **Selective ingestion** — the routing tree decides what's worth keeping (§5).
5. **Observability** — silent-failure detection as a first-class concern (§3, §11).
6. **The control plane** — operate many isolated client brains from one console (§8.4).

---

## 4. Functional requirements — Client brain

### 4.1 Chat (the front door)
- One input. An **intent router** classifies each message as a **query** (→ retrieval → provenance-labelled answer or abstention) or a **command** (→ agent/workflow runner). (§7.1)
- Every answer carries a provenance label: *I know this* / *This is live* / *Couldn't reach source* / *General inference*. (§6)
- Below the relevance floor, the brain **abstains** and logs a miss. (§6)
- Retrieval is permission-filtered to the asker and namespace-scoped to the context. (§4.7)
- Threads persist; sharing is RBAC-governed.
- **Acceptance:** asking a question with a known memory returns it with "I know this" + source + as-of date; asking for current structured data returns "This is live" from the SoR; asking something unknown abstains and logs a miss.

### 4.2 Memory
- One store, typed (working/episodic/semantic/procedural). Working never persists. (§4.1)
- Semantic memories may carry optional `(entity_ref, attribute, value)` slots for deterministic supersession/dedup; free-text facts fall back to similarity + classifier. (§4.5)
- Two surfaces: `memories` (full lifecycle) and `chunks` (RAG, 90-day TTL). **Both carry `zone` + `sensitivity_level` and are permission-filtered identically** — "no lifecycle" on chunks means no decay/invalidation, not no permissions. (§4.2, §9.1 brief)
- Namespaces (`org`/`client:{id}`/`project:{id}`) as a first-class column and filter. (§4.3)
- Sensitivity level + zone per memory; both fail-closed at retrieval.
- Inspector: browse/filter by namespace, type, sensitivity, date, source; admin can edit/invalidate/broaden. (§11.2)
- Invalidate-don't-overwrite; full history queryable. (§4.4)
- **Acceptance:** a Northwind memory never surfaces in a Meridian-scoped query; an invalidated fact never appears in an answer but is visible in the inspector; an SOP is never decayed.

### 4.3 Ingestion & routing
- Every incoming item runs the §5 gates in order: drop (sensitive/excluded) → fetch-live (current-state structured) → index-in-place (no/unsure interpretive value) → write-to-memory (lasting value), with SoR-write + episodic memory when it's also a structured action.
- Gate 2 is a deterministic schema lookup — **no LLM call ever**.
- After any write: provenance, sensitivity = max of sources, zone = union, content-hash dedup.
- Surfaces: what came in / captured / dropped / indexed-in-place, plus the review queue. (§11.3)
- Every gate decision is recorded in an **ingestion-decision log** (source-ref + content-hash + classifier confidence; references, not content) — the substrate for ingestion-side quality (§6.10).
- **Acceptance:** content from a do-not-ingest source is never stored; a CRM deal-stage field is fetched live, never copied; an uncertain item lands in `chunks`, not `memories`; a DROP decision is auditable from the decision log without storing the dropped content.

### 4.4 Connections
- Two tiers: org-wide and per-user; scope ≠ visibility. (§10.1)
- Each connection tagged structured-vs-unstructured (drives Gate 2) and live-vs-interpretive.
- Per-user integration tokens are selected by the run's **principal**; system-triggered runs use org connections only. (§7.5)
- Meeting-bot/recording is an unstructured, episodic-first connector: speaker attribution via the Identity Map, conservative sensitivity default, calendar-driven exclusion (HR/1:1/legal), consent flag; action items → SoR via Gate 4. (§10.2)
- Do-not-ingest list (Gate 1). Manual upload supported. Internet access for agents. (§10.2)

### 4.5 Agents & orchestration
- Configurable agents: persona/prompt, allowed tools, assigned skills, RBAC scope, trust score. (§7.2)
- Orchestrator decomposes goals and delegates to sub-agents (which may sub-delegate); live delegation tree + log. (§7.3)
- Workflows are JSON definitions in the tenant DB, run by the engine's workflow runner. (§7.4)
- Triggers: chat, schedule, webhook, system event. (§7.5)

### 4.6 Self-improvement
- Consolidation pipeline (the 6 Rs); evidence-backed suggestions that require admin approval; suggestions may target `system_config` values. (§7.6, §4.8)

### 4.7 Observability (12 dashboards)
Query interface, memory inspector, ingestion+queue health, agent activity+traces, proactive builder, self-improvement, cost monitor, quality monitor (silent-failure), system health, audit log (references-not-content), connections, orchestration. (§11)

### 4.8 Onboarding / cold-start
A zero-memory brain abstains on everything, so cold-start is a first-class capability (brief §10.3).
- **Entity seeding** — provisioning pulls entity lists from connected SoRs into the Identity Map (§6.12); federation-on-read then answers *"This is live"* from day one with zero memory.
- **Guided knowledge capture** — an onboarding interview writes procedural/semantic memory directly; the miss log seeds the capture backlog.
- **Bounded backfill** — connectors run over `coldstart_backfill_days` of history → `chunks` + `episodic` only, **no cold semantic auto-promote**; early consolidation throttled toward review (`coldstart_mode`).
- **Cold-start abstention UX** — abstention reframed as "still learning — here's what the SoRs show, want to teach me?"
- **Acceptance:** a freshly provisioned brain with connectors attached answers live SoR questions about a seeded entity on day one; backfill never auto-mints semantic facts; abstention copy reflects cold-start mode.

## 5. Functional requirements — Agency control plane

**Scope note (revised).** The operator *dashboard* is **deferred** — not yet thought through, nothing depends on it. What is in scope now is the **provisioning/migration machinery as scripts**. The dashboard items are retained below as a backlog sketch, not v0.1 requirements. Dropping the dashboard UI does **not** permit dropping the provisioning scripts: per-project isolation (brief §8.1a) depends on them.

**In scope (built now, as CLI scripts):**
- **Provisioning** — `provision-client`: create the Supabase project (Management API) → run migrations → deploy the Railway engine service → seed config. One command, not twenty minutes of clicking.
- **Migrations** — `migrate-all`: run a schema change across all tenant DBs as a scripted job. `deploy-all`: roll the shared engine image to all clients.

**Deferred (operator dashboard backlog):**
- **Clients** — every deployment with health/version/users/spend/memory count; click-through into a client brain.
- **Fleet health** — per-client instance + connector status, failed jobs, latency.
- **Cross-client cost** — spend, billed, margin per client.
- **Workflow registry** — workflow definitions across clients (data, not code).
- **Plugin registry** — the small plugin set; escalation-ladder discipline; promote-to-core flags. (§8.3)
- **Core deploys** — per-client version + rollout state (the UI over `deploy-all`).

---

## 6. The AI harness (the engine's AI runtime)

This is the layer that makes LLM calls safe, observable, and correct in production. It lives in the **sealed core** (§8.2) — never in plugins. Plugins may register agents/steps/prompts/scorers *into* it, but cannot alter it. Below is each component, what it must do, and how it cross-references the brief.

### 6.1 LLM gateway
The single chokepoint through which every model call passes.
- Model routing by task (cheap model for summarisation, strong model for reasoning) — config-driven, per §4.8.
- Fallback chain on provider error/timeout; bounded retries with backoff.
- Structured-output parsing + validation (JSON schema), with repair-or-fail, never silent malformed output.
- Per-call token + cost accounting emitted to the cost monitor (§11.7).
- Streaming support for chat.
- **Multi-provider generation, single-model embeddings.** *Generation* is routed across providers by task (cheap model for gate classification / summarisation / consolidation extraction; strong model for reasoning / synthesis) to save cost — but each route is **quality-gated by eval fixtures** (§6.10): a cheap model that fails structured output burns the saving in repair loops, so cost routing is quality-aware, never a static price table. *Embeddings* use **one fixed model+version**, recorded on every vector row (`embedding_model`, `embedding_version`); never cost-routed; changing it is a gated full re-embed of the corpus + floor re-calibration, not a config flip.
- **Prompt caching + per-client keys.** Stable prefixes (system prompt, persona, tool defs) are cached (~90% off cached input tokens). API keys are **per-client (BYO)** — clean cost attribution and no cross-client rate-limit noisy-neighbor. (Cost levers protect the client's pass-through API bill; tech-stack §5.)
- **Why core:** model choice, fallback, embedding-model pinning, key isolation, and cost tracking are exactly the things plugins must NOT touch (§8.2).

### 6.2 Context assembly
Builds the prompt sent to the model for a given turn.
- Pulls retrieved memories (post permission + namespace filter), tool definitions, agent persona, and recent thread.
- **Token budgeting:** ranks and truncates to fit the window; never blows the context limit silently.
- Attaches provenance metadata so the answer can be labelled (§6).
- **Acceptance:** assembled context never contains a memory the asker can't see; over-budget context is truncated by relevance, with what-was-dropped logged.

### 6.3 Routing-gate engine
Implements the §5 decision tree on incoming content, *before* the model where possible.
- Gate 1 (drop) and Gate 2 (fetch-live) are deterministic — Gate 2 is a pure schema lookup, no LLM.
- Gates 3–4 may use the model to judge interpretive value, with abstain-to-index-in-place as the safe default. **A cheap embedding-based pre-classifier runs in front of the Gate-3 LLM** — obvious cases (newsletters, automated noise) resolve without an LLM call; the model is the fallback for ambiguous items only (cuts Gate-3 LLM volume 50–70%; tech-stack §5.3).
- **Schema-drift safe default:** an unrecognised field on a *structured* connector routes to review (never auto-interpreted/stored); a periodic schema-drift job diffs live SoR schemas against `connector_schemas`. Keeps the spine fail-closed against drift. (§5)
- Runs async in the worker tier; emits to ingestion health (§11.3).

### 6.4 Retrieval
- Hybrid: Postgres `tsvector` + pgvector. RRF fuses and ranks the legs; because RRF discards score magnitude, the abstention floor is a **calibrated score** (target: a cross-encoder reranker over the top-N; v1: a pre-fusion dense cosine gate), **not** the RRF sum. (§4.7)
- **Permission-filtered at the vector layer, fail-closed** — never retrieve-then-filter. **Selectivity-aware:** predicate applied in SQL before ranking, then exact/flat search when the filtered set is small (restricted user, perfect recall) vs HNSW iterative scan when large. Same filter for `memories` and `chunks`. (§9.1, brief §4.7)
- Namespace-scoped from query context before retrieval.
- Single fixed embedding model+version across all vectors; never cost-routed (changing it = gated full re-embed + floor re-calibration). (§4.7)
- Abstain below `retrieval_min_relevance` (the calibrated floor); cap at `retrieval_max_results`. Both in `system_config`, re-calibrated per active scorer + embedding model.

### 6.5 Provenance & abstention layer
- **Per-claim grounding (not per-span):** the model cites its source (memory / live id) per factual claim via structured output; a verification pass confirms each citation is actually supported (run **conditionally** — low-confidence/high-stakes answers, not every answer — to bound cost); **uncited text is rendered "general inference" by exclusion.** Labels: memory / live / failed-fetch / general-inference. (§6)
- Abstains rather than confabulates; logs every abstention as a miss (the learning signal).
- **Acceptance:** no answer presents general inference as a business fact; a failed live fetch shows last-known with timestamp, not a guess; a cited claim is verifiably supported by its cited source.

### 6.6 Tool-calling orchestration
- The agent loop: model proposes tool call → execute → feed result back → repeat to a turn cap.
- Tool errors are caught and surfaced, not swallowed; bounded retries; escalate to human past the cap (per Agent Settings).
- **Capability-based routing:** each agent has a structured **manifest** (`whenToUse`, `capabilities`, `inputs`/`outputs`, `exampleGoals`). The orchestrator routes a sub-goal by (1) a deterministic pre-filter on capability tags + RBAC → small candidate set, then (2) LLM planning over those candidates. Delegation depth is bounded by `orchestrator_max_depth` (keep trees shallow). (brief §7.2, §7.3)
- **Clarification interrupt:** past the retry cap or on irreducible ambiguity, a (sub-)agent emits a typed `clarification_request` and **pauses** to durable `task_state` rather than guessing — the orchestrator answers from context, else a human does via the inbox, then the task **resumes from the pause**. This replaces a per-agent chat surface (brief §7.3).
- **Principal-scoped tokens & permissions:** every run carries a `principal` (user or service) fixed at trigger time and inherited by sub-agents; per-user integration tokens resolve from the principal and are unavailable to system-triggered runs (brief §7.5, §10.1).
- **Action authorization:** an action is allowed only if in `intersection(agent allowed tools, principal permissions)`; **irreversible/external actions (email, SoR write, money, client-facing) require preview → confirm** unless a standing approval exists. Writes are gated like sensitive config. (brief §9.2)
- Live SoR fetches happen here (federation, §4.9).
- Full step trace recorded (memory → tool → reasoning → output) for the activity log (§11.4).

### 6.7 Guardrails
- **Prompt-injection defence** on all ingested/tool content (the prototype's Security screen references this).
- **Anti-poisoning (trust-tiered writes):** content from low-trust sources (inbound external email, web) may be indexed-in-place but **may not auto-promote to semantic memory** without corroboration or human review; only high-trust sources earn "I know this" directly. Stops provenance from laundering injected content. (brief §5, §10.1)
- **Output validation:** schema + policy checks before an answer or tool-write is committed.
- **PII / confidentiality:** enforce sensitivity at write (Gate 1) and at retrieval; never log content to the audit trail (§11.10).
- **Confidentiality awareness** as a property of ingestion + retrieval, not a bolt-on (§7.7).

### 6.8 Memory lifecycle (crons)
- **Consolidation** (nightly): episodic → semantic, watermark + same-namespace dedup; auto-merge ≥0.97, review 0.92–0.97. (§4.5)
  - On a high-similarity match, a **duplicate / entails / contradicts / unrelated** classifier routes the pair: duplicate→drop, entails→merge, **contradicts→supersede (invalidate-old + write-new, §4.4)**, unrelated→keep both. Slot-able `(entity, attribute, value)` facts supersede deterministically (same slot, new value) without the classifier. (§4.5)
- **Decay** (weekly): type-aware utility scoring; procedural exempt; wrong→invalidate, unused→decay. **Episodic is reaped only once a confirmed semantic child back-references it** (`source_refs`); episodic with no consolidated child decays slowly / flags for review, never lost on age alone. A consolidation-coverage metric surfaces gaps. (§4.6, §11.8)
- **Chunk TTL:** prune index-in-place chunks past `chunk_ttl_days`.

### 6.9 Tracing & cost accounting
- Every model call, tool call, and retrieval emits a structured trace span (agent, **principal**, trigger, **model/provider used**, tokens, cost, duration, rating).
- **Traces may include content for debugging, but are short-TTL, permission-scoped to the data's clearance, never exported, and auto-pruned** — a debug buffer, not a durable shadow copy. The audit log stays references-only (§11.10). Two stores, different rules.
- Powers the activity log, cost monitor, and quality monitor.

### 6.10 Eval & quality monitoring
- Silent-failure detection (§3.1, §11.8): abstention rate (rising good, sudden drop suspicious), miss rate, low-rated-answer rate, retrieval quality, memory utility distribution. Plus the **ingestion-side blind spot**: false-drop rate (sampled human audit of low-confidence Gate-3 DROP/INDEX decisions) and **had-it-but-didn't-promote** misses (a logged miss whose content is found in `chunks` or the ingestion-decision log). The retrieval metrics alone never see what failed to enter.
- **The eval fixtures — not live metrics — are the arbiter of whether a config or self-improvement change helped.** A change to the relevance floor mechanically moves the abstention rate, so judging it by that rate is circular; the held-out fixture set is the ground truth. (Guards against the self-improvement loop optimising its own dashboard.)
- **Watching the watchers** — the detectors must not fail silently either (Brief §11.8): dead-man's switch on every monitor/cron (alert on absence of signal), embedding canary (re-embed a probe set, alarm on drift), completeness critic (mine misses for uncovered scenarios → new fixtures), and a CI architecture test that fails on any model-provider import outside the gateway (cost/trace completeness can't be silently broken).
- Offline eval harness: a fixture set of question→expected-behaviour cases run against the retrieval + answer pipeline on every core change (the tenant-fixtures from the architecture doc).
- Thresholds in `system_config`; breaches raise alerts.

### 6.11 Config-as-a-system
- Every threshold/weight/cadence/floor is a `system_config` row: gated (approval for quality-affecting), scoped (org default + client override), bounded (range-validated), audited + reversible. (§4.8)
- The self-improvement loop proposes changes here; admin approves; audit log records.

### 6.12 Entity resolution (the Identity Map)
The resolver from a mention to a canonical entity + its per-SoR external ids, used on both the write path (namespace derivation, §4.3) and the read path (federated live fetch, brief §4.10).
- Canonical entity ids are **minted internally**; external SoR ids are **mirrored** per connector. Identity is owned internally — "SoR wins" governs field *values* (§4.9), not identity.
- **Read:** resolve entity → look up external ids → fan out live fetch only to connectors that hold it → blend with namespace-scoped memory → one provenance-labelled answer under a latency budget; partial failure → "couldn't reach source"; short per-principal cache bounds latency/rate-limits.
- **Acceptance:** "what do we know about Client X" resolves to one canonical entity, fetches live only from connectors that hold it, and blends live + memory with correct per-span provenance; an entity that won't resolve abstains rather than guessing.

**Design decisions (resolved — the algorithm, not just the contract; this is the hardest piece, so the choices are named not left implicit):**
- **D1 — Entity resolution:** deterministic-first (exact/alias match) → embedding similarity with a **confidence floor**, context-boosted by the query's namespace. Below the floor → **abstain** (a wrong entity is a cross-client leak risk, never guess).
- **D2 — Query → fetch-plan:** a **deterministic planner** with a default field set per entity kind handles the common entity-centric queries; open-ended queries fall back to the LLM tool-loop (§6.6). Predictable where it matters, flexible where it must be.
- **D3 — Conflict:** SoR **wins on field values** (§4.9); memory is shown as the interpretive layer *beside* the live value, never silently overriding it.
- **D4 — Latency:** holding connectors fetched **in parallel**, each under a deadline; memory retrieval runs **concurrently** and never waits on a slow SoR; a missed deadline → "couldn't reach source" + last-known (§6).
- **D5 — Cache:** very short per-principal TTL (seconds), still honestly labelled "live"; **skipped when the answer will drive an action** (freshness matters more there).

---

## 7. Non-functional requirements

- **Isolation:** per-client DB + instance + **queue inside the client's own Supabase (`pgmq`, no shared Redis)**; no cross-tenant data path. The dominant risk is over-sharing (§3.2). Shared code ≠ shared data: one image, N isolated runtimes (brief §8.2).
- **Fail-closed:** every permission and namespace check defaults to deny/empty.
- **Observability-first:** if it isn't traced, it didn't happen — silent failure is the enemy (§3.1).
- **Latency:** a grounded turn chains routing + retrieval + reranker + federation + generation + validation; parallelise, set per-stage `latency_budget_ms`, give federation fetches a **deadline** (miss → memory answer + "couldn't reach source" rather than hang), cache where safe.
- **Portability:** containerised engine; PaaS now, orchestrator later, no app rewrite (§8.1a).
- **Auditability:** append-only, signed, references-not-content (§11.10).

## 8. Cross-reference: harness ↔ brief

| Harness component | Brief section |
|---|---|
| LLM gateway, config routing | §4.8, §8.2 |
| Context assembly + token budget | §6, §4.7 |
| Routing-gate engine | §5 |
| Retrieval (hybrid, fail-closed) | §4.7 |
| Provenance + abstention | §6 |
| Tool-calling + federation | §4.9, §7 |
| Guardrails | §7.7, §3.2 |
| Memory lifecycle crons | §4.4–4.6 |
| Tracing + cost | §11.4, §11.7 |
| Eval + quality monitoring | §3.1, §11.8 |
| Config-as-a-system | §4.8 |

## 9. Open questions (carried from brief §14)

None outstanding. The original open set is fully resolved:
- Per-agent chat → clarification interrupt (§6.6).
- Federation-on-read → Identity Map (§6.12).
- Ingestion-miss blindness → decision log + sampled audit (§4.3, §6.10).
- Contradiction-vs-duplication → classifier + slots (§6.8).
- Cold-start → onboarding capability (§4.8).
- Proactivity surface → the Inbox + digest (brief §7.5).
- Meeting-bot → unstructured episodic-first connector (§4.4, brief §10.2).
- connector_schemas drift → review-on-unknown + drift job (§6.3).
- Self-improvement metric integrity → eval fixtures are the arbiter (§6.10).

Remaining questions are operational, not architectural: per-connector latency/rate-limit budgets, backfill cost ceilings, and reranker selection.

---

*Next: tech stack + scaffolding — see `AIOS_TechStack_Scaffolding.md`.*
