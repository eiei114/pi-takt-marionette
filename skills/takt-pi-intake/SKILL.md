---
name: takt-pi-intake
description: "Resolve the exact TAKT target, intent, and execution constraints before any setup, planning, queueing, or run. Internal preflight phase; use through takt-pi-next-step or takt-pi-orchestrator, not as a generic TAKT front door."
disable-model-invocation: true
---

# TAKT Pi Intake

Resolve only missing facts. Do not create a task, modify project state, or
start TAKT during intake.

## Collect

1. **Target** — exact current project, explicit folder, or named profile. Never
   search arbitrary folders or infer a similarly named repository.
2. **Intent** — setup, ask for the next action, plan and queue, run pending,
   inspect, stop, or recover a checkpoint.
3. **Constraints** — preset/profile, provider/model, Pi-only requirement,
   worktree expectation, and allowed delivery side effects.
4. **Task contract** — goal, scope, non-goals, acceptance criteria, and
   validation evidence when the request creates work.

Use facts already present in the user message, current Pi project, and existing
profile. Ask one compact question only for the next missing fact.

## Done condition

Return an exact target/profile, one resolved intent, and preserved constraints.
Hand off to `takt-pi-project-setup` when the target needs bootstrap, or to
`takt-pi-next-step` for the next preflight boundary. Do not choose a workflow
here; workflow selection belongs to the orchestrator.

## Safety

- No guessed cwd or replacement profile.
- No shell `takt`, `taskkill`, enqueue, `/go`, or run.
- A named profile pointing at another cwd is a hard conflict; surface it.
