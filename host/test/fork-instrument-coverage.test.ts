/**
 * fork_instrument_coverage — comprehensive regression matrix for
 * `wasm-fork-instrument`.
 *
 * The test IDs originated in:
 * docs/plans/2026-05-13-fork-instrument-megaPR-eliminate-guard-dispatch-and-modern-EH-plan.md
 *
 * Six categories, 52 test IDs:
 *   D-* (10)  dispatch coverage — switch-dispatch and the runtime
 *             trampoline that replaces guard-dispatch.
 *   C-* (11)  catch-handler resume — B1/A2/A3/A4 patterns. (C-01..C-10
 *             from the matrix plus C-11 post-catch fork.)
 *   S-* (8)   side-effects-during-rewind — atomic ops, table.*,
 *             non-nullable funcref, throw-from-outside.
 *   K-* (7)   callback-registration and asynchronous fork roots.
 *   P-* (12)  process / threading patterns — main thread, blocked
 *             cond, held mutex, popen, posix_spawn, deep and failed
 *             continuation allocation. P-11 (root and later continuation
 *             ENOMEM) runs as two fixtures over the same program: one at
 *             a deliberately tight address-space ceiling and one at
 *             production layout (2026-09-19), so it counts as 12 rather
 *             than 11 runnable `it()`s.
 *   F-* (4)   explicit ucontext boundaries and Wasm-GC ownership.
 *
 * Modifiers describe the current ownership of each proof:
 *   - it()       — this file executes the process-runtime gate.
 *   - it.fails() — an explicit platform boundary is expected to fail
 *                  truthfully; an unexpected pass requires review.
 *   - it.skip()  — another named suite owns the executable proof because
 *                  the shape has no C/C++ source fixture.
 *
 * Supported compiler/reference shapes must not be hidden behind a skip whose
 * label still claims that ABI 43 rejects them.
 */
import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary, tryResolveBinary } from "../src/binary-resolver";

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
  /** Opt out when the fixture does not access the filesystem. */
  useDefaultRootfs?: boolean;
  /** Process memory ceiling for bounded allocation-failure fixtures. */
  maxPages?: number;
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
    useDefaultRootfs: expected.useDefaultRootfs,
    maxPages: expected.maxPages,
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
  ["/bin/echo", echoBinary],
  ["/usr/bin/echo", echoBinary],
  ["/tmp/echo", echoBinary],
]);

/** Minimal sh fixture built from programs/sh.c for popen("/bin/sh -c ..."). */
const shCandidate = resolveBinary("programs/sh.wasm");
const popenExecMap = new Map<string, string>([
  ["/bin/sh", shCandidate],
  ["/usr/bin/sh", shCandidate],
  ["/bin/echo", echoBinary],
  ["/usr/bin/echo", echoBinary],
  ["/tmp/echo", echoBinary],
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
  // LLVM 21 emits exnref locals and untagged cleanup catches for these C++
  // functions. ABI 43 gives both forms deterministic exception recipes, so
  // keep the compiler output in the real process-runtime gate.
  it("C-01 fork in compiler EH try body", async () => {
    await runFixture("programs/c_01_fork_in_try_no_throw.wasm", {
      contains: ["IN_TRY", "PRE_FORK", "CHILD: ok", "PASS: C-01"],
    });
  });

  it("C-02 fork in compiler EH catch", async () => {
    await runFixture("programs/c_02_fork_in_catch.wasm", {
      contains: ["THROWING", "CAUGHT: 7", "PRE_FORK", "CHILD: ok", "PASS: C-02"],
    });
  });

  it("C-03 fork in a distinct multi-arm catch target", async () => {
    await runFixture("programs/c_03_fork_in_multi_arm_catch.wasm", {
      contains: ["THROWING", "CAUGHT_STR: x", "PRE_FORK", "CHILD: ok", "PASS: C-03"],
    });
  });

  it("C-04 fork after an external throw reaches a catch", async () => {
    await runFixture("programs/c_04_fork_in_catch_external_throw.wasm", {
      contains: ["CALLING_HELPER", "IN_HELPER", "CAUGHT: 99", "PRE_FORK", "CHILD: ok", "PASS: C-04"],
    });
  });

  it("C-05 fork in a single modern-EH catch", async () => {
    await runFixture("programs/c_05_fork_modern_eh_single.wasm", {
      contains: ["THROWING", "CAUGHT: 1", "PRE_FORK", "CHILD: ok", "PASS: C-05"],
    });
  });

  it("C-06 fork in a reference-form multi-arm catch", async () => {
    await runFixture("programs/c_06_fork_modern_eh_multi_ref.wasm", {
      contains: ["THROWING", "CAUGHT_DOUBLE: 3.14", "PRE_FORK", "CHILD: ok", "PASS: C-06"],
    });
  });

  it("C-07 fork in a plain-form multi-arm catch", async () => {
    await runFixture("programs/c_07_fork_modern_eh_multi_plain.wasm", {
      contains: ["THROWING", "CAUGHT_LONG: 1234567", "PRE_FORK", "CHILD: ok", "PASS: C-07"],
    });
  });

  // C-08, C-09 — funcref/externref catch operands. There is no C-source
  // surface, so `crates/fork-instrument/tests/coverage_wat.rs` verifies the
  // ABI 43 boundary directly: reference payloads become complete exception
  // recipes and never enter module-instance scratch state.
  it.skip("C-08 funcref catch operand [coverage_wat.rs + catch-ref-fresh-worker.test.ts]", () => {});
  it.skip("C-09 externref catch operand [coverage_wat.rs + catch-ref-fresh-worker.test.ts]", () => {});

  it("C-10 forks in both a try body and its catch", async () => {
    await runFixture("programs/c_10_fork_in_try_and_catch.wasm", {
      contains: [
        "IN_TRY", "PRE_FORK_TRY", "CHILD_TRY: ok",
        "THROWING", "CAUGHT", "PRE_FORK_CATCH", "CHILD_CATCH: ok",
        "PASS: C-10",
      ],
    });
  });

  it("C-11 forks after a compiler catch has completed", async () => {
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

  // LLVM retains an exnref local across this external-throw path. Its
  // activation-owned recipe must survive the child instance boundary.
  it("S-08 external throw with live compiler exnref state", async () => {
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

  // K-06 lowers destructor cleanup to an untagged CatchAll. ABI 43 captures
  // the complete exception recipe rather than relying on the parent instance.
  it("K-06 fork from destructor through compiler CatchAll cleanup", async () => {
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

  // P-08: ABI 43 vfork uses the borrowed-memory transaction and parks the
  // caller until the child exits through the portable _exit-only path.
  it("P-08 vfork child exit resumes the parent", async () => {
    await runFixture("programs/p_08_vfork.wasm", {
      contains: ["PRE_VFORK", "PARENT: child=", "PASS: P-08"],
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

  // P-10: 4,096 live recursive activations require more frame payload than
  // ABI 41's retired 60 KiB contiguous reserve. This is the end-to-end guard
  // that the current host grows a linked continuation and replays it safely.
  it("P-10 continuation grows beyond the retired fixed reserve", async () => {
    await runFixture("programs/p_10_deep_linked_continuation.wasm", {
      contains: ["PRE_DEEP_FORK", "DEEP_CHILD: ok", "DEEP_PARENT: child=", "PASS: P-10"],
      timeout: 10_000,
      useDefaultRootfs: false,
    });
  });

  // P-11 first exhausts the address space completely so the root continuation
  // mmap fails before unwind, then frees exactly three pages so a deep fork
  // fails on its second chunk after committing frames. Both real guest paths
  // must leave no child and preserve a usable parent before a later fork
  // succeeds. The fill itself (programs/p_11_fork_continuation_enomem.c) uses
  // geometric backoff -- mmap a granule while it succeeds, halve on failure,
  // down to one wasm page -- so the SAME program can drive both fixtures
  // below to true ENOMEM regardless of how much address space it is given.
  //
  // TIGHT FIXTURE. The address space is constrained DELIBERATELY so the
  // error paths are reachable: root-allocation ENOMEM with no child, no
  // phantom child, a mid-unwind ABORT_UNWINDING, full unmapping, and a
  // recovery fork. Before 2026-09-18 this tightness came from a DEFECT --
  // the missing __heap_base export forced a 16 MiB brk fallback out of a
  // 24 MiB process -- so fixing the export would have made this fixture
  // quietly stop exercising what it claims. Constrained by maxPages, not
  // by stack size: the stack stays at the SDK default.
  //
  // THE RULE, not just a number: the fixed-3-page carve-out before the
  // deep fork (c:274, `free_pages_from_tail(&filler_count, 3)`) needs 3
  // free pages -- that is the real hard lower bound. The guard at c:199
  // (`total_pages_filled < 2`) only admits >= 2, so a fill that lands on
  // exactly 2 free pages passes the guard and then fails at the
  // carve-out instead, loudly and correctly ("FAIL: could not make fork
  // transaction page available") rather than at the guard. The guard's
  // threshold is looser than the real requirement; it does not change
  // what actually has to be true for this fixture to reach ENOMEM.
  //
  // There used to also be a practical UPPER bound of 511 free pages,
  // because the pre-2026-09-19 fill mapped one wasm page per array slot
  // (MAX_FILLER_MAPPINGS = 512), so it could not represent more than 511
  // free pages without running out of tracking slots before reaching real
  // ENOMEM -- exactly the failure the adaptive fixture below used to hit
  // at production layout (16384-page budget, 32x past that ceiling). The
  // 2026-09-19 geometric-backoff rewrite (mmap a granule while it
  // succeeds, halve on failure, down to one wasm page) removed that
  // upper bound rather than just raising it: a large free-page count now
  // costs on the order of a dozen mmap calls (one large chunk per binary
  // digit of the free-page count), not one call per page, so it stays
  // far under the 512-entry array regardless of size. Measured directly
  // against the rewritten fill: maxPages 384 (this fixture), 448, AND
  // 1024 all pass identically, and the unbounded production layout
  // (16384 pages, the adaptive fixture below) now passes too. A "+64
  // pages" perturbation will NOT find an edge here anymore -- there
  // isn't one below the production ceiling. This means the earlier
  // finding recorded against the pre-rewrite binary (that maxPages 1024
  // broke the fill) is now STALE; the fix that finding argued for is
  // exactly what removed it.
  //
  // So why keep maxPages: 384 for this fixture at all, if raising it no
  // longer breaks anything? Because it is a small, fast, and PRECISELY
  // KNOWN configuration -- roughly 5 free pages, not "however many
  // hundreds or thousands the SDK's current heap_base/stack choices
  // happen to leave" -- which is what makes it easy to reason about the
  // fixed-3-page carve-out and to keep this test cheap to run repeatedly.
  // See host/test/fork-identity-capacity.test.ts:192-197 for a case where
  // that SAME free-page window (there, eaten into by the fork-module's
  // identity-table static reservation) went red for real, which is a
  // genuine reason this window is worth keeping small and legible rather
  // than left to whatever the ambient layout happens to allow.
  it("P-11 root and later continuation allocation failures preserve the parent", async () => {
    await runFixture("programs/p_11_fork_continuation_enomem.wasm", {
      contains: [
        "ROOT_CONTINUATION_ENOMEM: ok",
        "ROOT_NO_PHANTOM_CHILD: ok",
        "ROOT_PARENT_USABLE: ok",
        "CONTINUATION_ENOMEM: ok",
        "NO_PHANTOM_CHILD: ok",
        "CONTINUATION_PAGE_REUSED: ok",
        "RECOVERY_CHILD: ok",
        "RECOVERY_PARENT: child=",
        "PASS: P-11",
      ],
      timeout: 10_000,
      useDefaultRootfs: false,
      maxPages: 384,
    });
  });

  // ADAPTIVE FIXTURE. The same program at the layout real software gets: a
  // real __heap_base, the SDK's 8 MiB shadow stack, the default page budget
  // (no maxPages override, i.e. PROCESS_MEMORY_DEFAULT_MAX_PAGES = 16384
  // pages = 1 GiB, host/src/generated/abi.ts:954). The tight fixture above
  // proves the error paths are CORRECT at a hand-constrained layout; this
  // one proves the SAME six error/success paths are still REACHABLE at
  // production scale, which nothing covered before 2026-09-18.
  //
  // This only works because the fill in
  // programs/p_11_fork_continuation_enomem.c uses geometric backoff rather
  // than one-wasm-page-at-a-time mmap calls. A single-page-at-a-time fill
  // needs one MAX_FILLER_MAPPINGS array entry (512 max) per page, so it can
  // only ever exhaust up to 512 * 64 KiB = 32 MiB -- a 32x shortfall against
  // the 1 GiB production budget. Measured before the fix: the fill hit its
  // own array cap having issued 512 successful 1-page mmaps and NEVER
  // reached ENOMEM, so it exited from inside its own fill loop having never
  // called fork() -- zero of the six error paths ran, and the fixture's
  // "PASS: P-11" was unreachable at this layout. Geometric backoff (start
  // at a large granule, halve on mmap failure, continue down to one page)
  // covers the same 1 GiB budget in on the order of a dozen mmap calls,
  // comfortably inside the 512-entry array, so the fill now reaches true
  // ENOMEM here exactly as it does in the tight fixture. Asserting the full
  // nine markers (not a subset) is deliberate: the whole point of this
  // fixture is that production layout now proves the identical sequence of
  // events the tight fixture proves, not merely that the program exits 0.
  it("P-11 reaches ENOMEM at production layout too", async () => {
    await runFixture("programs/p_11_fork_continuation_enomem.wasm", {
      contains: [
        "ROOT_CONTINUATION_ENOMEM: ok",
        "ROOT_NO_PHANTOM_CHILD: ok",
        "ROOT_PARENT_USABLE: ok",
        "CONTINUATION_ENOMEM: ok",
        "NO_PHANTOM_CHILD: ok",
        "CONTINUATION_PAGE_REUSED: ok",
        "RECOVERY_CHILD: ok",
        "RECOVERY_PARENT: child=",
        "PASS: P-11",
      ],
      timeout: 10_000,
      useDefaultRootfs: false,
      // no maxPages override
    });
  });
});

// ---------------------------------------------------------------------------
// F-* explicit boundaries and Wasm-GC ownership
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / F-* boundaries and Wasm-GC", () => {
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

  // F-03, F-04 — wasm-GC anyref / struct.new have no C-source surface.
  // `coverage_wat.rs` verifies that both are accepted, encoded into
  // activation-owned recipes, and emitted as independently valid Wasm.
  it.skip("F-03 wasm-GC anyref [coverage_wat.rs + gc-reference-state-fresh-worker.test.ts]", () => {});
  it.skip("F-04 wasm-GC struct.new [coverage_wat.rs + gc-reference-state-fresh-worker.test.ts]", () => {});
});
