---
name: best-practice-guard
description: Apply stack-aware security, accessibility, compatibility, performance, testing, and maintainability gates using current sources and measured evidence. Use when reviewing a change, selecting quality checks, or deciding whether a broad practice claim is justified.
---

# Best-Practice Guard

Build a quality decision from the project's actual stack and evidence. Treat a
practice as a hypothesis to check, not a universal label such as "secure" or
"fast."

## Establish the frame

1. Read the authoritative manifest, lockfile, runtime settings, framework
   version, supported browsers/devices, and project policies before choosing a
   check.
2. Write the changed surface, threat or user impact, compatibility baseline,
   performance budget, and acceptance tests. Keep unrelated polish out of the
   gate.
3. For each recommendation, record a source: a project rule, versioned vendor
   documentation, a recognized standard, or a reproducible measurement. Include
   the source date or version when it affects the result.

## Evaluate six gates

Use a small table with `gate`, `question`, `evidence`, `severity`, and `status`:

- **Security:** Are trust boundaries, validation, authorization, dependency
  changes, and sensitive outputs appropriate for this stack and threat model?
- **Accessibility:** Can the intended users discover, operate, and understand
  the changed surface with the project's supported input and assistive tools?
- **Compatibility:** Does the behavior fit the declared runtime, browser,
  device, API, and data-version support matrix?
- **Performance:** Does a reproducible measurement stay within the stated
  budget on a representative fixture? Explain what was not measured.
- **Tests:** Do focused tests cover the acceptance path, failure path, limits,
  and regression boundary without relying on unstable timing or private data?
- **Maintainability:** Are ownership, interfaces, naming, complexity, docs, and
  rollback understandable to the next maintainer?

## Keep claims honest

1. Prefer the smallest check that can falsify the concern, then expand only when
   the result or risk justifies it.
2. Mark `pass`, `fail`, `blocked`, or `unverified`; attach commands, measurements,
   and source links. Never infer a whole-stack guarantee from one passing check.
3. Distinguish a local result, a code review observation, and live production
   evidence. Do not hide missing tools, unsupported versions, or conflicting
   sources.
4. Fix high-impact failures first. If a gate requires a decision outside the
   requested scope, stop with the evidence and a bounded next action.

## Handoff

Return the stack snapshot, six-gate table, sources and versions, checks run,
redaction result, known gaps, rollback note, and the decision that the evidence
supports. State explicitly when a claim remains unverified.

