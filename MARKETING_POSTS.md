# WorktreeProof Marketing Posts — Ready to Paste

> **Use these from YOUR logged-in accounts** (Reddit, HN, dev.to, X). I cannot post for you — login/CAPTCHA/submission are owner boundaries.

---

## 1. Hacker News — "Show HN"

**Title:** Show HN: WorktreeProof — Evidence-backed guardrails for AI coding agents

**URL:** https://github.com/Nedal7707/worktree-proof

**Text (optional, HN allows text posts too):**

I built WorktreeProof because I was tired of AI agents making changes without a trace. It's a local-first toolkit that gives every agent lane:

- **Plan** → one named scope + target check
- **Reserve** → conflict-aware worktrees with bounded leases
- **Run** → commands executed without shell, output redacted
- **Close** → a JSON receipt that validates terminal evidence

No coordinator, no account, no telemetry. Just deterministic scope checks and closure receipts you can actually read.

v0.3.4 just released: 9 seeded fail-closed evals, green CI (Node 20/22 × linux/windows), SBOM + provenance per release, clean-install verified on Node 20/22/24.

Honest status: 5 days old, 0 stars, 0 downloads. But the engineering is rigorous — immutable task contracts, SAFE-3 circuit breakers, fixed terminal ledgers. If you manage AI coding agents (Codex, Claude Code, Cursor), this is the guardrail layer I wish existed.

Docs: https://nedal7707.github.io/worktree-proof/
npm: `npm i -g github:Nedal7707/worktree-proof#v0.3.4`

---

## 2. Reddit — r/ClaudeAI

**Title:** I built a tool that makes AI coding agents show their work — WorktreeProof v0.3.4

**Body:**

Been using Claude Code / Codex heavily and kept hitting the same problem: agents make changes, but there's no structured trail of *what* they did, *why*, and *what passed*. So I built WorktreeProof.

It's not another agent — it's a **guardrail layer** you wrap around any agent:

```
plan → reserve → run → close (with receipt)
```

Each lane gets a unique ID, non-overlapping file scope, bounded lease, and a JSON closure receipt that validates what actually passed (tests, lint, UI review notes — whatever you ran).

**What's different:**
- Local-first, zero runtime deps, no telemetry
- Fail-closed CLI (try `worktree-proof run` without a reservation → clean error)
- 9 seeded eval scenarios that *must* pass (CI gates on them)
- Worktree Proof Workflow V3 spec (immutable contracts, circuit breakers, crash recovery)
- Portable Agent Skills for Codex + Claude Code

**Honest status:** 5 days public, 0 stars, 0 npm downloads. But the release discipline is real: 5 releases in 5 days, SBOM/checksums/provenance per release, green CI matrix.

If you're building agent workflows and want evidence over vibes: https://github.com/Nedal7707/worktree-proof

Happy to discuss the architecture (clean separation: proof domain independent of Git/shell adapters) or the eval design.

---

## 3. Reddit — r/ChatGPTCoding

**Title:** WorktreeProof — scoped, evidence-backed guardrails for Codex/Claude agents

**Body:**

If you use Codex, Claude Code, or Cursor for coding: you know agents move fast but leave messy trails. WorktreeProof adds a thin, local-first layer that forces:

1. **Plan** — one named scope + acceptance check
2. **Reserve** — conflict-free worktree + bounded lease
3. **Run** — your commands (no shell, output bounded/redacted)
4. **Close** — JSON receipt validating terminal evidence

No cloud, no account, no telemetry. The proof domain is independent of Git/shell/browser adapters (clean architecture).

v0.3.4: 9 fail-closed evals, clean-install verified Node 20/22/24, SBOM+provenance per release.

GitHub: https://github.com/Nedal7707/worktree-proof
Docs: https://nedal7707.github.io/worktree-proof/
npm: `npm i -g github:Nedal7707/worktree-proof#v0.3.4`

Also includes portable Agent Skills for Codex + Claude Code — same `.worktree-proof/` state, neither invokes the other.

---

## 4. Reddit — r/opensource

**Title:** New OSS project: WorktreeProof — guardrails for AI coding agents (evidence-gated, local-first)

**Body:**

Released WorktreeProof v0.3.4 — an open-source toolkit for making AI coding-agent work scoped, inspectable, and verifiably closed.

**Core loop:** `plan → reserve → run → close` with a closure receipt that validates terminal evidence (tests, lint, UI review, whatever you ran).

**Why this exists:** AI agents are powerful but opaque. This adds deterministic boundaries: lane IDs, non-overlapping file scopes, bounded leases, fail-closed circuit breakers, and a fixed terminal ledger (progress = closed gates / total gates only — no invented percentages).

**Release hygiene:** 5 releases in 5 days, each with SBOM (CycloneDX), SHA256SUMS, release manifest, npm provenance. CI: Node 20/22 × ubuntu/windows, CodeQL, Dependency Review, Pages.

**Honest adoption:** 0 stars, 1 fork, 0 downloads (5 days old). But 6 policy-compliant upstream PRs submitted across 5 orgs (vercel-labs, anthropics, MCP registry, github, delegate-skills).

Apache-2.0. Local-first, model-agnostic, zero runtime deps.

Repo: https://github.com/Nedal7707/worktree-proof

---

## 5. Reddit — r/node

**Title:** WorktreeProof v0.3.4 — local-first CLI for scoped AI agent work (Node 20+, zero deps)

**Body:**

Built a Node.js toolkit that wraps AI coding agents (Codex, Claude Code, etc.) with evidence-backed guardrails:

- `plan` — describe the lane: scope, target check, intent
- `reserve` — creates isolated worktree, checks for conflicts
- `run` — executes your argv (no shell), captures bounded output
- `close` — validates a JSON receipt against closure schema
- `validate` — reads state without mutating

**Tech:** ES modules, Node ≥20, `node --test` only (188 tests), no external test runner. CI matrix: Node 20/22 × ubuntu/windows. Release automation: SBOM, checksums, provenance, npm publish.

**Also:** Agent Skills (portable prompts for Codex/Claude), MCP stdio server, Codex↔Claude bridge for bounded task handoffs.

npm: `npm i -g github:Nedal7707/worktree-proof#v0.3.4`
Source: https://github.com/Nedal7707/worktree-proof

---

## 6. Reddit — r/SideProject

**Title:** Side project: WorktreeProof — making AI agents show their receipts

**Body:**

Spent the last 5 days building and releasing WorktreeProof — a guardrail layer for AI coding agents. The idea: every agent lane should have a beginning, a safe surface, and a verifiable end with a receipt.

**What it does:**
- Reserves non-overlapping worktrees for parallel agent lanes
- Runs your checks (tests, lint, UI review) without shell injection
- Produces a closure receipt: what changed, what passed, what remains
- All local, no telemetry, no account needed

**Releases:** v0.1.0 → v0.3.4 in 5 days. Each release has SBOM, checksums, provenance. CI green on Node 20/22 × linux/windows + CodeQL.

**Honest metrics:** 0 stars, 0 downloads. But the engineering is the product — immutable task contracts, SAFE-3 circuit breakers, fixed terminal ledgers.

If you manage AI agents and want evidence over vibes: https://github.com/Nedal7707/worktree-proof

---

## 7. dev.to Article

**Title:** Vibe Fast, Ship with Proof: Building Guardrails for AI Coding Agents

**Tags:** `ai` `coding` `agents` `opensource` `node` `cli` `productivity`

**Body:**

---

### The problem

AI coding agents (Codex, Claude Code, Cursor, etc.) are incredibly fast. But they're also opaque. They make changes, run tests, maybe pass — but there's no structured, verifiable trail of *what* they did, *what scope they touched*, and *what actually passed*.

I've watched agents:
- Edit files outside the agreed scope
- Claim "tests pass" when they didn't run the right suite
- Leave no receipt when a lane closes
- Collide silently with parallel lanes

### The solution: WorktreeProof

WorktreeProof is a **local-first guardrail layer** you wrap around any AI coding agent. It enforces a simple, evidence-backed loop:

```
plan → reserve → run → close
```

**Plan** — One named lane, explicit file scope, named acceptance gate(s).
**Reserve** — Creates an isolated Git worktree, checks for conflicts, issues a bounded lease.
**Run** — Executes your commands as argv (no shell), captures bounded/redacted output.
**Close** — Validates a caller-supplied JSON receipt against a closure schema. The receipt *must* contain terminal evidence (test output, lint results, UI review notes, etc.). No evidence = no close.

That's it. No cloud, no account, no telemetry, no runtime dependencies.

### What makes it different

1. **Immutable task contracts** — Before the first mutation, the lane's outcome, gates, baseline SHA, scope, and deadline are frozen. Changing them = new contract, new identity.
2. **SAFE-3 circuit breaker** — At 40 tool calls since last terminal closure with zero closures, the lane freezes scope expansion and reports a blocker. No runaway loops.
3. **Fixed terminal ledger** — Progress = `terminal_closed / terminal_total` only. Commits, branches, PRs, tests, plans = 0 progress. Only named gates with evidence count.
4. **Clean architecture** — The proof domain (contracts, breakers, ledger) is independent of Git, shells, browsers, and providers. Adapters make external observations explicit and auditable.
5. **Fail-closed CLI** — Every mutating command validates preconditions. `run` without a reservation → `ERR_PROTOCOL`. `close` without a receipt → `ERR_MISSING_CLOSURE_RECEIPT`. No silent failures.
6. **Portable Agent Skills** — Same `.worktree-proof/` state works with Codex *and* Claude Code. Neither invokes the other.

### Release discipline

v0.3.4 (2026-08-15) is the 5th release in 5 days. Each release ships:
- SBOM (CycloneDX)
- SHA256SUMS
- Release manifest
- npm provenance attestation
- Green CI: Node 20/22 × ubuntu/windows, CodeQL, Dependency Review, Pages

Clean-install verified: `npm install worktree-proof@0.3.4` on Node 20/22/24 → full lifecycle `plan→reserve→run→close→release→validate` → `valid: true, receipts: 1`.

### Honest status

- Public since: 2026-08-10 (5 days)
- Stars: 0
- Forks: 1
- npm downloads: 0 (no data yet)
- Upstream PRs: 6 submitted across 5 orgs (3 open, 2 closed unmerged, 1 open in delegate-skills)

This is a credibility product — it only proves itself when others use it. The engineering is rigorous; the adoption is the next chapter.

### Try it

```bash
# From source (most reproducible)
git clone https://github.com/Nedal7707/worktree-proof.git
cd worktree-proof
npm ci
node bin/worktree-proof.js doctor --json
node bin/worktree-proof.js plan my-fix --scope src/ --json
node bin/worktree-proof.js reserve my-fix --scope src/ --json
node bin/worktree-proof.js run my-fix --json -- npm test
node bin/worktree-proof.js status --json
```

Or install the tag:
```bash
npm install --global github:Nedal7707/worktree-proof#v0.3.4
worktree-proof doctor
```

**Docs:** https://nedal7707.github.io/worktree-proof/
**Repo:** https://github.com/Nedal7707/worktree-proof
**npm:** https://www.npmjs.com/package/worktree-proof

### What's next

- Merge the 3 open upstream PRs (vercel-labs, anthropics, MCP registry)
- Get first external users with public evidence
- Dogfood WorktreeProof in its own maintenance (Codex review triage, release-integrity checks)

If you manage AI coding agents and want evidence over vibes, give it a spin. Feedback and focused PRs welcome.

---

## 8. X / Twitter Thread

**Tweet 1/8:**
Built WorktreeProof — a local-first guardrail layer for AI coding agents (Codex, Claude Code, Cursor). Every agent lane gets: plan → reserve → run → close with a JSON receipt that *validates* terminal evidence. No cloud, no telemetry, no account. https://github.com/Nedal7707/worktree-proof

**Tweet 2/8:**
The loop:
📋 plan — one named scope + acceptance gate
🔒 reserve — isolated worktree, conflict check, bounded lease
⚙️ run — your argv (no shell), bounded output
✅ close — receipt validates what actually passed (tests, lint, UI review)

**Tweet 3/8:**
What's different:
• Immutable task contracts (frozen before first mutation)
• SAFE-3 circuit breaker (freezes at 40 calls / 0 closures)
• Fixed terminal ledger (progress = closed gates / total only)
• Clean arch: proof domain independent of Git/shell/browser

**Tweet 4/8:**
v0.3.4: 9 seeded fail-closed evals, clean-install verified Node 20/22/24, SBOM+checksums+provenance per release, CI green (Node 20/22 × linux/windows + CodeQL). 5 releases in 5 days.

**Tweet 5/8:**
Portable Agent Skills included — same `.worktree-proof/` state works with Codex AND Claude Code. MCP stdio server + Codex↔Claude bridge for bounded task handoffs.

**Tweet 6/8:**
Honest status: 5 days public, 0 stars, 0 downloads. But 6 upstream PRs submitted across 5 orgs (vercel-labs, anthropics, MCP registry, github, delegate-skills). Apache-2.0.

**Tweet 7/8:**
Try it:
```
npm i -g github:Nedal7707/worktree-proof#v0.3.4
worktree-proof doctor
worktree-proof plan my-fix --scope src/
worktree-proof reserve my-fix --scope src/
worktree-proof run my-fix -- npm test
```

**Tweet 8/8:**
Docs: https://nedal7707.github.io/worktree-proof/
Repo: https://github.com/Nedal7707/worktree-proof
If you manage AI agents and want evidence over vibes — give it a spin. Feedback welcome.

---

## Posting Checklist

- [ ] HN: Submit "Show HN" (use your HN account)
- [ ] r/ClaudeAI: Post (your Reddit account)
- [ ] r/ChatGPTCoding: Post (your Reddit account)
- [ ] r/opensource: Post (your Reddit account)
- [ ] r/node: Post (your Reddit account)
- [ ] r/SideProject: Post (your Reddit account)
- [ ] dev.to: Create article (your dev.to account)
- [ ] X/Twitter: Post thread (your X account)
- [ ] Product Hunt: Prepare launch (optional, later)

**All posts are honest** — no inflated claims, real metrics (0 stars, 0 downloads), real engineering. That's the brand.