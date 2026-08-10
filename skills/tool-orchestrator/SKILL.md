---
name: tool-orchestrator
description: Discover and choose currently available tools by capability, risk, and evidence needs. Use when a task spans local commands, connectors, plugins, browsers, or external services and tool access or side effects must be made explicit.
---

# Tool Orchestrator

Select the smallest currently exposed or installed tool that can complete the requested step. Treat a tool's presence as capability information, never as permission to mutate an external system.

## Discover the current surface

1. Enumerate the installed tools, connectors, scripts, and local commands actually exposed in this session.
2. Tag each candidate with capabilities such as `inspect`, `read`, `edit`, `test`, `preview`, `browser`, `deploy`, `external-write`, `destructive`, or `secrets-sensitive`.
3. Separate availability, authentication, authorization, and evidence. A listed tool may still be unavailable, unauthenticated, unauthorized, or unable to prove a live result.
4. Prefer deterministic local inspection for local facts and an official service surface for service facts. Do not invent a connector or silently substitute a different system.

## Choose by capability and risk

1. Start with the least powerful tool that satisfies the step; prefer read-only over write-capable and dry-run over apply.
2. Compare candidates by scope, reversibility, privacy, reliability, and the evidence they can return. Record why the selected capability fits.
3. Keep one tool/resource per bounded lane when possible. Do not let two lanes mutate the same file, record, database object, or external resource.
4. If a capability is missing, explain the limitation and offer a safe local or manual fallback. Never claim that every vendor, connector, or integration is bundled, supported, or endorsed.

## Protect secrets and people

- Never print, echo, copy, screenshot, upload, or summarize credentials, tokens, cookies, private keys, auth headers, or secret values. Secret names are enough.
- Keep secrets out of command arguments, logs, fixtures, receipts, URLs, and screenshots. Redact returned output before sharing it.
- Ask for explicit confirmation immediately before a consequential external action: sending a message, changing account or billing settings, deploying, deleting, mutating production data, or placing an order. Bundle only the actions the user actually requested.
- Do not automate passwords, OTP/2FA, CAPTCHA, passkeys, or other human security challenges. Stop at the challenge and explain the owner action.
- Do not infer authorization from a connector, browser session, a previous approval, or a successful dry run.

## Execute and hand off

1. Show the selected capability, target, side effect, and rollback before a confirmed write.
2. Run one bounded action, capture the smallest useful redacted result, and distinguish source evidence from live production proof.
3. On failure, classify the actual cause, correct the input once, and avoid retry loops. Preserve a safe dry-run or read-only result when it is useful.
4. Return the chosen tool, capability tags, commands or calls, outcome, evidence limits, and the next safe action. Do not claim completion when the action was only planned or previewed.
