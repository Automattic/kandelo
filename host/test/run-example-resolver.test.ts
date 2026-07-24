import { describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { isWithinRealDirectory } from "../../examples/run-example-paths";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..", "..");
const hostRoot = join(repoRoot, "host");
const runExample = join(repoRoot, "examples", "run-example.ts");
const spawnSmokeWasm = join(repoRoot, "examples", "spawn-smoke.wasm");

describe("run-example exec resolver", () => {
  it("loads unrelated examples without probing legacy flat paths for multi-member packages", () => {
    const source = readFileSync(runExample, "utf8");
    const projection = JSON.parse(
      readFileSync(
        join(repoRoot, "packages", "registry", "program-packages.json"),
        "utf8",
      ),
    ) as {
      packages: Record<string, {
        members: Array<{ kind: string; mirrorPath: string }>;
      }>;
    };
    const probes = new Set(
      [...source.matchAll(/tryResolveBinary\("([^"]+)"\)/g)]
        .map((match) => match[1]),
    );
    const legacyMultiMemberProbes: string[] = [];
    for (const packageProjection of Object.values(projection.packages)) {
      if (packageProjection.members.length < 2) continue;
      for (const member of packageProjection.members) {
        if (member.kind !== "output") continue;
        const basename = member.mirrorPath.split("/").at(-1);
        if (basename && probes.has(`programs/${basename}`)) {
          legacyMultiMemberProbes.push(`programs/${basename}`);
        }
      }
    }
    expect(legacyMultiMemberProbes).toEqual([]);

    const cacheRoot = mkdtempSync(join(tmpdir(), "kandelo-run-example-load-"));
    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx/esm", runExample],
        {
          cwd: repoRoot,
          env: {
            ...process.env,
            // This intentionally does not match any checked-out binaries
            // mirror. No-argument usage must return before package probing;
            // otherwise this sentinel cache makes the test fail closed.
            WASM_POSIX_BINARY_CACHE_ROOT: cacheRoot,
            WASM_POSIX_DEPS_REGISTRY: "packages/registry",
          },
          encoding: "utf8",
          timeout: 30_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Usage: npx tsx examples/run-example.ts <name>",
      );
      expect(result.stderr).not.toContain("Legacy flat resolver path");
      expect(result.stderr).not.toContain("Package artifact closure");
    } finally {
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });

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
          cwd: hostRoot,
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
