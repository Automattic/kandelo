import base from './vitest.config.ts';

// These tests are classified source-only in the evidence registry. They use
// real shared functions/native subprocesses and need no guest or C fixtures.
export default {
  ...base,
  test: {
    ...base.test,
    globalSetup: [],
    include: [
      'test/node-buffer-encoding.test.ts',
      'test/node-url-exit-contracts.test.ts',
      'test/node-text-decoder.test.ts',
      '../tests/package-system/nodejs-harness.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
