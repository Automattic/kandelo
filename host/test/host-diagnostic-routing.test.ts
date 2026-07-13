import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

const entries = [
  ["Node", join(repoRoot, "host/src/node-kernel-worker-entry.ts")],
  ["browser", join(repoRoot, "host/src/browser-kernel-worker-entry.ts")],
] as const;

describe.each(entries)("%s kernel-worker diagnostic routing", (_name, path) => {
  const source = readFileSync(path, "utf8");

  it("reserves stderr protocol messages for the kernel's real onStderr bytes", () => {
    const stderrPosts = source.match(/type:\s*"stderr"/g) ?? [];
    expect(stderrPosts).toHaveLength(1);
    expect(source).toMatch(/onStderr:[\s\S]{0,160}type:\s*"stderr"/);
  });

  it("routes lifecycle, protocol, exec, clone, and thread failures as host diagnostics", () => {
    for (const diagnosticSource of [
      "worker protocol",
      "worker-main error message",
      "exec post-commit transition",
      "clone allocation",
      "thread worker failure",
    ]) {
      expect(source).toContain(`source: "${diagnosticSource}"`);
    }
    expect(source).toContain("reportHostDiagnostic({");
  });
});
