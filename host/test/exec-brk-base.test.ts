/**
 * Regression tests for the brk-base bug — mariadbd's `__wasm_call_ctors`
 * hung inside C++ static initialization when the kernel's hardcoded
 * `INITIAL_BRK` (16 MB) sat below mariadbd's `__heap_base` (~16.32 MB),
 * because malloc placed the heap inside the new program's stack region.
 *
 * The fix (`crates/kernel/src/wasm_api.rs::kernel_set_brk_base`) installs
 * `__heap_base` as the initial brk for every spawned/exec'd process, so
 * `brk(0)` returns a value above the data + stack region.
 *
 * The bug only surfaces when mariadbd is reached via an INTERMEDIATE
 * shell layer (dinit→sh→mariadbd or dash-exec→/bin/sh→mariadbd), because
 * the previous brk-preservation across exec advanced brk just enough on
 * each layer to push it into the stack region by the time mariadbd loaded.
 *
 * Tests skip when:
 *   - dash + mariadbd binaries aren't built/cached
 *   - cached binaries' `__abi_version` doesn't match the running kernel
 *     (i.e. the binaries-abi-v7 release hasn't been cut + fetched yet)
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { NodeKernelHost } from "../src/node-kernel-host";
import { extractAbiVersion } from "../src/constants";
import { tryResolveBinary, findRepoRoot } from "../src/binary-resolver";

// Read the kernel's expected ABI version from `glue/abi_constants.h`,
// which `scripts/check-abi-version.sh` keeps in sync with
// `crates/shared/src/lib.rs::ABI_VERSION`.
function readKernelAbiVersion(): number {
  const header = readFileSync(join(findRepoRoot(), "glue/abi_constants.h"), "utf-8");
  const m = header.match(/#define\s+WASM_POSIX_ABI_VERSION\s+(\d+)u?/);
  if (!m) throw new Error("could not parse glue/abi_constants.h for WASM_POSIX_ABI_VERSION");
  return parseInt(m[1], 10);
}
const ABI_VERSION_EXPECTED = readKernelAbiVersion();

function findCachedBinary(name: string, arch = "wasm32"): string | null {
  const cacheRoot = join(homedir(), ".cache/wasm-posix-kernel/programs");
  if (!existsSync(cacheRoot)) return null;
  for (const dir of readdirSync(cacheRoot)) {
    if (!dir.includes(`-${arch}-`)) continue;
    const candidate = join(cacheRoot, dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function locate(local: string, cacheName: string): string | null {
  const fromResolver = tryResolveBinary(local);
  if (fromResolver && existsSync(fromResolver)) return fromResolver;
  return findCachedBinary(cacheName);
}

const dashBinary = locate("programs/dash.wasm", "dash.wasm");
const mariadbdBinary = locate("programs/mariadb/mariadbd.wasm", "mariadbd.wasm");

function abiOf(path: string | null): number | null {
  if (!path) return null;
  const buf = readFileSync(path);
  return extractAbiVersion(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

const dashAbi = abiOf(dashBinary);
const mariadbdAbi = abiOf(mariadbdBinary);

const compatible =
  !!dashBinary && !!mariadbdBinary &&
  dashAbi === ABI_VERSION_EXPECTED && mariadbdAbi === ABI_VERSION_EXPECTED;

if (!compatible) {
  // eslint-disable-next-line no-console
  console.warn(
    `[exec-brk-base] skipping: dash=${dashBinary ? `abi=${dashAbi}` : "missing"} ` +
      `mariadbd=${mariadbdBinary ? `abi=${mariadbdAbi}` : "missing"} ` +
      `kernel-abi=${ABI_VERSION_EXPECTED}`,
  );
}

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

interface RunResult {
  exitCode: number;
  stderr: string;
  elapsed: number;
}

async function runDashCommand(cmd: string, timeoutMs = 25_000): Promise<RunResult> {
  let stderr = "";
  const exeMap: Record<string, string> = {
    "/bin/dash": dashBinary!,
    "/bin/sh": dashBinary!,
    "dash": dashBinary!,
    "sh": dashBinary!,
    "/usr/sbin/mariadbd": mariadbdBinary!,
    "/usr/bin/mariadbd": mariadbdBinary!,
    "mariadbd": mariadbdBinary!,
  };

  const host = new NodeKernelHost({
    maxWorkers: 8,
    onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
    onResolveExec: (path) => {
      const m = exeMap[path];
      return m && existsSync(m) ? loadBytes(m) : null;
    },
  });
  await host.init();

  const t0 = Date.now();
  try {
    const exitPromise = host.spawn(loadBytes(dashBinary!), ["/bin/sh", "-c", cmd], {
      env: ["PATH=/usr/sbin:/usr/bin:/bin", "HOME=/tmp"],
      cwd: "/tmp",
    });
    const timeoutPromise = new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), timeoutMs),
    );
    const exitCode = await Promise.race([exitPromise, timeoutPromise]);
    return { exitCode, stderr, elapsed: Date.now() - t0 };
  } finally {
    await host.destroy().catch(() => {});
  }
}

const SQL_PATH = join(tmpdir(), "wpk-brk-test", "bootstrap.sql");
mkdirSync(join(tmpdir(), "wpk-brk-test"), { recursive: true });
writeFileSync(SQL_PATH, "SELECT 1;\n");

const MARIADB_ARGS =
  "--no-defaults --bootstrap --skip-networking --skip-grant-tables " +
  "--datadir=/tmp --tmpdir=/tmp";

// What looked like a "spin loop" was a cascade of two wasm-port bugs:
//
//   1. musl-overlay/arch/wasm32posix/atomic_arch.h didn't override
//      `a_crash`, so the generic `*(volatile char *)0 = 0` fallback was
//      used. On Linux x86 address 0 is unmapped → SIGSEGV (clean abort);
//      on wasm32 address 0 is the start of valid linear memory, so the
//      write succeeds silently. Every mallocng / pthread / stdio
//      assertion was therefore a no-op on our port — including
//      mallocng's `assert(meta->mem == base)` in get_meta(). mariadbd's
//      atexit destructor chain happens to double-free a few InnoDB
//      pointers; mallocng caught the second free and called a_crash(),
//      which on wasm just dirtied byte 0, then proceeded with a corrupt
//      meta pointer. Eventually nontrivial_free dereferenced past the
//      memory bound and the wasm runtime trapped with "memory access
//      out of bounds" — far from the actual bug.
//
//   2. host/src/node-kernel-worker-entry.ts only handled the `error`
//      message type from process workers, not `exit`. When the proper
//      a_crash trapped via `__builtin_trap()`, worker-main.ts caught
//      the unreachable trap (treating it as normal _Exit semantics)
//      and posted `{type:"exit",pid,status:0}`. With no listener for
//      that message, the host kept waiting for an exit that never came.
//
// Both fixes land in this PR. The underlying mariadbd 10.5 atexit
// double-free is its own bug — it doesn't repro on Alpine 3.13 (same
// musl 1.2.2 + mallocng), so it's specific to how mariadbd's static
// destructors get invoked under our wasm-target compilation; not
// pursued further here. The clean-trap behaviour preserves the
// "InnoDB started" stderr output these tests actually assert against.
describe.skipIf(!compatible)("brk-base regression: mariadbd bootstrap via dash-exec", () => {
  // Sanity: dash exec's mariadbd directly, no intermediate shell layer.
  it("dash → exec mariadbd: boots InnoDB", async () => {
    const r = await runDashCommand(`exec /usr/sbin/mariadbd ${MARIADB_ARGS} < ${SQL_PATH}`);
    expect(r.stderr).toContain("InnoDB");
    expect(r.stderr).toContain("started");
  });

  // Bug case 1: dash exec's /bin/sh which then exec's mariadbd. Pre-fix
  // this hung silently in __wasm_call_ctors because the chain advanced
  // brk into mariadbd's stack region.
  it("dash → exec /bin/sh → exec mariadbd: boots InnoDB", async () => {
    const r = await runDashCommand(
      `exec /bin/sh -c "exec /usr/sbin/mariadbd ${MARIADB_ARGS} < ${SQL_PATH}"`,
    );
    expect(r.stderr).toContain("InnoDB");
    expect(r.stderr).toContain("started");
  });

  // Bug case 2: dash forks /bin/sh which forks mariadbd. The dinit-shape
  // chain (PID 1 → fork sh → fork mariadbd) — this is the original
  // mariadbd-bootstrap-hangs-in-wasm-port-during-kernel reproducer.
  it("dash → fork /bin/sh → fork mariadbd: boots InnoDB", async () => {
    const r = await runDashCommand(
      `/bin/sh -c "/usr/sbin/mariadbd ${MARIADB_ARGS} < ${SQL_PATH}"`,
    );
    expect(r.stderr).toContain("InnoDB");
    expect(r.stderr).toContain("started");
  });
});
