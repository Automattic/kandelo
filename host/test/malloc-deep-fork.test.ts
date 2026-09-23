// Deep-fork validation for the module-owned growing frame allocator (dynamic
// channel `SYS_mmap` frame allocation — the production capture path after Fix X
// was retired).
//
// `malloc-deep-fork.c` grows its heap via a big tracked malloc and forks from a
// deep linked continuation. Two invariants:
//   1. A deep fork (16000 frames) grows the continuation frame chunks cleanly
//      PAST the old 2 MiB Fix X cap and replays correctly (child == parent
//      survival + snapshot isolation), with coherent placement above the live
//      heap (no clobber).
//   2. A genuine memory-admission exhaustion is a TRUTHFUL failure: `fork()`
//      returns -1 to the guest and the parent survives (no crash, no silent
//      success, no clobber).
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtures = join(__dirname, "fixtures");

describe("deep fork: module-owned growing frame allocator", () => {
  it("grows a deep (16000-frame) fork past the old 2 MiB cap and replays cleanly", async () => {
    const r = await runCentralizedProgram({
      programPath: join(fixtures, "malloc-deep-fork.wasm"),
      argv: ["malloc-deep-fork", "16000"],
      timeout: 90_000,
    });
    expect(r.stdout).toMatch(/MALLOC_DEEP_FORK_PASS target=16000/);
    expect(r.exitCode).toBe(0);
  });

  it("fails truthfully on a genuine OOM: fork()=-1, parent survives", async () => {
    // THE BUDGET IS CALIBRATED TO THE MODULE'S REGION, and it moved. This was
    // 40 MiB while every fork-module instance reserved 3,735,552 bytes; the
    // storage conversion took that reservation to 1,376,256, and the deep
    // fork -- which overflowed 40 MiB by less than 0.7 MiB at a 2,818,048-byte
    // region and fitted at 2,490,368 -- now needs roughly 37 MiB in total. A
    // budget the fork fits inside is not a genuine OOM, and this case read
    // "MALLOC_DEEP_FORK_PASS" instead of a refusal from the commit that merged
    // the resume catalogs onward. 32 MiB refuses with margin at the current
    // region and is still large enough that the refusal is admission, not a
    // toy limit.
    const r = await runCentralizedProgram({
      programPath: join(fixtures, "malloc-deep-fork.wasm"),
      argv: ["malloc-deep-fork", "16000"],
      timeout: 60_000,
      maxProcessMemoryBytes: 32 * 1024 * 1024,
    });
    // The kernel refuses to grow the child clone past the admission budget, so
    // fork() returns -1 to the guest (recurse_and_fork rc=-1 -> exit 2) rather
    // than a silent success or a clobber. The parent process stays alive to
    // observe and report the failure (it is the one that exits).
    expect(r.stdout).not.toMatch(/MALLOC_DEEP_FORK_PASS/);
    expect(r.exitCode).not.toBe(0);
  });
});
