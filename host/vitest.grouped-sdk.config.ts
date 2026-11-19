import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// These prepared-product cases compile their own C executables through the
// normal SDK in beforeAll. They require the normally built/pinned kernel and
// image module, but none of the unrelated global program-fixture inventory.
export default defineConfig({
  ...base,
  test: { ...base.test, globalSetup: [], include: ['test/grouped-sdk-execution.test.ts', 'test/grouped-session-runtime.test.ts'], maxWorkers: 1 },
});
