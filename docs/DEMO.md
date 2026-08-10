# Reproducible demo

This walkthrough exercises the public contract without requiring a hosted account or a special shell.

## POSIX shell

```sh
set -eu
demo_dir="$(mktemp -d)"
cd "$demo_dir"
worktree-proof doctor
worktree-proof plan docs-demo --scope docs/
worktree-proof reserve docs-demo --scope docs/
worktree-proof run docs-demo -- node --version
worktree-proof status --json
worktree-proof close docs-demo --receipt .worktree-proof/receipts/docs-demo.json
worktree-proof validate .
worktree-proof cleanup --dry-run
```

## PowerShell

```powershell
$demoDir = Join-Path $env:TEMP ("worktree-proof-demo-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $demoDir | Out-Null
Set-Location $demoDir
worktree-proof doctor
worktree-proof plan docs-demo --scope docs/
worktree-proof reserve docs-demo --scope docs/
worktree-proof run docs-demo -- node --version
worktree-proof status --json
worktree-proof close docs-demo --receipt .worktree-proof/receipts/docs-demo.json
worktree-proof validate .
worktree-proof cleanup --dry-run
```

The demo is intentionally harmless. Replace `node --version` only with a command you have reviewed and understand; `run` is not a security sandbox.
