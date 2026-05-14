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
import { tryResolveBinary } from "../src/binary-resolver";

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
  expect(result.exitCode).toBe(expected.exitCode ?? 0);
  for (const fragment of expected.contains) {
    expect(result.stdout).toContain(fragment);
  }
}

/** Echo binary built from examples/echo.c, registered for popen/posix_spawn. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findRepoRoot } from "../src/binary-resolver";
const echoCandidate = join(findRepoRoot(), "examples", "echo.wasm");
const echoBinary = existsSync(echoCandidate) ? echoCandidate : null;
const echoExecMap = echoBinary
  ? new Map<string, string>([
      ["echo", echoBinary],
      ["/bin/echo", echoBinary],
      ["/usr/bin/echo", echoBinary],
    ])
  : undefined;

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

  it("D-06 fork inside try_table body (today: guard-dispatch; post-pivot: trampoline)", async () => {
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
  // Pre-pivot: B1 stages 1+2 shipped on this branch but the
  // synthetic fixture proves they don't actually close the case
  // end-to-end. Should pass after the architectural pivot.
  it.fails("C-02 fork inside single-arm plain catch (B1) [pivot: commits 2-4]", async () => {
    await runFixture("programs/c_02_fork_in_catch.wasm", {
      contains: ["THROWING", "CAUGHT: 7", "PRE_FORK", "CHILD: ok", "PASS: C-02"],
    });
  });

  // C-03: A3 multi-target plain-catch try_tables — carved out today,
  // implemented in commits 5-6 of the mega-PR.
  it.fails("C-03 fork in multi-arm plain catch (A3) [commit 6]", async () => {
    await runFixture("programs/c_03_fork_in_multi_arm_catch.wasm", {
      contains: ["THROWING", "CAUGHT_STR: x", "PRE_FORK", "CHILD: ok", "PASS: C-03"],
    });
  });

  // C-04: B2 throw outside instrumented region. Today guard-dispatch
  // leaves the throw ungated; under switch-dispatch + trampoline this
  // must just work.
  it.fails("C-04 fork in catch where throw originates outside instrumented region (B2) [pivot]", async () => {
    await runFixture("programs/c_04_fork_in_catch_external_throw.wasm", {
      contains: ["CALLING_HELPER", "IN_HELPER", "CAUGHT: 99", "PRE_FORK", "CHILD: ok", "PASS: C-04"],
    });
  });

  // C-05..C-07: modern wasm-EH variants. Pre-flip the SDK still uses
  // legacy-EH so these are effectively duplicates of C-02 / C-03 /
  // multi-typed-catch under legacy lowering. Real divergence appears
  // once C5's libcxx + flag flip lands in commit 8.
  it.fails("C-05 modern EH single-clause typed catch + fork [commit 8]", async () => {
    await runFixture("programs/c_05_fork_modern_eh_single.wasm", {
      contains: ["THROWING", "CAUGHT: 1", "PRE_FORK", "CHILD: ok", "PASS: C-05"],
    });
  });

  it.fails("C-06 modern EH multi-target *_ref try_table + fork (A2) [commit 5]", async () => {
    await runFixture("programs/c_06_fork_modern_eh_multi_ref.wasm", {
      contains: ["THROWING", "CAUGHT_DOUBLE: 3.14", "PRE_FORK", "CHILD: ok", "PASS: C-06"],
    });
  });

  it.fails("C-07 modern EH multi-arm plain catches + fork (A3) [commit 6]", async () => {
    await runFixture("programs/c_07_fork_modern_eh_multi_plain.wasm", {
      contains: ["THROWING", "CAUGHT_LONG: 1234567", "PRE_FORK", "CHILD: ok", "PASS: C-07"],
    });
  });

  // C-08, C-09 are stubs — A4 funcref/externref catch operands have no
  // C-source surface. Real fixtures need WAT. Marked it.todo so the
  // test ID is tracked but no assertion runs against the stub binary.
  it.todo("C-08 plain catch arm with funcref operand (A4 aux table) [needs WAT fixture; commit 7]");
  it.todo("C-09 plain catch arm with externref operand (A4 aux table) [needs WAT fixture; commit 7]");

  // C-10: fork in BOTH try body and catch handler. Combines D-06 with
  // C-02. Will fail until both the trampoline (commits 2-4) and the
  // catch-handler dispatch (commits 5-6) land.
  it.fails("C-10 fork in both try body and catch handler [pivot + A3]", async () => {
    await runFixture("programs/c_10_fork_in_try_and_catch.wasm", {
      contains: [
        "IN_TRY", "PRE_FORK_TRY", "CHILD_TRY: ok",
        "THROWING", "CAUGHT", "PRE_FORK_CATCH", "CHILD_CATCH: ok",
        "PASS: C-10",
      ],
    });
  });

  // C-11: post-catch fork (catch frame fully popped). Repro of the
  // SpiderMonkey spike test (b). Same root cause as C-02 — the
  // architectural pivot must fix it.
  it.fails("C-11 fork after fully-popped catch frame (spike test b) [pivot]", async () => {
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
  // emit these instructions; need WAT fixtures. Test IDs reserved.
  it.todo("S-04 table.fill before fork (B3) [needs WAT fixture; pivot]");
  it.todo("S-05 table.copy before fork (B3) [needs WAT fixture; pivot]");
  it.todo("S-06 table.grow before fork (B3) [needs WAT fixture; pivot]");
  it.todo("S-07 direct call returning non-nullable funcref before fork (B4) [needs WAT fixture; pivot]");

  // S-08: throw from outside instrumented region, caught inside,
  // fork in catch. Sibling of C-04. Same expected timeline.
  it.fails("S-08 throw from outside instrumented region, fork in catch (B2) [pivot]", async () => {
    await runFixture("programs/s_08_external_throw_fork_in_catch.wasm", {
      contains: ["ENTER_OUTER", "ENTER_INNER", "THROWING", "CAUGHT: 73", "PRE_FORK", "CHILD: ok", "PASS: S-08"],
    });
  });
});

// ---------------------------------------------------------------------------
// K-* callback-registration fork roots (C3 + C4)
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / K-* callback fork roots", () => {
  // K-01..K-04 surprisingly all pass today (verified empirically while
  // landing this scaffolding) — the address-taken handler functions
  // are reached via the kernel's signal-delivery / pthread-cleanup
  // path, and the fork-instrument tool's call-graph analysis already
  // picks up the indirect callers transitively. Marking these as
  // regression gates so the "C3 conservative rule" work in commits
  // 2-N doesn't accidentally regress them. If it turns out the
  // current pass is incidental rather than intentional, flipping back
  // to it.fails() while the explicit C3 work lands is fine.
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

  // K-03: fork-inside-pthread-cleanup hangs in the parent post-fork.
  // Empirical behavior on this branch: occasionally completes in ~5s
  // (one observed run during scaffolding) but generally times out at
  // ≥20s. Treating as broken — the C4 conservative-rule work in the
  // pivot is the planned fix. Tight timeout keeps the test fast.
  it.fails("K-03 fork from pthread_cleanup_push handler (C4) [pivot]", async () => {
    await runFixture("programs/k_03_fork_in_pthread_cleanup.wasm", {
      contains: ["THREAD_STARTED", "IN_CLEANUP arg=42", "PRE_FORK", "CHILD: ok", "PASS: K-03"],
      timeout: 7_000,
    });
  }, 10_000);

  it("K-04 fork from qsort comparator (C3 conservative-rule pathological case)", async () => {
    await runFixture("programs/k_04_fork_in_qsort_comparator.wasm", {
      contains: ["PRE_QSORT", "PRE_FORK", "CHILD: ok", "POST_QSORT sorted=1", "PASS: K-04"],
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

  // P-04 popen — known-broken under guard-dispatch
  // (memory:fork-instrument-O2-bug-investigation.md). The architectural
  // pivot is the planned fix.
  it.fails("P-04 popen+pclose (fork+exec+pipe end-to-end) [pivot]", async () => {
    await runFixture("programs/p_04_popen_pclose.wasm", {
      contains: ["POPEN_OPENED", "READ: hello-popen", "PCLOSE: status=0", "PASS: P-04"],
      execPrograms: echoExecMap,
    });
  });

  it("P-05 posix_spawn — non-forking path, must remain unchanged by refactor", async () => {
    await runFixture("programs/p_05_posix_spawn.wasm", {
      contains: ["SPAWNED child=", "WAIT: status=0", "PASS: P-05"],
      execPrograms: echoExecMap,
    });
  });
});

// ---------------------------------------------------------------------------
// F-* accepted-limit failure modes
// ---------------------------------------------------------------------------

describe("fork_instrument_coverage / F-* accepted limits", () => {
  // F-01, F-02 — ucontext API. The musl wasm sysroot exposes the
  // header but provides no implementation, so a real fixture would
  // fail to link. Real test = build-time link-failure assertion,
  // landing alongside the doc updates in commit 10. Placeholder
  // stubs exit non-zero so they're tracked.
  it.todo("F-01 getcontext accepted limit [needs link-failure harness; commit 10]");
  it.todo("F-02 makecontext/swapcontext accepted limit [needs link-failure harness; commit 10]");

  // F-03, F-04 — wasm-GC anyref / struct.new. No C-source surface;
  // need a WAT fixture + driver harness that invokes
  // wasm-fork-instrument directly and asserts non-zero exit. Lands
  // with the accepted-limit doc updates in commit 10.
  it.todo("F-03 wasm-GC anyref accepted limit [needs WAT + driver; commit 10]");
  it.todo("F-04 wasm-GC struct.new accepted limit [needs WAT + driver; commit 10]");
});
