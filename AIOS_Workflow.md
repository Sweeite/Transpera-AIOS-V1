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
11. **Repeat** for the next issue.

## After every milestone (M0, M1, …)
🟣 In the review session, run the **milestone gate** (per `AIOS_QA_Playbook.md`): end-to-end behaviour works, leak fixtures green, an adversarial review, one real scenario driven through it. **Don't start the next milestone until it's green.**

## Tips
- Tell the build session to **`git push` after each commit** (it commits locally otherwise — the remote drifts).
- Hitting Max usage limits? **⚙️ plumbing issues** can drop to `/model sonnet` (the issue's Model line notes which) — otherwise stay on Opus.
- **Lost the review chat?** Start a fresh one with `Be my review partner per AIOS_Review_Partner.md`. Nothing's lost — the standards live in the repo.
- **Golden rule:** never let the build session commit until the 🟣 review session has seen the result.

---

*The whole point: nothing critical lives in one chat. Delete or compact any session freely — the docs, the issues, the primer, and git history carry the state.*
