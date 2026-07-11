/**
 * Runs a real libc guest through the centralized Node host and verifies the
 * Linux-compatible procfs resource-accounting surface consumed by lxtask.
 * The C fixture owns the field-level parsing so this test covers guest-visible
 * directory, stat, stdio, and sysconf behavior rather than Rust helpers alone.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const fixture = join(repoRoot, "examples/procfs_accounting_test.wasm");

describe("procfs resource accounting guest contract", () => {
  it("reports logical sizes while unsupported resource metrics stay zero", async () => {
    expect(existsSync(fixture), `missing global-setup output: ${fixture}`).toBe(true);

    const result = await runCentralizedProgram({
      programPath: fixture,
      argv: ["procfs_accounting_test"],
      timeout: 15_000,
      useDefaultRootfs: false,
      execPrograms: new Map([
        ["/usr/bin/procfs-accounting-test", fixture],
      ]),
    });

    expect(result.exitCode, `stdout=${result.stdout}\nstderr=${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("IDENTITY euid=1000 egid=1000");
    expect(result.stdout).toContain("PROC enumeration stat=1 meminfo=1 self_pid=1");
    expect(result.stdout).toMatch(/STATM size_pages=[1-9]\d* unsupported_fields_zero=1/);
    expect(result.stdout).toMatch(/TASK main_tid=\d+ owner=1000:1000/);
    expect(result.stdout).toMatch(
      /STAT nice=7 vsize_bytes=[1-9]\d* rss_pages=0 owner=1000:1000/,
    );
    expect(result.stdout).toMatch(/CPU aggregate_fields=\d+ all_zero=1/);
    expect(result.stdout).toContain("MEMINFO required_fields=5 all_zero=1");
    expect(result.stdout).toContain("NPROCESSORS online=1 configured=1");
    expect(result.stdout).toMatch(
      /FOREIGN pid=\d+ owner=1000:1000 statm_pages=[1-9]\d* main_tid=1/,
    );
    expect(result.stdout).toContain("PASS procfs_accounting_test");
  });
});
