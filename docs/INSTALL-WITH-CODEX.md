# Install with Codex

`worktree-proof-stack` packages the full WorktreeProof workflow: turn a task into a
bounded scope, reserve independent lanes, run reviewed commands, and finish
with verified evidence or an explicit abandonment. The source location below
is intended to be public when published.

## One-link prompt

Paste this prompt into your next Codex turn when you want to install or use the
skill:

> Use the `worktree-proof-stack` skill from [the public skill source](https://github.com/Nedal7707/worktree-proof/tree/main/skills/worktree-proof-stack) for this task. Ask me to confirm before installing or invoking it; the link alone does not install anything. After a successful install, tell me the skill will be available on the next turn.

The link is a source location and a request aid, not an installer. Installation
still requires the user's explicit intent and the normal skill-installer
behavior.

## Skill-installer CLI fallback

If the one-link prompt is not available, run the official skill-installer helper
with the same public URL:

```sh
python "$HOME/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py" \
  --url "https://github.com/Nedal7707/worktree-proof/tree/main/skills/worktree-proof-stack"
```

Set `CODEX_HOME` and adjust the script path when the Codex installation uses a
different home directory. The installer refuses an existing destination rather
than overwriting it. Once installation succeeds, the skill is available on the
next turn; invoke it explicitly with `$worktree-proof-stack` when needed.

## Verify before use

After installation, ask Codex to display the skill name and source path, then
start with a bounded objective. Keep credentials out of prompts, commands,
receipts, and screenshots. A branch, patch, or local test is not terminal proof
until the target revision and redacted evidence are recorded.
