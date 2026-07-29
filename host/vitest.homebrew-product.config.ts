import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/lazy-tree.test.ts",
      "test/lazy-archive.test.ts",
      "test/package-deferred-tree.test.ts",
      "test/sharedfs-safety.test.ts",
      "test/vfs-image.test.ts",
      "test/homebrew-runtime-support.test.ts",
      "test/homebrew-support-data-bottle.test.ts",
      "test/homebrew-vfs-fetch.test.ts",
      "test/homebrew-vfs-builder.test.ts",
      "test/homebrew-vfs-image-save.test.ts",
      "test/derived-vfs-symlink.test.ts",
      "test/dinit-image-helpers.test.ts",
    ],
    pool: "forks",
    maxWorkers: 2,
  },
});
