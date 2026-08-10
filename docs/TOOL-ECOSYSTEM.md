# Tool ecosystem and capability tags

WorktreeProof is tool-agnostic. A tool can be a local command, library, browser surface, connector, plugin, or service API. Discover what is actually exposed in the current session, then choose the smallest capability that satisfies the step. This document does not bundle, certify, endorse, or claim support for every vendor.

## Separate four questions

Before selecting a tool, answer these independently:

| Question | Meaning |
| --- | --- |
| Available? | Is the tool exposed and callable in this session? |
| Authenticated? | Is there a usable session without asking an agent to enter a secret? |
| Authorized? | Does the user and project policy permit this target and side effect? |
| Proven? | Can the tool return evidence about the requested environment, especially production? |

A “yes” to availability is never a “yes” to authorization. A successful local command is not live-service proof.

## Capability tags

Use tags in plans, lane scopes, and handoffs so a replacement can be chosen by behavior rather than brand:

| Tag | Typical use | Safe default |
| --- | --- | --- |
| `inspect` / `read` | List files, inspect source, read a service record | Prefer first; no mutation |
| `edit` | Change project files or generated artifacts | Keep scope relative and review the diff |
| `test` | Run unit, contract, integration, or UI checks | Capture pass, fail, and skipped separately |
| `preview` | Render a local, disposable, or staging result | Redact output and verify the real surface |
| `browser` | Navigate or observe a web surface | Do not inspect storage or enter secrets |
| `deploy` | Promote code or configuration | Confirm target, release, rollback, and evidence |
| `external-write` | Send, publish, mutate a remote record | Ask confirmation immediately before the action |
| `destructive` | Delete, revoke, overwrite, or irreversible migration | Back up first and require an explicit rollback plan |
| `secrets-sensitive` | Touch a credential-bearing boundary | Keep values out of output; stop at human challenges |

Add more project-specific tags when they describe a real capability and have a clear safe limit. Do not add a tag just to advertise a product.

## Selection rules

1. Prefer local, deterministic, read-only inspection for local facts.
2. Prefer the official target surface for service facts and live evidence.
3. Prefer dry-run, preview, or export before apply; prefer reversible changes over destructive ones.
4. Compare scope, privacy, reversibility, reliability, and evidence quality. Record the reason for the choice.
5. Keep two lanes from mutating the same file, database object, record, or external resource.
6. If no suitable capability is exposed, report the limitation and offer a safe manual or local fallback. Do not invent access.

## Hard limits

- Never print, echo, copy, screenshot, upload, or summarize passwords, tokens, cookies, private keys, auth headers, or other secret values. Secret names are sufficient.
- Ask for confirmation immediately before sending messages, deploying, deleting, changing account or billing settings, mutating production data, or placing an order. Do not infer approval from a prior task or a logged-in browser.
- Never automate password, OTP/2FA, CAPTCHA, passkey, or device-approval entry. Stop at the human security challenge.
- Treat a plan, branch, commit, dry run, or passing test as intermediate evidence. State the missing live or terminal proof.
- Do not claim native Ultra, benchmark superiority, adoption, or universal vendor compatibility. Describe only the observed tool surface and result.

## Handoff fields

Return the selected tool and capability tags, target, side effect, confirmation status, command or call, redacted result, evidence limits, rollback, and next action. This makes a tool substitution understandable without coupling the recipe to a particular vendor.
