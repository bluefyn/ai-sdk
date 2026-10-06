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

## Run the live contract tests

The live contract tests check that each adapter records exactly the usage that the provider reported for the same call. They make small, real calls to Anthropic and OpenAI, and send one event to a Bluefyn ingest API. `npm test` never runs them.

The variables they need are listed at the top of `src/live/adapters.live-spec.ts`. To run them on your machine, set those variables and run `npx jest --config jest.live.config.cts`. `openai` is not a dev dependency, so the OpenAI tests load it from the directory that `AI_SPEND_SDK_LIVE_PEERS_DIR` names.

### Run them in CI

[`.github/workflows/live-contract.yml`](.github/workflows/live-contract.yml) runs the same tests every Monday at 06:17 UTC, and whenever a maintainer starts it. Pull requests and pushes never start it, so code from a fork or an unmerged branch never runs with its secrets.

The workflow reads these secrets of the `live-contract` environment. A group of tests runs only when its secrets are set.

| Secret | Value | Tests it runs |
| --- | --- | --- |
| `AI_SPEND_SDK_LIVE_ANTHROPIC_KEY` | An Anthropic API key | `wrapAnthropic`, and the Vercel adapter with `@ai-sdk/anthropic` |
| `AI_SPEND_SDK_LIVE_OPENAI_KEY` | An OpenAI API key | `wrapOpenAI`, and the Vercel adapter with `@ai-sdk/openai` |
| `AI_SPEND_SDK_LIVE_INGEST_KEY` | A Bluefyn SDK key (`bfu_...`) | The ingest test, together with the URL |
| `AI_SPEND_SDK_LIVE_INGEST_URL` | The API base of the Bluefyn environment that issued the key, such as `https://gateway.bluefyn.ai/api` | The ingest test, together with the key |

To set up the environment, a repository admin does this once:

1. In Settings → Environments, create the environment `live-contract`. If a run of the workflow created it first, open it instead. Under **Deployment branches and tags**, choose **Selected branches and tags** and add only `main`. A run started on another branch then cannot read the secrets. Do not add required reviewers, because a scheduled run would wait for an approval.
2. Add the secrets as environment secrets of `live-contract`, not as repository secrets.

Anyone with write access to the repository can start a run. Open **Actions** → **Live contract** → **Run workflow**, and run it on `main`.

If no group of tests has its secrets, a scheduled run ends with a notice and tests nothing. A run started by hand fails instead.

The log of a run shows only the name and status of each test. A failure message can hold token counts and provider error text, and the logs of this repository are public. To see why a test failed, run the tests on your machine.

A run makes four Anthropic calls and seven OpenAI calls, and every call sends the same one-sentence prompt. Each Anthropic call allows at most 16 output tokens. Six of the OpenAI calls allow at most 256 output tokens each, and the seventh is an embedding, which has no output tokens. The ingest test adds one usage event, for the customer `live-contract` and the feature `sdk.live_contract`, to the tenant that owns the ingest key.

The workflow installs `openai` at the exact version it names. Dependabot does not update that version, so raise it by hand. GitHub turns off a scheduled workflow in a public repository after 60 days without activity in the repository. To turn it back on, open the workflow in the **Actions** tab.

## Open a pull request

- Add a test for each change in behavior. The test calls the SDK the way an application does and asserts the result.
- Add a line to `CHANGELOG.md` under the `## Unreleased` heading at the top of the file. If the heading is missing, add it.
- If the change touches the wire payload, a default, or a supported peer version, say so in the pull request description. [RELEASING.md](RELEASING.md) explains how that changes the version and why a wire change ships server first.
- Leave the version unchanged. The release pull request bumps it.
- If you change `README.md`, `npm run check-docs` must still pass. A link to a section of the [AI Spend SDK guide](https://app.bluefyn.ai/docs/ai-spend-sdk) must use an anchor from `GUIDE_ANCHORS` in `scripts/check-docs.mjs`.

## Send metadata only

The SDK sends metadata about each model call: the provider, the model, token counts, status, latency, and the ids the application attaches. It never reads or sends prompts, completions, tool arguments, embeddings, or images. An adapter reads the usage numbers from a provider's response and nothing from its content.

A pull request that captures any of that content is not merged, even behind an option that is off by default.
