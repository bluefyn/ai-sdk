# Releasing @bluefyn/ai-spend-sdk

A release is a version bump merged to `main` and a `vX.Y.Z` tag on that commit. The tag starts [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which runs the checks again and publishes the package to npm with provenance. The workflow authenticates to npm by trusted publishing, so no npm token is involved.

Publish through the workflow only. Never run `npm publish` by hand. `.npmrc` sets `ignore-scripts=true`, so nothing builds on `npm publish`, and `dist/` is never committed. A manual publish from a fresh checkout would ship a package with no code. To stop that, `package.json` sets `"private": true`, and npm refuses the publish with `EPRIVATE`. The workflow's `Publish` step removes `private` right before it runs `npm publish`, after every check has passed. [0.2.0](#how-020-was-published) is the one version published by hand.

## Choose the version

The SDK follows [Semantic Versioning](https://semver.org/). Before 1.0.0, a minor release (0.x.0) can change the API, and a patch release (0.x.y) only fixes bugs.

- A bug fix is a patch.
- A new adapter or option is a minor.
- A change to the wire payload, to a default, or to a supported peer version is at least a minor. Call it out in the pull request and in `CHANGELOG.md`.
- A breaking API change is a minor before 1.0.0 and a major after it.

A wire change ships server first. Bluefyn's production ingest API must accept a new or changed field before an SDK release sends it. An ingest API that does not know a field drops it with a `field_dropped` warning or rejects the event, and that data is lost for every customer on the new version.

## Release a version

1. In one pull request, set the new version in `package.json` (`version`) and in `src/wire.ts` (`AI_SPEND_SDK_VERSION`). Every event reports `AI_SPEND_SDK_VERSION` as `sdk.version`.
2. In the same pull request, rename the `## Unreleased` heading of `CHANGELOG.md` to `## X.Y.Z`. If there is no `## Unreleased` section, write the version's entry.
3. Wait for the `Check` job of CI to pass. To run the same checks locally:

   ```sh
   npm ci && npm run typecheck && node scripts/check-version.mjs && npm test && npm run build && npm run check-docs
   ```

4. Merge the pull request to `main`.
5. Tag the merge commit and push the tag:

   ```sh
   git fetch origin main
   git tag -a vX.Y.Z -m vX.Y.Z <merge commit sha>
   git push origin vX.Y.Z
   ```

6. Watch the **Publish to npm** run in the Actions tab. If the `npm-publish` environment has required reviewers, approve the deployment. A prerelease version such as `1.2.0-beta.1` goes to the `next` dist-tag. Every other version goes to `latest`.
7. Check the release:

   ```sh
   npm view @bluefyn/ai-spend-sdk@X.Y.Z version
   # in an empty project:
   npm install @bluefyn/ai-spend-sdk@X.Y.Z && npm audit signatures
   ```

   `npm view` prints the version. `npm audit signatures` reports a verified registry signature and a verified attestation for the package.

## What the publish workflow checks

The workflow publishes nothing unless every step passes, in this order:

1. The tag is `vX.Y.Z`, with an optional `-<prerelease>` suffix.
2. The tagged commit is on `main`.
3. The version guard passes with the tag's version.
4. That version is not on npm yet.
5. `npm ci`, the typecheck, the unit tests, `npm run check-docs`, `npm run build` (which runs the smoke test), `npm pack --dry-run` and `node scripts/compat-check.mjs --matrix min` pass.

The version guard is `scripts/check-version.mjs`. It fails unless the `version` of `package.json` equals `AI_SPEND_SDK_VERSION` in `src/wire.ts`. Given an argument, it also fails unless that argument equals both. CI runs it on every pull request without an argument. The publish workflow passes the tag's version.

## Fix a failed or bad release

- If the run failed because of a setting outside the repository, such as the trusted publisher on npmjs.com or the `npm-publish` environment, fix the setting and re-run the failed job. The version is not on npm yet, so the run passes the `Not published yet` check again.
- If the run failed because of the tagged commit, or the version is on npm already, fix forward. Bump to the next patch version and release that.
- Never delete or move a tag. A published version's provenance names the commit it was built from, and a moved tag would point at different code.
- To stop people from installing a bad release, run `npm deprecate @bluefyn/ai-spend-sdk@X.Y.Z "<reason>"` and release a fix. Do not unpublish.

## One-time setup

0.2.0 is on npm, so npm can now add a trusted publisher to the package. Do these steps once, before the next release. Each step needs an owner of the account it names.

1. **Protect `main`.** In the repository settings, add a branch ruleset for `main` that requires a pull request with one approving review, requires the `Check` status check, and blocks force pushes and deletion. GitHub does not count the author's own approval. A sole maintainer needs a second reviewer, or a bypass for repository admins in the ruleset.
2. **Protect the release tags.** Add a tag ruleset for `v*` that restricts creation, update and deletion, with the release managers on its bypass list.
3. **Turn on private vulnerability reporting**, which [`SECURITY.md`](SECURITY.md) and the issue chooser tell reporters to use. It is under Settings → Advanced Security.
4. **Create the `npm-publish` environment.** Settings → Environments → **New environment** `npm-publish`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add only the tag rule `v*`. To have a person approve each publish, add required reviewers. If the environment has an `NPM_TOKEN` secret, delete it. The workflow does not read it.
5. **Add the trusted publisher.** On npmjs.com, open `@bluefyn/ai-spend-sdk` → **Settings** → **Trusted publishing** and add a **GitHub Actions** publisher with these values. Each value must match exactly.

   | Field | Value |
   | --- | --- |
   | Organization or user | `bluefyn` |
   | Repository | `ai-sdk` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm-publish` |

   The workflow filename is the file name only, without `.github/workflows/`. If the form asks for allowed actions, allow `npm publish`.
6. **Disallow tokens.** In the same **Settings** page, under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing still works.

The next release is the first run that uses the trusted publisher. If its `Publish` step fails, the error names the values to compare, and [Fix a failed or bad release](#fix-a-failed-or-bad-release) says how to retry.

## How 0.2.0 was published

npm adds a trusted publisher only to a package that already exists ([npm/cli#8544](https://github.com/npm/cli/issues/8544)). So the first version could not come from the workflow without an npm token, and 0.2.0 was published by hand, once:

- On 2026-10-06, a maintainer published a clean build of commit `3e456e7`, the first commit on `main`, from a laptop. npm recorded that commit as the version's `gitHead`, and `npm view @bluefyn/ai-spend-sdk@0.2.0 _npmUser` shows the account.
- The maintainer signed in to npm on the website, with two-factor authentication in the browser.
- The publish used `--provenance=false`, because npm generates provenance only in a supported CI system. So 0.2.0 has a registry signature and no provenance attestation, and `npm audit signatures` verifies only its signature.

The repository has no `v0.2.0` tag. A tag push runs `publish.yml` as it is in the tagged commit, and that workflow's `Not published yet` step fails, because 0.2.0 is on npm already. A `v0.2.0` tag would only start a failed run.

Every later version is published from its tag by the workflow, with provenance.
