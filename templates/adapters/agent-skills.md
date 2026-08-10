# WorktreeProof onboarding (Agent Skills/Codex)

This optional guide is host-neutral. It does not install software, contact a
service, read credentials, or claim that a host has a particular capability.

Inspect the repository, propose a dry-run plan, and wait for explicit
confirmation before creating files. Refuse collisions, traversal, symlink
escapes, secrets, auth files, lockfiles, and destructive changes.

Use `.worktree-proof/` as the shared state. Bridge messages are explicit local
files and never launch Claude or forward hidden context. Task awareness keeps
only hashed IDs, status, explicitly reported mode, and bounded reservations.
