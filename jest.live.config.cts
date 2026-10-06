const { join } = require('node:path');
const unit = require('./jest.config.cjs');

/**
 * Live contract tests: tiny REAL Anthropic / OpenAI calls through the adapters, and an SDK →
 * ingest smoke (see src/live/adapters.live-spec.ts for the variables). Never part of the unit
 * run — the testMatch of jest.config.cjs does not match `*.live-spec.ts`. Run with
 * `npx jest --config jest.live.config.cts`.
 *
 * Builds on jest.config.cjs. Set AI_SPEND_SDK_LIVE_PEERS_DIR to a directory with `openai` installed
 * (`npm install --prefix <dir> openai`) when it is not installed here; its node_modules joins the
 * module paths.
 */
const peersDir = process.env.AI_SPEND_SDK_LIVE_PEERS_DIR?.trim();

module.exports = {
  ...unit,
  displayName: 'ai-spend-sdk-live',
  testMatch: ['**/*.live-spec.ts'],
  ...(peersDir ? { modulePaths: [join(peersDir, 'node_modules')] } : {}),
  testTimeout: 120_000,
  maxWorkers: 1,
};
