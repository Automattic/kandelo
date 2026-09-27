# Honest Program Links and Kernel-Owned Host Stdin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every executable link fail when it needs a function the platform does not provide, and make host-supplied stdin an ordinary kernel pipe that parent and child processes share.

**Architecture:** One declaration in `crates/shared` of the `env` imports the host really provides is turned by the ABI generator into a checked-in symbol file (`libc/glue/kandelo-host-imports.txt`) that every link uses in place of `--allow-undefined`, and into a generated TypeScript list the host uses to refuse anything else at load time. The host's JavaScript stand-ins for C++ runtime functions move into the C++ runtime first, so the declaration stays honest. Separately, a new kernel export replaces fd 0 with the read end of a bounded kernel pipe; the host's `setStdinData`/`appendStdinData` write into it through the existing host-pipe exports, and the per-pid stdin buffers and the `onStdin` callback are deleted.

**Tech Stack:** Rust (`crates/shared`, `crates/runtime-core`, `crates/kernel`, `tools/xtask`), TypeScript host (`host/src`), SDK wrapper (`sdk/src`), bash build scripts, wasm-ld, musl, libc++/libc++abi, Vitest, Playwright, libc-test / POSIX / sortix conformance suites.

**Spec:** `docs/plans/2026-09-27-honest-links-and-kernel-stdin-design.md` (approved 2026-09-27). Read it first; section numbers below refer to it.

## Global Constraints

- One `ABI_VERSION` bump for the whole PR: 43 → 44 in `crates/shared/src/lib.rs`, with `abi/snapshot.json` and generated files regenerated in the same commit (Task 1). Later tasks that change the ABI regenerate under 44; they do not bump again.
- The link-time allowance is generated, never hand-edited. Single source: the declaration in `crates/shared`. Single generated artifact for links: `libc/glue/kandelo-host-imports.txt`.
- Executables never link with `--allow-undefined` again. Side modules (`SHARED_LINK_FLAGS`, `-shared`) keep it (spec §3.4).
- The host never invents an `env` import. An undeclared `env` import refuses instantiation with an error that names it.
- No JavaScript implementations of C or C++ library functions remain in `host/src/worker-main.ts` (spec §4).
- Host stdin is a kernel pipe; `stdinBuffers`, `stdinFinite`, and the `onStdin` callback are deleted, not left dormant. The PTY path is unchanged.
- Node and browser hosts both validated for every host change.
- All build and verification commands run under `scripts/dev-shell.sh`.
- Commit subjects `Area: Purpose` (`ABI:`, `SDK:`, `Host:`, `Kernel:`, `Packages:`, `Tests:`, `Docs:`); commit bodies wrapped at 72 columns; PR description one line per paragraph with `## Why` first.
- Package breakages are fixed at their own layer (spec §5, §4 of the FFmpeg design's triage rule): no Kandelo-named patches, no hand-seeded `HAVE_*` to paper over a missing function.
- Stop and ask the maintainer before changing PHP's feature set (spec §8), and before any fix that changes a package's user-visible features.

## Review Focus

1. **A configure check for a function that exists only in a library the program did not ask for** (e.g. `-liconv` omitted): must fail the check, not pass by borrowing another archive. Test: Task 2, "configure-style check reports a missing function as absent".
2. **A C++ program with a function-local `static` object used from two threads**: guard acquire/release must still serialize initialization after the host stand-ins are removed. Test: Task 4, `cxx_runtime_test.cpp` "static-local guard".
3. **A child that reads part of inherited stdin and exits, then the parent reads the rest**: one shared offset, no lost or repeated bytes. Test: Task 8, "parent and child share one stdin offset".
4. **Stdin much larger than the pipe (tens of MB)**: must arrive complete and in order, with bounded kernel memory. Test: Task 8, "delivers input larger than the pipe in order".
5. **Keyboard input to a framebuffer demo while the program is blocked in `read(0)`**: must wake immediately. Test: Task 9, the existing fbDOOM and Quake Playwright specs.

---

### Task 1: Declare the host's `env` imports and generate the allowance

**Files:**
- Modify: `crates/shared/src/lib.rs` (new declaration next to `PROCESS_EXPECTED_GLOBALS`, line ~1955; `ABI_VERSION` 43 → 44 at line 121)
- Modify: `tools/xtask/src/dump_abi.rs` (snapshot section, TS export, new generated file)
- Create (generated): `libc/glue/kandelo-host-imports.txt`
- Modify (generated): `abi/snapshot.json`, `host/src/generated/abi.ts`
- Test: `tools/xtask/src/dump_abi.rs` `#[cfg(test)]` module

**Interfaces:**
- Produces: `shared::abi::HOST_ENV_IMPORTS: &[HostEnvImport]` where `pub struct HostEnvImport { pub name: &'static str, pub kind: HostEnvImportKind, pub link_time: bool, pub reason: &'static str }` and `pub enum HostEnvImportKind { Function, Global, Memory, Table, Tag }`.
- Produces: TS `export const HOST_ENV_IMPORTS: readonly { name: string; kind: "function" | "global" | "memory" | "table" | "tag" }[]` in `host/src/generated/abi.ts`.
- Produces: `libc/glue/kandelo-host-imports.txt`, one name per line, sorted, containing exactly the entries with `link_time: true`.

- [ ] **Step 1: Inventory what the host provides.** Read `host/src/worker-main.ts` from `const envImports` (~line 2358) to the import object (~line 2740), plus `dlopenImports` and `forkEnvImports`. Classify every name:
  - platform service → declaration: `memory`, `__channel_base`, `__wasm_dlopen_prepare`, `__wasm_dlopen_next`, `__wasm_dlopen_main`, `__wasm_dlsym`, `__wasm_dlclose`, `__wasm_dlerror`, `__wasm_posix_vm_interrupt_after`, `__c_longjmp`, `__cpp_exception`, and every `env` entry of the generated `WPK_FORK_REQUIRED_IMPORTS` plus `FORK_UNWIND_TAG_IMPORT_NAME` (`link_time: false` for fork entries — they are added after linking);
  - library function → Task 4, not declared: `_Znwm`, `_Znam`, `_ZdlPv`, `_ZdlPvm`, `_ZdaPv`, `_ZdaPvm`, `_ZnwmRKSt9nothrow_t`, `_ZnamRKSt9nothrow_t`, `__cxa_atexit`, `__cxa_guard_acquire`, `__cxa_guard_release`, `__cxa_guard_abort`, `__cxa_pure_virtual`, `__dynamic_cast`, `__cxa_thread_atexit`, `_ZNSt3__122__libcpp_verbose_abortEPKcz`, `_ZNSt3__16__sortIRNS_6__lessIyyEEPyEEvT0_S5_T_`.
  Record the classified list in the task's ledger line. If the host provides anything not listed here, classify it the same way.

- [ ] **Step 2: Write the failing generator test** in `dump_abi.rs`'s test module:

```rust
#[test]
fn host_env_imports_generate_one_link_allowance() {
    let names: Vec<&str> = shared::abi::HOST_ENV_IMPORTS
        .iter()
        .filter(|i| i.link_time)
        .map(|i| i.name)
        .collect();
    let rendered = render_host_imports_file();
    let lines: Vec<&str> = rendered.lines().collect();
    let mut sorted = names.clone();
    sorted.sort();
    assert_eq!(lines, sorted, "allowance file must list exactly the link-time imports, sorted");
    for fake in ["_Znwm", "__cxa_thread_atexit", "__dynamic_cast"] {
        assert!(!lines.contains(&fake), "{fake} is a library function, not a host service");
    }
    for real in ["__wasm_dlsym", "__wasm_posix_vm_interrupt_after", "__channel_base"] {
        assert!(lines.contains(&real), "{real} must be allowed at link time");
    }
    assert!(!lines.iter().any(|l| l.starts_with("__wpk_fork_")), "fork imports are added after linking");
    let ts = render_ts_module();
    assert!(ts.contains("export const HOST_ENV_IMPORTS"));
}
```

- [ ] **Step 3: Run it.** `scripts/dev-shell.sh bash -c 'cargo test -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" host_env_imports'`. Expected: compile error — `HOST_ENV_IMPORTS` / `render_host_imports_file` not defined.

- [ ] **Step 4: Implement.** In `crates/shared/src/lib.rs` `pub mod abi`, add the struct, enum, and `HOST_ENV_IMPORTS` from Step 1 (fork entries built from the same constants the generated `WPK_FORK_REQUIRED_IMPORTS` comes from, so they cannot drift). Bump `ABI_VERSION` to 44. In `dump_abi.rs`: add a `host_env_imports()` snapshot section (sorted `[{name, kind, link_time}]`), emit `HOST_ENV_IMPORTS` in `render_ts_module()`, add `render_host_imports_file()` returning the sorted link-time names joined by `\n` with a trailing newline, write it to `libc/glue/kandelo-host-imports.txt`, and add it to the `--check` branch with `check_file(...)` like the other generated files.

- [ ] **Step 5: Regenerate and pass.** `scripts/dev-shell.sh bash -c 'cargo run -p xtask --target "$(rustc -vV | awk "/^host/ {print \$2}")" --quiet -- dump-abi'`, then rerun Step 3's test. Expected: PASS. Run `bash scripts/check-abi-version.sh` and the `dump-abi --check` mode. Expected: both pass.

- [ ] **Step 6: Record the epoch.** Add the ABI 44 entry to `docs/abi-versioning.md` (what changed: declared host `env` imports, load-time refusal, host stdin pipe export; consequence: every artifact rebuilt).

- [ ] **Step 7: Commit.** Subject: `ABI: Declare the env imports the host provides`.

---

### Task 2: The SDK links against the allowance

**Files:**
- Modify: `sdk/src/lib/flags.ts` (`linkFlags` signature and body)
- Modify: `sdk/src/bin/cc.ts:373` (pass the allowance path)
- Test: `sdk/test/honest-link.test.ts` (new)

**Interfaces:**
- Consumes: `libc/glue/kandelo-host-imports.txt` (Task 1); `toolchain.glueDir` (`sdk/src/lib/toolchain.ts:40`).
- Produces: `linkFlags(arch: WasmArch, hostImportsFile: string, mainThreadStackSizeBytes?: number): string[]` — emits `-Wl,--allow-undefined-file=<hostImportsFile>` and never `-Wl,--allow-undefined`.

- [ ] **Step 1: Write the failing tests** in `sdk/test/honest-link.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(__dirname, "../..");
const cc = join(repo, "sdk/bin/wasm32posix-cc");

function link(source: string, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "honest-link-"));
  const src = join(dir, "t.c");
  writeFileSync(src, source);
  return spawnSync(cc, [src, "-o", join(dir, "t.wasm"), ...extra], { encoding: "utf8" });
}

describe("honest executable links", () => {
  it("fails to link a call to a function no library defines", () => {
    const r = link("int no_such_function(void);\nint main(void){return no_such_function();}\n");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/undefined symbol: no_such_function/);
  });

  it("still links an ordinary program", () => {
    const r = link('#include <stdio.h>\nint main(void){puts("ok");return 0;}\n');
    expect(r.status, r.stderr).toBe(0);
  });

  it("configure-style check reports a missing function as absent", () => {
    // autoconf's AC_CHECK_FUNCS shape: declare, take the address, link.
    const r = link("char closesocket();\nint main(void){return closesocket();}\n");
    expect(r.status).not.toBe(0);
  });

  it("never passes --allow-undefined to wasm-ld", () => {
    const r = link("int main(void){return 0;}\n", ["-###"]);
    expect(r.stderr).not.toMatch(/--allow-undefined(?!-file)/);
    expect(r.stderr).toMatch(/--allow-undefined-file=.*kandelo-host-imports\.txt/);
  });
});
```

- [ ] **Step 2: Run.** `scripts/dev-shell.sh bash -c 'cd sdk && npx vitest run test/honest-link.test.ts'`. Expected: first, third, and fourth tests FAIL (the link succeeds; `--allow-undefined` present).

- [ ] **Step 3: Implement.** In `flags.ts` replace `'-Wl,--allow-undefined',` in `linkFlags` with `` `-Wl,--allow-undefined-file=${hostImportsFile}` `` and add the parameter; update the comment block to say why (spec §1, G2). In `cc.ts` call `linkFlags(arch, join(toolchain.glueDir, 'kandelo-host-imports.txt'), preparedStackSize)`. Leave `SHARED_LINK_FLAGS` unchanged and add a comment citing spec §3.4. Update any other `linkFlags(` callers (`grep -rn "linkFlags(" sdk/`).

- [ ] **Step 4: Run.** Same command. Expected: 4/4 PASS. Then the whole SDK suite: `cd sdk && npx vitest run`. Expected: all pass (fix any test that asserted the old flag).

- [ ] **Step 5: Commit.** Subject: `SDK: Fail links that need functions the platform lacks`.

---

### Task 3: Every other link path uses the same allowance

**Files:**
- Modify: `scripts/build-programs.sh:173,509`
- Modify: `scripts/run-libc-tests.sh:111`, `scripts/run-posix-tests.sh:80`, `scripts/run-sortix-tests.sh:156`, `scripts/run-browser-libc-tests.sh:125`, `scripts/run-browser-posix-tests.sh:93`, `scripts/run-browser-sortix-tests.sh:177`
- Modify: `packages/registry/mariadb/wasm32-posix-toolchain.cmake:98`, `packages/registry/mariadb/wasm64-posix-toolchain.cmake`, `packages/registry/espeak-ng/wasm32-posix-toolchain.cmake:90`, `packages/registry/lsof/build-lsof.sh:83`
- Create: `scripts/check-no-allow-undefined.sh` (guard) and its test `scripts/test-check-no-allow-undefined.sh`

**Interfaces:**
- Consumes: `libc/glue/kandelo-host-imports.txt`.
- Produces: `scripts/check-no-allow-undefined.sh` — exits 1 and lists every file under `scripts/`, `sdk/`, `packages/registry/`, `tools/` that passes `--allow-undefined` (not `--allow-undefined-file`) outside an explicit side-module context line marked `# side-module: dynamic linking resolves at dlopen`.

- [ ] **Step 1: Write the guard test first** (`scripts/test-check-no-allow-undefined.sh`): create a temp tree with one file containing `-Wl,--allow-undefined` and one with `-Wl,--allow-undefined-file=x`, run the guard with that tree as root, expect exit 1 naming only the first file; then a tree with only the second, expect exit 0. Run it; expected FAIL (guard missing).

- [ ] **Step 2: Write the guard** (`scripts/check-no-allow-undefined.sh <root>`), using `grep -rnE -- '--allow-undefined([^-]|$)'` and excluding lines carrying the side-module marker. Run the test; expected PASS. Run the guard on the repo; expected FAIL listing the files above.

- [ ] **Step 3: Convert each file.** Shell scripts: replace with `-Wl,--allow-undefined-file="$GLUE_DIR/kandelo-host-imports.txt"` (use the script's existing glue-dir variable; add one from `$REPO_ROOT/libc/glue` where absent). CMake toolchains: `"-Wl,--allow-undefined-file=${KANDELO_REPO_ROOT}/libc/glue/kandelo-host-imports.txt"` using whatever variable the file already uses for the repo root. Where a test runner links deliberately-shared objects (`-shared`), keep `--allow-undefined` with the side-module marker comment. Update stale comments that say "the SDK links with --allow-undefined" (`build-dri-stubs.sh`, `build-gles-stubs.sh`, `sdl2`, `sdl-dsp-test`, `tools/xtask/src/local_build.rs:615`) to describe the new contract.

- [ ] **Step 4: Conformance runners must report link failures honestly.** In each runner, a test whose program now fails to link is a FAIL with reason `link: undefined symbol …`, not a skip. Check the runner's compile-failure path and adjust if it silently skips. Rebuild the libc-test programs and run `scripts/run-libc-tests.sh`; record in the ledger every test that newly fails to link and why (each is a test calling something Kandelo lacks; it was already failing at run time). Expected list on main: none known — any entry is investigated before continuing.

- [ ] **Step 5: Guard passes.** `bash scripts/check-no-allow-undefined.sh .` → exit 0. Add the guard to the ordinary checks that `scripts/ci-run-test-suite.sh` runs (next to `check-abi-version.sh`).

- [ ] **Step 6: Commit.** Subject: `SDK: Use the generated link allowance in every link path`.

---

### Task 4: C++ runtime functions come from the C++ runtime

**Files:**
- Modify: `libc/glue/cxxrt.c` (complete minimal runtime for programs that do not link libc++abi)
- Modify: `packages/registry/libcxx/build-libcxx.sh` (only if `__cxa_thread_atexit` is missing from `libc++abi.a`; see Step 1)
- Create: `examples/cxx_runtime_test.cpp`; register it in `host/test/global-setup.ts` next to other `examples/*_test.c` programs (C++ variant; follow how existing C++ fixtures are compiled, `grep -n "\.cpp" host/test/global-setup.ts`)
- Create: `host/test/cxx-runtime-guest.test.ts`

**Interfaces:**
- Produces: every symbol in Task 1 Step 1's "library function" list defined by either `cxxrt.c` or `libc++abi.a`/`libc++.a`, so no C++ program imports it from `env`.

- [ ] **Step 1: Establish what each library defines.** `wasm32posix-nm --defined-only` over `sysroot/lib` glue objects, `libc++abi.a`, and `libc++.a` from the resolved `libcxx` package (`cargo run -p xtask … -- build-deps path libcxx`). For each of the 17 names, record where it is defined, if anywhere. Expected: libc++abi defines the `__cxa_*` family and `__dynamic_cast`; `__cxa_thread_atexit` is defined only if libc++abi built `cxa_thread_atexit.cpp`.

- [ ] **Step 2: Write the failing guest test** `examples/cxx_runtime_test.cpp`:

```cpp
#include <cstdio>
#include <new>
#include <pthread.h>
#include <atomic>

struct Base { virtual int f() = 0; virtual ~Base() = default; };
struct Derived : Base { int f() override { return 7; } };

static std::atomic<int> constructed{0};
struct Counted { Counted() { constructed++; } };
static Counted& shared_instance() { static Counted c; return c; }  // guard

static std::atomic<int> tls_destroyed{0};
struct TlsProbe { ~TlsProbe() { tls_destroyed++; } };
static thread_local TlsProbe tls_probe;

static void* worker(void*) {
  shared_instance();
  (void)&tls_probe;  // odr-use so the thread constructs it
  return nullptr;
}

int main() {
  int failures = 0;
  int* p = new int(3);           if (*p != 3) failures++; delete p;
  int* a = new int[4]{1,2,3,4};  if (a[3] != 4) failures++; delete[] a;
  int* nt = new (std::nothrow) int(5); if (!nt || *nt != 5) failures++; delete nt;
  Base* b = new Derived;
  if (!dynamic_cast<Derived*>(b) || b->f() != 7) failures++;
  delete b;
  pthread_t t[2];
  for (auto& th : t) pthread_create(&th, nullptr, worker, nullptr);
  for (auto& th : t) pthread_join(th, nullptr);
  if (constructed.load() != 1) { std::printf("FAIL static-local guard: %d\n", constructed.load()); failures++; }
  if (tls_destroyed.load() != 2) { std::printf("FAIL thread_local destructors: %d\n", tls_destroyed.load()); failures++; }
  if (failures) return 1;
  std::puts("PASS cxx runtime");
  return 0;
}
```

and `host/test/cxx-runtime-guest.test.ts` running it on wasm32 (and wasm64 if the fixture set builds C++ for wasm64), asserting exit 0 and `PASS cxx runtime`, and asserting the compiled module imports none of the 17 names from `env` (read imports with `WebAssembly.Module.imports`).

- [ ] **Step 3: Run it.** Build the fixture and run `cd host && npx vitest run test/cxx-runtime-guest.test.ts`. Expected: FAIL — the link fails for the missing names (Task 2 made links honest), or the import assertion fails. Record which names.

- [ ] **Step 4: Implement.** Complete `cxxrt.c` (weak definitions, overridden by libc++abi when linked) for the names a program can need without linking libc++abi: the eight `new`/`delete` forms (nothrow forms return `NULL` on failure; throwing forms call `abort()` on failure because there is no C++ exception runtime without libc++abi), `__cxa_pure_virtual` (abort with a message), `__cxa_atexit` (forward to musl's `__cxa_atexit` if the name collides — check musl first; musl defines `__cxa_atexit`, so do not redefine it), and the `__cxa_guard_*` trio (a mutex- and futex-free implementation is wrong with threads: use `pthread_once`-style acquire with a global `pthread_mutex_t` and the guard byte, as libc++abi's `cxa_guard.cpp` does). For `__cxa_thread_atexit`: if Step 1 found it missing from libc++abi, enable its build in `build-libcxx.sh` (libc++abi's `cxa_thread_atexit.cpp` with `LIBCXXABI_HAS_CXA_THREAD_ATEXIT_IMPL=OFF` implements it with pthread keys) and bump the libcxx `build.toml` revision; do not add a second implementation in `cxxrt.c`. `__dynamic_cast`, `__libcpp_verbose_abort`, and `std::__sort` come from libc++abi/libc++: a program that uses them must link them.

- [ ] **Step 5: Run.** Same test. Expected: PASS, and the import assertion holds. Run `cd host && npx vitest run test/sdl2.test.ts` as a C++-free regression spot check, and the cargo/Vitest suites touching `cxxrt` (`grep -rln cxxrt host/test sdk/test`).

- [ ] **Step 6: Commit.** Subject: `SDK: Provide C++ runtime functions from the C++ runtime`.

---

### Task 5: The host refuses undeclared imports and stops faking library functions

**Files:**
- Create: `host/src/env-imports.ts` (the check, importable by tests)
- Modify: `host/src/worker-main.ts` (~2530–2740: delete the C++ stand-ins and the "Unimplemented import" stub loop; call the check)
- Test: `host/test/host-env-imports.test.ts` (new)

**Interfaces:**
- Consumes: `HOST_ENV_IMPORTS` from `host/src/generated/abi.ts`.
- Produces: `export function assertDeclaredEnvImports(module: WebAssembly.Module): void` in `host/src/env-imports.ts`, throwing `Error("program imports env.<name>, which Kandelo does not provide; rebuild it with the current SDK")`.

- [ ] **Step 1: Write the failing tests** in `host/test/host-env-imports.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOST_ENV_IMPORTS } from "../src/generated/abi";
import { assertDeclaredEnvImports } from "../src/env-imports";

// Same WAT tooling host/test/dylink.test.ts uses (wabt's wat2wasm from the dev shell).
async function moduleFromWat(wat: string): Promise<WebAssembly.Module> {
  const dir = mkdtempSync(join(tmpdir(), "env-imports-"));
  writeFileSync(join(dir, "t.wat"), wat);
  execFileSync("wat2wasm", [join(dir, "t.wat"), "-o", join(dir, "t.wasm")]);
  return new WebAssembly.Module(readFileSync(join(dir, "t.wasm")));
}

describe("host env imports", () => {
  it("refuses a program that imports an undeclared env function", async () => {
    const m = await moduleFromWat(`(module (import "env" "re_search" (func)))`);
    expect(() => assertDeclaredEnvImports(m)).toThrow(/env\.re_search/);
  });

  it("refuses the removed C++ stand-ins", async () => {
    const m = await moduleFromWat(`(module (import "env" "_Znwm" (func (param i32) (result i32))))`);
    expect(() => assertDeclaredEnvImports(m)).toThrow(/env\._Znwm/);
  });

  it("accepts every declared import", async () => {
    for (const { name, kind } of HOST_ENV_IMPORTS) {
      if (kind !== "function") continue;
      const m = await moduleFromWat(`(module (import "env" "${name}" (func)))`);
      expect(() => assertDeclaredEnvImports(m), name).not.toThrow();
    }
  });
});
```

and a source-level test that `worker-main.ts` contains no `Unimplemented import` stub and no assignment to any of the 17 library names (`readFileSync` + regex; this keeps the fakes from creeping back).

- [ ] **Step 2: Run.** `cd host && npx vitest run test/host-env-imports.test.ts`. Expected: FAIL (function missing).

- [ ] **Step 3: Implement.** Add `assertDeclaredEnvImports`; call it where the import object is built, before instantiation, on both the initial load and `exec` paths (they share this builder; verify with `grep -n "buildImports\|const envImports" host/src/worker-main.ts`). Delete the C++ stand-in block and the stub loop. Every declared import must still be supplied when the module imports it — keep the existing supply code for them.

- [ ] **Step 4: Run.** The new test, then the whole host suite: `cd host && npx vitest run > <log>`. Expected: new test PASS; any other failure is a program still importing an undeclared name (it must be rebuilt — Task 6) or a test fixture that relied on a stub (fix the fixture honestly). Record each.

- [ ] **Step 5: Commit.** Subject: `Host: Refuse programs that import functions Kandelo lacks`.

---

### Task 6: Rebuild everything and fix what the honest link breaks

**Files:** discovered; expected per spec §5: `packages/registry/{coreutils,tar,bash,php,ruby,mariadb,espeak-ng}/…`, plus `scripts/wasm-artifact-guards.sh`.

**Interfaces:**
- Consumes: Tasks 1–5.

- [ ] **Step 1: Artifact guard reads the generated list.** In `scripts/wasm-artifact-guards.sh`, replace the hand-written `env.__wasm_posix_vm_interrupt_after` allowance with a read of `libc/glue/kandelo-host-imports.txt` (reserved-prefix names only). Test: `bash scripts/test-wasm-artifact-guards.sh` before (still passes) and after; add a case that a reserved name not in the file is rejected.

- [ ] **Step 2: Rebuild the sysroots and every package.** `scripts/dev-shell.sh bash scripts/build-musl.sh && scripts/dev-shell.sh bash scripts/build-musl.sh --arch wasm64posix && scripts/dev-shell.sh ./run.sh setup`. Record every package that fails, with its first error.

- [ ] **Step 3: Fix each failing package at its own layer**, one commit each (`Packages: …`), following this protocol: reproduce with the package's build; confirm the missing symbol; decide the layer (configure now correctly selects a replacement → no change needed beyond removing stale compensation; the package links a library it uses without declaring it → declare the dependency; the program needs an API Kandelo lacks → stop and record as a gap for the maintainer). Expected cases:
  - `coreutils`, `tar`: honest configure selects gnulib's `regex`, `isapipe`, `rpmatch`. Verify: `coreutils --coreutils-prog=expr abcdef : 'a.*d'` prints `4` (add as a package test in `packages/registry/coreutils/test/`).
  - `bash`: `locale_charset` — find which of bash's options pulls it in (`grep -rn locale_charset` in the bash source) and link the providing library or let configure choose bash's own fallback.
  - `php`: **stop point.** Report what PHP's configure does now for Fibers (spec §8) with a concrete proposal, and wait for the maintainer.
  - `ruby`: `sqlite3_column_database_name` (the sqlite3 extension's link must use the `sqlite` package's archive, which is built with `SQLITE_ENABLE_COLUMN_METADATA`); `backtrace`/`backtrace_symbols` (musl has no execinfo; honest configure disables Ruby's use of it).
  - `mariadbd`, `espeak-ng`: resolved by Task 4 once they link the C++ runtime; if `espeak-ng` still imports `_Znwm`, its toolchain file is linking without the SDK's glue — route it through `wasm32posix-c++`.

- [ ] **Step 4: Survey.** Re-run the `env`-import inventory over every built program (`find local-binaries/source-only-v1 -name '*.wasm' … wasm-objdump -x -j Import …`, as in the FFmpeg ledger) and assert that nothing outside `HOST_ENV_IMPORTS` remains. Commit the survey script as `scripts/check-program-env-imports.sh` with a test, and add it to the checks.

- [ ] **Step 5: Side modules.** Build a side module that references a symbol the main program does not export, `dlopen` it from a guest test, and assert `dlopen` returns NULL with a `dlerror()` naming the symbol (`host/test/dlopen-unresolved.test.ts`). If it instead loads and traps later, fix the loader in `host/src/dylink.ts` to fail at `dlopen`.

---

### Task 7: The kernel owns host stdin as a pipe

**Files:**
- Modify: `crates/runtime-core/src/process_table.rs` or `process.rs` (a method that replaces a process's fd 0 with a new pipe read end)
- Modify: `crates/kernel/src/wasm_api.rs` (new export)
- Modify: `crates/shared/src/lib.rs` (declare the export in the kernel-exports contract; regenerate under ABI 44)
- Test: Rust unit tests in `crates/runtime-core`

**Interfaces:**
- Produces: `#[unsafe(no_mangle)] pub extern "C" fn kernel_install_host_stdin_pipe(pid: u32) -> i32` — replaces fd 0 of `pid` with the read end (`FileType::Pipe`, `O_RDONLY`, host handle `-(pipe_idx + 1)`, path `/dev/stdin`) of a new pipe from `crate::pipe::global_pipe_table()` sized like the kernel's other pipes (65536); the pipe's write end stays open until `kernel_pipe_close_write`; returns the pipe index, or a negative errno (`-ESRCH` unknown pid, `-EMFILE`/`-ENOMEM` on allocation failure).
- Consumes: existing `kernel_pipe_write(pid, pipe_idx, ptr, len) -> i32`, `kernel_pipe_close_write(pid, pipe_idx) -> i32`, `kernel_pipe_is_read_open`, `kernel_pipe_has_readers`.

- [ ] **Step 1: Write the failing Rust tests** in `crates/runtime-core` next to the stdio tests (`process.rs:3025`):
  - `host_stdin_pipe_replaces_fd0_with_fifo_read_end`: after install, fd 0's OFD is `FileType::Pipe`, `O_RDONLY`; `fstat` on fd 0 reports FIFO.
  - `host_stdin_pipe_is_shared_across_fork`: write `"abcdef"` into the pipe; child (via the table's fork path) reads 3 bytes; parent reads the next 3 (`"def"`).
  - `host_stdin_pipe_eof_after_close_write`: write `"x"`, close write; read gets `"x"` then 0.
  - `host_stdin_pipe_read_blocks_while_open_and_empty`: read on an empty open pipe returns `EAGAIN`/would-block (the kernel's blocking signal), not 0.
  Run: `cargo test -p runtime-core host_stdin_pipe`. Expected: compile failure (method missing).

- [ ] **Step 2: Implement** the runtime-core method using the same pipe creation `sys_pipe2` uses (`syscalls.rs:2915`: `pipe_handle = -((pipe_idx as i64) + 1)`), closing the old fd 0 through the normal close path so its OFD reference is released. Check how `PipeBuffer` counts writers (`pipe.rs:1163`, `1234`) so a pipe with no writer OFD still reports its write end open until `close_write_end`; follow the TCP-injected pipes, which have the same shape. Add the kernel export. Declare it in the kernel-exports contract and regenerate the ABI files.

- [ ] **Step 3: Run.** `cargo test -p runtime-core` and `cargo test -p kandelo` (or the kernel crate's name). Expected: new tests PASS, nothing else regresses.

- [ ] **Step 4: Commit.** Subject: `Kernel: Give host-supplied stdin a kernel pipe`.

---

### Task 8: The host writes stdin into the kernel pipe

**Files:**
- Modify: `host/src/kernel-worker.ts` (`setStdinData`, `appendStdinData`, `isStdinConsumed`; delete `stdinBuffers`, `stdinFinite`, `onStdin` wiring ~3354; reuse `writePipeChunked` ~31183)
- Modify: `host/src/kernel.ts` (delete the handle-0 `onStdin` branch ~2755 and the `onStdin` callback type ~783)
- Modify: `host/src/node-kernel-worker-entry.ts:1331`, `host/src/browser-kernel-worker-entry.ts:1485` (install the pipe at spawn when the process has host stdin)
- Test: `host/test/host-stdin-pipe.test.ts` (new); existing `host/test/interactive-stdin.test.ts` must keep passing

**Interfaces:**
- Consumes: `kernel_install_host_stdin_pipe` (Task 7), `kernel_pipe_write`, `kernel_pipe_close_write`.
- Produces (unchanged public signatures): `setStdinData(pid, data)` = queue + close after draining; `appendStdinData(pid, data)` = queue; `isStdinConsumed(pid): boolean` = write end closed and the pipe empty. Internally: `#hostStdin: Map<number /* pipeIdx */, { pending: Uint8Array[]; closeWhenDrained: boolean }>` keyed by pipe, plus `pid → pipeIdx` only to route the two API calls.

- [ ] **Step 1: Write the failing tests** in `host/test/host-stdin-pipe.test.ts`, using `runCentralizedProgram` with `stdinBytes` and the `dash` package binary (`tryResolveBinary("programs/dash.wasm")`, fail — not skip — if missing):

```ts
it("a child reads stdin inherited from the shell", async () => {
  const r = await runCentralizedProgram({ programPath: dash, argv: ["sh", "-c", "cat"],
    stdinBytes: new TextEncoder().encode("hello from the host\n"), timeout: 30_000 });
  expect(r.exitCode, r.stderr).toBe(0);
  expect(r.stdout).toBe("hello from the host\n");
});

it("parent and child share one stdin offset", async () => {
  const r = await runCentralizedProgram({ programPath: dash,
    argv: ["sh", "-c", "head -c 3; printf '|'; cat"],
    stdinBytes: new TextEncoder().encode("abcdef"), timeout: 30_000 });
  expect(r.stdout).toBe("abc|def");
});

it("delivers input larger than the pipe in order", async () => {
  const big = new Uint8Array(24 * 1024 * 1024).map((_, i) => i % 251);
  const r = await runCentralizedProgram({ programPath: dash,
    argv: ["sh", "-c", "cat | wc -c"], stdinBytes: big, timeout: 120_000 });
  expect(r.stdout.trim()).toBe(String(big.byteLength));
});

it("appendStdinData wakes a reader blocked on empty stdin", async () => {
  let out = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    onStdout: (_p, d) => { out += new TextDecoder().decode(d); },
  });
  await host.init();
  try {
    let started!: (pid: number) => void;
    const pidReady = new Promise<number>((r) => { started = r; });
    const bytes = readFileSync(dash);
    const exit = host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      ["sh", "-c", "head -c 5"], { onStarted: (pid) => started(pid) });
    const pid = await pidReady;
    await new Promise((r) => setTimeout(r, 500)); // let head block in read(0)
    const t0 = Date.now();
    host.appendStdinData(pid, new TextEncoder().encode("hello"));
    expect(await exit).toBe(0);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(out).toBe("hello");
  } finally {
    await host.destroy();
  }
}, 60_000);

it("large input arrives byte-for-byte", async () => {
  const big = new Uint8Array(8 * 1024 * 1024).map((_, i) => (i * 7) % 256);
  const r = await runCentralizedProgram({ programPath: dash,
    argv: ["sh", "-c", "sha256sum"], stdinBytes: big, timeout: 120_000 });
  expect(r.stdout.split(" ")[0]).toBe(createHash("sha256").update(big).digest("hex"));
}, 180_000);
```
Imports for this file: `vitest`, `node:fs` `readFileSync`, `node:crypto` `createHash`, `NodeKernelHost` from `../src/node-kernel-host`, `runCentralizedProgram` from `./centralized-test-helper`, `tryResolveBinary` from `../src/binary-resolver`; `const dash = tryResolveBinary("programs/dash.wasm")` with `if (!dash) throw` at module top (a missing shell is a build failure, not a skip). `sha256sum`/`head`/`wc` come from the default rootfs, so these tests use the default rootfs (do not pass `useDefaultRootfs: false`).

- [ ] **Step 2: Run.** `cd host && npx vitest run test/host-stdin-pipe.test.ts`. Expected: the inheritance, shared-offset, and large-input tests time out or fail (G4); record which.

- [ ] **Step 3: Implement.** At spawn, when the process's stdin is host-backed (not a PTY), call `kernel_install_host_stdin_pipe(pid)` and record the pipe index. `appendStdinData` enqueues and calls `#pumpHostStdin(pipeIdx, entry)`: write queued bytes with `writePipeChunked`; stop when it returns less than offered (pipe full); after draining, if `closeWhenDrained`, call `kernel_pipe_close_write`; then `scheduleWakeBlockedRetries(entry)` so blocked readers run. Re-pump when readers drain the pipe — find how the TCP path learns the pipe has space (`grep -n "schedulePump" host/src/kernel-worker.ts`) and use the same trigger. Delete `stdinBuffers`, `stdinFinite`, the `onStdin` callback and its handle-0 branch in `kernel.ts`. Keep process-exit cleanup: drop the map entries when the last reader closes (`kernel_pipe_is_read_open` false).

- [ ] **Step 4: Run.** The new tests (expected 5/5 PASS), `interactive-stdin.test.ts`, and the whole host suite. Then the FFmpeg-branch scenario: `echo x | npx tsx examples/run-example.ts <dash.wasm> -c cat` prints `x` (add as a case in `host/test/run-example-resolver.test.ts` or a new runner test).

- [ ] **Step 5: Commit.** Subject: `Host: Deliver host stdin through the kernel pipe`.

---

### Task 9: Browser validation and conformance

- [ ] **Step 1: Provision the browser app** (`./run.sh prepare-browser`) and run, reading the per-test list (not the summary): `apps/browser-demos/test/kandelo-doom-ingest.spec.ts`, `kandelo-quake.spec.ts`, `kandelo-evdev.spec.ts`, `login-terminal-session.spec.ts`, `kandelo-source-rootfs-shell.spec.ts`, `lazy-archive-runtime.spec.ts`. Expected: all pass; none skipped. Also add a browser case mirroring Task 8's "child reads inherited stdin" through the browser kernel host (`set_stdin_data` path) in a new `apps/browser-demos/test/host-stdin-pipe.spec.ts`.

- [ ] **Step 2: Conformance suites, before and after.** On `origin/main` (the monaco worktree's baseline results from 2026-09-26 are libc-test 303 pass / 0 fail / 20 XFAIL) and on this branch: `scripts/run-libc-tests.sh`, `scripts/run-posix-tests.sh`, `scripts/run-sortix-tests.sh`, `cargo test` for `runtime-core`, kernel, `fork-instrument`, and `xtask`, and the full host Vitest suite. Any new failure is investigated; any test that newly fails to link is listed with its missing symbol.

- [ ] **Step 3: Quiet-machine audio check.** Run `host/test/audio-integration.test.ts` when the machine's load average is below 4 (`uptime`). This is the outstanding FFmpeg-branch item; record the result in both ledgers.

---

### Task 10: Docs and PR

**Files:**
- Modify: `docs/sdk-guide.md` (link contract: generated allowance, what a link failure means), `docs/porting-guide.md` (configure checks are truthful; `config.site` seeds for missing functions are unnecessary), `docs/posix-status.md` (stdin is a pipe shared across `fork`), `docs/package-management.md` (the executable-registration paragraph that says "The SDK deliberately permits undefined symbols"), `docs/abi-versioning.md` (Task 1), `docs/architecture.md` if it describes `onStdin`.

- [ ] **Step 1: Update docs**, each stating why this design, the alternatives rejected (per-package seeding; host-side stdin keyed by open file), and residual risk (spec §6 risks).

- [ ] **Step 2: Rebase check.** `git fetch origin && git rebase origin/main`; if another change bumped `ABI_VERSION` meanwhile, take the next number and regenerate.

- [ ] **Step 3: Push and open the PR** (`gh pr create --draft --base main`), title `SDK: Make program links honest and give host stdin a kernel pipe`, description `## Why` / `## What changed` / `## Validation` with the per-suite counts, the package fixes, and the stop-point outcomes. Push only after the maintainer confirms the PHP decision (Task 6 Step 3).

---

## Self-Review Notes

- **Spec coverage:** §3.1–3.2 → Task 1; §3.3 link → Tasks 2–3, load → Task 5, guard → Task 6 Step 1; §3.4 → Task 6 Step 5; §4 → Task 4 (+ Task 5 deletion); §5 → Task 6; §6 → Tasks 7–8; §7 → Task 1 (bump), Task 7 (export under 44); §8 → Task 6 Step 3 stop point; §9 → Tasks 2–9.
- **Ordering:** C++ runtime (Task 4) precedes host refusal (Task 5) so C++ programs are not stranded; honest links (Tasks 2–3) precede Task 4 so its test proves nothing is borrowed from the host.
- **Known discovery points:** Task 1 Step 1 (exact host inventory), Task 4 Step 1 (where each C++ symbol lives), Task 6 Step 3 (package breakages), Task 7 Step 2 (pipe writer accounting), Task 8 Step 3 (the pump trigger). Each names the file to read and the evidence to record.
