import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildVforkSideModuleFixture } from "./vfork-side-module-fixture";

function withOutputRoot(operation: (outputRoot: string) => void): void {
  const outputRoot = mkdtempSync(join(tmpdir(), "kandelo-vfork-side-test-"));
  try {
    operation(outputRoot);
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

describe("vfork side-module fixture lifecycle", () => {
  it("removes its build directory idempotently", () => {
    withOutputRoot((outputRoot) => {
      const fixture = buildVforkSideModuleFixture({ outputRoot });
      const buildDir = dirname(fixture.programPath);
      expect(existsSync(buildDir)).toBe(true);

      fixture.cleanup();
      expect(existsSync(buildDir)).toBe(false);
      expect(() => fixture.cleanup()).not.toThrow();
      expect(readdirSync(outputRoot)).toEqual([]);
    });
  });

  it("removes its build directory when compilation fails", () => {
    withOutputRoot((outputRoot) => {
      expect(() => buildVforkSideModuleFixture({
        outputRoot,
        clangDriver: join(outputRoot, "missing-clang"),
      })).toThrow();
      expect(readdirSync(outputRoot)).toEqual([]);
    });
  });
});
