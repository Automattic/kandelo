import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parsePackageRuntimeFileContract,
  readPackageRuntimeFileContract,
} from "../../scripts/package-runtime-file";
import { findRepoRoot } from "../src/binary-resolver";

function metadata(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    artifact: "icu.dat",
    guest_path: "/usr/lib/php/icu.dat",
    mode: 0o644,
    mirror_path: "php/icu.dat",
    closure_mirror_paths: ["php/php.wasm", "php/intl.so", "php/icu.dat"],
    ...overrides,
  });
}

describe("package runtime-file closure metadata", () => {
  it("reports every declared PHP output and runtime file", () => {
    const contract = readPackageRuntimeFileContract(
      findRepoRoot(),
      "php",
      "icu.dat",
    );
    expect(contract.closureMirrorPaths).toEqual([
      "php/php.wasm",
      "php/php-fpm.wasm",
      "php/curl.so",
      "php/phar.so",
      "php/zend_test.so",
      "php/zip.so",
      "php/intl.so",
      "php/icu.dat",
    ]);
  }, 120_000);

  it("uses an explicitly prepared xtask without ambient host tools", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-metadata-"));
    const xtask = join(root, "xtask");
    writeFileSync(
      xtask,
      `#!/bin/sh
[ "$#" = 4 ]
[ "$1" = build-deps ]
[ "$2" = runtime-file-metadata ]
[ "$3" = php ]
[ "$4" = icu.dat ]
printf '%s\\n' '${metadata()}'
`,
    );
    chmodSync(xtask, 0o755);
    const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
    const hadSavedXtask = Object.prototype.hasOwnProperty.call(
      process.env,
      "WASM_POSIX_XTASK_BIN",
    );
    const savedPath = process.env.PATH;
    const hadSavedPath = Object.prototype.hasOwnProperty.call(
      process.env,
      "PATH",
    );
    process.env.WASM_POSIX_XTASK_BIN = xtask;
    process.env.PATH = "";
    try {
      expect(readPackageRuntimeFileContract(findRepoRoot(), "php", "icu.dat"))
        .toEqual({
          artifact: "icu.dat",
          guestPath: "/usr/lib/php/icu.dat",
          mode: 0o644,
          mirrorPath: "php/icu.dat",
          closureMirrorPaths: [
            "php/php.wasm",
            "php/intl.so",
            "php/icu.dat",
          ],
        });
    } finally {
      if (hadSavedXtask) {
        process.env.WASM_POSIX_XTASK_BIN = savedXtask ?? "";
      } else {
        delete process.env.WASM_POSIX_XTASK_BIN;
      }
      if (hadSavedPath) {
        process.env.PATH = savedPath ?? "";
      } else {
        delete process.env.PATH;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("runs the xtask cargo built when CARGO_TARGET_DIR redirects output", () => {
    // xtask local-build exports a private CARGO_TARGET_DIR into every package
    // recipe (the shell package reaches this code from build-shell.sh). Real
    // cargo honors it, so the built xtask is NOT under <repo>/target; a fresh
    // worktree has nothing there and a stale one holds an older binary.
    const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-metadata-"));
    const repo = join(root, "repo");
    const bin = join(root, "bin");
    const recipeTarget = join(root, "recipe-cargo-target");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFileSync(
      join(bin, "rustc"),
      "#!/bin/sh\nprintf 'rustc fake\\nhost: fake-host-target\\n'\n",
    );
    // Behaves like cargo for this purpose: output follows CARGO_TARGET_DIR,
    // and artifact JSON is emitted only when --message-format=json* asks.
    writeFileSync(
      join(bin, "cargo"),
      `#!/bin/sh
set -eu
json=0
for arg in "$@"; do
  case "$arg" in --message-format=json*) json=1 ;; esac
done
out="\${CARGO_TARGET_DIR:-$PWD/target}/fake-host-target/release"
/bin/mkdir -p "$out"
/bin/cat > "$out/xtask" <<'XTASK'
#!/bin/sh
printf '%s\\n' '${metadata()}'
XTASK
/bin/chmod 755 "$out/xtask"
if [ "$json" = 1 ]; then
  printf '{"reason":"compiler-artifact","package_id":"path+file:///x/tools/xtask#0.1.0","target":{"kind":["bin"],"name":"xtask"},"executable":"%s"}\\n' "$out/xtask"
  printf '{"reason":"build-finished","success":true}\\n'
fi
`,
    );
    chmodSync(join(bin, "rustc"), 0o755);
    chmodSync(join(bin, "cargo"), 0o755);
    const names = [
      "WASM_POSIX_XTASK_BIN",
      "KANDELO_DEV_SHELL_TOOL_PATH",
      "CARGO_TARGET_DIR",
      "PATH",
    ] as const;
    const saved = new Map(
      names.map((name) => [name, process.env[name]] as const),
    );
    delete process.env.WASM_POSIX_XTASK_BIN;
    process.env.KANDELO_DEV_SHELL_TOOL_PATH = bin;
    process.env.CARGO_TARGET_DIR = recipeTarget;
    process.env.PATH = bin;
    try {
      expect(readPackageRuntimeFileContract(repo, "php", "icu.dat"))
        .toMatchObject({ artifact: "icu.dat", mirrorPath: "php/icu.dat" });
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects a prepared xtask path that is not a regular file", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-runtime-metadata-"));
    const savedXtask = process.env.WASM_POSIX_XTASK_BIN;
    const hadSavedXtask = Object.prototype.hasOwnProperty.call(
      process.env,
      "WASM_POSIX_XTASK_BIN",
    );
    process.env.WASM_POSIX_XTASK_BIN = root;
    try {
      expect(() =>
        readPackageRuntimeFileContract(findRepoRoot(), "php", "icu.dat")
      ).toThrow(/Prepared xtask is not a regular file/);
    } finally {
      if (hadSavedXtask) {
        process.env.WASM_POSIX_XTASK_BIN = savedXtask ?? "";
      } else {
        delete process.env.WASM_POSIX_XTASK_BIN;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate or incomplete closure path metadata", () => {
    expect(() => parsePackageRuntimeFileContract(
      metadata({
        closure_mirror_paths: ["php/php.wasm", "php/icu.dat", "php/icu.dat"],
      }),
      "php",
      "icu.dat",
    )).toThrow(/invalid runtime-file metadata/);

    expect(() => parsePackageRuntimeFileContract(
      metadata({ closure_mirror_paths: ["php/php.wasm", "php/intl.so"] }),
      "php",
      "icu.dat",
    )).toThrow(/invalid runtime-file metadata/);
  });

  it("rejects closure mirror traversal before binary resolution", () => {
    expect(() => parsePackageRuntimeFileContract(
      metadata({
        closure_mirror_paths: ["php/php.wasm", "../outside", "php/icu.dat"],
      }),
      "php",
      "icu.dat",
    )).toThrow(/invalid runtime-file metadata/);
  });
});
