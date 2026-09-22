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

Release `pi-takt-marionette` by bumping `version` in `package.json` and
`package-lock.json` in the PR that prepares the release:

```bash
npm version <patch|minor|major> --no-git-tag-version
```

Add the matching `CHANGELOG.md` section, then merge. A `package.json` version
change on `main` creates the `vX.Y.Z` tag and publishes through npm Trusted
Publishing; do not add long-lived npm tokens to GitHub Secrets. See
`docs/release.md` for the full flow, the manual tag path, and Trusted
Publisher settings.
