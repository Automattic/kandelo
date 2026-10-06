# FFmpeg Port — Gap Ledger

Running record of every Kandelo gap the FFmpeg port exposes. Procedure:
`docs/plans/2026-09-26-ffmpeg-port-plan.md`, "Gap-Fix Protocol".
Design: `docs/plans/2026-09-26-ffmpeg-port-design.md` §4 and §9.

## Status

| Rung | Reached | Open gaps |
|---|---|---|
| 0 honest configure | configure completes with all dependencies; audit passes with no correction (G2 closed by #1428) | — |
| 1 running binaries | Tier 1 and process-runtime tests pass | — |
| 2 full codec set | compiles with 0 errors; link audit clean; Big Buck Bunny video bit-exact; FATE 1,408/1,408 across h264, hevc (upstream wasm simd128), aac, mpeg4, vp9, opus, flac, pcm, mov, matroska, vfilter, afilter | — |
| 3 devices + ffplay | `/dev/fb0` and `/dev/dsp` on Node; ffplay video in the browser's KMS pane and as a Wayland client in the Omarchy desktop (G6 closed by #1428) | — |

Acceptance (`packages/registry/ffmpeg/test/run-acceptance.sh`, 2026-10-01, on #1428 at `c8081a0cf`): Node tiers 25/25, FATE 1,408/1,408, browser (Chromium) 4/4, no skips.

## Known non-gaps

- **SDL2 `--disable-render`** — not a failure. It dates from SDL2's
  audio-only package (`313cfdfeb`); video was enabled later (`2bef9f783`)
  for a demo that draws with GLES2 directly, so nothing needed SDL's
  renderer. Enabled in Task 6.

- **Native reference used non-bit-exact NEON code** — native n9.0 on arm64
  decodes (and encodes) the MPEG-4 Part 2 fixture differently from its own
  C code from the second GOP on, even with `-flags +bitexact` on the input.
  Kandelo matched native `-cpuflags 0` exactly, so the references are now
  built with `--disable-asm` (`Tests: Take native FFmpeg references from
  its portable C code`). Possibly an upstream arm64 bit-exactness bug;
  not a Kandelo gap.
- **GNU libiconv's header shadowed libc iconv** — with `--disable-autodetect`
  FFmpeg probes the libc's `iconv` (musl has one); an `-I` for GNU
  libiconv made `iconv.h` rename calls to `libiconv_*`, and the probe
  "passed" only because of G2. A package-build mistake, fixed in the
  package's flags; FFmpeg now uses Kandelo's libc iconv. The post-link
  audit now also fails the build if a program imports anything from `env`
  beyond `memory` and `__channel_base`, so this class of mistake cannot
  ship silently from this package whatever happens with G2.
- **Host files created by the guest are mode 0600 on disk** — deliberate:
  `host/src/native-positioned-write.ts` creates native backing files with
  `NATIVE_BACKING_MODE = 0o600` and Kandelo keeps the guest-visible mode in
  its own metadata (a guest `open(…, 0666)` under umask 022 reads back 644
  through `fstat` and `stat`). Not a gap.

## Gaps

### G1. libxml2 package does not install upstream's header layout

- **Found at:** rung 0 / Task 2, command: `cargo run -p xtask --target <host> -- build-deps resolve ffmpeg`
- **Symptom:** FFmpeg's configure probe `#include <libxml2/libxml/xmlversion.h>` fails: `'libxml2/libxml/xmlversion.h' file not found`, then `ERROR: libxml-2.0 not found using pkg-config`.
- **Traced layer:** package build (`packages/registry/libxml2/build-libxml2.sh`). Upstream libxml2 installs headers at `<prefix>/include/libxml2/libxml/*.h` and its `libxml-2.0.pc` says `Cflags: -I${includedir}/libxml2`. Kandelo's hand-written install puts them at `<prefix>/include/libxml/*.h` with `Cflags: -I${includedir}`. Software written against the real layout (FFmpeg) cannot find them; PHP already compensates with an extra `-I…/include` in `build-php.sh`.
- **Disposition (spec §4):** fix the platform — the libxml2 package must install the layout upstream documents, so consumers need no compensation.
- **Fix commit:** `Packages: Install libxml2 headers in upstream's layout`
- **Proof:** `packages/registry/libxml2/test/libxml2-layout.test.ts` 3/3 (RED before: headers and Cflags missing; GREEN after rebuild at rev 5). PHP rebuilt against it through the resolver (`build-deps resolve php` EXIT 0). After the full rebuild, PHP's package suite against the rebuilt PHP: 27 passed, 5 skipped (the intl side-module group, gated on an unrelated artifact); `SimpleXML works` passes.
- **Status:** closed

### G2. Link probes succeed for functions Kandelo does not have

- **Found at:** rung 0 / Task 2, `audit-configure.sh config` after FFmpeg's configure.
- **Symptom:** `config.h` claims `HAVE_CLOSESOCKET`, `HAVE_GETHRTIME`, and `HAVE_SYSCTL`; `sysroot/lib/libc.a` defines none of them (they are Windows, Solaris, and BSD APIs).
- **Traced layer:** SDK. `linkFlags()` in `sdk/src/lib/flags.ts` passes `-Wl,--allow-undefined` to every executable link, so a configure probe that links a call to a nonexistent function succeeds and records the function as present. No package-level flag can undo it (tested): wasm-ld documents `--allow-undefined` as `--import-undefined` plus `--unresolved-symbols=ignore-all`, and `--import-undefined` turns every missing function into an import before any unresolved-symbol policy runs, so `--unresolved-symbols=report-all`, `--error-unresolved-symbols`, and `--warn-unresolved-symbols` all link a call to a nonexistent function silently. The resulting program imports the missing function from `env` and traps if the call is ever reached.
- **Blast radius today** (survey of the 123 program binaries in `local-binaries/` on 2026-09-26): besides the platform's own imports (`env.memory`, `env.__channel_base`, the `__wasm_dl*` loader hooks), shipped programs import functions that do not exist — `coreutils`: `re_search`, `re_match`, `re_compile_pattern`, `re_compile_fastmap`, `isapipe`; `tar`: `rpmatch`; `bash`: `locale_charset`; `php`/`php-fpm`: `swapcontext`, `makecontext`, `getcontext`; `ruby`: `sqlite3_column_database_name`; `mariadbd`: `__cxa_thread_atexit`; one program imports C++ runtime symbols (`_Znwm`, `__cxa_throw`, …). Each is a probe that lied or a link that silently accepted a missing symbol. Concretely, the shipped `coreutils` fails a basic regular-expression match today: `coreutils --coreutils-prog=expr abcdef : 'a.*d'` dies with `Unimplemented import: env.re_compile_pattern` — coreutils' configure believed libc provided GNU's regex API, so gnulib's own regex was never compiled in.
- **Disposition (spec §4):** SDK probe gap — a cross-cutting SDK contract change, so per the plan's G3 it goes to the maintainer before implementation.
- **Options:**
  1. *(recommended)* Replace the blanket `--allow-undefined` with `-Wl,--allow-undefined-file=<sdk list>` naming only the symbols the platform really provides at instantiation (`__channel_base`, the dynamic-loader hooks, and whatever else the survey proves legitimate). Every configure probe in every package becomes honest, and programs that silently depend on missing functions fail at link time instead of trapping at run time. Cost: every package's cache key changes (full rebuild), and each package that breaks is a new, real gap.
  2. An opt-in strict mode (for example an environment variable the SDK honours) that configure-time links use. Smaller blast radius, but probes stay dishonest by default for every other package.
  3. Per-package seeding, the current practice for autoconf packages. FFmpeg's configure is not autoconf and has no cache variables, so this would mean patching its configure or editing `config.h` — which the §4 patch rule forbids.
- **Decision:** option 1 (maintainer, 2026-09-27), as a separate platform PR (#1428) that this PR builds on.
- **Fix commits (#1428):** `ABI: Declare the env imports the host provides`, `SDK: Fail links that need functions the platform lacks`, `SDK: Use the generated link allowance in every link path`, `Host: Refuse programs that import functions Kandelo lacks`, and the package fixes the honest links exposed (coreutils regex, espeak-ng, Ruby's SQLite, PHP Fibers, the desktop packages main added).
- **Proof:** FFmpeg's configure audit passes on the real package build with no `config.h` correction; `check-program-env-imports.sh` finds no undeclared import in 293 built programs; `coreutils expr abcdef : 'a.*d'` matches. Validation detail is in #1428.
- **Status:** closed

### G3. 128-bit integer division builtins are missing

- **Found at:** rung 1 / Task 3, inspecting the imports of the linked `ffmpeg` and `ffprobe`.
- **Symptom:** both programs import `env.__divti3`, `env.__udivti3`, and `env.__umodti3`. Nothing provides them, so any 128-bit division or modulo traps at run time; the link only succeeded because of G2's `--allow-undefined`.
- **Traced layer:** SDK/libc glue. The toolchain ships no LLVM compiler-rt builtins library for wasm32 (`clang -print-libgcc-file-name` names `…/wasm32-unknown-unknown/libclang_rt.builtins.a`, which does not exist). The SDK instead links `libc/glue/compiler_rt.c`, a hand-written subset that has the 128-bit shifts and multiply (`__ashlti3`, `__lshrti3`, `__ashrti3`, `__multi3`) but not divide or modulo. Clang lowers every `__int128` division to these calls.
- **Disposition (spec §4):** fix the platform — add the missing builtins (`__udivmodti4`, `__udivti3`, `__umodti3`, `__divti3`, `__modti3`). Additive; no existing contract changes.
- **Fix commit:** `SDK: Provide 128-bit integer division builtins`
- **Proof:** `host/test/int128-division-guest.test.ts` 2/2, wasm32 and wasm64 (RED before: `Unimplemented import: env.__udivti3`). Full local rebuild relinked every package with the new glue (all succeeded except FFmpeg, blocked on G2); libc-test afterwards: 303 passed, 0 failed, 0 timeouts, 20 expected failures (the known list).
- **Status:** closed

### G4. Host-provided stdin is not inherited by child processes

- **Found at:** rung 1 / Task 4, the shell-pipeline process test.
- **Symptom:** `sh -c 'ffmpeg -i pipe:0 … | ffprobe …'` with stdin supplied by the host hangs until timeout. Bisected with a plain C probe: a process reading its own host-provided stdin gets every byte and then end-of-file (`fstat` says FIFO, `lseek` says `ESPIPE`, correct), but a child that inherits fd 0 through `fork`/`exec` blocks forever in `read()` — no data, no end-of-file. A pipeline the shell creates itself (`ffmpeg … pipe:1 | ffprobe … pipe:0`) works.
- **Traced layer:** host runtime / kernel boundary. `host/src/kernel-worker.ts` keeps finite stdin in `stdinBuffers: Map<pid, …>` and `stdinFinite: Set<pid>`, and the kernel's `onStdin` callback answers for `this.currentHandlePid`. POSIX makes fd 0 after `fork` the *same open file description*, shared by parent and child with one read offset; keying the bytes by pid gives the child nothing and the "not finite → block" default.
- **Reach:** every Node host program given stdin (`NodeKernelHost.spawn({ stdin })`, `setStdinData`/`appendStdinData`, `examples/run-example.ts` with piped input) whose stdin is read by a child — e.g. `echo x | run-example sh -c cat`. The browser uses the same kernel-worker code for `set_stdin_data`/`append_stdin_data`; its terminal path is a PTY and is unaffected.
- **Disposition (spec §4):** fix the platform. The fix changes the kernel/host interface, so per the plan's G3 it goes to the maintainer first.
- **Options:**
  1. *(recommended)* Make host-supplied stdin a kernel object: the host hands the bytes to the kernel, which installs fd 0 as an open file description of a non-seekable stream that owns the buffer, the read offset, end-of-file, and `poll` readiness. `fork`, `dup`, and `exec` then share it for free, and the host's per-pid buffers and `onStdin` path go away — in line with pushing state into Rust and shrinking the host surface.
  2. Keep the buffer in the host but key it by an identifier the kernel passes to `onStdin` for the open file description, so every sharer reads the same buffer and offset. Smaller change; keeps a host-owned piece of file state.
- **Decision:** option 1 (maintainer, 2026-09-27), in #1428 with G2.
- **Fix commits (#1428):** `Kernel: Give host-supplied stdin a kernel pipe`, `Host: Deliver host stdin through the kernel pipe`, `Host: Never let host stdin input take the kernel down`.
- **Proof:** `host/test/host-stdin-pipe.test.ts` (a forked child reads inherited stdin; parent and child share one offset; 24 MB in order). FFmpeg's shell-pipeline process test passes.
- **Status:** closed

### G5. Fork instrumentation miscounted SIMD lane loads and stores

- **Found at:** rung 3 / Task 7, running the fork-instrumented `ffplay`.
- **Symptom:** the instrumented module fails to compile: `Compiling function #70:"decode_frame" failed: not enough arguments on the stack for local.set`. Binaryen's parser reports the same spot ("popping from empty stack").
- **Traced layer:** `crates/fork-instrument`. walrus files the SIMD lane memory operations under `Instr::LoadSimd` alongside the plain SIMD loads, but `v128.loadN_lane` is 2 → 1 and `v128.storeN_lane` is 2 → 0; the instrumenter modelled all of them as 1 → 1 (`top_level_stack_effect` in `instrument.rs` and the typed model in `reference_analysis.rs`). Overcounting the operand stack at a fork-path call makes it spill carryovers that do not exist. `ffplay` is the first package that is both compiled with `-msimd128` and fork-instrumented (SDL2 can fork), so this was latent until now. It also matters for any future SDK-wide SIMD default.
- **Disposition (spec §4):** fix the platform.
- **Fix commit:** `Fork: Count SIMD lane loads and stores correctly`
- **Proof:** new `crates/fork-instrument/tests/switch_dispatch.rs::simd_lane_memory_ops_keep_carryover_count_exact` with fixture `simd_lane_carryover.wat` (RED: `wasmparser validation failed: type mismatch: expected i32 but nothing on stack`; GREEN after). Whole crate: 339 passed, 0 failed. The real `ffplay` now instruments to a module V8 compiles, and plays audio on Node.
- **Status:** closed

### G6. SDL's GLES2 renderer could not draw through Kandelo's GL

- **Found at:** rung 3 / Task 9, the `ffplay` browser profile.
- **Symptom:** `Failed to create window or renderer: Couldn't find matching render driver`. With that fixed, the window stayed black; inside the Omarchy desktop the whole display then went black.
- **Traced layer:** libGLESv2 and the host WebGL bridge, three defects. (1) SDL's GLES2 renderer looks up `glBlendFuncSeparate`, `glBlendEquationSeparate`, `glFinish` and `glShaderBinary` at startup; libGLESv2 had none. (2) SDL2 draws from client-side vertex arrays (OpenGL ES 2.0 core; SDL uses buffers only on Emscripten); libGLESv2 forwarded the client pointer as a buffer offset and WebGL rejected every attribute and draw with `GL_INVALID_OPERATION`. (3) Programs sharing one canvas share one WebGL2 context, and their default vertex-array state was WebGL's single default VAO, so ffplay's attributes broke the compositor's draws.
- **Disposition (spec §4):** fix the platform.
- **Fix commits (#1428):** `GL: Add the blend, finish and shader-binary entry points SDL needs`, `GL: Draw from client-side vertex arrays`, `GL: Give each program its own default vertex array`.
- **Proof:** WebGL unit tests (the vertex-array isolation tests fail without the fix); `apps/browser-demos/test/kandelo-ffmpeg.spec.ts` shows testsrc's colour bars in the KMS pane and in an Omarchy window; the existing Omarchy, Wayland, modeset, SDL2, ScummVM and KMS context-loss specs still pass.
- **Status:** closed

### G7. The binaries embedded the build machine's paths

- **Found at:** Task 11, reading `ffplay`'s banner.
- **Symptom:** `ffmpeg -version` printed `--extra-cflags='-I/Users/<builder>/.cache/kandelo/…/zlib-…/include'` and similar; two machines building the same inputs produced different binaries.
- **Traced layer:** this package's build. FFmpeg compiles its configure arguments into the binaries (`FFMPEG_CONFIGURATION`), and the recipe passed resolver prefixes as arguments.
- **Disposition:** package build fix; FFmpeg itself is correct.
- **Fix:** `ffmpeg_normalize_configuration` in `configure-flags.sh` rewrites each prefix to the name of the variable that held it and fails the build if a host path remains (part of `Packages: Add FFmpeg n9.0`).
- **Proof:** `ffmpeg-tier1.test.ts` "names no build-machine path in its configuration" (RED on the earlier build, GREEN after).
- **Status:** closed

### G8. ffplay's strip removed the names fork facts bind through

- **Found at:** reviewing #1471 (fork sinks, ABI 46) for its effect on this package.
- **Symptom:** none yet visible: ffplay would build and run, but fork instrumentation would ignore the compiler's call-type facts and keep far more functions instrumented than the facts allow.
- **Traced layer:** this package's build. FFmpeg links `ffplay_g` and ships `$(STRIP) -o ffplay ffplay_g`; configure's default `strip` (the dev shell's `llvm-strip`) removes the `name` section. The instrumenter binds `kandelo.calltypes` facts to functions by name, and when it cannot it falls back to the analysis without facts with only a warning, by design (facts are an optimization input). `strip --strip-debug` keeps `name`, `producers` and `kandelo.calltypes`.
- **Disposition:** package build fix. Whether a silent fallback should fail other builds too is a question for the fork-instrumentation work, not for this package.
- **Fix:** `--strip=llvm-strip --strip-debug` in `configure-flags.sh`, and `build-ffmpeg.sh` fails unless `wasm-fork-instrument --sink-report` reports `source facts` for ffplay.
- **Proof:** the check reports `source builtin` for an ffplay built before facts existed (RED). GREEN needs the ABI 47 rebuild.
- **Status:** open until the rebuild confirms it

## Results

### SIMD benchmark (Node host)

Bounded to FFmpeg single-threaded decode of these inputs as Kandelo processes
on the Node host; not a claim about Kandelo generally. Builds: the scratch
full-default build (`-msimd128`, 346,909 SIMD instructions in `ffmpeg`) and the
same configure without `-msimd128` plus `--disable-simd128` (0 SIMD
instructions). `test/bench/simd-bench.sh`, 5 runs each, builds interleaved so
drifting load affects both; machine load average 11–13 from other workspaces.
Each run includes Kandelo start-up, measured separately as 0.415 s median
(`ffmpeg -version`, 5 runs).

| Input | With SIMD (median) | Without (median) | Decode only, with / without |
|---|---|---|---|
| HEVC `hevc-conformance/DELTAQP_A_BRCM_4.bit` (FATE sample) | 1.319 s | 1.500 s | 0.90 s / 1.09 s — about 17% less decode time |
| H.264 Big Buck Bunny 320x180, whole file | 4.859 s | 4.789 s | no measurable difference (runs 2–3 hit load spikes of 8–10 s in both builds) |

This matches upstream: FFmpeg n9.0's hand-written wasm SIMD covers HEVC IDCT
and SAO only, and compiler auto-vectorization gives H.264 decode nothing
measurable here.

### SIMD benchmark (browser)

Bounded to FFmpeg single-threaded decode of these inputs inside a Kandelo
machine in headless Chromium; not a claim about Kandelo generally. Both builds
are scratch builds made the same way as FATE's (`run-fate.sh`), one with and
one without simd128, downloaded into the machine with `curl` from a local
server; `sha256sum` inside the machine matched the host files. Five runs each,
interleaved, timed with bash's `time` (each run includes Kandelo process
start-up); machine load average about 2.

| Input | With SIMD (median, runs) | Without (median, runs) |
|---|---|---|
| HEVC `hevc-conformance/DELTAQP_A_BRCM_4.bit` | 0.938 s (0.961, 0.931, 0.955, 0.938, 0.917) | 1.109 s (1.116, 1.109, 1.139, 1.107, 1.101) — about 15% less time with SIMD |
| H.264 Big Buck Bunny 320x180, whole file | 4.322 s (4.376, 4.338, 4.322, 4.288, 4.236) | 4.333 s (4.361, 4.337, 4.317, 4.333, 4.222) — no difference |

The browser agrees with the Node host: upstream's wasm SIMD helps HEVC and
nothing helps H.264 measurably.
