# AIOS — First-Client Readiness Checklist

*The gate between **"all 52 build issues are done"** and **"I can onboard paying client #1 and take their money."***

The 52 issues give you a feature-complete **engine + client-facing surface**. They do **not** by themselves make a sellable, live-with-a-paying-client product. This doc is everything *else* a real sale needs. **Run it AFTER the build, BEFORE the first contract.** Most of the gap is deferred *on purpose* (synthetic data can't tune the brain; you operate multi-client ops yourself early) — not forgotten.

**Companions:** `AIOS_Operations.md` (the live tripwire log + onboarding runbook — several items here mirror tripwires there) · `AIOS_Brief.md` (the spine) · `AIOS_QA_Playbook.md` (how you prove each piece) · `AIOS_Issues.md` (the build).

---

## How to read this

Three tiers — the tier is the decision, not the effort:

- 🔴 **BLOCKER** — cannot take money / cannot go live without it.
- 🟡 **MANUAL-OK** — genuinely needed, but you can do it *by hand* for the first 1–3 clients. Do **not** build the automation yet.
- 🟢 **SCALE** — defer until ~3–5 clients, or until a specific deal demands it.

**The headline:** 52 issues done = **design-partner-sellable** (white-glove, you operate it, you tune on their real data). The 🔴 items below = the gate to actually take money. The 🟢 items = the second lap to **scale-sellable**.

---

## 1. The product is actually *tuned* (not just feature-complete)

The build proves quality on **synthetic** data. Real quality is only proven on the client's real content. These fire **at** first client (mirrors the `AIOS_Operations.md` tripwire table):

- [ ] 🔴 **Finalize the embedding pin.** Run the bake-off (`tests/eval/embedding-bakeoff/`) on the client's *real, de-identified* content. Pick the winner, finalize model + dim + dtype, bump `EMBEDDING_VERSION` off `0-provisional`, write the **final** ADR 0001. **Do this BEFORE backfill fills the index** (changing it later = full re-embed, not a flag). `→ #1, #43`
- [ ] 🔴 **Re-derive the abstention floor** (`retrieval_min_relevance`) on their real vectors — synthetic data saturates (~100%) and can't set a real floor.
- [ ] 🟡 **Decide int8/binary quantization** and re-derive the floor on the *quantized* vectors you'll actually ship. `→ #3`
- [ ] 🔴 **Run the leak fixtures (#36) against THEIR org shape** — their real zones / namespaces / sensitivity levels, not just the test fixtures. RBAC correct for their actual structure is the red line.
- [ ] 🔴 **Non-English check** — if their content isn't English, re-confirm the embedding model handles their language (it's a selection criterion; may change the pin). `→ #1`

## 2. Connected to *their* stack (per-client integration — recurs every sale)

The connector **framework** is built by the 52; wiring each client's actual tools is integration work **per sale**.

- [ ] 🔴 **Map their systems of record.** For each fact type, what is the SoR? (The spine rule: materialise to memory only if it's *not* a live field in an SoR.)
- [ ] 🔴 **Wire the connectors** for their live tools (CRM, PM, comms, docs) — auth, schema mapping, and the **`trust_level` per connection** (anti-poisoning depends on it being stamped at routing time).
- [ ] 🔴 **Cold-start backfill plan** — bounded + rate-limited. What historical content seeds the brain, and in what order?
- [ ] 🟡 **Schema-drift monitors** pointed at their live SoRs (alert when a connector's schema diverges from what we mapped).

## 3. Commercial + legal (none of this is in the 52 — it's not engineering)

- [ ] 🔴 **Contract / MSA + SOW** — the **$15k upfront + $3.5k/month** terms in writing.
- [ ] 🔴 **Data Processing Agreement (DPA)** — you're handling their data *and* their clients' data. Agencies will need this.
- [ ] 🔴 **Billing mechanics** — how you invoice upfront + monthly. **Their own API + infra accounts** (Anthropic/OpenAI/Supabase/Railway) set up under their billing — they pay those directly; that's the ~pure-labor-margin model.
- [ ] 🟡 **Define the $3.5k/month** concretely — support hours, SLA, what's in-scope vs change-request.

## 4. Provision + operate (you are the operator early)

The **operator/agency console (`apps/console`) is deferred** — until it exists you run multi-client ops by hand/CLI.

- [ ] 🔴 **Provisioning runs end-to-end** — own Supabase + Railway + pgmq per client, every migration applied (expand/contract), plugin loaded, clearance seeded. `→ #39, #40`
- [ ] 🔴 **Per-client secrets isolation** — their keys + DB URLs, segregated, no cross-tenant path. (Isolation layer 1 is physical — keep it that way operationally too.)
- [ ] 🔴 **Alerting wired** — monitor heartbeats, the dead-man's-switch watchdog, fleet health. **You** get paged, not the client. (No silent failure — the red line — extends to ops.)
- [ ] 🔴 **Backups + restore tested** on their Supabase (don't discover restore is broken during an incident).
- [ ] 🟡 **Onboard their *users*** — assign real people to roles / zones / clearances (the RBAC built in #9).
- [ ] 🟡 **Re-enable `enforce_admins`** on the repo's `main` branch protection (it's off for the solo build phase — see the `AIOS_Operations.md` tripwire).

## 5. The product *feels* finished (UX)

- [ ] 🔴 **Chat feels like Claude/ChatGPT** — streaming, history, sensible empty / error / loading / "source unavailable" states. (You explicitly flagged not wanting it to feel dumb or unfinished.)
- [ ] 🟡 **Inspector + inbox + traces** are usable by a *non-technical agency user*, not just you.
- [ ] 🟢 **Mobile / accessibility** pass.

## 6. Scale-only — explicitly defer

- [ ] 🟢 **Operator/agency console (`apps/console`)** — manage all clients from one UI (fleet health, per-client billing). Operate by hand until ~3–5 clients.
- [ ] 🟢 **SOC 2 readiness** — start at ~5 paying clients or the first enterprise prospect that asks. (Railway's posture is thin; fine for the initial ICP.)
- [ ] 🟢 **Self-serve / automated onboarding** — only once the manual runbook is boring and repeatable.

---

## The one-line answer

**52 issues done → design-partner-sellable.** Clear the 🔴s → you can take money and go live. Operate the 🟡s by hand for the first few clients. Don't build the 🟢s until a third client or a real deal forces them. Given your ICP (high-touch agencies), the deferred console matters *less* early — the **per-client tuning (§1) and connector wiring (§2) are the real recurring "between feature-complete and live" work**, and they repeat every sale.

*Living doc — when the build closes an item here, check it off; when a real onboarding teaches you a missing one, add it. This is the readiness gate, not the build plan (`AIOS_Issues.md` is the build).*
