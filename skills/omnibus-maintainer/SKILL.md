---
name: omnibus-maintainer
description: Route common open-source maintenance work through a concise, progressive-disclosure workflow. Use when triaging issues, improving tests or docs, preparing releases, reviewing dependencies, or responding to routine maintenance requests.
---

# Omnibus Maintainer

Coordinate maintenance without loading unrelated project context. Keep the maintainer accountable for scope and decisions while using only tools that are actually available in the current environment.

## Triage

Classify the request before editing:

- **Quality:** reproduce the issue, add a focused test, and report the observed behavior.
- **Documentation:** update the nearest authoritative page and verify examples or links.
- **Release:** run the release checklist, update version notes, and capture a receipt.
- **Security:** minimize exposure, follow the project's security policy, and keep sensitive details out of public records.
- **Dependencies:** review necessity, license, update surface, and CI impact before adding anything.

## Progressive disclosure

Start with the task description, project README, and command help. Load only the relevant architecture, threat-model, privacy, maintenance, or release note. Use available repository tools and scripts; do not assume a connector, hosted service, or special capability exists.

Do not copy or vendor third-party skill packages into a project. Route to the available tool or local instruction instead, and summarize the chosen path in the change or receipt.

## Delivery

Keep one objective per lane. Run the narrowest meaningful checks, inspect the diff, update changelog or notices when behavior warrants it, and record what remains unverified. Distinguish a proposed change from a merged or released result.

End with a concise handoff: changed files, checks run, evidence, unresolved risk, and the next bounded action.
