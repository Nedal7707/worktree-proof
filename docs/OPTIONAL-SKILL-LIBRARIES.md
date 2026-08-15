# Optional Skill Libraries

WorktreeProof may point to external Agent Skills without bundling them. The record
below describes upstream material, not WorktreeProof authorship or endorsement.

## Skill and plugin inventory (complete)

| Source | Kind | Contents |
|---|---|---|
| `amElnagdy/delegate-skills` | upstream | 13 delegation skills: `opencode-delegate`, `vibe-delegate`, `codex-delegate`, `claude-delegate`, `cursor-delegate`, `cline-delegate`, `aider-delegate`, `grok-delegate`, `kimi-delegate`, `pi-delegate`, `qoder-delegate`, `agy-delegate`, `delegate-setup` |
| `obra/superpowers` | upstream | Superpowers framework: `brainstorming`, `planning`, `test-driven-development`, `systematic-debugging`, `executing-plans`, `subagent-driven-development`, `writing-plans`, `verification-before-completion`, `using-git-worktrees`, `requesting-code-review`, `receiving-code-review`, `dispatching-parallel-agents`, `finishing-a-development-branch`, `using-superpowers`, `writing-skills` |
| `anthropics/skills` | upstream | Anthropic official: `docx`, `pdf`, `pptx`, `xlsx`, `canvas-design`, `webapp-testing`, `skill-creator`, `mcp-builder`, `doc-coauthoring`, `theme-factory`, `frontend-design`, `algorithmic-art`, `brand-guidelines`, `internal-comms`, `claude-api` |
| `vercel-labs/agent-skills` | upstream | Vercel official: `react-best-practices`, `react-native-skills`, `react-view-transitions`, `composition-patterns`, `web-design-guidelines`, `writing-guidelines`, `vercel-optimize`, `deploy-to-vercel`, `vercel-cli-with-tokens` |
| `openai/codex` | upstream | OpenAI Codex official CLI and platform reference |
| WorktreeProof plugins | local vendored | `opencode-plugin-chrome-use` (13 tools), `opencode-plugin-computer-use` (12 tools), `opencode-plugin-goal-plan` (11 tools), `opencode-plugin-worktree-proof` (16 tools), `opencode-plugin-workflow-enforcement` (2 tools + system mandate) |
| WorktreeProof skills | local vendored | 12 skills including `complete-workflow`, `ui-proof-loop`, `worktree-proof-stack`, `safe-parallel-delegation`, `vibe-to-verified`, `tool-orchestrator`, `token-efficient-context`, `resource-efficient-coding`, `best-practice-guard`, `protocol-client`, `omnibus-maintainer`, `worktree-proof` |

## Upstream refs (pinned)

| Library | Pinned ref |
|---|---|
| `amElnagdy/delegate-skills` | `f9f2528525b820e7fd24724f87d6821c0e272947` |
| `obra/superpowers` | `b36e0829c6d0140e93cfef2ca599b1b07d4a7797` |
| `anthropics/skills` | `f6656c1256d5a8adfa37db9110046ef20bac644c` |
| `vercel-labs/agent-skills` | `b8caa260a420a73042e35521de4b5c8baf6446cc` |
| `openai/codex` | `3685a61dadefebb66690f8c0f945df044fc11b25` |

## `amElnagdy/delegate-skills`

- **Upstream URL:** <https://github.com/amElnagdy/delegate-skills>
- **License:** MIT, as attributed to the upstream project; WorktreeProof does not
  relicense or copy its contents.
- **Purpose:** optional delegation-oriented Agent Skills that an operator may
  inspect and selectively install when a task benefits from them. Includes the
  important `opencode-delegate` and `vibe-delegate` skills for multi-agent
  delegation.
- **Provenance:** authored and maintained upstream by
  `amElnagdy/delegate-skills`; this repository stores metadata only.

Example discovery and selective installation commands (run by an operator, not
by WorktreeProof):

```text
npx skills add https://github.com/amElnagdy/delegate-skills --list
npx skills add https://github.com/amElnagdy/delegate-skills --skill <skill-name>
```

WorktreeProof must not vendor, auto-install, authenticate to, or execute this
upstream library. Review its current license, ref, and contents before any
operator-managed installation; the pinned metadata above is not a claim that
the upstream project is safe for every task.

## `obra/superpowers`

- **Upstream URL:** <https://github.com/obra/superpowers>
- **License:** MIT
- **Purpose:** the agentic skills framework and software development
  methodology. Required sub-skills for L99 plan execution:
  `superpowers:subagent-driven-development` and `superpowers:executing-plans`.

## `anthropics/skills`

- **Upstream URL:** <https://github.com/anthropics/skills>
- **License:** MIT
- **Purpose:** Anthropic's official Agent Skills for document generation
  (docx/pdf/pptx/xlsx), canvas design, webapp testing, skill creation, and MCP
  building.

## `vercel-labs/agent-skills`

- **Upstream URL:** <https://github.com/vercel-labs/agent-skills>
- **License:** MIT
- **Purpose:** Vercel's official collection of agent skills for React
  development, UI guidelines, writing, and Vercel deployment.

## `openai/codex`

- **Upstream URL:** <https://github.com/openai/codex>
- **License:** Apache-2.0
- **Purpose:** OpenAI's official Codex repository — the lightweight coding
  agent CLI and platform reference.

## Installation

**Automatic (recommended):** `npm run opencode:plugins:install` installs all
WorktreeProof-owned plugins and skills into `~/.config/opencode/plugins/` and
`~/.claude/skills/`, plus operator-managed copies of the pinned upstream
delegate-skills and superpowers skills. Restart OpenCode afterwards.

**Manual upstream installation (operator-run, never by WorktreeProof):**

```text
npx skills add https://github.com/amElnagdy/delegate-skills --list
npx skills add https://github.com/amElnagdy/delegate-skills --skill opencode-delegate
npx skills add https://github.com/anthropics/skills --list
npx skills add https://github.com/vercel-labs/agent-skills --list
git clone https://github.com/obra/superpowers.git
```

WorktreeProof must not vendor, auto-install, authenticate to, or execute these
upstream libraries without operator action. Review each license, ref, and
contents before any operator-managed installation; the pinned metadata above
is not a claim that the upstream project is safe for every task.
