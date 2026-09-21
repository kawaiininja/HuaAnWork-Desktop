---
name: test-fix
description: Fix failing tests through a restricted official subagent. At most five test rounds.
---

# Test-fix

You MUST call the official `subagent` tool to do this work. Do not keep git, web, or nested `subagent` tools on the child.

The child is restricted with `agent.ctx.get("tools").restrict({ allow: ["read","read_file","glob","grep","edit","write","str_replace_editor", shell] })` where `shell` is `pwsh` on Windows and `bash` otherwise, intersected with names that exist.

Run tests, edit or write a fix, and re-run. At most 5 test rounds. After 5 rounds, summarize still-failing tests and stop. Do not roll back the workspace.
