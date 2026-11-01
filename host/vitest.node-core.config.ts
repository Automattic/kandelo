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
      'test/node-assertion-semantics.test.ts',
      'test/node-positioned-io.test.ts',
      'test/node-response-body.test.ts',
      'test/node-network-attempts.test.ts',
      'test/node-module-entrypoints.test.ts',
      'test/node-call-sites.test.ts',
      'test/node-fatal-exit.test.ts',
      'test/node-exit-listeners.test.ts',
      'test/node-tcp-server.test.ts',
      'test/node-timers.test.ts',
      'test/node-sync-processes.test.ts',
      'test/node-socket-timeouts.test.ts',
      '../tests/package-system/nodejs-harness.test.ts',
    ],
    maxWorkers: 1,
    fileParallelism: false,
  },
};
