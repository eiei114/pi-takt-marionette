# To TAKT Tasks reference

## Spec execution group

One invocation starts from one explicit PRD/spec. That spec is the execution
boundary:

```text
spec
├── child ticket 01
├── child ticket 02
└── child ticket 03
        ↓
one aggregate TAKT task
        ↓
one worktree and one branch
```

Child tickets remain separate Markdown artifacts for acceptance criteria,
status, and traceability. They are not separate TAKT queue entries by default.
The aggregate task contains the child tickets in deterministic blocker order.
If a ticket genuinely needs an independent branch, split the spec execution
group explicitly; never pretend that multiple TAKT tasks sharing a branch are
one worktree.

## Issue shape

Generated child issues follow the local Markdown tracker convention:

```markdown
---
title: "<ticket title>"
created: YYYY-MM-DD
status: ready-for-agent
type: AFK
---

# <ticket title>

## Spec

<spec slug>

## Execution group

<spec slug>

## What to build

<end-to-end behaviour>

## Acceptance criteria

- [ ] <observable criterion>

## Non-goals

- <explicit exclusion>

## Validation

- `<exact command>`

## Constraints

- workflow: <standalone workflow id>

## Blocked by

None - can start immediately
```

HITL children use `status: ready-for-human` and `type: HITL`. They remain
durable issues but are excluded from the AFK aggregate. If a HITL child blocks
an AFK child, the spec group is not queueable until that boundary is resolved.

The task compiler removes frontmatter, `Status:` lines, and `## Comments`.
It does not summarize or rewrite acceptance criteria. It composes one
aggregate body from all queueable AFK child issues, adds each source ticket
reference, and puts the exact group directives at the top:
`workflow: <id>` and `branch: takt/<spec-slug>`.

## Workflow catalog and search

`takt_workflow_catalog` is the selection seam. It returns the effective
standalone catalog for the exact target, merging these layers in order:

1. project: `<target>/.takt/workflows/`
2. user-global: `<TAKT_CONFIG_DIR>/workflows/` (or `~/.takt/workflows/`)
3. builtin: the installed TAKT builtin catalog, when enabled

Duplicate names resolve to the higher-precedence layer. Builtin disablement
settings apply. The picker presents category, source (`project`, `user`, or
`builtin`), description, and id. Uncategorized entries appear under
`Others`/`Other`. Search passes a case-insensitive query for workflow id,
description, or category back to `takt_workflow_catalog`; it can be repeated
until the user selects an exact id. Callable/internal workflows are never
picker candidates.

The workflow is selected once for the spec execution group. Child tickets do
not silently select different workflows. A ticket that needs a different
workflow requires an explicit split into another execution group.

## Explicit TAKT execution policy

This route writes TAKT's task files directly. It does not modify TAKT source.
The execution policy is selected once for the spec execution group and passed
to the bridge explicitly:

```markdown
workflow: <standalone workflow id>
branch: takt/<spec-slug>
```

The bridge accepts these exact policy choices:

| Worktree | PR mode | Persisted task fields |
|---|---|---|
| `true` | `none` | `worktree: true`, `auto_pr: false`, `draft_pr: false` |
| `true` | `regular` | `worktree: true`, `auto_pr: true`, `draft_pr: false` |
| `true` | `draft` | `worktree: true`, `auto_pr: true`, `draft_pr: true` |
| `false` | `none` | `worktree: false`, `auto_pr: false`, `draft_pr: false` |
```

Regular and draft PR modes require `worktree: true`. The policy is required at
the queue seam; missing, malformed, or incompatible values fail closed. Never
silently inherit project defaults or choose `none` when regular/draft was not
confirmed. The persisted task fields are verified before queue success is
reported.

## Preflight contract

Preflight must finish before the direct persistence call:

- PRD path exists and is the requested source.
- Profile/cwd is explicit and resolves to the intended target.
- The effective catalog is ready and the selected workflow is standalone and
  enabled.
- The spec has exactly one usable workflow binding and one execution-group id.
- Every child issue belongs to that same spec/group; every `Blocked by` title
  resolves to a child issue in the same feature set.
- The graph is acyclic.
- The aggregate child-ticket order is a deterministic topological order;
  numeric filename order breaks ties.
- Existing ledger entries have the same target, spec/group id, child-ticket
  set, aggregate hash, workflow, branch, and execution policy before they can
  be skipped.

Do not write task files when any preflight check fails. Do not silently turn HITL into
AFK or select a default workflow.

## Queue ledger shape

The ledger is Markdown so a human can inspect it without a special tool:

```markdown
# TAKT queue: <feature>

- PRD: `<path>`
- Target profile: `<profile>`
- Target cwd: `<cwd>`
- Created: `<timestamp>`
- Mode: enqueue-only

## Queue

| Order | Spec/group | Child tickets | Branch | Workflow | Body SHA-256 | Result | Task name |
|---:|---|---|---|---|---|---|---|
| 1 | `fullscreen-focus` | `01, 02, 03` | `takt/fullscreen-focus` | `default` | `<hash>` | queued | `<id>` |
```

Result values are `queued`, `skipped-existing`, `failed`, or `unattempted`.
There is normally one row per spec execution group. On enqueue failure, append
the exact error and the full child-ticket set. Never claim all tickets ran
when only the pending aggregate task was queued.

## Rerun rules

The ledger is a resume record, not an execution result. A matching queued row
means only that the queue writer persisted one pending aggregate task; it does not mean
TAKT ran or completed it. If the spec/group, child-ticket set, aggregate body,
workflow, branch, target profile, or target cwd changes, stop and require a new
queue plan rather than risk duplicate work.

The topological order is recorded inside the aggregate task body. TAKT does
not provide native child-ticket failure gates; the skill must not claim that
it does.
