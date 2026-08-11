# Reproducible end-to-end demo

This walkthrough uses a disposable directory and a synthetic **abandoned**
receipt. It exercises the public plan → reserve → run → inspect → close →
release → validate flow without a hosted account, credentials, or a special
shell. The receipt is test data; it is not proof of a real merge or deployment.

Run the examples from a checkout after `npm ci` (see the [quick start](../README.md#five-minute-quick-start)). They invoke `node bin/worktree-proof.js` directly so the example is independent of a global PATH wrapper.

## POSIX shell

```sh
set -eu
repo_root="$(git rev-parse --show-toplevel)"
cli="$repo_root/bin/worktree-proof.js"
wtp() { node "$cli" "$@"; }
demo_dir="$(mktemp -d)"
cd "$demo_dir"

wtp doctor --repo "$demo_dir" --json
wtp plan docs-demo --scope docs/ --repo "$demo_dir" --json
wtp reserve docs-demo --scope docs/ --repo "$demo_dir" --json
wtp run docs-demo --repo "$demo_dir" --json -- node --version
wtp status --repo "$demo_dir" --json

cat > receipt.json <<'JSON'
{
  "schemaVersion": "1",
  "laneId": "docs-demo",
  "outcome": "abandoned",
  "closedAt": "2026-01-01T12:00:00Z",
  "branchDeleted": true,
  "worktreeClean": true,
  "reason": "Disposable documentation demo; no merge was attempted."
}
JSON

wtp close docs-demo --receipt receipt.json --repo "$demo_dir" --json
wtp release docs-demo --repo "$demo_dir" --json
wtp validate . --repo "$demo_dir" --json
wtp cleanup --dry-run --repo "$demo_dir" --json
```

## PowerShell

```powershell
$repoRoot = (git rev-parse --show-toplevel).Trim()
$cli = Join-Path $repoRoot 'bin/worktree-proof.js'
function Invoke-Wtp { node $cli @args }
$demoDir = Join-Path $env:TEMP ("worktree-proof-demo-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $demoDir | Out-Null
Set-Location $demoDir

Invoke-Wtp doctor --repo $demoDir --json
Invoke-Wtp plan docs-demo --scope docs/ --repo $demoDir --json
Invoke-Wtp reserve docs-demo --scope docs/ --repo $demoDir --json
Invoke-Wtp run docs-demo --repo $demoDir --json -- node --version
Invoke-Wtp status --repo $demoDir --json

$receipt = @'
{
  "schemaVersion": "1",
  "laneId": "docs-demo",
  "outcome": "abandoned",
  "closedAt": "2026-01-01T12:00:00Z",
  "branchDeleted": true,
  "worktreeClean": true,
  "reason": "Disposable documentation demo; no merge was attempted."
}
'@
[IO.File]::WriteAllText((Join-Path $demoDir 'receipt.json'), $receipt)

Invoke-Wtp close docs-demo --receipt receipt.json --repo $demoDir --json
Invoke-Wtp release docs-demo --repo $demoDir --json
Invoke-Wtp validate . --repo $demoDir --json
Invoke-Wtp cleanup --dry-run --repo $demoDir --json
```

The output includes generated timestamps, UUIDs, and a temporary path. Those
values are expected to differ between runs. Replace `node --version` only with
a command you have reviewed and understand; `run` passes argv without an
implicit shell but is not a security sandbox. Remove the temporary directory
when you no longer need its local state.
