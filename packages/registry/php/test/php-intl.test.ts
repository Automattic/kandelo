import { beforeAll, describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../../host/src/vfs/image-helpers";
import { resolvePackageRuntimeFile } from "../../../../scripts/package-runtime-file";

const __dirname = dirname(fileURLToPath(import.meta.url));
const icuRuntime = resolvePackageRuntimeFile(
  join(__dirname, "../../../.."),
  "php",
  "icu.dat",
);

// intl is a RUNTIME-OPTIONAL side module: base php.wasm is built with
// --enable-intl=shared, so intl is NOT compiled in. intl.so is loaded on
// demand via `extension=intl.so`, and pulls its ICU common data from the
// separate icu.dat at runtime (udata_setCommonData in intl-icu-data-loader.c).
const phpBinaryPath =
  icuRuntime?.closureHostPaths.get("php/php.wasm") ??
  join(__dirname, "../php-src/sapi/cli/php");
const intlSoPath = icuRuntime?.closureHostPaths.get("php/intl.so");
const rootfsPath =
  tryResolveBinary("rootfs.vfs") ??
  tryResolveBinary("programs/rootfs.vfs") ??
  join(__dirname, "../../../../host/wasm/rootfs.vfs");
const INTL_GUEST_PATH = "/usr/lib/php/extensions/intl.so";
const PHP_INTL_VFS_MAX_BYTES = 256 * 1024 * 1024;
const O_RDONLY = 0;

if (intlSoPath && !icuRuntime) {
  throw new Error(
    "PHP intl.so is present but the declared php:icu.dat runtime file is not materialized",
  );
}

const READY = existsSync(phpBinaryPath)
  && intlSoPath != null
  && existsSync(rootfsPath);
let intlRootfsImage: Uint8Array;

function readVfsBinary(fs: KandeloImageFs, path: string): Uint8Array {
  return fs.readFile(path);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// RETIRED 2026-09-17: "authenticates an imported v3 rootfs before rebasing".
//
// It planted a sealed lazy-atomic tree with `host/test/lazy-atomic-seal-
// fixture.ts`, called `verifyImportedLazyAtomicGroupSeals()`, and asserted the
// rebased filesystem still carried the tree. The fixture was deleted with the
// host's own seal verification (`0cd9fec21`), so THIS FILE HAS BEEN FAILING TO
// COMPILE SINCE THEN — a census that grepped `host/` for callers missed this
// one under `packages/`, the same miss as `tools/mkrootfs/test/cli.test.ts`.
//
// The claim it made is now inherent rather than tested here: `loadImage`
// authenticates every cohort seal because `rootfs::load_image` does, so an
// image that reaches the rebase below is one whose cohorts checked out, and
// there is no separate verification a caller can forget. Where the refusal
// itself is asserted: `seal.rs`'s seventeen unit tests, `rootfs.rs`'s
// `a_load_refuses_an_image_whose_cohorts_do_not_authenticate`, and the CLI
// boundary case in `tools/mkrootfs/test/cli.test.ts`.

describe.skipIf(!READY)("PHP intl as a runtime-loadable side module", () => {
  beforeAll(async () => {
    // THE LOAD AUTHENTICATES, and the rebase is a declared ceiling rather
    // than a new filesystem. `rebaseToNewFileSystem` copied a whole tree into
    // a second buffer of the requested size, because capacity was an
    // allocation; the module records the ceiling the export will declare and
    // copies nothing.
    const fs = KandeloImageFs.create();
    fs.loadImage(new Uint8Array(readFileSync(rootfsPath)));
    fs.setImageCapacity(PHP_INTL_VFS_MAX_BYTES);
    ensureDirRecursive(fs, dirname(INTL_GUEST_PATH));
    ensureDirRecursive(fs, dirname(icuRuntime!.guestPath));
    writeVfsBinary(
      fs,
      INTL_GUEST_PATH,
      new Uint8Array(readFileSync(intlSoPath!)),
      0o755,
    );
    const icuBytes = new Uint8Array(readFileSync(icuRuntime!.hostPath));
    writeVfsBinary(
      fs,
      icuRuntime!.guestPath,
      icuBytes,
      icuRuntime!.mode,
    );
    const stagedIcuBytes = readVfsBinary(fs, icuRuntime!.guestPath);
    expect(stagedIcuBytes.byteLength).toBe(icuBytes.byteLength);
    expect(sha256(stagedIcuBytes)).toBe(sha256(icuBytes));
    intlRootfsImage = await fs.saveImage();
  });

  // Proves the base binary is genuinely ICU-free / intl-free: intl only
  // appears when explicitly loaded. This is the whole point of the design.
  it("base php.wasm does NOT include intl", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-m"],
      rootfsImage: intlRootfsImage,
    });
    expect(exitCode).toBe(0);
    expect(stdout.toLowerCase()).not.toContain("intl");
  }, 60_000);

  it("loads intl.so at runtime via extension=", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${INTL_GUEST_PATH}`, "-r",
        'echo extension_loaded("intl") ? "intl-loaded" : "intl-missing";'],
      rootfsImage: intlRootfsImage,
    });
    expect(stdout).toContain("intl-loaded");
    expect(exitCode).toBe(0);
  }, 60_000);

  // Exercises real ICU data (locale display names) to prove icu.dat is
  // actually loaded and usable, not just that the module registered.
  it("intl uses ICU data (Locale::getDisplayLanguage)", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${INTL_GUEST_PATH}`, "-r",
        'echo Locale::getDisplayLanguage("fr", "en");'],
      rootfsImage: intlRootfsImage,
    });
    expect(stdout).toContain("French");
    expect(exitCode).toBe(0);
  }, 60_000);

  // Collator sorting is a core ICU service that requires collation data.
  it("intl Collator sorts with locale rules", async () => {
    const { stdout, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${INTL_GUEST_PATH}`, "-r", `
        $c = new Collator("en_US");
        $a = ["banana", "apple", "cherry"];
        $c->sort($a);
        echo implode(",", $a);
      `],
      rootfsImage: intlRootfsImage,
    });
    expect(stdout).toContain("apple,banana,cherry");
    expect(exitCode).toBe(0);
  }, 60_000);

  // dlopen occurs before fork. The child therefore replays intl.so without
  // rerunning constructors and must retain ICU's common-data pointer from the
  // copied process image; exercising ICU in both branches verifies that real
  // side-module replay contract rather than only the synthetic linker shape.
  it("intl and icu.dat survive pcntl_fork replay", async () => {
    const { stdout, stderr, exitCode } = await runCentralizedProgram({
      programPath: phpBinaryPath,
      argv: ["php", "-d", `extension=${INTL_GUEST_PATH}`, "-r", `
        $before = Locale::getDisplayLanguage("fr", "en");
        $pid = pcntl_fork();
        if ($pid < 0) { fwrite(STDERR, "fork-failed"); exit(20); }
        if ($pid === 0) {
          $child = Locale::getDisplayLanguage("fr", "en");
          echo "child=" . $child . "\\n";
          exit($child === "French" ? 0 : 21);
        }
        $status = 0;
        $waited = pcntl_waitpid($pid, $status);
        $c = new Collator("en_US");
        $a = ["banana", "apple", "cherry"];
        $c->sort($a);
        echo "parent=" . $before . ":" . implode(",", $a) . "\\n";
        if ($waited !== $pid || !pcntl_wifexited($status) || pcntl_wexitstatus($status) !== 0) {
          fwrite(STDERR, "child-status=" . $status);
          exit(22);
        }
      `],
      rootfsImage: intlRootfsImage,
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("child=French");
    expect(stdout).toContain("parent=French:apple,banana,cherry");
    expect(exitCode).toBe(0);
  }, 60_000);
});
