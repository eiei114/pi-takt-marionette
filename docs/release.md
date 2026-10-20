# Release

Releases are `vX.Y.Z` git tags that publish the root package through npm Trusted
Publishing (OIDC). They never use `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

Merging a version bump does **not** publish. Releases are an explicit authorized
action.

## Authorization barriers

Publication requires all of the following, independently. Removing any one of
them fails closed; `tests/release-trigger-contract.test.mjs` enforces the shape.

1. **`workflow_dispatch` only.** `auto-release.yml` has no `push` or `release`
   trigger, so a merge runs CI only.
2. **The protected `release` environment.** The release job declares
   `environment: release`, whose deployment branch policy allows only `main`.
   The environment can additionally require reviewer approval before the job
   starts. A `github.ref` condition inside branch-editable workflow code is not a
   boundary on its own; the environment is.
3. **`release_authorized: true`.** The dispatch input is `required: true` and
   defaults to `false`.

## How to release

```bash
gh workflow run auto-release.yml --ref main -f release_authorized=true
```

The workflow then:

1. reads `package.json` `version`, refusing anything that is not stable semver;
2. skips when `v<version>` already exists, or when the version matches the last
   released tag;
3. creates and pushes the `v<version>` tag;
4. creates the GitHub Release with a changelog compare link;
5. dispatches `publish.yml` for that tag.

`publish.yml` runs `npm ci`, the repository CI, and `npm publish --access public`
with provenance. It skips `name@version` when that exact version already exists
on npm, so a re-dispatch is idempotent.

## One-time npm setup

Configure npm Trusted Publishing for package `pi-takt-marionette`, repository
`eiei114/pi-takt-marionette`, workflow `publish.yml`.

## Why not on merge

An earlier shape created the tag and release from a `push` to `main`. That made
merge permission equivalent to publish permission and removed the human decision
from publication. The current shape keeps the decision explicit and auditable.
