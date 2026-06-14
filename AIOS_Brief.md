# AIOS — Product & Architecture Brief

*Canonical reference. Everything — PRD, scaffolding, data model, the prototype — derives from this. Living document. In sync with the prototype as of the date below; §14 holds the decisions log and the few genuinely open questions.*

Last updated: 13 June 2026 — synced with the reshaped prototype (two modes, chat front door, memory namespaces, config-as-a-system, agency console).

---

## 0. One-line definition

A durable, queryable, permission-safe organisational brain for agencies and consultancies — it captures the perishable knowledge that lives in people's heads, answers questions about the business with honest provenance, and runs a workforce of agents that act on what it knows.

It is the Jarvis for a knowledge business: the system that remembers everything worth remembering, lets a founder leave for seven weeks without anything breaking, and turns "the knowledge walked out the door when she resigned" into "it's all still here, ask it anything."

---

## 1. Vision

The product is sold by an AI agency to other agencies and consultancies (10–70+ employees). Each client gets their own brain, wired into every tool their business runs on — email, Slack/Teams, drives, documents, CRM, ERP, meeting bots, project tools, finance. It follows the work everywhere it happens.

It remembers what humans do and decide, **without duplicating data that already lives in a system of record**. When someone leaves, their knowledge and the relationships they held stay. Handovers stop being a scramble. Decisions become queryable — not just *what* was decided but *why*. The institutional knowledge about a client or vendor that used to live in one account manager's head is now on a platform the whole company can query, at their permission level.

New hires get up to speed in days instead of months, because the context is already captured and answerable.

Because it learns so much, it becomes **proactive** — preparing for meetings, generating performance and research reports, surfacing patterns that unlock revenue or expose risk before a human would have noticed. It is the system that makes the business measurably better over time, like a quantum computer plugged into the company that never stops improving it.

And it is a **super-servant**: anyone can trigger agents to do real work — an admin process, an externally-triggered automation, a task fired straight from a chat message. It scales the whole business by doing the work, not just describing it.

---

## 2. Is / Is not

**It is:**

- Durable, queryable organisational memory
- The "person who remembers everything"
- A capture layer for perishable, in-people's-heads knowledge: decisions + the reasoning behind them, client preferences, sentiment, lessons learned, SOPs, relationships
- Queryable by both humans and agents
- Permission-safe — the right person sees the right thing, and no more
- A workforce: agents and multi-agent workflows that act on the memory

**It is not:**

- A copy of the CRM, ERP, or any system of record
- A replacement for existing business tools
- A system that remembers *everything* — unbounded memory degrades quality and is treated as a correctness problem, not a feature

**The core rule that governs all ingestion:**

> Materialise into memory ONLY if (a) it is NOT already a field in a system of record AND (b) it has lasting interpretive value. Everything that is current-state structured data is fetched LIVE as a tool call. On conflict, the system of record always wins.

This single rule is the product's spine. It is what makes the brain a thin, valuable interpretive layer rather than a stale, bloated second copy of every other tool.

---

## 3. The three risk principles

These constrain design more than any feature does. Every design decision is checked against them.

**1. These systems fail silently.** They are fluent, confident, and wrong while quality quietly erodes. Therefore observability and quality monitoring are first-class, not afterthoughts. The brain must be able to detect its own degradation. *No system is immune to silent failure — believing otherwise is the trap.* The honest goal is to shrink the residual surface to three buckets (eval-coverage gaps, the monitors themselves dying, genuinely novel modes) and guard each — including **watching the watchers** (§11.8).

**2. The dominant risk is over-sharing, not bad answers.** Showing the right data to the wrong person is the worst possible failure for a knowledge business. Permission-aware retrieval, fail-closed by default, outranks almost everything else. When in doubt, the system shows less, not more.

**3. Unbounded memory is a correctness problem.** Decay, tight retrieval, and selective writing are mandatory. A brain that hoards everything retrieves worse over time. Memory maintenance is correctness maintenance, not optional optimisation.

---

## 4. The memory model

### 4.1 One table, typed

A single Postgres table with a `type` column. **Do not build separate stores per type.**

| Type | Holds | Example | Persisted? |
|---|---|---|---|
| Working | Live conversation context, current task | The question being answered right now | Never |
| Episodic | Records of events — what happened, when, who | A client call on 3 May; a decision made in a meeting | Yes |
| Semantic | Durable facts, entities, relationships, decisions | "Client X prefers monthly reporting"; "We discount this vertical 15%" | Yes |
| Procedural | How-to, playbooks, SOPs, rules | "How we onboard a retainer client"; "Standard proposal process" | Yes |

**Working memory is conversational context only — it is not task-execution state.** A multi-step agent task that pauses (e.g. waiting on a stuck sub-agent's clarification, §7.3) needs *durable* state that survives a worker restart. That lives in a separate `task_state` record (status, accumulated agent context, the open question), never in working memory. Working = the live turn; `task_state` = a running job that may outlive the turn. Conflating them loses in-flight work on every restart.

### 4.2 Two retrieval surfaces, one pipeline

There are two places content can land, sharing one hybrid retrieval pipeline:

- **`memories`** — content that cleared the bar for lasting interpretive value. Carries the full lifecycle: status, utility score, invalidation, sensitivity inheritance, decay. Surfaced as *"I know this."*
- **`chunks`** — content indexed-in-place (RAG only). Chunked, embedded, searchable, but carries none of the memory lifecycle. Pruned by simple age-based TTL (`chunk_ttl_days`, default 90). Surfaced as *"I found this in [source]."* **Chunks still carry `zone` + `sensitivity_level` and are permission-filtered identically to memories** (§9.1) — "no lifecycle" means no decay/utility/invalidation, *not* no permissions. Permissions are orthogonal to lifecycle; a chunk from a confidential doc must never surface to someone who can't see it.

The memory lifecycle on the `memories` table — selective writing, utility scoring, invalidation, decay — is the moat. Most "RAG apps" only have the `chunks` half.

### 4.3 Namespaces

Namespaces scope memory retrieval to a context. They are a first-class column on the memories table, sitting alongside `type`, `sensitivity_level`, and `zone`. Three valid values:

| Namespace | Meaning | Who sets it |
|---|---|---|
| `org` | Applies to the whole organisation. Default for all writes. | Automatic — the default. |
| `client:{id}` | Specific to one client. Prevents Client A's preferences bleeding into answers about Client B. | Agent or operator, derived from entity refs in the proposal. |
| `project:{id}` | Specific to one project or engagement. | Agent or operator, derived from entity refs. |

**Namespace is the structural answer to "is client/account a first-class object?" — yes.** For an agency, the killer query is "what do we know about Client X," and namespacing makes client and project structural dimensions of memory itself, not just tags. Resolved from query context *before* retrieval, never post-filtered.

**Namespace and permission are orthogonal — both apply, both fail-closed.** Namespace answers *is this memory relevant to the context being asked about* (don't bleed Client A into Client B). Permission (`zone` / `sensitivity_level`) answers *is this asker allowed to see it*. A query about Client A in the `client:acme` namespace is still permission-filtered to the asker's clearance — an account exec sees Acme's project notes, not the founder's view of Acme's contract margin. Two filters, different jobs, never conflated.

### 4.4 Invalidate, don't overwrite

When a fact changes, never overwrite. Set `valid_to = now()` and `status = 'invalidated'` on the old record, then write a new record. History is always preserved — "what did we believe about this client in March, when did it change, and why" becomes queryable.

Retrieval filters to `status = 'active'` (`valid_to IS NULL`) by default, so invalidated records never resurface in answers. The Memory Inspector (dashboard 2) can show full history including invalidated records. The lifecycle is invisible in answers, visible in the inspector/audit surface.

### 4.5 Consolidation

A cron job (configurable cadence, default nightly 2am) distils episodic events into semantic facts:

```
episodic: "In the May 3 call, client said they prefer async updates"
    ↓ consolidation cron
semantic: "Client X prefers async updates over calls"
```

The raw episodic record is never deleted — the semantic fact points back via `source_refs`.

**Two duplicate guards, every run:**
- *Episodic watermark* — the job records `consolidation_last_run_at` in `system_config`; each run only considers episodic memories created after that watermark. Already-consolidated events are never reprocessed. The watermark updates at the *end* of a successful run, not the start, so a failed run reprocesses rather than skips.
- *Semantic similarity check before commit* — before writing a new semantic memory, run a vector similarity search against active semantic memories **in the same namespace** (cross-namespace consolidation would be the bleed bug in disguise). Scoring above `consolidation_dedup_similarity_threshold` (default 0.92) routes the candidate to human review rather than auto-committing. Exact duplicates are caught earlier by `content_hash`.

**Auto-merge band (added):** above a higher confidence threshold (`consolidation_auto_merge_threshold`, default 0.97) the candidate is auto-merged without review; the 0.92–0.97 band goes to human review. This keeps humans from becoming the bottleneck in the system's own learning loop. Review-queue depth (dashboard 3) is the metric that catches a stalling consolidation pipeline.

**Sensitivity on consolidation — tighten by algorithm, broaden only by a human.** A semantic fact distilled from multiple episodic sources inherits `sensitivity_level = max(sources)` and `zone = union(sources)` (§5). This is fail-closed and correct, but it *ratchets*: consolidated knowledge can only ever become less shareable, never more — so the brain's most valuable distilled facts risk becoming its least accessible. The system **never auto-broadens** (that is the over-share principle #2 forbids and you cannot un-leak after the fact). Instead, a consolidation that inherited high sensitivity from a single sensitive source is flagged into the review queue with a "consider broadening?" prompt; only an admin broadens (§11.2). Tighten by algorithm, broaden by human.

**Duplication is not contradiction — and similarity can't tell them apart.** "Prefers weekly reporting" and "prefers monthly reporting" score as near-duplicates in vector space yet are direct opposites. So a high-similarity match (above the dedup threshold) does **not** auto-dedup; it triggers a small **duplicate / entails / contradicts / unrelated** classifier (a cheap LLM call, run only on the already-similar pair):

- *duplicate* → drop the candidate (the existing fact stands).
- *entails / refines* → merge into the existing fact.
- *contradicts* → **this is how supersession is detected**: invalidate the old record and write the new one (§4.4), using timestamps + source credibility to separate *genuine change over time* (supersede) from *two sources disagreeing right now* (route to review).
- *unrelated-but-similar* → keep both.

**Structured slots where they fit.** A semantic memory may optionally carry `(entity_ref, attribute, value)` slots alongside its free-text statement. When a candidate is slot-able, supersession and dedup are **deterministic** — same `(entity, attribute)`, new `value` → supersede, no LLM call. Free-text facts (sentiment, lessons, nuanced relationships) that don't fit a slot fall back to the similarity + classifier path. Slots are an optimisation and a precision win, never a requirement — the extractor produces them only when confident.

### 4.6 Decay — type-aware

A cron job (configurable, default weekly Sunday 3am) recomputes `utility_score` on eligible memories and invalidates those below threshold. **Decay is type-aware — this is a correctness requirement, not an optimisation, because uniform decay would silently delete high-value rarely-retrieved knowledge (an SOP read once a quarter), which is exactly the silent-failure mode of principle #1.**

| Type | Decay behaviour |
|---|---|
| **Episodic** | Decays normally — and aggressively. It's raw event material; once consolidation has distilled it into a semantic fact (which survives and points back via `source_refs`), the raw event can fade. |
| **Semantic** | Slow decay. But a *wrong* fact is **invalidated** (§4.4), not decayed — see the feedback split below. |
| **Procedural (SOPs, playbooks)** | **Exempt from utility-decay entirely.** A playbook doesn't lose value from non-use; it loses value when *replaced*. It leaves active status only by explicit replacement/invalidation. The decay cron never considers it. |
| **Working** | Never persisted; decay is irrelevant. |

So the decay cron only ever touches episodic and (gently) semantic memories. Procedural is outside its scope — there is no path by which an SOP silently disappears.

**Episodic is only reaped once it has a confirmed semantic child.** The "episodic can fade because consolidation distilled it" logic assumes consolidation is complete — but it never is (it has recall gaps). So aggressive episodic decay must require that an *active* semantic memory actually back-references the record; episodic with **no** consolidated child decays slowly and flags for review rather than hard-invalidating on age alone. *The back-reference is a **typed, queryable relation** (a `memory_links` edge `kind = consolidated_child`), not a flat `source_refs` string array — otherwise the decay guard has no column to ask "does an active semantic memory reference this?" and the silent-data-loss guard is itself unbuildable.* Otherwise a consolidation miss becomes permanent data loss — exactly principle #1's silent failure. A **consolidation-coverage metric** (aging episodic with no semantic child) on the Quality Monitor (§11.8) turns that gap into a visible number.

*Exempt from decay ≠ exempt from review.* An SOP can still be flagged for human review if it looks stale (references a disconnected tool, unconfirmed for a long period). Flagging asks a human "is this still true?"; it never auto-invalidates. The system never throws away a playbook on its own.

**Utility score** (computed by the decay cron, not on every write), range 0.0–1.0:

```
utility_score = (retrieval_recency_score   × 0.4)   -- exp decay from last_retrieved_at
              + (retrieval_frequency_score  × 0.3)   -- log-scaled retrieval_count
              + (feedback_score             × 0.3)   -- thumbs signals
```
- `retrieval_recency_score`: `exp(-days_since_last_retrieval / 90)` — halves ~every 62 days of non-use.
- `retrieval_frequency_score`: `min(1.0, log(retrieval_count + 1) / log(50))` — saturates at 50 retrievals.
- `feedback_score`: `clamp((positive − negative) / max(total, 1), -1, 1)` mapped to 0.0–1.0.

**Feedback split (added):** a 👎 meaning *"factually wrong"* routes to **invalidation** (§4.4) — kill and replace — not decay. A 👎 meaning *"not relevant/useful"* feeds the `feedback_score` and decay. Conflating them means wrong facts linger at low utility instead of being killed; a single "wrong" should not merely nudge a score, it should invalidate.

Config keys (`system_config`):

| Key | Default | Description |
|---|---|---|
| `decay_min_utility_score` | 0.2 | Invalidate if score below this |
| `decay_min_age_days` | 30 | Only decay memories older than this |
| `decay_cron_schedule` | `0 3 * * 0` | Weekly Sunday 3am |

Any decay setting that affects answer quality requires admin approval (§4.8, §11.6) before taking effect.

### 4.7 Retrieval

- **Hybrid** — Postgres `tsvector` keyword search + pgvector dense search. RRF **fuses and ranks** the two legs. RRF is rank-based and deliberately discards score magnitude, so a calibrated confidence cannot be recovered from its output — the abstention decision is therefore made on a calibrated score, **not** the RRF sum.
- **Abstention floor is a calibrated score, not the RRF output.** *Target design:* a cross-encoder **reranker** scores the top-N fused candidates and its score is the floor (`retrieval_min_relevance`) — one calibrated, eval-backed knob, robust to embedding-model drift, and it also catches the "wrong memory ranked above the floor" failure. *Pragmatic v1 (before the reranker exists):* apply the floor as a **dense-leg cosine gate pre-fusion**, using RRF only to order survivors. The floor *interface* is identical either way, so the reranker drops in later without touching callers.
- **One embedding model, fixed.** Every vector — memories and chunks — is produced by a single embedding model, stored with `embedding_model` + `embedding_version` on the row. Embeddings are **never routed by cost** (mixing vector spaces silently corrupts retrieval, consolidation dedup, and decay). Changing the model is a deliberate, gated batch re-embed of the whole corpus plus a floor re-calibration — never a config flip.
- **Permission-filtered at the vector layer, fail-closed — never retrieve-then-filter.** (Retrieve-then-filter leaks through ranking signals and timing; most implementations get this wrong.) Concretely, filtered ANN is **selectivity-aware**: the permission predicate (§9.1) is applied in SQL *before* ranking, then — if the filtered candidate set is small (a restricted user, the dangerous case) — retrieval uses **exact/flat search** (sub-50ms over a few thousand rows, perfect recall); if the set is large (`org`-wide), **HNSW with iterative scan**, plus a partial index on the high-traffic `org` zone. This dodges the trap where HNSW + a selective filter silently collapses recall — restricted users would otherwise get the *worst* retrieval, invisibly.
- **Namespace-scoped** — every query filters by the relevant namespace(s) (e.g. `org` + `client:acme` for a client query), resolved from context before retrieval, never post-filtered.
- **Dynamic with a hard cap** — retrieve all memories above the relevance floor, up to the max-results limit.
- **Provenance + freshness label on every retrieved piece** (§6).
- **Zero results below floor → abstain.** Never inject low-confidence memories to dodge an abstention.

Config keys (`system_config`):

| Key | Default | Description |
|---|---|---|
| `retrieval_min_relevance` | 0.72 | Calibrated relevance floor — reranker score (target) or pre-fusion dense cosine (v1); below this is never injected and the query abstains. Re-calibrated per active scorer + embedding model. |
| `retrieval_max_results` | 20 | Hard cap per query, even if more clear the floor |

These two are levers the self-improvement loop may *propose* changes to (admin-approved): if abstention spikes the floor may be too high; if low-rated answers spike it may be too low.

### 4.8 Configuration as a system (everything tunable, safely)

**Every threshold, weight, cadence, and floor in the system is runtime-configurable, never hardcoded.** They live as rows in `system_config`, editable in the UI. This makes the system tunable in production, per-client, without a developer or a redeploy across instances — which is what lets one engine serve many clients with different tunings, exactly as workflows-as-data does.

But the config *is* the system's correctness (a fat-fingered relevance floor of 0.99 makes the brain abstain on everything — a self-inflicted silent failure). So the configuration system has four mandatory properties:

1. **Gated by impact.** Cosmetic settings (workspace name, theme) apply instantly. Quality-affecting settings (anything changing what the brain retrieves, decays, consolidates, or how it answers) go through the propose→approve flow — an admin confirms before it takes effect. Same gate as the self-improvement suggestions.
2. **Scoped.** Org-level default, optionally overridden per client (`client:acme` floor 0.80, everyone else 0.72). Resolution order: client override → org default. Same shape as namespace resolution. The tuning is data, like workflows.
3. **Bounded.** Each key has a valid range the UI enforces (relevance floor clamped e.g. 0.5–0.95; retrieval cap can't be 0). The dials have stops — "editable on the fly" never means "breakable on the fly."
4. **Audited & reversible.** Every change is an audit-log event (who, what, old→new, when) and rolls back to any prior value. The audit log is also the undo history for the system's own tuning.

This closes the self-improvement loop: the engine *proposes* a config change → an admin *approves* → the config changes → the audit log *records* → the quality monitor *watches* whether it helped. One coherent system. The settings UI is organised by area (memory, retrieval, decay, consolidation, agents, cost, ingestion).

### 4.9 Federation, not warehousing

Current-state structured facts are never copied in. They are fetched live from the system of record at query time. The brain holds only the interpretive layer on top. Architecturally this makes the product a **federation layer**: live tool-calls to SoRs, with latency and rate-limits as real design constraints, and the rule that on any conflict the SoR wins.

### 4.10 Identity map — entity resolution (read and write)

Federation-on-read and namespacing-on-write both depend on a component the rest of this brief had left implicit: a resolver from a mention ("Client X") to a **canonical entity** and its **per-SoR external ids**. It is needed on both sides — the same resolver that derives a write's namespace (§4.3, "derived from entity refs") resolves the entity a query is about — so it is promoted to a first-class core component: the **Identity Map**.

- **Canonical ids are owned internally; SoR ids are mirrored.** Each canonical entity (client / project / person / vendor) is minted internally and carries its namespace plus a map of external ids (`{ ghl: contact_123, xero: cust_456, asana: proj_789 }`). Identity is *not* delegated to any one SoR: a client can span several SoRs with different ids, switch CRM, or exist before it's in any SoR — a CRM-minted id breaks in all three cases. The "SoR wins" rule (§4.9) still governs *field values* — just not *identity*.
- **Read path.** "What do we know about Client X" → resolve to the canonical entity → look up its external ids → fan out live fetches only to the connectors that hold it → blend with namespace-scoped memory into one provenance-labelled answer (§6), under a latency budget, with partial failure shown as "couldn't reach source." A short per-principal cache bounds latency and rate-limits. An entity that won't resolve abstains rather than guesses.
- **Write path.** Entity refs on an incoming proposal resolve through the same map to set the memory's namespace — keeping Client A out of Client B's answers (§4.3).

*This is the hardest piece to build (entity resolution + live orchestration), so the five algorithm-level decisions — resolution method, query→fetch-plan, value conflict, latency, cache — are named explicitly in PRD §6.12 and encoded in `harness/federation.ts`, not left to discover mid-build.*

---

## 5. The routing decision tree

Every piece of incoming content runs these gates in order. Stop at first match. This is the operational heart of the ingestion system.

```
1. SENSITIVE / EXCLUDED?
   Source on do-not-ingest list (HR mailbox, /Legal, #personal)?
     YES → DROP. Never indexed, never stored.
   Content has a sensitivity label (MS label, manual tag)?
     YES → DROP or ROUTE TO REVIEW QUEUE.

2. CURRENT-STATE STRUCTURED FACT?
   Only runs for structured connectors. Unstructured connectors (Gmail,
   Drive) skip this gate — their connector_schemas are empty by default
   and all content is treated as interpretive.
   Structured connectors tag every item with field metadata:
     { field: 'deal_stage', value: 'Proposal', connector_type: 'ghl' }
   Gate 2 checks if `field` exists in connector_schemas for that connector_type.
   Deterministic lookup — NO LLM CALL, EVER.
     YES → FETCH LIVE. Never copy into memory.
     NO, but the connector IS structured → DO NOT silently fall through to
         interpretation. An unrecognised field on a structured connector is
         far more likely current-state structured data than lasting insight,
         so treat it as fetch-live-pending and ROUTE TO REVIEW — never
         auto-store. This keeps the spine fail-closed against schema drift.

3. LASTING INTERPRETIVE VALUE?
   A decision + why, a preference, sentiment, a lesson, a relationship, an SOP?
     NO     → INDEX-IN-PLACE (chunks table)
     YES    → continue to gate 4
     UNSURE → INDEX-IN-PLACE (safe default; never auto-promote uncertain content)
   ANTI-POISONING: content from a LOW-TRUST source (inbound external email,
   web) may be INDEX-IN-PLACE ("I found this in [source]") but may NOT
   auto-promote to a semantic "I know this" memory without corroboration
   from another source OR human review. Only high-trust sources (internal
   decisions, manual capture, SoR) earn semantic memory directly. A claim
   reaches trusted memory via source-trust OR corroboration OR review —
   never on a single untrusted source's say-so. (This stops provenance
   from laundering injected content into trusted-looking fact.)

4. ALSO A STRUCTURED ACTION?
   Produces an action item with owner + date, a new contact, a pipeline change?
     YES → BOTH: write structured part to the SoR (Asana task, GHL contact)
                 AND write an episodic memory of where it came from
     NO  → WRITE TO MEMORY (pick type from §4.1)

AFTER ANY WRITE:
  - Attach provenance (source refs, author, timestamp)
  - sensitivity_level = highest of all source levels
  - zone = union of all source zones
  - Check content_hash — if exists, skip (tier-1 dedup)
  - If it supersedes an older fact, invalidate the old record

AT EVERY RETRIEVAL:
  - Enforce permissions at query time, fail-closed
  - Label provenance + freshness in the output
```

Key architectural fallout: a `connector_schemas` registry table; a hard structured/unstructured connector distinction; provenance, `sensitivity_level`, and `zone` as columns that exist from row one and propagate through every operation; an async worker tier that runs these gates on incoming content; and an **ingestion-decision log** that records every gate outcome — including DROP and INDEX-IN-PLACE — with the classifier's confidence (source-ref + content-hash, references not content), so the ingestion classifier finally has a feedback loop (§11, dashboards 3 & 8). A periodic **schema-drift job** introspects each structured connector's live schema and diffs it against `connector_schemas`; new or changed fields go to review, never auto-trusted — keeping the registry fresh without letting drift silently violate the spine.

---

## 6. Provenance & honest answering

A signature, product-defining behaviour. Every answer visibly tags where each part came from:

- **"I know this"** — from memory (shows source + as-of date)
- **"This is live"** — from a system of record right now
- **"Couldn't reach source"** — live fetch failed (shows last-known + timestamp)
- **"General inference, not from your business"** — rendered visually distinct, never presented as a business fact

**The brain abstains rather than confabulates.** If nothing clears the relevance floor:

> "I don't have durable knowledge on this. Here's what the systems of record show: [...]. Want me to capture an answer if someone knows?"

**Every abstention is logged as a miss** — the single best signal for what to learn next. (And, per §3.1, a *falling* abstention rate is a warning sign of silent degradation, not automatically a good thing.)

**How this is actually built (per-claim, not per-span).** Attributing each *span* of fluent generated prose to a source is unreliable — models don't faithfully report which sentence came from where. So grounding is **per-claim by citation**: the model cites its source (memory / live-fetch id) as it generates each factual claim (structured output), and a lightweight **verification pass** confirms each cited claim is actually supported by its cited source (catching mis-citation). **Anything without a citation is rendered as "general inference" by exclusion** — which flips the unsolvable problem ("detect when the model is inferring") into a tractable one ("detect what's grounded"). The four labels live at the claim level, not the free-prose span level.

This provenance system is a core design primitive and a trust differentiator competitors won't replicate easily. It should look and feel consistent everywhere the brain answers.

---

## 7. The agent & workforce layer

The memory is the brain; the agents are what make it *act*. They are not a separate product — agents are the primary consumers of memory, and memory is what makes the agents non-generic (they answer and act with the company's actual context, permission-scoped).

### 7.1 The unified surface — chat as the front door

The product opens like a chat (the Claude-chat interaction model). One box. Behind every message is an **intent router**:

- **Query** → retrieval pipeline → provenance-labelled answer or abstention (§6)
- **Command** → agent / workflow runner → action

The user never has to decide "am I asking or commanding" — they just talk to it, and it figures out whether to *answer* or *act*. This collapses the old separate "query interface" and "command console" into one surface.

> Divergence from Claude chat to keep in mind: this is multi-user, shared-brain, and permission-scoped. Each message's retrieval is filtered to the asker's clearance; threads may be shareable per RBAC. The familiar UX hides a much more complex backend.

**Conversation state is a real, persisted store** (`threads` + `messages`), not working memory (which never persists, §4.1). It is the source of the "recent thread" fed into context assembly *and* the intent router — without it the router cannot resolve a follow-up like "do it" → *do what?*. Threads are owned by a user and RBAC-shareable.

### 7.2 Agents

Configurable agents (researcher, scorer, email-writer, analyst, etc.), each with a persona/prompt, an allowed tool set, assigned skills, and memory access scoped by RBAC. Each agent also carries an explicit **capability manifest** — `whenToUse` (the routing line), `capabilities` tags, `inputs`/`outputs`, and `exampleGoals` — which is what the orchestrator reads to pick it (§7.3). Routing quality depends entirely on these manifests, so they are a first-class, structured part of an agent's definition, not free text. An agent's *actions* are authorized as `intersection(allowed tools, the run's principal permissions)`, with a confirmation gate on irreversible/external actions (§9.2). **Trust score** = a rolling success / rejection / error rate weighted by human feedback; below a configurable threshold an agent is **constrained** (outputs require approval before commit), and lower still it is **quarantined** (disabled).

### 7.3 Orchestration & multi-agent

A core capability: an orchestrator agent can decompose a goal and **delegate to sub-agents**, which can themselves sub-delegate. The system exposes the live delegation tree (who is coordinating whom, who handed what to whom) and a delegation log. This is central to the pitch — "multi-agent" must be visible and real, not implied.

**How a sub-goal reaches the right agent (routing).** Two stages, cheap-to-expensive: (1) a deterministic **pre-filter** narrows the roster by capability-tag overlap + RBAC (the run's principal/clearance + each agent's `allowedRoles`), producing a *small* candidate set; (2) the orchestrator LLM then plans and sequences over those candidates' manifests (`whenToUse`/`exampleGoals`). A small candidate set is what keeps planning both cheap and reliable. **Keep trees shallow:** delegation depth is bounded by `orchestrator_max_depth` (default 3) — deep trees are where cost and debuggability fall apart, so start flat and only deepen when a goal genuinely needs it.

**One human-in-the-loop interrupt primitive, used three ways.** Clarification (a stuck sub-agent), action confirmation (an irreversible/external tool call, §9.2), and trust-constrained approval (a low-trust agent, §7.2) are the *same* mechanism — pause to durable `task_state`, surface to the Inbox, **resume idempotently**. Build it once, not three times. Resume is **single-consumer and idempotent** (an optimistic `version` + a lease on the row): a concurrent resume or a watchdog re-queue must never run the same side-effecting tool call twice, and resume **always preserves the original run's principal** — an answer from a lower-cleared human can unblock a task but never escalate its authority.

**Stuck sub-agents ask, they don't silently fail or guess.** When a sub-agent hits irreducible ambiguity or a tool failure past its retry cap, it emits a typed `clarification_request` and **pauses** to durable `task_state` (§4.1) rather than confabulating an answer. Resolution ladder: the orchestrator first tries to answer from memory/context; if it can't, it escalates to a human via the inbox (per the Agent Settings turn-cap/escalation, PRD §6.6); the answer is injected back and the task **resumes from the pause**. This is the *only* agent-directed input surface — there is deliberately **no per-agent chat** ("talk to one agent") view. The unified front door (§7.1) covers asking; answering a stuck task's question covers the rest.

### 7.4 Workflows — definitions are data, not code

A workflow is a JSON definition stored in the client's database, e.g.:

```json
{
  "workflow_id": "lead_qual_v1",
  "trigger": "new_crm_contact",
  "steps": [
    { "agent": "researcher",   "input": "{{contact.name}}" },
    { "agent": "scorer",       "input": "{{researcher.output}}" },
    { "agent": "email_writer", "condition": "score > 7" }
  ]
}
```

The shared engine's workflow runner reads and executes these. New workflows are created in a no-code builder, never by deploying code (see §9, escalation ladder).

**The DSL orchestrates; agents compute.** To stop "workflows-as-data" from sliding into a bad programming language, the DSL is bounded — sequential steps, conditions, parallel fan-out, a human-approval step, a retry policy — and *nothing more*. Anything needing real logic happens **inside an agent step** (arbitrary reasoning), not by growing DSL control flow. When even that won't hold it → plugin (the escalation ladder). The DSL never becomes Turing-complete; complexity lives in agents, not in control flow.

### 7.5 Triggers & proactivity

Workflows and agents are fired by: a chat message, a scheduled routine (cron-style, no-code), an external event (webhook), or a system event (new CRM contact, calendar event, inbound email). Proactive routines are how the system prepares meeting briefs, generates reports, and surfaces patterns without being asked.

**The Inbox is the single destination for everything the system pushes to a person.** Proactive outputs don't vanish into a log — they land in a per-user, permission-scoped **Inbox**: meeting briefs and reports, surfaced patterns, **stuck-agent clarification requests** (§7.3), alerts, and — for admins — self-improvement suggestions (§7.6). Items are typed and actionable (answer / approve / dismiss / open). A **digest** is a configurable roll-up of the inbox delivered on a cadence to an external channel (email / Slack); external delivery is just an adapter. Inbox content obeys the same fail-closed retrieval as answers — a brief generated for one person contains only what that person is cleared to see. A proactive **routine** (the §11.5 builder) is therefore: trigger (cron/event) + workflow + delivery (inbox / digest / channel) + recipient(s).

**Every run carries a `principal`, fixed at trigger time and immutable down the delegation tree.** Two clearly-separated trigger classes follow from this:

- **Individual cron / chat trigger** → principal = a real user. May use that user's **per-user integrations**; retrieval is permission-filtered to that user; memory it writes inherits that user's zone/sensitivity context.
- **System cron / webhook / system event** → principal = a service identity. **Org-wide connections only — per-user tokens are never used** (there is no user to borrow from, and borrowing would leak one user's access into an automation).

Sub-agents **inherit the triggering principal**, so token scope and permission filtering are decided once at the top of the tree and can never escalate mid-delegation. Individual vs system crons are declared explicitly; there is no implicit "current user" for a system run.

### 7.6 Self-improvement

The system reviews itself and proposes improvements to: its own memory (the consolidation pipeline — the **6 Rs**, each a concrete job: *recall* = gather candidate memories, *relate* = link to existing facts/entities, *refine* = merge/improve, *reduce* = dedup/compress, *reweave* = re-embed/re-index, *reflect* = self-eval against the fixtures), agent prompts (from rejection patterns), agent performance, and cost (e.g. downgrading a model where quality is unaffected — judged by the eval fixtures, §6.10 PRD, not live metrics). Suggestions are evidence-backed and require admin approval. This is correctness maintenance per §3.3, framed as a product surface.

### 7.7 Confidentiality awareness

The system must be conscious of absorbing confidential information — this is enforced primarily at Gate 1 of the routing tree (exclusions, sensitivity labels, review queue) and at retrieval (fail-closed permissions). Confidentiality is not a feature bolted on; it is a property of ingestion and retrieval.

---

## 8. Tenancy & deployment architecture

### 8.1 Single-tenant data plane

Each client gets their own brain and their own database. Client data is **never** co-mingled. For a trust product sold to agencies (whose own clients' data is inside), isolation is non-negotiable and is itself a sales asset.

### 8.1a Deployment topology — split compute and data planes

The system splits into two planes, isolated per client:

- **Data plane → Supabase.** Supabase *is* the Postgres (with pgvector built in — perfect for the memory model), plus auth and storage. One Supabase project per client.
- **Compute plane → Railway.** The Dockerised TS engine + worker tier run here, one service per client. Railway only runs the container; the database lives in Supabase. (Render is an acceptable substitute — both just run the container — but Railway is chosen for its scriptable provisioning API, which the agency console depends on for standing up new clients.)

**Packaging:** the sealed engine is a single Docker image, built once, run identically everywhere. This is what makes the control plane's "deploy core to all clients" possible and keeps the compute layer portable.

**Isolation (the decision that matters most).** Per principle #2 — over-sharing is the dominant risk and "we physically cannot leak between clients" is a sales asset — isolation lives in Supabase, and the chosen model is **one Supabase project per client.** This keeps the physically-separate story literally true and matches the per-service compute model one-to-one: Client A's engine connects only to Client A's Supabase project; there is no shared database and no cross-tenant query path. The cheaper alternative (one shared project with database/schema-per-client + Row-Level Security) is explicitly rejected for now: RLS misconfiguration is precisely the kind of silent error that causes the cross-tenant leak principle #2 forbids, and you cannot un-leak a shared database after an incident. Revisit only if per-project overhead becomes painful at scale — and even then, consolidate deliberately, not by default.

**Auth vs authorization (two layers, not one).** Supabase Auth handles *authentication* — who the user is, SSO, sessions. The engine still owns *authorization* — the fail-closed, sensitivity/zone/namespace-aware retrieval filtering (§9). That domain-specific logic cannot live in Supabase Auth; it's part of the harness. Keep them deliberately separate.

**Hosting (later):** because the engine is containerised, the same image lifts onto an orchestrator (Kubernetes / Fly / ECS) when the ops weight of hand-operating ~15–20 Railway services justifies it — without rewriting the app. Supabase can stay as the data plane through that transition. Do *not* reach for orchestration now; it solves a scale problem that doesn't exist yet.

**Things to bake in from day one** (hardened by the ops pressure-test — see the tech-stack doc §5):
- *Scriptable provisioning* — standing up client N is one command: create the Supabase project (Management API), run migrations, deploy the engine service (Railway API), seed the Identity Map + cold-start backfill. Never twenty minutes of clicking. It is an **idempotent, resumable state machine** (`pending → db_created → migrated → deployed → seeded`) with teardown on failure — a half-failed onboard must never leave an orphaned paid project or manual cleanup.
- *Per-tenant migrations & backups* — a schema change runs against N separate Supabase projects as a control-plane job. **Every migration is expand/contract** (additive → deploy → cleanup), because the single shared image must tolerate schema N and N-1 during fleet rollout; `migrate-all` reports per-project status and halts `deploy-all` to un-migrated projects. Supabase handles backups per project; **PITR is a paid tier**.
- *Secrets* — per-client secrets encrypted in the client's *own* Supabase (Supabase Vault) + **per-client (BYO) LLM keys**; never in the shared image. BYO keys also give clean cost attribution and close the only un-isolated tier (LLM rate-limit noisy-neighbor).
- *Health-without-data separation + fleet alerting* — the control plane reads service + project *health* (connector failing, queue backed up) without holding a key to client *data*. Even with the console UI deferred, **fleet alerting ships day one** (heartbeat + error rate to Sentry/uptime) — deferring the dashboard is fine; flying blind is not.
- *Compliance escape hatch* — launch on Railway for the initial ICP; the provider-abstraction lets a SOC 2-credible host (Fly / ECS / Cloud Run) drop in **per-client when a deal requires it**, without an app rewrite.

### 8.2 Shared, sealed engine + plugins (the chosen architecture)

**Three independent layers of separation — do not conflate them.** This is the most-misunderstood part of the architecture, so it is stated plainly:

1. **Cross-client data — physical.** Separate Supabase project + separate Railway service + a queue inside each client's *own* Supabase (§8.1a, §12). No shared DB, no shared queue, **no cross-tenant query path at all.** Client A's engine holds credentials for only Client A's data plane — it cannot *address* Client B's database, not merely "is filtered from" it. Un-leakable by construction, which is why shared-DB-with-RLS was rejected (a physical boundary cannot be misconfigured into a leak).
2. **Within-client users — logical.** Inside one brain, zone + sensitivity + namespace filtering, fail-closed (§9). This governs which staff member sees which memory; it never crosses a client boundary (that's layer 1's job).
3. **The code — shared, singular.** One sealed core image, built once, run identically everywhere. **Shared code ≠ shared data:** the image is identical on all deployments; each running instance connects only to its own client's data plane. You manage **one codebase**, never N forks — per-client variation is data (config/workflows/prompts in the client's DB) or a rare plugin folder, never a branch.

One shared engine codebase, identical for every client. The engine exposes fixed, documented **extension points** (hooks) and **knows nothing about any specific client** — no client names, no client-specific branches, ever. Client-specific code, when genuinely needed, slots in as an isolated **plugin** that registers into those hooks. A plugin is a *folder loaded by tenant ID*, not a fork; the escalation ladder (§8.3) keeps the total count flat (3–6 across *all* clients) as client count grows, so 25 clients is still one codebase shipped to 25 isolated runtimes via `deploy-all`.

```
core/                      ← sealed, shared, owned by you; never knows a client exists
├── llm/                   ← LLM caller
├── memory/                ← memory manager, retrieval, routing gates
├── tools/                 ← tool executor
└── workflow-runner/       ← reads workflow JSON
plugins/                   ← client custom code, isolated
├── client-a/
└── client-b/
deployments/               ← env vars + infra config only, ZERO logic
└── client-x/
tests/
├── core/
└── tenant-fixtures/       ← per-client workflow test scenarios
```

**Hook points the engine exposes** (extend as identified): `registerAgent`, `registerStep`, `overridePrompt`, `registerScorer`, tool configuration.

**Plugins MAY:** add agents, add workflow steps, override prompts/personas, register custom scorers/tools.

**Plugins MAY NOT:** touch auth/session, billing/usage tracking, the core LLM call logic, RBAC, or the database access layer.

**Plugin registration:** at boot, based on tenant ID from environment.

**Plugin fault isolation.** *Cross-client* isolation is free: instance-per-client (one Railway service + Supabase project each, §8.1a) means Client A's plugin cannot touch Client B's runtime. The *real* work is **in-process** isolation within one client: a plugin that throws at `register()`, leaks an unhandled rejection, or blocks the event loop must not crash that client's engine — so plugin load/register is wrapped in try/catch and, on failure, the engine **boots core-only + raises a System Health alert** rather than failing closed-down (#35).

### 8.3 The escalation ladder (the discipline that keeps this healthy)

Every "custom" client request is forced down this ladder, falling to the next rung only when the one above genuinely can't hold it:

1. **Config** (the ~90% path) — express it as data in the tenant DB: a workflow JSON, a feature flag, a prompt column. No code. A core update can't break it.
2. **Core capability behind a flag** — if it's new but *other clients would plausibly want it too*, build it into the engine as a configurable feature, off by default. This is the rung people skip; skipping it is what bloats the plugin folder.
3. **Plugin** (last resort) — only for logic genuinely specific to one client that no other client will ever want.

**Health metric:** count plugins after client 10. ~3–6 total across all clients = healthy. Roughly one-per-client = the pattern has failed and you've rebuilt the branch problem. Plugin count staying flat as client count grows is the signal it's working.

**Promotion rule:** the moment two clients want the same "custom" thing, promote it into core as a configurable option. It stops being custom.

### 8.4 Two products

| | Client brain | Agency console |
|---|---|---|
| Who uses it | The agency's staff | You (the operator) |
| What it is | Chat, memory, agents, workflows, the observability dashboards | Provisioning, fleet health, cost across all clients, plugin/workflow registry, core deploys |
| Tenancy | Single-tenant, isolated per client | Sits above all tenants — cross-tenant control plane |

**The console splits into two halves with very different urgency, and only one is built now.**

1. **Provisioning & migration machinery (built now).** Three scripts: `provision-client` (create Supabase project via Management API → run migrations → deploy Railway service), `migrate-all`, `deploy-all`. This is CLI plumbing, *not* a product surface — but it is what makes one-project-per-client (§8.1a) survivable without hand-clicking, and the isolation story is a sales asset. It ships with the engine.
2. **The operator dashboard (deferred).** Fleet health, cross-tenant cost, the registries — a real product, its own repo and deploy, talking to clients only through health-without-data APIs (§8.1a). It is **deferred**: not yet thought through, and nothing depends on it. Treat it as post-MVP.

The decision that matters: dropping the dashboard UI does **not** let you also drop the provisioning machinery — per-project isolation depends on it. The two were conflated; they are now separated.

---

## 9. Permissions (RBAC)

This is a company-wide system, so RBAC is pervasive and applies to more than screens:

- **Data/feature access** — an employee must not see the Xero data the founder sees.
- **Memories** — individual memories carry a `sensitivity_level` and `zone`; retrieval is filtered per asker, fail-closed.
- **Agents** — specific agents are restricted to specific roles.
- **Connections** — see §10.

### 9.1 The concrete model (within a client — layer 2 of §8.2)

Permission-aware retrieval is the highest-stakes correctness property in the system, so its data model is defined explicitly rather than left as "filter somehow":

- **Zone** — a tenant-configurable set of *functional/departmental* access labels. Defaults: `general`, `finance`, `hr`, `legal`, `exec`. Client-team zones can additionally be derived from the Identity Map for agencies that scope by engagement team. Zone answers *which part of the org* a memory belongs to; namespace (§4.3) answers *about whom* — orthogonal, both applied.
- **Sensitivity level** — an ordinal scale (`1` internal → `5` restricted), comparable, so the check is a simple `≤`.
- **Clearance** — a row per user (defaults inherited from role, per-user overrides allowed): `{ allowed_zones[], max_sensitivity }`. It lives in the **engine's authorization layer**, never in Supabase Auth (the auth-vs-authz split, §8.1a). Empty `allowed_zones` ⇒ sees nothing (fail-closed).
- **The retrieval filter** is therefore literally: `zone ∈ user.allowed_zones AND sensitivity ≤ user.max_sensitivity AND namespace ∈ query_namespaces`. Applied in the query predicate *before* ranking (§4.7), never post-filtered. **This filter is identical for `memories` and `chunks`** — every retrievable row carries zone + sensitivity; only the lifecycle differs (§4.2).
- **The empty-set fail-OPEN trap.** An empty `allowed_zones` must compile to `WHERE false`, never an empty `zone IN ()` — that is a Postgres syntax error, and an ORM that silently drops an empty `IN` returns **everything**. This single edge case is the most likely way the highest-stakes property fails *open*; it carries an explicit `denyAll` flag and a test.
- **Clearance is keyed to the auth identity.** A user's clearance row is keyed on the Supabase Auth user id (`principal_id`). A **missing** row ⇒ deny (a brand-new user sees nothing), which is deliberately distinct from an *empty-zones* row; provisioning seeds the first admin's clearance so a fresh brain isn't locked out of itself (see onboarding, §10.3).

### 9.2 Action authorization (the write side)

Read-RBAC governs what you *see*; this governs what an agent may *do* — the bigger blast radius for a system that acts:

- **Authorization = `intersection(agent's allowed tools, the run's principal permissions)`.** An agent can never exceed the authority of the principal that triggered it (§7.5). Each tool declares read-vs-write, which SoR it touches, and a blast-radius class.
- **Confirmation gate by blast radius** (the same gate-by-impact pattern as config, §4.8). Reversible/internal actions execute directly; **irreversible/external actions — send email, modify an SoR record, anything touching money or a client — go preview → confirm** before execution, unless the user has granted a standing approval for that action type. High-blast actions always confirm. Writes are gated like sensitive config: preview, confirm, audit.

Permission changes are the highest-value class of event in the audit log.

---

## 10. Connections & ingestion

### 10.1 Two ownership tiers

- **Company-wide (org)** — one shared connection for the whole business (CRM, shared Slack workspace). Credentials stored once.
- **Per-user** — each person's own connection (personal Gmail, personal Drive). One credential row per user.

**Connection scope ≠ data visibility.** An org-wide connection ingests broadly, but each user only ever sees what their permissions allow.

**Each connection carries a trust level** (high: internal SoRs, manual upload; low: inbound external email, web). Trust gates promotion to semantic memory (the anti-poisoning rule, §5) — not what gets ingested, but what gets *believed*. **The connection's trust level is stamped onto each item's provenance at routing time** — if that stamp is dropped, the anti-poisoning field defaults wrong and the gate silently no-ops, so it is an explicit step, not an assumption.

**Token selection is principal-driven (§7.5).** When an agent needs a per-user integration, it uses the run's principal's token — and only a user-principal has one. System-triggered runs have no per-user token and use org connections exclusively. This is enforced, not advisory.

### 10.2 Ingestion capabilities

- Manual upload of anything (docs, SOPs) to bring the brain up to speed.
- Internet access for the agents/brain.
- The routing tree (§5) governs everything that comes in, from every connector.

**Integrations are a first-class, uniform extension point.** Every connector implements one `Connector` interface (`sync` / `fetchLive` / `schema` / `authFor(principal)` / `healthCheck`) and registers into a registry — so adding the 5th or the 20th integration is "implement the interface, register it," never bespoke wiring. Core ships the common connectors; plugins may register more via the SDK (§8.2). The interface carries the metadata the rest of the system needs: structured-vs-unstructured (drives Gate 2), live-vs-interpretive, org-vs-per-user ownership (§10.1), and a default trust level (anti-poisoning, §5).

**Meeting-bot / recording ingestion (connector type).** Transcripts are an **unstructured connector** (interpretive by default — they skip Gate 2) and **episodic-first**: a meeting is an event ("In the 3 May call, X decided Y because Z"), distilled to semantic over time. Speakers are attributed to people via the Identity Map (§4.10); unmapped speakers keep their raw label and are flagged. Because recordings frequently carry confidential discussion, the **default sensitivity is conservative** (higher than email) and **calendar metadata drives exclusion** — HR, 1:1, and legal meetings are do-not-ingest by default (Gate 1), and each meeting connection carries a consent / record-allowed flag. Transcripts are rich in Gate-4 structured actions (commitments with owner + date) → written to the SoR as tasks plus an episodic memory of origin.

### 10.3 Cold-start & onboarding

A brand-new brain has zero memory, so naïvely it abstains on everything — day-one UX is "I don't know" to every question, which kills adoption. Cold-start is therefore a first-class capability, not an afterthought. Four mechanisms, in order of leverage:

1. **Entity seeding makes the brain useful on day one — before any memory exists.** At provisioning, entity lists are pulled from connected SoRs (CRM companies/contacts, project-tool projects, accounting customers) and minted as canonical entities in the Identity Map (§4.10). The moment entities + connectors exist, **federation-on-read works**: "what's Acme's deal stage / outstanding balance" answers *"This is live"* from the SoR with zero memory. The live half of the brain is useful immediately; only the interpretive half is cold.
2. **Guided knowledge capture (highest-value).** A structured onboarding flow interviews key people — "how do you onboard a retainer client? who are your top clients and what should I know about each?" — capturing procedural (SOPs, playbooks) and semantic knowledge directly into memory. This is the in-people's-heads knowledge that is the whole point of the product, and the fastest path to *"I know this."* The early **miss log seeds the capture backlog** — what people ask and the brain can't answer becomes the interview queue.
3. **Bounded historical backfill.** Connectors run over a *bounded* window of history (`coldstart_backfill_days`) through the routing gates. To control cost and quality, backfill lands in `chunks` (index-in-place) and `episodic` memory by default and **does not auto-promote to semantic** — promotion happens through normal consolidation over time, not from a single cold bulk batch (auto-minting semantic facts from a massive cold batch is the over-generalisation failure at scale). Early consolidation runs are throttled and lean toward review over auto-merge, because a cold batch carries higher error risk.
4. **Cold-start abstention UX.** While the brain is learning, abstention is reframed from failure to onboarding: *"I'm still learning the interpretive side — here's what the systems of record show, and want to teach me?"* The *"This is live"* provenance carries the early experience while memory fills in over weeks.

Config keys (`system_config`): `coldstart_backfill_days` (default 90); `coldstart_mode` (while true, throttles consolidation auto-merge toward review).

---

## 11. Observability — 12 dashboards

These exist because of risk principle #1 (silent failure). All data comes from existing tables if everything above is instrumented correctly — no additional collection required.

1. **Query Interface** — *Everyone.* NL query box; answers with provenance labels; source citations; feedback buttons (👍/👎/"this is wrong"); clear abstention; query history.
2. **Memory Inspector** — *Everyone (filtered to clearance).* Browse everything the brain knows. Filter by entity, type, date, source, sensitivity. Each record shows content, source, created, last-retrieved, sensitivity. Admin can edit, invalidate, or broaden visibility.
3. **Ingestion + Queue Health** — *Operator+.* What came in by connector/period; what was captured (by type); what was dropped (by reason); what was indexed-in-place; human review queue depth + oldest-item age + backlog trend; memory-proposal queue depth + drain rate; confidence-score distributions. Every gate decision is written to an **ingestion-decision log** (source-ref + content-hash + classifier confidence — references, not content; re-fetch from source to audit); a **sampled human audit** of low-confidence DROP / INDEX-IN-PLACE decisions yields a measured false-drop rate.
4. **Agent Activity + Full Traces** — *Manager+.* Every agent run: which agent/user/trigger; full step-by-step trace (memory retrieved → tools called → tool responses → reasoning → output); performance rating; tokens + cost; duration. Filterable.
5. **Proactive Builder** — *Operator+.* Create/edit/enable/disable routines; per-routine run history; last-run output; test-run button.
6. **Self-Improvement Suggestions** — *Admin.* Pending suggestions with evidence + reasoning; approve/reject; history with outcomes; performance trend charts (answer quality, miss rate, retrieval quality over time).
7. **Cost Monitor** — *Admin.* Token spend by day/week/month; breakdown by user/agent/connector/job-type; storage growth; tool-call volume; per-user cost; **cost-per-ingested-item**; configurable budget-alert threshold. Ingestion economics are kept sane by gate ordering: Gate 1 (drop) and Gate 2 (fetch-live) are deterministic and run *before any model call*, so most high-volume structured/excluded content never costs an LLM call; Gate 3 uses the cheapest capable model with content-hash dedup first; embeddings run only on content heading toward storage. Backfill is bounded and rate-limited under a `backfill_cost_ceiling`.
8. **Quality Monitor (silent-failure detection)** — *Admin.* Abstention rate over time (rising = good; sudden drop = suspicious); memory miss rate; low-rated-answer trend; memory utility distribution (retrieved vs just accumulating); retrieval-quality scores; threshold alerts. Plus the **ingestion-side blind spot**: false-drop rate (from the sampled audit, dashboard 3) and **had-it-but-didn't-promote** misses — a logged miss whose content is found in `chunks` or the ingestion-decision log, i.e. proof the brain saw it but failed to keep it. The retrieval metrics alone only ever see what entered; these see what didn't.

**Watching the watchers** (the detectors must not fail silently either, §3.1): (1) a **dead-man's switch** — every monitor/cron heartbeats after each run, and a watchdog alerts on the *absence* of signal (losing a detector silently is the failure we're guarding against); (2) an **embedding canary** — periodically re-embed a fixed probe set and alarm on drift, catching a provider silently changing the model behind a version (the one-way door, §4.7); (3) a **completeness critic** — the eval-fixture set is never "done"; real misses are mined for uncovered scenarios and proposed as new fixtures; (4) an **architecture test** — CI fails on any model-provider import outside the gateway, so cost/trace completeness can't be silently broken by a rogue direct call.
9. **System Health** — *Admin.* Failed jobs (+ error detail + retry state); connector status + last-sync; LLM API error rate; queue depths; worker health; DB health; active alerts.
10. **Audit Log** — *Admin.* Append-only, tamper-evident. Auth events; connection lifecycle; permission changes (highest-value); memory mutations; tool write actions; query access; review-queue decisions; config changes. Filterable by user/action/date. **The rule: log references and actions, never content** — the audit log must enable reconstruction without becoming a second copy of sensitive data that bypasses the permission model.

   *Audit vs debuggability — two stores, different rules.* The audit log (references, append-only, long retention) is for compliance. Debugging a bad answer needs the actual retrieved content, so **traces may include content — but are short-TTL, permission-scoped to the same clearance as the underlying data, never exported, and auto-pruned.** A debugging buffer, not a durable shadow copy. You can reconstruct a recent failure without creating a second permanent copy that bypasses permissions.

*(The two dashboards left open in the original list are now confirmed and built: a connections manager — see Connections (§10) — and an orchestration view — see the multi-agent delegation tree (§7.3).)*

---

## 12. Architecture signals (for stack & scaffolding)

Pulled directly from the decisions above — these drive the tech choices:

- **Supabase (Postgres + pgvector)** — the data plane, one project per client. One `memories` table (typed), a `chunks` table (RAG-in-place), a `connector_schemas` registry, plus provenance/sensitivity/zone columns throughout. Supabase Auth handles authentication; the engine owns authorization.
- **Async worker / queue tier** — runs the §5 routing gates on incoming content; drains ingestion, proposal, and review queues. **The queue lives inside each client's own Supabase (Postgres-backed: `pgmq`), not a shared Redis** — keeping the entire data plane per-client, with no shared queue as a cross-tenant data path or shared failure domain (layer 1, §8.2).
- **Latency budget as a first-class concern** — a grounded chat turn chains intent-routing + retrieval + reranker + federation fetch + generation + output validation. These are parallelised where possible; federation fetches carry a **deadline** (miss it → answer from memory + "couldn't reach source"); per-stage `latency_budget_ms` is config. Grounded answers are honestly slower than vanilla chat; "checking sources…" turns that latency into visible trustworthiness.
- **Per-connector ingestion adapters** — structured (schema-tagged, Gate-2 eligible) vs unstructured (interpretive by default).
- **Agent runtime** — does live SoR fetches at query time; enforces fail-closed permission filtering on retrieval; produces full traces.
- **Intent router** — front of every chat turn; query vs command.
- **Workflow runner** — executes JSON workflow definitions from the tenant DB.
- **Sealed core engine + plugin loader** — loads plugins by tenant ID at boot; hook registry; fault isolation.
- **`system_config` table + settings service** — every threshold/weight/cadence/floor as a row; gated (approval for quality-affecting keys), scoped (org default + client override), bounded (range-validated), audited/reversible. Wired to the self-improvement approval loop.
- **Deployment** — split planes: Supabase (data, one project per client) + Railway (compute, one engine service per client); single Docker image; scriptable provisioning (Supabase Management API → migrations → Railway API); per-tenant migrations as a control-plane job. Portable to an orchestrator later.
- **LLM gateway — multi-provider generation, single-model embeddings, per-client keys.** Generation routed across providers by task to save cost, each route quality-gated by eval fixtures; **prompt caching of stable prefixes** (~90% off cached input tokens); **per-client (BYO) API keys** (clean attribution, no noisy-neighbor). Embeddings pinned to one model+version, stored per vector row; never cost-routed. (Cost levers protect the client's pass-through bill — tech-stack §5.)
- **Identity Map (entity resolution)** — mention → canonical entity → per-SoR external ids; powers namespacing on write and federated live fetch on read. Canonical ids owned internally, SoR ids mirrored. (§4.10)
- **Ingestion-decision log + sampled audit** — every gate outcome recorded (references, not content); feeds the ingestion false-drop rate and had-it-but-didn't-promote misses on the Quality Monitor. (§11)
- **Semantic slots (optional)** — `(entity_ref, attribute, value)` columns on memories for deterministic supersession/dedup, with free-text fallback. (§4.5)
- **Durable `task_state`** — execution state for multi-step / long-running and *paused* agent tasks (stuck-sub-agent clarification, §7.3), distinct from never-persisted working memory.
- **`principal` on every run and trace** — user vs service identity, fixed at trigger time and inherited down the delegation tree; drives both token selection and permission filtering (§7.5, §10.1).
- **Agency control plane** — split into provisioning/migration **scripts (built now)** and a **deferred operator dashboard**; cross-tenant, health-without-data.

This is a backend-heavy product. The UI (the ~33 prototype screens) is roughly a quarter of the actual system.

---

## 13. Prototype state

The prototype now reflects this brief end to end. It is a single self-contained HTML file, two modes, fully clickable, with realistic mock data. State as built:

**Two modes, switchable in the sidebar:**
- **Client brain** — what an agency's staff use. Brain-first nav: Ask → Knowledge → Work → Agents → Automate → Observe → Admin.
- **Agency console** — the operator's cross-tenant control plane (you). Fleet → Build → Operate.

**The spine — chat as the front door.** Landing screen is a conversational surface with the intent router behind it (query vs command). It demonstrates all four provenance labels ("I know this" / "This is live" / "Couldn't reach source" / "General inference"), an abstention logged as a miss, and a command routed to agents. Provenance is a consistent component wherever the brain answers.

**Memory as a central pillar (Knowledge group).** Typed model (working/episodic/semantic/procedural) as filters; namespaces (`org` / `client:{id}` / `project:{id}`) as a first-class filter row and per-entry badge; sensitivity badges per entry; SOPs marked decay-exempt. Sibling screens: Ingestion & Routing (the §5 gates as a live flow with the memory-proposal review queue) and Connections (the org / per-user / do-not-ingest tiers, each tagged structured-vs-unstructured and live-vs-interpretive).

**Observability reframed to the brief.** Quality Monitor centres silent-failure detection (abstention rate, miss rate, memory utility distribution) with agent task quality demoted to secondary. Activity Log shows full expandable agent traces (memory → tools → reasoning → output, with cost/tokens/rating). Audit Trail enforces "log references and actions, never content." Self-Improvement shows the 6 Rs consolidation pipeline + suggestions that feed the config approval loop.

**Config as a system.** System Settings exposes the real tunables (`retrieval_min_relevance`, decay/consolidation thresholds, TTLs) as editable rows, each tagged Gated / Scoped / Bounded with valid ranges, wired conceptually to the self-improvement approval loop.

**Agency console (second product), built.** Clients (per-deployment health/version/spend, click-through into a client's brain), Fleet Health, Cross-client Cost (with margin view), Workflow Registry (workflows-as-data), Plugin Registry (the escalation-ladder discipline made visible — plugin count flat as clients grow, "promote to core" flags), Core Deploys, Provisioning, Migrations-across-tenants. *(**Superseded:** the console UI is now deferred and this prototype mode is a discarded sketch; only the provisioning/migration scripts survive into the build — §8.4, §14.)*

**Everything is v1 — no phases.** The agent/task screens (Field Ops, Priority Matrix, Brain Dump, Objectives, Projects) are all present and kept prominent; the nav simply leads brain-first so the product reads as a brain without cutting anything.

File: `AIOS_prototype.html`.

---

## 14. Decisions log & remaining questions

**Resolved:**
- **Instance isolation** → separate instance per client. Split planes: Supabase (data, one project per client) + Railway (compute, one engine service per client). One Supabase project per client chosen over shared-project-with-RLS, because RLS misconfig is exactly the cross-tenant leak principle #2 forbids. §8.1a.
- **Client/account as a first-class object** → yes, expressed structurally via namespaces (`client:{id}`, `project:{id}`). §4.3.
- **Agency console scope** → split. Provisioning/migration *scripts* built now (per-project isolation depends on them); operator *dashboard* deferred (not yet thought through, nothing depends on it). The prototype's console mode is a discarded sketch. §8.4.
- **Per-agent chat** → no. Replaced by a stuck-sub-agent **clarification interrupt** (pause → orchestrator/human answers → resume). §7.3.
- **Multi-model** → multi-provider *generation* routed by task; **single fixed embedding model**, re-embed-on-change. §4.7, §12.
- **Per-user tokens** → **principal-driven**; system-triggered runs never use per-user tokens; individual vs system crons declared explicitly. §7.5, §10.1.
- **Relevance floor** → a **calibrated score** (reranker target; pre-fusion dense cosine v1), not the RRF output. §4.7.
- **Sensitivity on consolidation** → tighten by algorithm (max/union), broaden only by a human. §4.5.
- **v1 vs v2 line** → no phases; everything is v1. Nav leads brain-first but nothing is cut. §13.
- **Type-aware decay** → procedural/SOPs decay-exempt (leave only by replacement); episodic decays; semantic slow; wrong→invalidate, unused→decay. §4.6.
- **Config tunability** → everything in `system_config`, gated/scoped/bounded/audited, wired to self-improvement. §4.8.
- **The "12" dashboards** → the two unspecified ones are confirmed as a connections manager (Connections) and an orchestration view (Orchestration), both built.
- **Federation-on-read** → resolved via a first-class **Identity Map**: canonical entity ids owned internally, per-SoR ids mirrored; read path resolves → fans out live fetch → blends with memory; unresolved entity abstains. §4.10.
- **Ingestion-miss blindness** → **ingestion-decision log** + sampled human audit + miss↔ingestion cross-check; surfaced on the Quality Monitor as false-drop rate and had-it-but-didn't-promote misses. §5, §11.
- **Contradiction vs duplication** → high-similarity matches run a duplicate/entails/contradicts/unrelated classifier; *contradicts* = supersession (invalidate-old + write-new). Optional `(entity, attribute, value)` slots make supersession deterministic. §4.5.
- **Cold-start / onboarding** → entity seeding (live answers day one) + guided knowledge capture (miss log seeds the backlog) + bounded backfill to chunks/episodic (no cold semantic auto-promote) + cold-start abstention UX. §10.3.
- **Proactivity surface** → the **Inbox** is the single per-user, permission-scoped destination (briefs, clarification requests, alerts, suggestions); digest = a cadence'd roll-up to a channel. §7.5.
- **Meeting-bot ingestion** → unstructured, episodic-first connector; speaker attribution via Identity Map; conservative sensitivity + calendar-driven exclusion + consent flag; action items → SoR via Gate 4. §10.2.
- **Connector-schema drift** → an unrecognised field on a structured connector routes to review (never auto-stored), plus a periodic schema-drift job; the spine stays fail-closed. §5.
- **Self-improvement metric integrity** → eval fixtures are the arbiter of whether a change helped, not the live metrics it mechanically moves. PRD §6.10.

**Resolved — third pass (stack / economics / ops; detail in tech-stack §5):**
- **Commercial model** → managed service: $15k upfront + $3.5k/mo, **client pays API *and* infra (BYO keys + own Supabase/Railway billing)**. ⇒ recurring COGS ≈ $0, so the $3.5k is ~pure labor margin regardless of client size; the *only* constraint is *hours-per-client*, so ops automation protects margin directly. The per-seat "small clients are marginal" worry does **not** apply.
- **Cost reduction** → *variable* API cost is materially reducible (prompt caching, multi-model routing, Gate-3 pre-classifier, conditional verify) — but this now protects the *client's* pass-through bill, not your margin. *Fixed* per-client infra (~$215/mo) is **not** reducible without breaking one-project-per-client isolation; that floor is the price of the core promise and is immaterial under the $3.5k model. Don't engineer it away.
- **Compliance / host** → launch on Railway; provider-abstraction allows a SOC 2-credible host **per-client when a deal requires it**; SOC 2 readiness after ~5 clients. §8.1a.
- **Ops disciplines** → idempotent/resumable provisioning; **expand/contract migrations** (image tolerates schema N and N-1); secrets in client's own Supabase Vault; **fleet alerting day one**; **per-client BYO LLM keys**; PITR as a paid tier. §8.1a, tech-stack §5.4.
- **Build sequencing** → **tracer-bullet slice first** (upload → embed → retrieve → provenance → abstain); validate the **embedding model** on real data before committing (the #1 one-way door); test **RBAC adversarially** the moment retrieval exists.

**Open (the genuinely undecided):**

None outstanding. Remaining questions are operational tuning (reranker selection, per-connector latency/rate budgets, backfill cost ceilings) — set against real pilot data, not design holes.

---

*This brief and the prototype are in sync as of the date above. Natural next steps: (a) run agency scenarios — new-hire week one, partner's sabbatical, "what do we know about Client X," someone resigns — to pull out behaviours and resolve the open questions; or (b) move from this brief into the PRD and tech-stack / scaffolding.*
