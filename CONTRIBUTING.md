# Contributing to @bluefyn/ai-spend-sdk

This repository is where the SDK is developed and released. Bug reports and pull requests are welcome.

## Report a bug

Open an issue with the [bug report form](https://github.com/bluefyn/ai-sdk/issues/new/choose). It asks for the SDK version, the Node.js version, the runtime, the adapter, and the output of `aiSpend.stats()`. Never paste an SDK key (`bfu_...`) or a provider API key into an issue.

To report a security vulnerability, do not open an issue. Follow [SECURITY.md](SECURITY.md). For questions about your Bluefyn account, email [support@bluefyn.ai](mailto:support@bluefyn.ai).

## Set up the repository

Use Node.js 24 for development. CI also runs the tests on Node.js 20.16.0 and 22.3.0, the lowest versions that `engines` allows.

```sh
npm ci
```

`.npmrc` sets `ignore-scripts=true`, so `npm ci` runs no install scripts of any dependency.

## Run the checks

CI's `Check` job runs these commands. Run them before you open a pull request:

```sh
npm run typecheck                            # sources and specs
npm test                                     # unit tests
npm run build                                # dist/ (CommonJS and ESM), then a smoke test of every entry point
npm run check-docs                           # every ts block of README.md compiles against the built types
node scripts/compat-check.mjs --matrix min   # the packed tarball beside the lowest tested peer versions
```

`compat-check.mjs` needs `dist/`, so run `npm run build` first. `check-docs` and `compat-check.mjs` install packages from the npm registry and need network access.

The live contract tests make small, real calls to Anthropic and OpenAI, and `npm test` never runs them. The variables they need are listed at the top of `src/live/adapters.live-spec.ts`. To run them, set those variables and run `npx jest --config jest.live.config.cts`.

## Open a pull request

- Add a test for each change in behavior. The test calls the SDK the way an application does and asserts the result.
- Add a line to `CHANGELOG.md` under the `## Unreleased` heading at the top of the file. If the heading is missing, add it.
- If the change touches the wire payload, a default, or a supported peer version, say so in the pull request description. [RELEASING.md](RELEASING.md) explains how that changes the version and why a wire change ships server first.
- Leave the version unchanged. The release pull request bumps it.
- If you change `README.md`, `npm run check-docs` must still pass. A link to a section of the [AI Spend SDK guide](https://app.bluefyn.ai/docs/ai-spend-sdk) must use an anchor from `GUIDE_ANCHORS` in `scripts/check-docs.mjs`.

## Send metadata only

The SDK sends metadata about each model call: the provider, the model, token counts, status, latency, and the ids the application attaches. It never reads or sends prompts, completions, tool arguments, embeddings, or images. An adapter reads the usage numbers from a provider's response and nothing from its content.

A pull request that captures any of that content is not merged, even behind an option that is off by default.
