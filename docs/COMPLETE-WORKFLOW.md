# WorktreeProof Complete Workflow (L99 + Ultra + Plugins + Skills)

> **One workflow, zero gaps.** This is the single authoritative end-to-end
> process for every WorktreeProof lane, session, and release. It combines the
> L99 discipline (immutable contracts, terminal-only evidence), the Ultra/free
> model routing profile, the OpenCode plugins (Chrome, Computer, Goal/Plan,
> WorktreeProof CLI), and the curated skill stack (Superpowers, Anthropic
> official, Vercel official, OpenAI Codex, WorktreeProof skills).

## 0. The invariant

Every item of work goes through the same loop, no exceptions:

```
GOAL → CONTRACT → PLAN → RESERVE → RUN → EVIDENCE → REVIEW → MERGE → RELEASE → LAUNCH
```

Progress is **terminal-only**: `terminalClosed / terminalTotal`. Plans,
branches, commits, tests without a named acceptance gate, and commentary are
**zero progress**. No invented percentages, no invented ETAs
(`FORECAST_UNAVAILABLE` unless the owner explicitly asks and ≥3 comparable
gates exist).

---

## 1. Skill map (which skill for which phase)

| Phase | Skill(s) to load/use |
|---|---|
| Goal intake / ideation | `superpowers:brainstorming`, `vibe-to-verified` |
| Planning / decomposition | `superpowers:planning`, `superpowers:executing-plans`, `planning-and-task-breakdown`, `safe-parallel-delegation` |
| Implementation (build lane) | `superpowers:test-driven-development`, `incremental-implementation`, `worktree-proof`, `worktree-proof-stack` |
| Debugging / failure | `superpowers:debugging-with-context`, `debugging-and-error-recovery`, `doubt-driven-development` |
| Code quality | `clean-code-guard`, `code-review-and-quality`, `code-simplification`, `best-practice-guard` |
| Docs / prose | `writing-guidelines` (Vercel), `docs-guard`, `documentation-and-adrs` |
| Frontend / web | `react-best-practices`, `web-design-guidelines`, `frontend-ui-engineering`, `accessibility`, `core-web-vitals` |
| Documents (docx/pdf/pptx/xlsx) | `docx`, `pdf`, `pptx`, `xlsx` (Anthropic official) |
| MCP / API / tools | `mcp-builder` (Anthropic), `api-and-interface-design`, `tool-orchestrator`, `protocol-client` |
| Security | `security-and-hardening`, `security-threat-model`, `security-best-practices` |
| Testing | `test-driven-development`, `test-guard`, `browser-testing-with-devtools` |
| CI/CD | `ci-cd-and-automation`, `github-workflow-automation` |
| Release / launch | `shipping-and-launch`, `git-workflow-and-versioning`, `deprecation-and-migration`, `omnibus-maintainer` |
| Context / token efficiency | `token-efficient-context`, `context-engineering` |
| Resources / safety | `resource-efficient-coding` |
| UI proof | `ui-proof-loop`, `screenshot` |
| Skill creation | `skill-creator` (Anthropic), `using-agent-skills` |

All WorktreeProof-owned skills (11) are always available; upstream libraries
(Superpowers, Anthropic, Vercel, OpenAI Codex, delegate-skills) are pinned in
`integrations/skill-sources.json` and installed operator-side.

---

## 2. Plugin map (which plugin for which action)

| Action | Plugin / tool |
|---|---|
| Any browser/web task | `chrome_*` tools — **ONLY the user's normal Chrome profile** (launched on port 9222 via `scripts/launch-chrome-cdp.mjs`; the profile with all logged-in accounts). Never a dedicated automation profile, guest/incognito, or logged-out Chrome. |
| Any visible desktop task | `computer_*` tools (screenshot, mouse, keyboard, windows) |
| Lane lifecycle | `wp_plan`, `wp_reserve`, `wp_run`, `wp_close`, `wp_release`, `wp_status`, `wp_validate` |
| Goal/contract/ledger | `goal_set`, `plan_create`, `task_start`, `task_done` (evidence required), `review_gate`, `review_summary` |
| Diagnostics | `wp_doctor`, `wp_capabilities`, `wp_cleanup`, `wp_leases`, `wp_tools`, `wp_recipes`, `wp_resources` |
| Interop | `wp_bridge_inbox`, `wp_manifest` |

**Boundaries (never crossed by any agent):** passwords/OTP/CAPTCHA/passkeys
(owner only), billing/account-security (owner only), live trade execution
(owner only, permanent), credentials in logs/commits/receipts (never printed).

---

## 3. Ultra + free model router profile

The Ultra workflow keeps the parent at maximum reasoning while routing work to
free/cheap helpers through the local model router:

1. Parent (`gpt-5.6-sol` / Ultra) reasons, decomposes, decides, reviews.
2. Lanes dispatch through the free model router (`opencode`, `aihubmix`,
   `zenmux`, `nvidia` free tiers) at **standard speed** — never Fast mode, no
   `service_tier: fast`, no `features.fast_mode`.
3. Helper models: Luna `max` for independent diagnosis/design; Terra `high`
   for ordinary implementation; `medium` for mechanically verifiable work;
   never `low`.
4. **Token-Free Gateway (internal helper free pool).** The local gateway at
   `http://127.0.0.1:3456/v1` (provider `gateway`, name "Token-Free Gateway")
   exposes free Claude (Sonnet 4/4.6, Opus 4/4.6, Haiku 4/4.6), GPT-4 family,
   DeepSeek Chat/Reasoner, Gemini Pro/Ultra, GLM 4 Plus/Think, and Kimi 8K/32K
   models with high/max reasoning variants. These are part of the internal
   helper free pool and are preferred for lane work when the primary free
   tiers are unavailable or a lane needs a different model family — same
   rules apply: standard speed, never Fast mode, one attempt then drop on
   failure, helpers never become authority gates.
5. NVIDIA models: **one instant attempt per model, then DROP** — never retry,
   cool down, poll, or sweep.
6. Effective helper pool = intersection of genuinely independent lane scopes
   and live resource availability (host cap observed at 12; requested 20;
   supported ceiling 24). Never create sidebar/user-visible tasks as overflow.
7. Backfill a freed slot immediately while independent items exist; idle slots
   are the failure, busy ones are not. Spawning solely to occupy capacity is a
   violation.

---

## 4. The L99 lane lifecycle (every lane)

1. **Contract (immutable).** `goal_set` with one outcome, named terminal gates,
   fixed `terminalTotal`, allowed scope, authoritative baseline SHA, deadline
   or `none`. Frozen before the first mutation. Changing it = new contract,
   new identity.
2. **Plan.** `plan_create` with non-overlapping tasks; every task carries a
   named terminal acceptance condition and concrete scope.
3. **Reserve.** `wp_reserve --scope <relative> --dry-run` to preview, then
   `--dry-run false` to reserve. Duplicate IDs, overlapping scopes, and unsafe
   paths fail closed.
4. **Run.** `wp_run` with argv (no shell), bounded/redacted output, timeout.
5. **Evidence.** `wp_close` with an explicit receipt; `task_done` only with
   terminal evidence. No evidence = no close.
6. **Review.** `review_gate` (all tasks done + evidence) then `review_summary`
   (`terminalClosed/terminalTotal`, `FORECAST_UNAVAILABLE`).
7. **Merge.** One PR per gate advance; name the gate in the PR description.
   Merge only with CI/CodeQL/dependency-review green; record
   `git rev-parse origin/main` plus public check URLs.
8. **Cleanup.** `wp_cleanup` inventory; delete superseded branches/worktrees in
   the same session. Never `--force` a dirty checkout — preserve for bounded
   rescue.
9. **Activity log.** Every merge/deploy/mutation gets its own row in
   `docs/agent-activity-log.md`, shipped in the same commit.

---

## 5. Safety gates (fail closed, every time)

- **SAFE-3 circuit breaker** at the lifecycle entry point: every normal
  `agent:worktree` call needs a current `--circuit-breaker-json`; missing,
  malformed, or tripped state fails closed before branch/worktree creation.
- **F13 no-output breaker:** at 40 tool calls since the last terminal closure
  with zero closures, freeze new spawns/backfill, secure or abandon dirty
  work, report zero plus one blocker, end the turn.
- **F1 no silent wait:** never hold a turn waiting on a reply that may never
  come; write one `TRUE BLOCKER / OWNER ACTION REQUIRED` line and stop.
- **F2 no retry loops:** 3 strikes on the same error class → fix the
  parameter, skip, or report; never a fourth retry.
- **F6 bounded spend:** > ~1M tokens or > ~40 tool-call cycles without a
  committed artifact → STOP and report.
- **F11/F12 truth:** one frozen contract, one goal; progress is
  `terminal_closed/terminal_total` with named gates and concrete evidence;
  deadlines are immutable (`MISSED` never reset).

---

## 6. Release checklist (per version)

1. `npm run check` (lint + 188 tests) green on `origin/main`.
2. `npm run eval` (9 seeded fail-closed checks) green.
3. `npm run benchmark` emits schema-conformant output.
4. `npm run release:integrity` (SBOM + checksums + manifest + provenance).
5. Clean-install proof: fresh `npm install <pkg>@<version>` on Node 20/22/24,
   full lifecycle `plan→reserve→run→close→release→validate` → `valid:true`.
6. Activity-log row for the release.
7. Tag, release workflow, verify registry/release metadata, record URLs.

---

## 7. Launch checklist (OSS visibility)

1. Verify release URL, license (Apache-2.0), local-first privacy boundaries,
   and limitations.
2. Draft destination-specific messages (HN Show HN, r/ClaudeAI,
   r/ChatGPTCoding, r/opensource, r/node, r/SideProject, dev.to, X).
3. Every draft: names what was built, tested capabilities, Apache-2.0,
   privacy, limitations, release link; no vote/star begging, no manufactured
   engagement, no false claims (honest metrics: 0 stars/0 downloads are fine).
4. Post once per destination through logged-in owner accounts; capture public
   URLs and timestamps only.
5. Record in activity log; popularity is an observed metric, never an
   acceptance claim.

---

## 8. Definitions of done

| Gate | Evidence |
|---|---|
| Lane closed | `wp_close` receipt + `review_gate` ready + merged to `origin/main` |
| Goal closed | All plan tasks `done` with evidence; `terminalClosed = terminalTotal` |
| Release closed | Tag + npm + GitHub artifacts + SBOM + checksums + provenance + install proof |
| Launch closed | Public post URLs + timestamps, redacted |

## 9. The no-gap audit (run this checklist before declaring any goal done)

- [ ] One immutable contract exists (`goal_set`) with fixed denominator
- [ ] Plan exists with named gates and scopes (`plan_create`)
- [ ] Every task is either pending, in_progress, done-with-evidence, or blocked
- [ ] No overlapping scopes, no duplicate lane IDs
- [ ] Every `done` task has explicit terminal evidence (`task_done`)
- [ ] `review_gate` returns ready
- [ ] Merge landed on `origin/main`, `git rev-parse origin/main` recorded
- [ ] CI/CodeQL/dependency review green on the merge commit
- [ ] Superseded branches/worktrees deleted in-session
- [ ] Activity-log row exists for merge/deploy/mutation
- [ ] No credentials, secrets, or private paths in commits/logs/receipts
- [ ] `FORECAST_UNAVAILABLE` unless explicitly authorized forecast exists
- [ ] No daemons, schedulers, or standing monitors were created
- [ ] Release (if any) verified from a clean install, SBOM/checksums recorded
- [ ] Launch messages (if any) disclose affiliation, license, limitations
