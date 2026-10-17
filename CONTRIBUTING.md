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

Release and npm publication are disabled until a trusted external authorization
boundary for those privileged actions is configured and verified. The current
repository has no protected release environment or release ruleset, so the
branch-controlled workflow conditions are not sufficient authorization.

Do not create or push a `vX.Y.Z` tag expecting it to publish the package. This
repository currently has no automated or manual release path. An owner must
establish and verify the required GitHub protection outside this repository
before restoring any release or publication workflow. This repository does not
configure credentials, permissions, environments, or approval rules. See
[`docs/release.md`](docs/release.md) for the full current policy.
