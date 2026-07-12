/**
 * fork_instrument_coverage — comprehensive regression matrix for
 * `wasm-fork-instrument`.
 *
 * Source of truth: docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
 *
 * Six categories, 41 test IDs:
 *   D-* (10)  dispatch coverage — switch-dispatch and the runtime
 *             trampoline that replaces guard-dispatch.
 *   C-* (11)  catch-handler resume — B1/A2/A3/A4 patterns. (C-01..C-10
 *             from the matrix plus C-11 post-catch fork.)
 *   S-* (8)   side-effects-during-rewind — atomic ops, table.*,
 *             non-nullable funcref, throw-from-outside.
 *   K-* (4)   callback-registration fork roots — sigaction, signal,
 *             pthread_cleanup_push, qsort comparator.
 *   P-* (5)   process / threading patterns — main thread, blocked
 *             cond, held mutex, popen, posix_spawn.
 *   F-* (4)   accepted-limit failure modes — ucontext, wasm-GC refs.
 *
 * Pre-refactor expected behaviour is encoded with vitest modifiers:
 *   - it()       — should pass today AND after the architectural
 *                  pivot. Regression gate against the refactor
 *                  accidentally breaking working features.
 *   - it.fails() — expected to fail today; should pass after the
 *                  named commit lands. When CI flags it as
 *                  unexpectedly passing, flip to it().
 *   - it.todo()  — fixture not yet written (e.g. needs WAT). Marked
 *                  for tracking; no assertion runs.
 *
 * The whole file must stay green until the architectural pivot ships
 * (commits 2-N of the mega-PR). Each pivot commit should flip the
 * relevant tests from it.fails() to it().
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary, tryResolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Expected {
  /** Substring(s) that must appear in stdout for PASS. */
  contains: string[];
  /** Expected exit code (default 0). */
  exitCode?: number;
  /** Run timeout (default 10s — fork tests are short). */
  timeout?: number;
  /** Optional argv (defaults to [binaryName]). */
  argv?: string[];
  /** Optional virtual-path → wasm binary map for exec/spawn targets. */
  execPrograms?: Map<string, string>;
}

async function runFixture(relPath: string, expected: Expected) {
  const binary = tryResolveBinary(relPath);
  if (!binary) {
    // Surface this as a regular failure; tests should never silently
    // skip when their fixture is missing — that hides the regression
    // contract. If the binary genuinely can't be built yet, the test
    // should be marked it.todo() at the call site, not gated here.
    throw new Error(`Fixture not built: ${relPath}`);
  }
  const result = await runCentralizedProgram({
    programPath: binary,
    argv: expected.argv ?? [relPath],
    timeout: expected.timeout ?? 10_000,
    execPrograms: expected.execPrograms,
  });
  expect(
    result.exitCode,
    `${relPath} exited unexpectedly\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  ).toBe(expected.exitCode ?? 0);
  for (const fragment of expected.contains) {
    expect(result.stdout, `${relPath} stdout`).toContain(fragment);
  }
}

/** Echo fixture registered for popen/posix_spawn child exec targets. */
const echoBinary = resolveBinary("programs/echo.wasm");
const echoExecMap = new Map<string, string>([
  ["echo", echoBinary],
  ["/echo", echoBinary],
  ["/tmp/echo", echoBinary],
  ["/bin/echo", echoBinary],
  ["/usr/bin/echo", echoBinary],
]);

/** Minimal sh fixture built from programs/sh.c for popen("/bin/sh -c ..."). */
const shCandidate = resolveBinary("programs/sh.wasm");
const popenExecMap = new Map<string, string>([
  ["sh", shCandidate],
  ["/bin/sh", shCandidate],
  ["/usr/bin/sh", shCandidate],
  ["echo", echoBinary],
  ["/echo", echoBinary],
  ["/tmp/echo", echoBinary],
  ["/bin/echo", echoBinary],
  ["/usr/bin/echo", echoBinary],
]);

// ---------------------------------------------------------------------------
// D-* dispatch coverage
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / D-* dispatch", () => {
  it("D-01 single top-level fork", async () => {
    await runFixture("programs/d_01_single_fork.wasm", {
      contains: ["PRE_FORK", "CHILD: ok", "PASS: D-01"],
    });
  });

  it("D-02 multiple top-level forks", async () => {
    await runFixture("programs/d_02_multi_top_fork.wasm", {
      contains: ["ARM:", "PRE_FORK", "CHILD: ok", "PASS: D-02"],
    });
  });

  it("D-03 fork inside if body", async () => {
    await runFixture("programs/d_03_fork_in_if.wasm", {
      contains: ["IN_IF", "PRE_FORK", "CHILD: ok", "PASS: D-03"],
    });
  });

  it("D-04 fork inside block body", async () => {
    await runFixture("programs/d_04_fork_in_block.wasm", {
      contains: ["IN_BLOCK", "PRE_FORK", "CHILD: ok", "PASS: D-04"],
    });
  });

  it("D-05 fork inside loop body (today: guard-dispatch; post-pivot: trampoline)", async () => {
    await runFixture("programs/d_05_fork_in_loop.wasm", {
      contains: ["ITER 0", "PRE_FORK", "CHILD: ok", "PASS: D-05"],
    });
  });

  // D-06: fork inside try_table body. Pre-2026-05-14, this hit a
  // structural bug in apply_plain_catch_handlers (B1 stage 2)
  // surfaced by modern wasm-EH: the per-arm capture tail
  // (emit_capture_save_and_branch's spill+save+set-flags+br code)
  // was emitted INSIDE each cap_seq, AFTER the `br $b1_outer`
  // terminator — making it dead code on both the fall-through path
  // (br terminated) and the catch path (catch jumped to cap_seq
  // END, past the capture tail). The catch payload propagated out
  // of cap_seq with nothing consuming it, hitting V8's validator
  // ("expected 0 elements on the stack for fallthru"). Fixed by
  // moving each arm J's capture tail to its PARENT block
  // (cap_seq[J-1] for J>0, outer_seq for J=0) where control
  // actually lands after the catch's br-to-label.
  it("D-06 fork inside try_table body", async () => {
    await runFixture("programs/d_06_fork_in_try_body.wasm", {
      contains: ["IN_TRY", "PRE_FORK", "CHILD: ok", "PASS: D-06"],
    });
  });

  it("D-07 fork via call_indirect (today: guard-dispatch; post-pivot: trampoline)", async () => {
    await runFixture("programs/d_07_fork_call_indirect.wasm", {
      contains: ["PRE_FORK", "CHILD: ok", "PASS: D-07"],
    });
  });

  it("D-08 fork with stack carryovers (today: guard-dispatch; post-pivot: trampoline)", async () => {
    await runFixture("programs/d_08_fork_stack_carryovers.wasm", {
      contains: ["COMPUTED:", "PRE_FORK", "CHILD: ok", "PASS: D-08"],
    });
  });

  it("D-09 fork in irreducible CFG (today: guard-dispatch; post-pivot: trampoline)", async () => {
    await runFixture("programs/d_09_fork_irreducible_cfg.wasm", {
      contains: ["ROUTE:", "PRE_FORK", "CHILD: ok", "PASS: D-09"],
    });
  });

  it("D-10 fork in callee, caller instruments correctly", async () => {
    await runFixture("programs/d_10_fork_in_callee.wasm", {
      contains: ["IN_A", "IN_B", "PRE_FORK", "CHILD: ok", "POST_B", "POST_A", "PASS: D-10"],
    });
  });
});

// ---------------------------------------------------------------------------
// C-* catch-handler resume coverage (B1 + A2 + A3 + A4)
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / C-* catch-handler resume", () => {
  it("C-01 try { fork() } catch (int) — no throw, fork in try body", async () => {
    await runFixture("programs/c_01_fork_in_try_no_throw.wasm", {
      contains: ["IN_TRY", "PRE_FORK", "CHILD: ok", "PASS: C-01"],
    });
  });

  // C-02: B1 plain catch, single arm — fork inside catch handler.
  // The B1-stages-1+2 machinery (Phase 6 rewind-throw stub + capture
  // block + exnref stash) handles this correctly under modern wasm-EH
  // lowering. Was `it.fails` pre-2026-05-14 because the SDK emitted
  // legacy `try`/`catch`; the B1 machinery is structured for modern
  // `try_table`/`catch_ref`/`throw_ref` only. Commit 9's SDK flip
  // (with the empirical 2026-05-14 follow-up adding
  // `-wasm-use-legacy-eh=false` explicitly) made this case actually
  // exercise the existing modern-EH path.
  it("C-02 fork inside single-arm plain catch (B1)", async () => {
    await runFixture("programs/c_02_fork_in_catch.wasm", {
      contains: ["THROWING", "CAUGHT: 7", "PRE_FORK", "CHILD: ok", "PASS: C-02"],
    });
  });

  // C-03: multi-arm plain-catch try_tables. The B1 stage 2 machinery's
  // per-arm capture-block emission handles multi-arm under modern EH.
  it("C-03 fork in multi-arm plain catch", async () => {
    await runFixture("programs/c_03_fork_in_multi_arm_catch.wasm", {
      contains: ["THROWING", "CAUGHT_STR: x", "PRE_FORK", "CHILD: ok", "PASS: C-03"],
    });
  });

  // C-04: throw originates outside the instrumented region. Switch-
  // dispatch's body-skip-on-REWIND construction means the throw
  // doesn't re-fire on REWIND — no gating needed.
  it("C-04 fork in catch where throw originates outside instrumented region (B2)", async () => {
    await runFixture("programs/c_04_fork_in_catch_external_throw.wasm", {
      contains: ["CALLING_HELPER", "IN_HELPER", "CAUGHT: 99", "PRE_FORK", "CHILD: ok", "PASS: C-04"],
    });
  });

  // C-05..C-07: modern wasm-EH variants. Post-commit-9 + 2026-05-14
  // follow-up, ALL C++ programs lower via modern EH, so these are
  // effectively duplicates of C-02 / C-03 / multi-typed-catch under
  // the unified lowering — but kept distinct in case future toolchain
  // versions reintroduce divergence.
  it("C-05 modern EH single-clause typed catch + fork", async () => {
    await runFixture("programs/c_05_fork_modern_eh_single.wasm", {
      contains: ["THROWING", "CAUGHT: 1", "PRE_FORK", "CHILD: ok", "PASS: C-05"],
    });
  });

  it("C-06 modern EH multi-target *_ref try_table + fork", async () => {
    await runFixture("programs/c_06_fork_modern_eh_multi_ref.wasm", {
      contains: ["THROWING", "CAUGHT_DOUBLE: 3.14", "PRE_FORK", "CHILD: ok", "PASS: C-06"],
    });
  });

  it("C-07 modern EH multi-arm plain catches + fork", async () => {
    await runFixture("programs/c_07_fork_modern_eh_multi_plain.wasm", {
      contains: ["THROWING", "CAUGHT_LONG: 1234567", "PRE_FORK", "CHILD: ok", "PASS: C-07"],
    });
  });

  // C-08, C-09 — A4 funcref/externref catch operands. No C-source
  // surface; covered by `crates/fork-instrument/tests/coverage_wat.rs`
  // which verifies fork-instrument doesn't panic on these patterns.
  // Full A4 implementation (per-arm aux-table spilling for ref-typed
  // catch operands) is future work — today the affected function is
  // carved out of the fork-path set via b2_carveout.
  it.skip("C-08 plain catch arm with funcref operand [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});
  it.skip("C-09 plain catch arm with externref operand [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});

  // C-10: fork in BOTH try body and catch handler. Combines D-06 with
  // C-02. Passes under modern EH.
  it("C-10 fork in both try body and catch handler", async () => {
    await runFixture("programs/c_10_fork_in_try_and_catch.wasm", {
      contains: [
        "IN_TRY", "PRE_FORK_TRY", "CHILD_TRY: ok",
        "THROWING", "CAUGHT", "PRE_FORK_CATCH", "CHILD_CATCH: ok",
        "PASS: C-10",
      ],
    });
  });

  // C-11: post-catch fork (catch frame fully popped). Repro of the
  // SpiderMonkey spike test (b). Closed by commit 9 + follow-up
  // alongside C-02 — same root cause (modern-EH-only B1 machinery).
  it("C-11 fork after fully-popped catch frame (spike test b)", async () => {
    await runFixture("programs/c_11_post_catch_fork.wasm", {
      contains: ["CAUGHT: 42", "PRE_FORK", "CHILD: ok", "PASS: C-11"],
    });
  });
});

// ---------------------------------------------------------------------------
// S-* side-effect-during-rewind coverage (B1 + B3 + B4 elimination)
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / S-* side effects during rewind", () => {
  // S-01..S-03 use C-source intrinsics (atomic_fetch_add, atomic_notify,
  // atomic_compare_exchange) and should pass today AND after the
  // pivot. Single-shot fork doesn't actually trigger REWIND replay
  // duplication; the regression they guard against is the pivot
  // accidentally introducing it.
  it("S-01 atomic_fetch_add before fork (B1 RMW)", async () => {
    await runFixture("programs/s_01_atomic_fetch_add_fork.wasm", {
      contains: ["PRE_FORK counter=0", "POST_FORK counter=1", "CHILD: ok counter=1", "PASS: S-01"],
    });
  });

  it("S-02 atomic.notify before fork (B1 notify)", async () => {
    await runFixture("programs/s_02_atomic_notify_fork.wasm", {
      contains: ["PRE_FORK", "POST_NOTIFY", "CHILD: ok", "PASS: S-02"],
    });
  });

  it("S-03 atomic_compare_exchange_strong before fork (B1 cmpxchg)", async () => {
    await runFixture("programs/s_03_atomic_cmpxchg_fork.wasm", {
      contains: ["PRE_FORK", "CAS swapped=1", "CHILD: ok", "PASS: S-03"],
    });
  });

  // S-04..S-07 — table.* and non-nullable funcref. C source can't
  // emit these instructions; covered by `crates/fork-instrument/tests/coverage_wat.rs`
  // which verifies fork-instrument produces validating wasm for
  // each side-effect-before-fork pattern. End-to-end runtime
  // verification would require a custom test driver that doesn't
  // depend on channel_syscall.c glue — out of scope today.
  it.skip("S-04 table.fill before fork [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});
  it.skip("S-05 table.copy before fork [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});
  it.skip("S-06 table.grow before fork [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});
  it.skip("S-07 non-nullable funcref direct-call result before fork [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});

  // S-08: throw from outside instrumented region, caught inside,
  // fork in catch. Sibling of C-04. Closed by commit 9 + 2026-05-14
  // follow-up (explicit modern EH).
  it("S-08 throw from outside instrumented region, fork in catch (B2)", async () => {
    await runFixture("programs/s_08_external_throw_fork_in_catch.wasm", {
      contains: ["ENTER_OUTER", "ENTER_INNER", "THROWING", "CAUGHT: 73", "PRE_FORK", "CHILD: ok", "PASS: S-08"],
    });
  });
});

// ---------------------------------------------------------------------------
// K-* callback-registration fork roots (C3 + C4)
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / K-* callback fork roots", () => {
  // K-01/K-02/K-04/K-07 prove callback-style fork roots work through
  // the existing direct + call_indirect closure. The originally planned
  // C3 "instrument every address-taken function" rule was dropped as
  // redundant after these fixtures stayed green. K-03 covers the
  // pthread-worker fork path fixed by the wpk_fork port of PR #468.
  it("K-01 fork from sigaction(SIGUSR1) handler (C3) [signal-handler discovery]", async () => {
    await runFixture("programs/k_01_fork_in_sigusr1_handler.wasm", {
      contains: ["REGISTERED", "RAISING", "IN_HANDLER", "PRE_FORK", "CHILD: ok", "PASS: K-01"],
    });
  });

  it("K-02 fork from signal(SIGALRM) handler (C3) [signal-handler discovery]", async () => {
    await runFixture("programs/k_02_fork_in_sigalrm_handler.wasm", {
      contains: ["REGISTERED", "ALARMED", "IN_HANDLER", "PRE_FORK", "CHILD: ok", "PASS: K-02"],
    });
  });

  // K-03: pthread cleanup handlers run on a pthread worker channel, so
  // fork() here exercises the same fork-from-non-main-thread host path as
  // P-06. The child must rewind from the thread's fork buffer and enter the
  // saved pthread entry function, not `_start`.
  it("K-03 fork from pthread_cleanup_push handler (C4)", async () => {
    await runFixture("programs/k_03_fork_in_pthread_cleanup.wasm", {
      contains: ["THREAD_STARTED", "IN_CLEANUP arg=42", "PRE_FORK", "CHILD: ok", "PASS: K-03"],
      timeout: 7_000,
    });
  }, 10_000);

  it("K-04 fork from qsort comparator (C3 indirect-callback pathological case)", async () => {
    await runFixture("programs/k_04_fork_in_qsort_comparator.wasm", {
      contains: ["PRE_QSORT", "PRE_FORK", "CHILD: ok", "POST_QSORT sorted=1", "PASS: K-04"],
    });
  });

  // K-05: fork() with a pending signal. Tests that fork()'s
  // unwind/rewind doesn't get confused by signal-pending state
  // queued via sigprocmask + kill prior to fork.
  it("K-05 fork with pending signal (sigprocmask blocked SIGUSR1)", async () => {
    await runFixture("programs/k_05_fork_during_signal.wasm", {
      contains: ["PRE_FORK", "CHILD: ok", "PARENT: child=", "PASS: K-05"],
    });
  });

  // K-06: fork() from a C++ destructor. Unusual but legal RAII
  // pattern. The dtor is called as part of stack unwinding when
  // the object goes out of scope; fork() inside it must work.
  it("K-06 fork from C++ destructor (RAII)", async () => {
    await runFixture("programs/k_06_fork_from_dtor.wasm", {
      contains: ["IN_SCOPE", "IN_DTOR", "PRE_FORK", "CHILD: ok", "PARENT: child=", "PASS: K-06"],
    });
  });

  // K-07: fork() from an atexit-registered handler. The handler
  // is called via libc's exit() machinery during process
  // termination. fork() inside it spawns a child; the handler
  // also waitpid's it before main() returns.
  it("K-07 fork from atexit handler", async () => {
    await runFixture("programs/k_07_fork_from_atexit.wasm", {
      contains: ["PRE_EXIT", "IN_ATEXIT", "PRE_FORK", "CHILD: ok", "PARENT: child=", "POST_FORK_PARENT", "PASS: K-07"],
    });
  });
});

// ---------------------------------------------------------------------------
// P-* process / threading patterns
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / P-* process & threading", () => {
  it("P-01 fork from main thread, no other threads", async () => {
    await runFixture("programs/p_01_fork_main_thread.wasm", {
      contains: ["PRE_FORK", "CHILD: pid=", "PARENT: child=", "PASS: P-01"],
    });
  });

  it("P-02 fork while another thread is blocked in pthread_cond_wait", async () => {
    await runFixture("programs/p_02_fork_with_blocked_thread.wasm", {
      contains: ["THREAD_BLOCKED", "PRE_FORK", "CHILD: ok", "THREAD_WOKE", "PASS: P-02"],
    });
  });

  it("P-03 fork holding pthread_mutex (POSIX-mandated child inherits locked)", async () => {
    await runFixture("programs/p_03_fork_holding_mutex.wasm", {
      contains: ["LOCKED", "PRE_FORK", "CHILD: trylock=EBUSY", "CHILD: unlocked", "PASS: P-03"],
    });
  });

  it("P-04 popen+pclose (fork+exec+pipe end-to-end)", async () => {
    await runFixture("programs/p_04_popen_pclose.wasm", {
      contains: ["POPEN_OPENED", "READ: hello-popen", "PCLOSE: status=0", "PASS: P-04"],
      execPrograms: popenExecMap,
    });
  });

  it("P-05 posix_spawn — non-forking path, must remain unchanged by refactor", async () => {
    await runFixture("programs/p_05_posix_spawn.wasm", {
      contains: ["SPAWNED child=", "WAIT: status=0", "PASS: P-05"],
      execPrograms: echoExecMap,
    });
  });

  // P-06: fork from a non-main thread (pthread_create'd worker).
  // The host must drive `wpk_fork_*` around the pthread entry function and
  // pass the thread's fork buffer + fnPtr/argPtr through to the child worker.
  it("P-06 fork from non-main thread", async () => {
    await runFixture("programs/p_06_fork_from_thread.wasm", {
      contains: ["THREAD_STARTED", "PRE_FORK_THREAD", "CHILD_THREAD: ok", "PARENT_THREAD: child=", "PASS: P-06"],
      timeout: 5_000,
    });
  });

  // P-07: recursive fork — parent forks child, child forks
  // grandchild. Verifies fork-instrument's UNWIND/REWIND machinery
  // works correctly when a child process becomes a parent and
  // forks again.
  it("P-07 recursive fork (parent → child → grandchild)", async () => {
    await runFixture("programs/p_07_recursive_fork.wasm", {
      contains: ["PARENT: pre-fork-1", "CHILD: pre-fork-2", "GRANDCHILD: ok", "CHILD: child=", "PARENT: child=", "PASS: P-07"],
    });
  });

  // P-08: vfork(). musl's vfork typically aliases fork (no copy-on-
  // write distinction inside our kernel). If the libc returns
  // ENOSYS or the symbol isn't linked, the test prints SKIP_VFORK
  // and still passes — verifies the surface is at least gracefully
  // handled.
  it("P-08 vfork (or graceful unsupported skip)", async () => {
    await runFixture("programs/p_08_vfork.wasm", {
      contains: ["PRE_VFORK", "PASS: P-08"],
    });
  });

  // P-09: posix_spawn forking path. musl's posix_spawn uses
  // fork+exec internally — this exercises fork-instrument's
  // UNWIND/REWIND machinery during spawn (in contrast to P-05
  // which exercises the non-forking fallback path).
  it("P-09 posix_spawn forking path (fork+exec via spawn)", async () => {
    await runFixture("programs/p_09_posix_spawn_fork.wasm", {
      contains: ["PRE_SPAWN", "PARENT: child=", "PASS: P-09"],
      execPrograms: echoExecMap,
    });
  });

  // P-10: a fork child creates its first pthread. This is the Tcl notifier
  // restart shape: patch the child program into a thread module, start the
  // thread worker, and reclaim it before the child exits.
  it("P-10 fork child creates and joins a pthread", async () => {
    await runFixture("programs/p_10_fork_child_creates_thread.wasm", {
      contains: ["PRE_FORK", "CHILD_THREAD: ok", "CHILD: joined", "PASS: P-10"],
      timeout: 10_000,
    });
  });

  it("P-10 works through the custom PlatformIO clone callback", async () => {
    const binary = tryResolveBinary("programs/p_10_fork_child_creates_thread.wasm");
    expect(binary, "missing P-10 fixture").toBeTruthy();
    const result = await runCentralizedProgram({
      programPath: binary!,
      io: new NodePlatformIO(),
      timeout: 10_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("CHILD_THREAD: ok");
    expect(result.stdout).toContain("PASS: P-10");
  });
});

// ---------------------------------------------------------------------------
// F-* accepted-limit failure modes
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / F-* accepted limits", () => {
  // F-01: getcontext(). Empirically: musl's wasm sysroot exposes
  // the symbol via an `env.getcontext` import that the kernel
  // doesn't implement — the program traps at first call with
  // "Unimplemented import: env.getcontext". That's the accepted
  // failure mode (loud trap, not silent miscompile). Marked
  // `it.fails` to encode the trap-as-expected contract.
  it.fails("F-01 getcontext accepted limit (traps cleanly on unimplemented import)", async () => {
    await runFixture("programs/f_01_ucontext_get.wasm", {
      contains: ["PASS: F-01"],
    });
  });

  // F-02: makecontext + swapcontext. Userspace stack-switching is
  // unsupported by this kernel. Same trap mode as F-01 — same
  // accepted-limit contract.
  it.fails("F-02 makecontext/swapcontext accepted limit (traps cleanly on unimplemented import)", async () => {
    await runFixture("programs/f_02_ucontext_makeswap.wasm", {
      contains: ["PASS: F-02"],
      timeout: 5_000,
    });
  });

  // F-03, F-04 — wasm-GC anyref / struct.new. No C-source surface
  // (LLVM-emitted C doesn't produce these); covered by cargo-level
  // tests in `crates/fork-instrument/tests/coverage_wat.rs` which
  // verify fork-instrument rejects the accepted-limit shapes with a
  // clear diagnostic rather than silently accepting them.
  it.skip("F-03 wasm-GC anyref accepted limit [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});
  it.skip("F-04 wasm-GC struct.new accepted limit [tested via crates/fork-instrument/tests/coverage_wat.rs]", () => {});
});
