import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workers = [
  ["Node", "node-kernel-worker-entry.ts", "rootfsMemfs"],
  ["browser", "browser-kernel-worker-entry.ts", "memfs"],
] as const;

describe.each(workers)("%s package-prefetch worker", (
  _name,
  filename,
  rootName,
) => {
  const source = readFileSync(resolve("src", filename), "utf8");

  it("dispatches through the shared resolver on the worker-owned root", () => {
    expect(source).toContain("prefetchHomebrewPackageClosures");
    expect(source).toContain('case "prefetch_homebrew_packages"');
    expect(source).toMatch(new RegExp(
      `prefetchHomebrewPackageClosures\\(\\s*${rootName}`,
      "u",
    ));
  });
});
