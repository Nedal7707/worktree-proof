---
name: ui-proof-loop
description: Verify UI screens, states, and actions in short evidence rounds with redaction and operator review. Use when a change needs browser or desktop interaction proof, a visual handoff, or a careful boundary around sensitive UI data.
---

# UI Proof Loop

Turn a UI claim into a bounded, reviewable observation. A passing unit test or a
source inspection is useful context, but it is not proof that a screen behaves
as expected.

## Make the proof matrix

1. Name the route or surface, user role, environment, and one observable goal.
2. Inventory each screen or entry point with its relevant states: loading,
   empty, success, error, disabled, and permission-limited where applicable.
3. Pair each state with the action to perform, expected visible signal, and
   evidence needed. Mark states that are intentionally out of scope.
4. Identify actions that could send data, change records, or reach a protected
   boundary. Use a safe fixture or a dry run for those actions.

## Run short rounds

1. Start from a known reset and execute one action at a time. Keep each round
   small enough that a reviewer can reproduce it.
2. When tools support it, record console, network, and DOM evidence alongside a
   screenshot or other visual artifact. Capture only the lines needed to explain
   the result and include a timestamp or request identifier when it is safe.
3. Label every observation as live UI evidence, local test evidence, source
   evidence, or unverified. Do not turn a missing browser/tool capability into a
   pass.
4. On failure, preserve the first useful trace, classify the failure, and stop
   before repeated attempts change the evidence.

## Protect people and data

- Redact credentials, tokens, cookies, private URLs, personal fields, and full
  request bodies from screenshots, recordings, console output, and network logs.
- Review video frames and metadata for accidental sensitive fields before
  sharing. Prefer a still, crop, or short trace when video adds no proof.
- Do not automate passwords, OTP/2FA, CAPTCHA, passkeys, or other human security
  challenges. Stop at that boundary and record the required operator action.

## Require review and close

1. Present the proof matrix, redacted artifacts, console/network/DOM excerpts,
   test commands, environment, and known gaps to an operator.
2. Require the operator to review the actual UI evidence before calling the
   surface verified. A coordinator may reject a claim even when every scripted
   action passed.
3. Close with the target, states exercised, action outcomes, evidence class,
   redaction check, operator review result, and one next action for anything
   unverified.

