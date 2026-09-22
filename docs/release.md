# Release

Releases are `vX.Y.Z` git tags that publish the root package through npm
Trusted Publishing (OIDC); they never use `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

## Automated path (default)

`.github/workflows/auto-release.yml` runs on every push to `main` that changes
`package.json`:

1. merge a PR that bumps `version` in `package.json` and `package-lock.json`
   and adds the matching `CHANGELOG.md` section;
2. the workflow creates and pushes the `vX.Y.Z` tag, opens the GitHub release,
   and dispatches `publish.yml` for that tag;
3. `publish.yml` runs `npm ci`, `npm run ci`, and `npm publish --access public`
   with provenance.

No manual `git tag` is needed, and the workflow skips the push when the version
is unchanged or the tag already exists.

## Manual path

Push the tag yourself when a release must bypass the merge path:

```bash
npm run ci
git diff --check
git tag vX.Y.Z
git push origin vX.Y.Z
```

`publish.yml` also supports `workflow_dispatch` for an existing tag.

## One-time setup

Configure npm Trusted Publishing for package `pi-takt-marionette`, repository
`eiei114/pi-takt-marionette`, workflow `publish.yml`.
