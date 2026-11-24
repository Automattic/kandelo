import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/rust-first-host-boundary.test.ts"] },
});
