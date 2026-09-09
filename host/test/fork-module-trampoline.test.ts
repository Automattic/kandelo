// Phase 6 D7a.1a-host: the production TypeScript port of the per-activation
// frame TRAMPOLINE (`crates/fork-module/tests/fork-trampoline.mjs`) must, in a
// real WebAssembly engine, route N activations' frozen guest-facing frame calls
// to the shared fork-module's activation-parameterized exports without
// cross-activation aliasing. This mirrors the module-side multi-activation
// harness against the STAGED `fork_module32.wasm`.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import {
  type ForkModuleExports,
  instantiateForkModule,
} from "../src/fork-module-instance";
import {
  emitTrampoline,
  ForkModuleTrampolines,
} from "../src/fork-module-trampoline";

const MiB = 1024 * 1024;

function loadForkModule32(): WebAssembly.Module {
  return new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm")));
}

describe("fork-module trampoline (production TS port)", () => {
  it("emits a valid, correctly-typed trampoline module", () => {
    const bytes = emitTrampoline(1);
    expect(WebAssembly.validate(bytes as unknown as BufferSource)).toBe(true);
    const mod = new WebAssembly.Module(bytes as unknown as BufferSource);
    const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
    for (const need of [
      "shared.fm_frame_reserve",
      "shared.fm_frame_commit",
      "shared.fm_frame_peek",
      "shared.fm_frame_next",
      "shared.fm_resume_peek",
    ]) {
      expect(imports).toContain(need);
    }
    const exportNames = new Set(WebAssembly.Module.exports(mod).map((e) => e.name));
    for (const need of [
      "__wpk_fork_frame_reserve",
      "__wpk_fork_frame_commit",
      "__wpk_fork_frame_peek",
      "__wpk_fork_frame_next",
      "__wpk_fork_resume_peek",
    ]) {
      expect(exportNames.has(need)).toBe(true);
    }
  });

  // The former in-process multi-activation frame-ROUTING case that drove a full
  // unwind -> replay cycle here used the module's in-realm FIXED-arena harness
  // exports (`fm_begin_unwind_fixed_arena` / `fm_add_activation_unwind_fixed_arena`
  // / `fm_finish_unwind` / `fm_begin_replay` / `fm_finish_replay`). Those
  // fine-grained DRIVE exports and the fixed-arena machinery were deleted once
  // every fork phase routed through the coarse `fm_parent_*` per-phase entries
  // (control-flow inversion), which drive the guest phase-flip exports through the
  // injected `fm_drive_execute` shim and cannot be driven without a real guest +
  // channel responder. Per-activation frame routing (independent writers, no
  // cross-activation aliasing, the journal activation gate) is now covered
  // end-to-end by the coarse two-activation dlopen forks in
  // `fork-from-dlopen-side-module-e2e.test.ts` / `fork-dlopen-replay-e2e.test.ts`
  // and the host-native `--lib` runner. This file retains the guest-independent
  // trampoline emit/validate and per-activation instance caching coverage.

  it("caches one instance per activation id and evicts on request", () => {
    const module = loadForkModule32();
    const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
    let next = 8 * MiB;
    const fm = instantiateForkModule({
      module,
      memory,
      ptrWidth: 4,
      reserve: (size) => {
        const base = next;
        next += size;
        return base;
      },
      label: "trampoline-cache-test",
    });
    const trampolines = new ForkModuleTrampolines(fm.exports as ForkModuleExports);
    const first = trampolines.instanceFor(2);
    expect(trampolines.instanceFor(2)).toBe(first);
    trampolines.evict(2);
    expect(trampolines.instanceFor(2)).not.toBe(first);
  });
});
