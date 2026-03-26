import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "../examples/libs/php/test/**/*.test.ts", "../examples/wordpress/test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
  },
});
