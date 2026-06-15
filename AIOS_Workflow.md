# AIOS — Build Workflow (per issue)

*The loop for building this repo, issue by issue. Two sessions, three things you ever say. Companions: `AIOS_Review_Partner.md` (the reviewer role), `AIOS_QA_Playbook.md` (the verification discipline), `CLAUDE.md` (the standing rules).*

## Two sessions, two roles
- 🔵 **Build session** — Claude Code in the repo. Writes the code. Auto-loads `CLAUDE.md`.
- 🟣 **Review session** — a separate Opus chat. The adversarial reviewer/advisor. Start it **once** with:
  `Be my review partner per AIOS_Review_Partner.md`

## One-time setup
- Set the model: `/model opus`, then `/fast` (both persist across sessions).
- By issue **#7**: install Docker + the Supabase CLI + `supabase login` (the issue reminds you when).

## The per-issue loop
1. 🟣 **Review session** → say: `generate the build command for #N`
2. 🟢 **You** → copy its output, paste into the 🔵 build session.
3. 🔵 **Build session** → plans the issue (hard ones) and stops, or builds straight (trivial ones).
4. 🟢 **You** → copy the plan, paste into the 🟣 review session.
5. 🟣 **Review session** → "approved" or a list of fixes to fold in.
6. 🟢 **You** → paste the review back into the 🔵 build session ("approved, proceed" or the fixes).
7. 🔵 **Build session** → builds **test-first**, then stops before committing and shows the result.
8. 🟢 **You** → copy the result, paste into the 🟣 review session.
9. 🟣 **Review session** → confirms it's safe to commit, or lists fixes (loop 6–8 if needed).
10. 🔵 **Build session** → commits as one clean `#N` commit, then `git push`.
11. 🟣 **Review session** → after the final OK, **closes the issue itself** (`gh issue close N`) and confirms **CI is green on the push** (both lanes — and that any new `*.real.test.ts` actually *ran*: the file count must bump). Don't delegate the close — a delegated one silently dropped #8.
12. **Fresh 🔵 build session for the next issue.** Start each issue in a clean build chat — a session carried across several issues degrades ("the 250k dumbzone"; #10 was built degraded). Everything it needs is in the repo + the command, so nothing's lost. (Run two builds in parallel only for genuinely independent slices in different subsystems via `git worktree` — never two 🔒 issues.)

## After every milestone (M0, M1, …) — the boundary ritual
🟣 In the review session: run the **milestone gate** (per `AIOS_QA_Playbook.md`) — end-to-end behaviour works, leak fixtures green, an adversarial review, one real scenario driven through it. **Don't start the next milestone until it's green.** Then:
- **Refresh both sessions** — the review session has accumulated too; start a fresh one (it reloads from the repo/memory).
- **Write a handover** (`AIOS_Handover_<milestone>.md`) — a "resume here" state snapshot (closed/open, live seams, deferred tripwires, next milestone's first move).
- **Boot the demo** (`pnpm ask`) — actually *feel* what the milestone built before moving on; it's the behavioural-grill half of the gate.

## Tips
- Tell the build session to **`git push` after each commit** (it commits locally otherwise — the remote drifts).
- Hitting Max usage limits? **⚙️ plumbing issues** can drop to `/model sonnet` (the issue's Model line notes which) — otherwise stay on Opus.
- **Lost the review chat?** Start a fresh one with `Be my review partner per AIOS_Review_Partner.md` + the latest handover. Nothing's lost — the standards live in the repo.
- **Reviewer grounds in the real code** — read the actual files + run the gate yourself; never approve off a build summary (it can lie at high context).
- **Golden rule:** never let the build session commit until the 🟣 review session has seen the result.

---

*The whole point: nothing critical lives in one chat. Delete or compact any session freely — the docs, the issues, the primer, and git history carry the state.*
