---
name: explore
description: Read-only codebase exploration through the official subagent tool.
---

# Explore

You MUST call the official `subagent` tool to do this work. Do not explore in the current session.

The child is restricted with `agent.ctx.get("tools").restrict({ allow: ["read","read_file","glob","grep"] })`, intersected with names that exist. It must not receive `bash`, `pwsh`, git tools, web tools, or `subagent`.

If the child asks for `bash`, policy and restrict Deny.

Return only the conclusion to the parent. Intermediate steps stay in the child session log.
