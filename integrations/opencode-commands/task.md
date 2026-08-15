---
description: Start or close a WorktreeProof task with evidence
agent: build
---
Use WorktreeProof tools for the requested task lifecycle. If the request says start, call `task_start`; if it says done or close, call `task_done` only with explicit terminal evidence; otherwise inspect with `task_next` and `plan_show`. Keep the fixed goal and scope unchanged.

Task instruction: $ARGUMENTS
