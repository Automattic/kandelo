import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isWithinRealDirectory } from "../../examples/run-example-paths";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const runExample = join(repoRoot, "examples", "run-example.ts");
const spawnSmokeWasm = join(repoRoot, "examples", "spawn-smoke.wasm");

describe("run-example exec resolver", () => {
  it("compares canonical workdir paths without allowing symlink escapes", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kandelo-workdir-boundary-"));
    const realWorkdir = join(tempDir, "real-workdir");
    const workdirAlias = join(tempDir, "workdir-alias");
    const outsideDir = join(tempDir, "outside");
    const guestProgram = join(realWorkdir, "guest-program");
    const outsideProgram = join(outsideDir, "host-program");
    const escapedProgram = join(realWorkdir, "escaped-program");
    try {
      mkdirSync(realWorkdir);
      mkdirSync(outsideDir);
      writeFileSync(guestProgram, "guest");
      writeFileSync(outsideProgram, "host");
      symlinkSync(realWorkdir, workdirAlias, "dir");
      symlinkSync(outsideProgram, escapedProgram, "file");

      expect(isWithinRealDirectory(workdirAlias, guestProgram)).toBe(true);
      expect(isWithinRealDirectory(workdirAlias, escapedProgram)).toBe(false);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("does not resolve native host executables outside KERNEL_CWD as guest programs", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "kandelo-host-native-"));
    const nativeLikeBinary = join(tempDir, "host-tool");
    try {
      writeFileSync(nativeLikeBinary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));

      const result = spawnSync(
        process.execPath,
        [
          "--experimental-wasm-exnref",
          "--import",
          "tsx/esm",
          runExample,
          spawnSmokeWasm,
          nativeLikeBinary,
        ],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            KERNEL_CWD: repoRoot,
            TIMEOUT: "30000",
          },
          encoding: "utf8",
          timeout: 45_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("No such file or directory");
      expect(result.stderr).not.toContain("Exec format error");
      expect(result.stderr).not.toContain("WebAssembly.compile()");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
