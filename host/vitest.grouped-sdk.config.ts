import { defineConfig } from 'vitest/config';
import base from './vitest.config.ts';

// Prepared-product cases use the normally built/pinned Rust kernel. SDK cases
// compile their own C executables; boundary cases connect that real kernel to
// host transport. Neither needs the unrelated global program-fixture inventory.
export default defineConfig({
  ...base,
  test: { ...base.test, globalSetup: [], include: ['test/grouped-sdk-execution.test.ts', 'test/grouped-session-runtime.test.ts', 'test/grouped-root-launch.test.ts', 'test/exec-state-tracking.test.ts', 'test/group-memory-kernel.test.ts', 'test/group-memory-worker-boundary.test.ts'], maxWorkers: 1 },
});
