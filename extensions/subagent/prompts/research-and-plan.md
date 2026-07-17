---
description: Researcher gathers cited evidence, planner turns it into an implementation plan
---
Use the subagent tool with the chain parameter to execute this workflow:

1. First, use the "researcher" agent to investigate: $@
2. Then, use the "planner" agent to create a concrete implementation plan from the research (use {previous} placeholder).

Do not implement changes. Return the plan and unresolved questions.
