import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const resolver = join(repoRoot, "scripts", "resolve-binary.sh");
let fakeRepo: string;

beforeEach(() => {
  fakeRepo = mkdtempSync(join(tmpdir(), "kandelo-resolve-binary-"));
  mkdirSync(join(fakeRepo, "abi"), { recursive: true });
  mkdirSync(join(fakeRepo, "crates", "shared", "src"), { recursive: true });
  mkdirSync(join(fakeRepo, "local-binaries", "programs", "wasm32"), {
    recursive: true,
  });
  writeFileSync(join(fakeRepo, "Cargo.toml"), "[workspace]\nmembers = []\n");
  writeFileSync(join(fakeRepo, "abi", "snapshot.json"), "{}\n");
  writeFileSync(
    join(fakeRepo, "crates", "shared", "src", "lib.rs"),
    "pub const ABI_VERSION: u32 = 39;\n",
  );
});

afterEach(() => rmSync(fakeRepo, { recursive: true, force: true }));

function runResolver(relPath: string) {
  return spawnSync(resolver, [relPath], {
    cwd: fakeRepo,
    encoding: "utf8",
  });
}

describe("resolve-binary", () => {
  it("resolves declared non-Wasm program artifacts without Wasm ABI checks", () => {
    const zipPath = join(
      fakeRepo,
      "local-binaries",
      "programs",
      "wasm32",
      "vim.zip",
    );
    writeFileSync(zipPath, "not a Wasm module");

    const result = runResolver("programs/vim.zip");
    expect(result.status).toBe(0);
    expect(realpathSync(result.stdout.trim())).toBe(realpathSync(zipPath));
  });

  it("continues to reject Wasm program artifacts without a current ABI", () => {
    const wasmPath = join(
      fakeRepo,
      "local-binaries",
      "programs",
      "wasm32",
      "vim.wasm",
    );
    writeFileSync(
      wasmPath,
      Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    );

    const result = runResolver("programs/vim.wasm");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("stale wasm artifact ignored");
  });
});
