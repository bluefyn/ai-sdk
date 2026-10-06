/**
 * The unit test config, used by `npm test`.
 *
 * Specs are TypeScript, transformed by @swc/jest to CommonJS. The Vercel AI SDK (`ai`, `@ai-sdk/*`)
 * and a few of its dependencies ship ESM only, so they are transformed too instead of being ignored;
 * when a future release pulls in another ESM-only package, jest's "Unexpected token 'export'"
 * error names it — add it to ESM_ONLY.
 */
const ESM_ONLY = ['ai', '@ai-sdk', '@workflow', 'eventsource', 'eventsource-parser', 'json-schema-typed', 'nanoid'];
const escape = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

module.exports = {
  displayName: 'ai-spend-sdk',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  // `*.live-spec.ts` (real provider calls) never match: they run only through jest.live.config.cts.
  testMatch: ['**/*.spec.ts'],
  // The spec that drives the REAL Vercel AI SDK needs Node >= 22 (the `engines` of `ai` 7); on the
  // package's Node 20 floor the adapter's own specs (vercel.spec.ts) still run.
  testPathIgnorePatterns: ['/node_modules/', ...(Number(process.versions.node.split('.')[0]) < 22 ? ['/vercel\\.ai-sdk\\.spec\\.ts$'] : [])],
  transform: {
    '^.+\\.[cm]?[tj]s$': [
      '@swc/jest',
      {
        jsc: { target: 'es2022', parser: { syntax: 'typescript' }, keepClassNames: true },
        module: { type: 'commonjs' },
      },
    ],
  },
  // npm (`node_modules/ai/…`) and pnpm (`node_modules/.pnpm/ai@x/…`, scopes as `@ai-sdk+…`) layouts.
  transformIgnorePatterns: [
    `node_modules/(?!\\.pnpm/(?:${ESM_ONLY.map((n) => (n.startsWith('@') ? `${escape(n)}\\+` : `${escape(n)}@`)).join('|')})|(?:${ESM_ONLY.map(escape).join('|')})/)`,
  ],
  moduleFileExtensions: ['ts', 'js', 'mjs', 'cjs', 'json'],
  coverageDirectory: '<rootDir>/coverage',
};
