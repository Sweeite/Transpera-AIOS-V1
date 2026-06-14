# AIOS — Operations Runbook

*How we **run** the business, not build the engine. Client onboarding, ingestion, ongoing maintenance — and the "do this when X happens" tripwire log so deferred decisions never slip.*

This is a **living doc.** Many steps are built by specific issues (marked `→ #N`); they fill in as the build completes. The **Deferred Decisions** table below is live and useful *today*.

---

## ⏳ Deferred decisions & tripwires (the "do X when Y" log)

Things we consciously postponed during the build, each with the trigger that means "do it now." **Check this list at every onboarding and every milestone.**

| Trigger | What to do | Why deferred | Ref |
|---|---|---|---|
| **First client onboarding** | **Finalize the embedding pin.** Run the bake-off (`tests/eval/embedding-bakeoff/`) on the client's real de-identified content. Pick the winner, finalize model + dim + dtype + the abstention floor, bump `EMBEDDING_VERSION` off `0-provisional`, write the *final* ADR 0001. | Synthetic data saturates (both models scored ~100%) — it can't pick a winner. The choice only becomes irreversible once real data is filed. Today's OpenAI pick is a **provisional placeholder**. | #1 → #43, `gateway.ts` |
| **First-client bake-off** | Decide **int8/binary quantization** (RAM saving) and re-derive the floor on the *quantized* vectors you'll actually ship. | We started un-quantized (`float`) to keep it simple. | #3 |
| **When the reranker ships (#14)** | **Re-derive `retrieval_min_relevance`** — the reranker uses a different score scale, so the current floor is invalid for it. Not a reuse, a recalibration. | Reranker isn't built yet. | #14 |
| **First client with non-English content** | Re-check the embedding model handles their language (a selection criterion); may change the pick. | Assumed English v1. | #1 |
| **First client (or any second contributor to the repo)** | **Re-enable `enforce_admins` on `main`'s branch protection:** `gh api -X PUT repos/Sweeite/Transpera-AIOS-V1/branches/main/protection/enforce_admins`. During the solo build phase admin enforcement is OFF (the required checks `[hermetic, real-postgres]` still run and go red, but the admin can push straight to main) to keep the per-issue loop fast. Once real client data exists or anyone else can push, the gate must actually *block* — not just go red. (Capability proven via PR #53; #51.) | A PR-per-issue loop ~2–3× slows a solo 50-issue sprint; the integrity payoff is small when you're the only actor and you watch CI. | #51 |
| **A client's memory/chunk corpus grows large** | Size that client's Supabase compute so the HNSW index fits in RAM; watch index size as a health metric. | pgvector HNSW is RAM-hungry; small tiers swap and retrieval silently slows. | tech-stack §5.2 |
| **~5 paying clients, or first enterprise prospect asking** | Start **SOC 2 readiness**; consider a SOC2-credible compute host per-client where a deal requires it. | Railway's compliance posture is thin; fine for the initial ICP. | tech-stack §5.2 |
| **A client needs point-in-time recovery** | Enable **PITR** (paid Supabase add-on) for that client; it's a priced tier, not default. | Keeps the small-client floor low. | tech-stack §5.4 |

*Add a row whenever the build defers something to "later" — this is the memory for that.*

---

## 🚀 Client onboarding runbook (per new client)

The end-to-end of standing up a new client brain. Copy this checklist per client.

```
ONBOARDING — <client name>   ·   started ____   ·   live ____
```
1. **Commercial** — contract signed; $15k setup invoiced; data-processing terms agreed; sub-processor list shared (Supabase, Railway, OpenAI/Voyage). `→ pre-product`
2. **Provision infra** — run `provision-client` (Supabase project + Railway service + migrations + seed config), idempotent/resumable, region chosen for residency. `→ #39, #6`
3. **First admin + RBAC** — create their first admin user, seed full clearance so the brain isn't locked out of itself; define their **zones** (general/finance/hr/legal/exec or client-team) and who sits where. `→ #47, #9`
4. **Connect integrations** — wire their tools (email, Slack/Teams, Drive, CRM, accounting, calendar). Tag each: org-wide vs per-user, structured vs unstructured, trust level. Store creds in *their* Supabase Vault. `→ #20, #41`
5. **Do-not-ingest + sensitivity** — set exclusions (HR mailbox, /Legal, #personal), sensitivity defaults (esp. meeting recordings + consent). `→ #17`
6. **Seed entities** — pull their clients/projects/people/vendors from connected SoRs into the Identity Map → the brain answers *live* from day one even with zero memory. `→ #16, #43`
7. **★ Finalize the embedding pin** (the deferred decision — see tripwire table) — bake-off on their real de-identified content, pin for real, bump version. **Do this before backfill fills the index.** `→ #1, #43`
8. **Bulk backfill** — bounded historical ingest (`coldstart_backfill_days`), into chunks/episodic only (no cold semantic auto-promote), throttled under a cost ceiling. `→ #43`
9. **Guided knowledge capture** — interview their key people; capture SOPs, top-client context, decisions + why → straight into procedural/semantic memory. The fastest path to "I know this." `→ #43`
10. **Verify (QA before handover)** — run the QA Playbook scenario battery *with their data + roles*: honest answers, no leaks across clearances, abstention fires, federation works. `→ AIOS_QA_Playbook.md`
11. **Train + hand over** — show their team the chat front door, provenance labels, the inbox; set up fleet alerting for their instance. `→ #42`

> Until features #39/#43/#47 exist, early clients are onboarded **semi-manually** following these same steps — that's expected, and it's what the $15k setup pays for.

---

## 🔌 Ingestion & connections (how their stuff gets in)

- **Two ownership tiers:** org-wide connections (one shared CRM/Slack) and per-user (personal Gmail/Drive). Scope ≠ visibility — each user only ever sees what their clearance allows.
- **Every connector is tagged:** structured (CRM/accounting — fields fetched *live*, never copied) vs unstructured (email/docs — interpretive), and a **trust level** (low-trust inbound email can't become trusted "I know this" memory without corroboration).
- **The routing gates decide** what's dropped, fetched-live, indexed, or remembered — automatically, per the spine rule. The operator's job is configuring *which* connections exist, the do-not-ingest list, and sensitivity defaults.
- **Manual upload** is always available — drop in SOPs/docs to bring the brain up to speed fast.

---

## 🔁 Ongoing maintenance (the recurring work — what the $3.5k/mo buys)

**Daily / on-alert**
- [ ] Watch **fleet alerts** (dead worker, backed-up queue, failed connector) — fix before the client notices. `→ #42`
- [ ] Triage **System Health** failures (failed jobs, LLM API errors, connector last-sync).

**Weekly**
- [ ] **Quality Monitor** — abstention/miss/low-rated trends, memory-utility distribution. A *sudden drop* in abstention is suspicious (silent degradation), not a win. `→ #32`
- [ ] **Drain the review queues** — memory proposals, consolidation reviews, "consider broadening?" sensitivity flags.
- [ ] **Approve/reject self-improvement suggestions** (judged by eval fixtures, not vibes). `→ #33`
- [ ] **Cost check** — the client's API + infra bill; flag surprises (their pass-through, but their satisfaction).

**Per release / as needed**
- [ ] **Migrate the fleet** — `migrate-all` (expand/contract; halts deploy to un-migrated clients), then `deploy-all`. `→ #40`
- [ ] **Rotate secrets** on schedule or on any leak suspicion. `→ #41`
- [ ] **Verify backups / PITR** actually restore (an untested backup is a liability).
- [ ] **Grow the eval + leak fixtures** from any real miss or close call — the corpus only grows. `→ AIOS_QA_Playbook.md`
- [ ] **Adversarial review** after any meaningful change (same hostile method as the build audit).

**Watch-the-watchers** — confirm the monitors themselves are alive (dead-man's switch, embedding-drift canary). A dead monitor is the silent failure that hides all the others. `→ #45`

---

## 🎚️ Strictness tuning (trustworthy ↔ helpful) — a per-client dial, not a switch

The brain leans conservative by default (a confident *wrong* answer is worse for a business than "I don't know", §3) — but "too strict" feels dumb. It is a **slider**, tuned per client, never by gut.

**It already has three modes, not two** — the middle one is the "try to help, honestly" path:
- **"I know this"** — grounded in memory, sourced.
- **"General inference"** — it reasons/cobbles a take, **clearly labelled** as inference (not a business fact). This is the anti-dumb mode; M0 ships it nearly off, later milestones open it up.
- **Abstain** — only when there's genuinely nothing useful.

**The answer policy is graceful degradation, not refusal:** ground it if possible → else offer a reasoned take (marked inference) → else show what the **live systems** say (federation) → else "want me to capture an answer?". It always tries to be useful; it's just transparent about which rung it's on.

**The dials (all tunable, scoped per client via `system_config`, gated + audited):**
- `retrieval_min_relevance` (the floor) — lower = tries harder on weaker matches; higher = stricter. The primary knob.
- The synthesis **prompt** — tight = extractive/strict; loose ("offer reasoned suggestions from these sources, marked inference") = more willing to cobble.
- The **inference allowance** — how freely it adds reasoned-but-unsourced takes.
- **Model routing** (`→ #10`) — a stronger model cobbles *intelligently* when allowed.

**Tune against eval fixtures, not vibes (`→ #32/#33`).** Build fixtures that encode *both* failure modes — "must NOT invent a business fact" AND "SHOULD helpfully infer here" — and move the dials until both pass. The self-improvement loop watches the balance live: abstention rate (rising = honest), miss rate (too strict), low-rated-answer rate (too loose), and *proposes* floor/prompt changes when it drifts. Conservative client → higher floor; "move fast" client → lower floor + more inference. Same engine, different dial.

> Where the real intelligence lands (so it doesn't stay flat Q&A): strong-model routing (#10, M1), live-data blending (#23, M4), and the **agent layer that decomposes a goal into multi-step work** (#26/#27, M5 — the librarian→analyst leap). The M0 "flat Q&A" feel is the trustworthy *floor*, built first on purpose; the reasoning is layered on top.

---

## 🗂️ Per-client record (copy one per client)

```
## <Client name>
- Provisioned:        <date>  ·  region: ____  ·  Supabase project: ____  ·  Railway service: ____
- First admin:        <name/email>
- Zones in use:       general / finance / hr / legal / exec / <client-team>
- Connections:        <CRM, email, Slack, Drive, accounting, calendar, meeting-bot...>
- Do-not-ingest:      <sources excluded>
- Embedding pin:      model ____  dim ____  dtype ____  version ____  (ADR link)
- Floor:              retrieval_min_relevance = ____  (derived on their data)
- Config overrides:   <any per-client system_config values>
- PITR / compliance:  <on/off, notes>
- Onboarded by:       ____   ·   Notes: ____
```

---

## What the $3.5k/month covers (your recurring deliverable)
Keeping their brain **healthy, honest, and not leaking**: watching quality + silent-failure signals, draining review queues, approving improvements, shipping core updates safely across the fleet, rotating secrets, verifying backups, and growing the guardrails. The reliability *is* the product — it's what they're paying you not to have to think about.

---

*Living doc — add a tripwire when the build defers something; add a maintenance item when ops teaches you one. Companions: `AIOS_Issues.md` (build), `AIOS_QA_Playbook.md` (verify), `AIOS_Brief.md` (the spine).*
