---
name: takt-pi-model-preflight
description: "Validate the two-layer TAKT/Pi provider and model route before starting or resuming a workflow, including old global TAKT thinking-level syntax and embedded model-catalog checks."
disable-model-invocation: true
---

# TAKT Pi Model Preflight

Use this phase whenever a task starts or resumes with `provider: pi` and an
explicit model. It prevents a valid Pi model selection from being passed to
TAKT in a form that the embedded Pi runtime cannot resolve.

## Two provider layers

Keep these values separate:

- TAKT `provider` selects the workflow executor. For Pi execution this is
  `pi`.
- TAKT `model` selects a model in Pi. Use the fully qualified
  `<pi-provider>/<pi-model>` route, for example
  `opencode-go/muse-spark-1.3-contributor`.
- `extensions` is a list of explicitly trusted Pi extension sources. It is
  not a provider name and does not make a model available.

Never turn the Pi provider (`opencode-go`) into the TAKT provider flag, and do
not put Pi thinking level, `reasoning_effort`, or extension sources into the
model id unless the selected TAKT version explicitly documents that syntax.

## Old global TAKT model syntax

The older/global TAKT CLI accepts a Pi thinking level after the model reference
using the final colon:

```text
--provider pi
--model opencode-go/muse-spark-1.3-contributor:xhigh
```

Valid suffixes are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. The suffix is a Pi thinking-level selector, not a model name and not a
DeepSeek provider option. Preserve the provider/model route before adding it.

If the selected TAKT release does not support this suffix, stop and report the
version-specific contract. Do not silently switch to a runtime YAML or legacy
provider-option representation.

For a bridge call, put the executor and route in their corresponding fields:

```json
{
  "provider": "pi",
  "model": "opencode-go/muse-spark-1.3-contributor:xhigh"
}
```

Do not pass `opencode-go` as TAKT's `provider`, and do not split the route into
separate provider/model values after preflight.

## Model availability is a separate check

`pi --list-models` is a useful candidate list, but it is **not proof** that the
embedded TAKT Pi runtime can resolve the model. TAKT may use a shipped static
catalog plus `models.json`, an in-memory model store, and network-disabled
startup. A model visible in Pi through a persisted `models-store.json` can
therefore still produce:

```text
Pi model "<provider>/<model>" was not found
```

Before launch:

1. Preserve the exact target profile/cwd and the exact model route.
2. Check the candidate with `pi --list-models`, but label that result
   **candidate only**.
3. Check that the same route is available to the embedded TAKT runtime: it
   must be in TAKT's shipped catalog or in the configured Pi
   `~/.pi/agent/models.json` overlay. Do not treat `models-store.json` alone as
   sufficient when TAKT uses an in-memory store.
4. If the route is unavailable, stop before retrying. Offer only these
   remediations: update the global TAKT/Pi runtime, add a verified non-secret
   model definition to `models.json` while preserving existing entries, or
   choose another model after the user approves. Never invent endpoint,
   compatibility, or credential data, and never copy secrets from `auth.json`.

Do not create `.takt/runtime.yaml` merely to make a direct `--model` route
resolve. An active runtime-v1 provider section can conflict with legacy
`config.yaml` provider settings; migration is a separate, explicit task.

## Launch and observation contract

The direct workflow tool's successful return means only that a child process
was started. It does not prove model resolution or task success.

- Before launch, note the target profile/cwd and the latest target run id.
- After launch, inspect `takt_read_screen` and the target's
  `.takt/runs/*/meta.json` (or an equivalent target-scoped status read).
- Require the observed project/cwd to match the requested target. If the
  widget shows another project or an older completed session, mark it stale;
  do not stop it, claim it as the new run, or start a duplicate.
- A new target run must reach `running` (or a later terminal state) with the
  requested workflow context. Verify the model from the bridge launch context
  and an early log/trace when run metadata does not expose a model field. If
  the requested model cannot be evidenced, report the run as unverified rather
  than claiming success. An immediate `failed` result is a launch failure;
  report its reason and fix the preflight blocker before retrying.

Before launch, this phase is complete when the route and embedded catalog
availability are evidenced. After launch, hand the target-identity and
model-observation checks to the runner; do not start a second run from this
phase.

## Boundary

This Skill validates a Pi model route. It does not select workflows, enqueue
tasks, alter global Pi settings without explicit approval, stop external PTYs,
or replace a failed run with a different provider/model.
