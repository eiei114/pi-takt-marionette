# Contributing

Thanks for helping improve this Pi package.

## Development

```bash
npm install
npm run ci
```

## Local Pi testing

```bash
pi -e .
```

## Pull requests

Before opening a PR:

- Run `npm run ci`
- Update docs when behavior changes
- Update `CHANGELOG.md` for user-facing changes
- Keep package contents small and intentional
- Run `npm pack --dry-run` when you add, remove, or rename `docs/` files so `package.json` `files` matches what you ship

## Release

Merging a version bump does not publish. Releases are an explicit authorized
action, gated by three independent barriers:

1. `auto-release.yml` is `workflow_dispatch` only; it has no `push` trigger.
2. The release job runs in the protected `release` environment, whose deployment
   branch policy allows only `main`.
3. The dispatch requires `release_authorized=true`.

```bash
gh workflow run auto-release.yml --ref main -f release_authorized=true
```

`tests/release-trigger-contract.test.mjs` enforces this shape and fails if any
barrier is removed. See [`docs/release.md`](docs/release.md) for the full policy.
