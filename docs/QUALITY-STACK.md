# Quality Stack

WorktreeProof quality checks are a stack-aware evidence ladder. Start with the
project's declared runtime and changed surface, then choose only checks that can
answer a real risk. A passing check supports that check; it is not a blanket
claim about the whole product.

| Gate | Ask | Useful evidence |
| --- | --- | --- |
| Security | Are trust boundaries, authorization, validation, dependencies, and sensitive outputs appropriate for this stack? | Threat-model notes, focused tests, dependency or static analysis, redacted traces |
| Accessibility | Can supported users discover, operate, and understand the changed surface? | Keyboard/focus checks, semantic DOM, assistive-technology or UI evidence, project standards |
| Compatibility | Does the change fit the declared runtimes, browsers, devices, APIs, and data versions? | Support matrix, versioned fixtures, targeted cross-runtime checks |
| Performance | Does a representative measurement meet the stated budget? | Timed test, profiler, trace, or benchmark with workload and environment |
| Tests | Do acceptance, failure, limit, and regression paths behave deterministically? | Focused test command and redacted output |
| Maintainability | Can the next maintainer understand ownership, interfaces, complexity, docs, and rollback? | Review notes, API/docs checks, diff and rollback plan |

## Operating rules

1. Record the manifest, lockfile, runtime, framework version, and policy source
   used to select gates.
2. Give every gate a status (`pass`, `fail`, `blocked`, or `unverified`), a
   severity, and the smallest supporting evidence.
3. Cite the project rule, versioned documentation, recognized standard, or
   measurement behind a recommendation. Mark conflicts and stale sources.
4. Separate local/source evidence from live production proof. Redact secrets,
   personal data, private URLs, credentials, and unnecessary payloads before
   storing or sharing output.
5. If a gate reveals a high-impact failure or needs an out-of-scope decision,
   stop with a bounded next action rather than widening the task.

The [`best-practice-guard`](../skills/best-practice-guard/SKILL.md) skill turns
these rules into a compact review workflow; use [`ui-proof-loop`](../skills/ui-proof-loop/SKILL.md)
for evidence that must be seen and operated rather than inferred from source.

