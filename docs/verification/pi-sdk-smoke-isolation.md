# Pi SDK smoke isolation

`npm run smoke:pi` (`scripts/pi-sdk-smoke.mjs`) starts the real Pi RPC host with
this package loaded (`-e .`). The extension in that host resolves the same
user-level state a real Pi session uses, so the smoke must redirect every root
it can reach or it will operate on the operator's live setup.

| Root | Resolved from | Without isolation |
| --- | --- | --- |
| project/profile registry | `APPDATA` (win32) / `XDG_CONFIG_HOME`, `lib/takt-config-path.ts` | enumerates and attaches to the operator's saved projects |
| PTY broker descriptor | `os.tmpdir()/.pm-<identity>`, `brokerPaths()` | attaches to a live broker and sends it `shutdown` on `session_shutdown`, stopping a running TAKT process |
| TAKT global config / CLI | `TAKT_CONFIG_DIR`, `TAKT_COMMAND` | reads the operator's workflows and presets, can start a real `takt` run |

Setting only `PI_CODING_AGENT_DIR` and `PI_OFFLINE` therefore does not isolate
the smoke. The earlier harness did exactly that and reached a live broker.

## What the harness does now

`scripts/pi-sdk-smoke-isolation.mjs` builds one throwaway root per run and hands
every host an environment where:

- `APPDATA`/`XDG_CONFIG_HOME` and `HOME`/`XDG` point inside the root,
- `TEMP`/`TMP`/`TMPDIR` point inside the root, so `os.tmpdir()` — and therefore
  the broker descriptor directory — is test-owned,
- the fake broker's Unix socket uses a short path (see below), because macOS
  limits a Unix socket path to 104 bytes,
- `PI_CODING_AGENT_DIR` points inside the root, and inherited `PI_*` variables
  are dropped,
- `TAKT_CONFIG_DIR` points inside the root and `TAKT_COMMAND` points at a
  managed fake TAKT CLI (records each invocation, answers only the read-only
  `list`/`root` commands),
- credential-shaped variables (`*_API_KEY`, `*_TOKEN`, `*_SECRET`,
  `AWS_*`, `AZURE_*`, …) are dropped.

A managed fake PTY broker (`tests/fixtures/fake-takt-broker.mjs`) implements the
descriptor protocol of `lib/takt-run-controller.ts` without owning a PTY. It
records every connection and request, so the smoke can prove which endpoint a
host reached.

## Unix socket length

macOS stores a Unix socket path in `sockaddr_un.sun_path`, which is 104 bytes
including the NUL terminator (Linux: 108), and `server.listen()` fails with
`EINVAL` beyond it. A hosted macOS runner `TMPDIR` is already ~55 bytes, so
nesting the socket under the run's `tempRoot`, `.pm-<identity>` and a label
produced 109-122 byte paths and the broker died before publishing its descriptor
— `fake TAKT broker <label> did not become ready (exit 1, descriptor missing)`.
`fakeBrokerSocketPath()` therefore keeps only the descriptor in
`tempRoot/.pm-<identity>` and places the socket at the first candidate that fits
`UNIX_SOCKET_PATH_LIMIT_BYTES`: the run's own `tempRoot`, then `/tmp`. The token
in the name keeps both unique, the broker unlinks it on shutdown and
`close()` unlinks it again.
`tests/pi-sdk-smoke-isolation.test.mjs` covers the limit with a long temp root
and a short base, so the regression reproduces on any platform.

## Assertions

The `extension_load` case carries the run-level isolation evidence:

| ID | Fails when |
| --- | --- |
| `smoke_config_isolated` | no host reached the isolated endpoint, or the operator-shaped bait endpoint/registry was touched |
| `child_process_env_isolated` | a child inheriting the smoke environment resolves temp, registry, Pi agent, TAKT config or TAKT command outside the test root |
| `no_mutating_takt_command` | the fake TAKT CLI saw `run`, `exec`, `clear`, `resume` or `stop` |
| `bait_endpoint_detectable` | the negative-control host did not attach to the control endpoint and shut it down — without this, the bait fixture would be vacuous |

The Bait endpoint and registry are never reachable from the isolated hosts. The
control endpoint is deliberately reached by one extra host so that "nothing
happened" cannot pass as "isolation worked".

## Boundaries

- The real Pi host, extension loader/lifecycle and `/takt:mode` feature stay
  real; only provider inference is omitted and only the registry, broker and
  TAKT CLI are fixtures.
- No user-level file is read or written, and no real TAKT process is started.
  `TAKT_COMMAND` also guards paths the assertions cannot observe directly.
- `tests/pi-sdk-smoke-isolation.test.mjs` covers the environment contract,
  the Unix socket length limit and each assertion's negative case;
  `tests/pi-sdk-smoke-fake-broker.test.mjs` checks the fixture against the real
  controller's attach/shutdown protocol.
