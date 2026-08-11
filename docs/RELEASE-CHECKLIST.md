# Release checklist

Use this checklist for a bounded release lane:

1. Confirm the supported Node.js range and package version.
2. Run `npm run check` on Node.js 20 and 22.
3. Run the POSIX or PowerShell demo from [DEMO.md](DEMO.md).
4. Run `worktree-proof validate .` and inspect any receipt it reports.
5. Review the threat-model and privacy notes for behavior changes.
6. Update [CHANGELOG.md](../CHANGELOG.md), [NOTICE.md](../NOTICE.md), and package metadata when applicable.
7. Build and verify the checksummed release bundle described in
   [RELEASE-INTEGRITY.md](RELEASE-INTEGRITY.md).
8. Record a closure receipt with commands, outcomes, and redacted evidence.

Do not present a plan, branch, or passing local command as a release until the release lane has a terminal receipt.
