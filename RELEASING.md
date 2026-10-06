# Releasing @bluefyn/ai-spend-sdk

A release is a version bump merged to `main` and a `vX.Y.Z` tag on that commit. The tag starts [`.github/workflows/publish.yml`](.github/workflows/publish.yml), which runs the checks again and publishes the package to npm with provenance.

Publish through the workflow only. Never run `npm publish` by hand. `.npmrc` sets `ignore-scripts=true`, so nothing builds on `npm publish`, and `dist/` is never committed. A manual publish from a fresh checkout would ship a package with no code. To stop that, `package.json` sets `"private": true`, and npm refuses the publish with `EPRIVATE`. The workflow's `Publish` step removes `private` right before it runs `npm publish`, after every check has passed.

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

- If the publish fails after the tag exists, fix forward. Bump to the next patch version and release that.
- Never delete or move a tag. A published version's provenance names the commit it was built from, and a moved tag would point at different code.
- To stop people from installing a bad release, run `npm deprecate @bluefyn/ai-spend-sdk@X.Y.Z "<reason>"` and release a fix. Do not unpublish.

## One-time setup

Do these steps once, in this order, before the first release. Each step needs an owner of the account it names.

1. **Confirm that Bluefyn owns the `@bluefyn` npm scope.** Sign in to npm with a Bluefyn account and run `npm org ls bluefyn`. It must list Bluefyn people as `owner` or `admin`. If the command fails or lists people you do not know, stop and find out who controls the org.
2. **Protect `main`.** In the repository settings, add a branch ruleset for `main` that requires a pull request with one approving review, requires the `Check` status check, and blocks force pushes and deletion. GitHub does not count the author's own approval. A sole maintainer needs a second reviewer, or a bypass for repository admins in the ruleset.
3. **Protect the release tags.** Add a tag ruleset for `v*` that restricts creation, update and deletion, with the release managers on its bypass list.
4. **Turn on private vulnerability reporting**, which [`SECURITY.md`](SECURITY.md) tells reporters to use. It is under Settings → Advanced Security.
5. **Create the `npm-publish` environment.** Settings → Environments → **New environment** `npm-publish`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add only the tag rule `v*`. To have a person approve each publish, add required reviewers.
6. **Add the bootstrap token.** npm adds a trusted publisher only to a package that already exists ([npm/cli#8544](https://github.com/npm/cli/issues/8544)), so the first publish uses a token.
   1. On npmjs.com, create a granular access token with **Read and write** on the `@bluefyn` scope. Tick **Bypass two-factor authentication**, because the workflow cannot answer a 2FA prompt. Set the shortest expiry that covers the release, such as 7 days.
   2. In the `npm-publish` environment, add the token as the environment secret `NPM_TOKEN`. Do not add it as a repository secret, because a repository secret is readable from every branch.

   npm has announced that tokens which bypass 2FA lose the right to publish in January 2027. If the first release has not happened by then, this step no longer works. Revisit it with npm's staged publishing first.
7. **Check that the production ingest route is live.** The SDK sends to `https://gateway.bluefyn.ai/api` by default. The route must answer `401` (no key), not `404`:

   ```sh
   curl -s -o /dev/null -w '%{http_code}\n' -X POST https://gateway.bluefyn.ai/api/v1/ai-usage/events
   ```

8. **Release 0.2.0.** `package.json` already says 0.2.0, so start at step 5 of [Release a version](#release-a-version) and tag the `main` commit whose `Check` job passed. The `Publish` step warns "publishing with the NPM_TOKEN bootstrap secret". That warning is expected for this release only.
9. **Switch to trusted publishing and delete the token.**
   1. On npmjs.com, open `@bluefyn/ai-spend-sdk` → **Settings** → **Trusted publishing** and add a **GitHub Actions** publisher: organization `bluefyn`, repository `ai-sdk`, workflow filename `publish.yml`, environment `npm-publish`. If the form asks for allowed actions, allow `npm publish`.
   2. Under **Publishing access**, choose **Require two-factor authentication and disallow tokens**. Trusted publishing still works.
   3. Delete the `NPM_TOKEN` secret from the `npm-publish` environment, and delete the token on npmjs.com.

   The next release authenticates with OIDC, and the workflow needs no edit. Without the secret, `npm publish` runs with no token, and npm exchanges the job's OIDC token for a publish token. If that publish fails, the step's error names what to check.
