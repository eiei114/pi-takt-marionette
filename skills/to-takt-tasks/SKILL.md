---
name: to-takt-tasks
description: Turn one explicit PRD into child tickets and queue them as one ordered aggregate TAKT task on one spec branch. Use when a user wants the grill → spec → TAKT queue flow, asks to stack implementation work in TAKT, or wants a PRD converted into a bridge-owned task.
disable-model-invocation: true
---

# To TAKT Tasks

Composite planning-and-queueing skill for the explicit flow:

`grill-with-docs → to-spec → to-takt-tasks`

It performs the ticket-slicing work formerly provided by `to-tickets`, keeps the
child tickets as durable artifacts, and projects one spec into one TAKT pending
task. The child tickets remain individually trackable, but they share the
spec's execution branch/worktree. It never starts TAKT execution.

## Required inputs

- An explicit PRD/spec path. Never guess a `.scratch` feature or use an
  unrelated recent document.
- An explicit TAKT profile or exact target cwd. Never infer a repository from
  `related_project`, the current Vault cwd, or a similarly named folder.
- A target that is ready for the bridge. Use `takt_project_setup` only with the
  exact supplied cwd/profile when setup is needed.

## Gate 1 — spec execution group and child tickets

1. Read the complete PRD and the target project's guidance.
2. Read the target's effective standalone workflow catalog with
   `takt_workflow_catalog`; stop if it is unavailable or empty. The catalog
   includes enabled project workflows, user-global workflows, and builtins in
   effective precedence order: project > user-global > builtin. Respect
   builtin enable/disable settings; do not copy builtin files into the
   project.
3. Draft multiple child tickets under the single explicit spec. Show title,
   AFK/HITL type, end-to-end outcome, acceptance criteria, and `Blocked by`
   edges. Keep the spec as the execution-group boundary; do not create one
   execution group per child ticket.
4. Assign exactly one catalog workflow to the spec execution group during the
   same review. Present candidates grouped by category with workflow name,
   source, and description.
   Offer case-insensitive search over workflow id, description, and category by
   passing `query` to `takt_workflow_catalog`; include `Others`/`Other` for
   uncategorized entries. Same-name entries are already resolved to one
   effective candidate; show its source so project overrides are visible. Do
   not expose callable/internal workflows or silently use a default. Ask the
   user to approve the child-ticket granularity, edges, types, and one workflow
   binding for the whole spec.
5. Use the bridge's direct TAKT task-file contract without modifying TAKT: the supported
   execution policy is `worktree: true` and `pr: none`. The aggregate task
   receives one explicit branch directive, `branch: takt/<spec-slug>`. Do not
   ask for or advertise per-ticket worktree/PR settings. If the user requests
   worktree=false or automatic regular/draft PR delivery, stop and report that
   it is unsupported by the direct queue contract; never silently downgrade it.
6. After approval, save child issues under `.scratch/<feature>/issues/NN-*.md`.
   AFK issues use `Status: ready-for-agent`; HITL issues use
   `Status: ready-for-human`. Each issue records the parent spec and execution
   group. HITL issues are never silently included in the AFK task. If a HITL
   child blocks an AFK child, the group is not queueable until that boundary is
   resolved.

Only approved AFK child tickets enter the aggregate TAKT task. A spec with no
queueable AFK child is saved but not enqueued.

## Gate 2 — preflight and one enqueue

1. Topologically order the AFK child tickets inside the spec execution group.
   Use numeric issue order as the deterministic tie-breaker. This is execution
   order inside one task, not multiple TAKT queue entries.
2. Compile one aggregate execution body. Preserve each child ticket's
   outcome, scope, non-goals, acceptance criteria, validation, constraints,
   and source reference; omit YAML frontmatter, Status, and Comments. Add the
   exact group directives at the top:
   `workflow: <id>` and `branch: takt/<spec-slug>`.
3. Preflight the target/profile, the single workflow binding, the spec/group
   identity, aggregate body hash, duplicate ledger entry, and child-ticket
   order. A missing or invalid workflow, group identity, or unsupported
   execution request fails closed before direct persistence.
4. Show one queue plan containing the spec, branch, workflow, and all child
   tickets. Ask for one explicit enqueue confirmation.
5. After confirmation, call `takt_enqueue_task` exactly once for the aggregate
   body, with the existing tool contract (`profile` and `task` only). Require
   verification of the directly persisted workflow. The `branch:`
   directive is stored as TAKT task context; preserve it in the ledger. Do not
   call `takt_run_pending`, `takt_exec_prompt`, or send `/go` separately.
6. Write `.scratch/<feature>/takt-queue.md` with one spec/group row, its child
   tickets, target, profile, branch, workflow, body hash, task name, tasks file,
   and result.

## Failure and retry

- On the aggregate enqueue failure, stop. Do not continue or attempt unsafe
  TAKT rollback. Record the spec/group, child tickets, and failure in the
  ledger.
- A later invocation resumes only when target, spec/group identity, aggregate
  body hash, workflow, branch, and child-ticket set match the ledger. A
  matching `queued` group is skipped; mismatches stop.
- Queueing is not execution. Report pending state and leave running to the
  explicit TAKT runner/run gate.

## Boundary

`to-takt-tasks` owns decomposition, issue persistence, spec-group queue
planning, and one direct enqueue. `to-spec` owns the single spec. `takt-pi-runner`
owns execution and recovery. The generic `feature-development.yml` playbook
remains target-agnostic; use the TAKT-specific playbook variant when this route
is intended.
