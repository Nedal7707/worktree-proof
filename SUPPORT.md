# Support

WorktreeProof is an early, community-maintained project. Start with the
[README](README.md), [architecture](docs/ARCHITECTURE.md), and the command help
for the version you are running. The repository currently has no hosted support
service, response-time guarantee, bounty program, or claim of vendor support.

## Public questions and bugs

Use a [GitHub issue](https://github.com/Nedal7707/worktree-proof/issues) for a
reproducible question or ordinary bug. Before opening one:

1. Confirm the version (`worktree-proof --version`) and Node.js version.
2. Run the smallest relevant command with `--json` where possible.
3. Include the operating system, command shape, exit code, and a redacted
   excerpt of the result.
4. Say whether the observation is local, disposable, staging, or live.
5. Remove credentials, cookies, tokens, personal data, private hostnames, and
   full production logs. Attach a synthetic fixture when a state file is
   needed.

Do not describe a plan, branch, or passing local test as a shipped fix. If a
receipt is relevant, include only the fields needed to reproduce the contract.

## Security reports

Do not use a public issue for a vulnerability. Follow [SECURITY.md](SECURITY.md)
and the repository host's non-public security-advisory or maintainer channel.
Send the minimum redacted reproduction; never send secrets or full logs.

## Feature requests

Explain the user problem, the smallest observable outcome, compatibility and
privacy implications, and how the change could be rolled back. New network,
telemetry, authentication, cleanup, or hosted-coordination behavior requires a
separate threat-model and security review; a popularity or adoption argument is
not evidence by itself.
