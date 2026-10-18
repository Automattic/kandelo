# FFmpeg Port to Kandelo — Design

Date: 2026-09-26
Branch: `brandonpayton/ffmpeg-on-kandelo`

## §1. Why

Kandelo's north star is complete POSIX conformance, exercised through the
normal platform path: SDK, libc, package resolver, VFS image, syscalls, host
runtime, and kernel. Porting demanding real software is how we find out where
that path is incomplete.

FFmpeg is an unusually good forcing function. It is large (roughly 2,000 C
source files), portable C with a hand-written `configure`, and it touches a
wide platform surface in one program: file I/O with large seeks, pipes,
threads, terminal raw mode, signals, clocks, and — through its device layer —
Kandelo's framebuffer (`/dev/fb0`) and OSS audio (`/dev/dsp`). Its decoders
are bit-exact, so correctness can be checked byte-for-byte against a native
build instead of judged by "it did not crash".

This campaign is a **platform campaign with an FFmpeg-shaped forcing
function**, not a package port. When FFmpeg exposes a Kandelo gap, the gap is
the deliverable: we fix the platform, and the port waits.

### Why not ffmpeg.wasm

[ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) is the well-known
browser build of FFmpeg. It is the wrong shape for Kandelo:

- Its artifact is an **Emscripten module**, not a POSIX executable. It carries
  its own libc, its own in-memory filesystem (MEMFS/WORKERFS), and JavaScript
  glue. It cannot run as a Kandelo process, read the Kandelo VFS, take part in
  pipes, or be `exec`'d by a shell script.
- It configures FFmpeg with `--disable-programs`, so there is no real `ffmpeg`
  binary. The command-line tool is rebuilt from a **vendored, patched fork** of
  FFmpeg's `fftools/` sources so that `main()` becomes a callable function.
- It is pinned to FFmpeg **n5.1.4**. Upstream is at **n9.0**.
- It tells FFmpeg's `configure` that the target is a 32-bit x86 machine
  (`--arch=x86_32`) because that combination makes configure accept the build.

We port **upstream FFmpeg** as an ordinary registry package that produces real
`ffmpeg`, `ffprobe`, and `ffplay` programs. ffmpeg.wasm's per-library build
scripts remain useful as reconnaissance for which configure flags cross-compile
cleanly; nothing from it is a dependency.

## §2. Definition of done

1. `packages/registry/ffmpeg` builds FFmpeg n9.0 with exactly the target
   configure in §5, and the post-configure assertions pass (simd128, pthreads,
   and every declared dependency enabled).
2. `packages/registry/ffmpeg/patches/` is empty, or every patch in it passes
   the upstreamability test in §4.
3. The acceptance tiers in §8 pass on the Node host. Tier 1 and the video
   playback checks pass in the browser. ffplay audio is verified manually with
   `./run.sh browser`.
4. `ffplay` displays video in the browser (§6). Its Node limitation is a
   documented boundary, not an omission.
5. The acceptance run reports the list of tests that actually executed, so a
   skipped test cannot read as a pass.
6. Every gap in the ledger (§9) is closed, or the maintainer has approved its
   deferral.
7. Every platform fix records which conformance suites were run or considered.
8. The SIMD benchmark in §9 has been run and reported, whatever it shows.

If the campaign stops early, the honest report is: the highest aperture rung
reached (§7), FATE pass/fail counts, and the open ledger gaps. Never a bare
"FFmpeg works".

### Non-goals

- **External codec libraries** (x264, x265, libvpx, lame, opus, libwebp, dav1d,
  and the libass/freetype/fribidi/harfbuzz subtitle stack). Each is its own
  port. FFmpeg's native decoders already cover H.264, HEVC, VP8/VP9, AAC, Opus,
  Vorbis, and FLAC, and it has native encoders for AAC, FLAC, PNG, FFV1, and
  MPEG-4 Part 2.
- **TLS / `https://` input.** See §5 on OpenSSL.
- **A polished kandelo.dev demo page.** FFmpeg ships as a lazy archive in the
  shell product; a showcase demo is a follow-on.
- **Making `-msimd128` an SDK-wide default.** It is scoped to this package.
  A separate audit covers other SIMD opportunities.

## §3. Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Goal is **platform proof**: real `ffmpeg`/`ffprobe`/`ffplay` processes with FFmpeg's built-in codecs | Smallest scope that exercises the platform; the base for later codec and demo work |
| D2 | Gap policy is **fix the platform** | A package that succeeds by avoiding platform paths proves nothing |
| D3 | Build the **current upstream release, n9.0** | Porting upstream means current upstream; a stale pin is ffmpeg.wasm's core problem |
| D4 | **Include ffplay** | It is the seed for later playback work, and SDL2 is already a Kandelo package |
| D5 | **One PR, rebase-merged**, with each platform fix as a discrete commit | Each fix stays independently reviewable and revertable |
| D6 | Acceptance uses a **small committed fixture** plus a **large pinned MPEG-4 file**, plus **FATE** | See §8 |
| D7 | Optional dependencies: `zlib`, `sdl2`, `libiconv`, `libxml2` | Already Kandelo library packages with declared outputs; see §5 |
| D8 | `-msimd128` is **scoped to this package** | Avoids rebuilding every package mid-campaign; gives the SIMD audit one measured data point |
| D9 | Strategy is the **widening aperture** ladder in §7 | Reaches a running binary early, where the valuable kernel gaps show up |
| D10 | **No Kandelo-named branches in upstream source or build systems** | See §4 |
| D11 | Enable **SDL2's render subsystem** in this campaign | Without it, ffplay cannot display video (§6) |

## §4. Gap triage

**Decision rule.** A failure is a Kandelo platform gap unless you can name the
specific WebAssembly-inherent or browser-sandbox limit it belongs to. The
default is "gap"; the burden of proof sits on "boundary".

**Upstreamability test for patches.** Could this patch be sent upstream and
accepted without the word "Kandelo" in it? If not, it is not a patch — it is a
Kandelo gap, and the fix belongs in Kandelo. A patch is legitimate only when
upstream is genuinely wrong for every generic Unix target. The target state is
an empty `patches/` directory.

| Failure | Disposition |
|---|---|
| A POSIX API is missing, syscall semantics are wrong, VFS behavior is wrong, or Node and browser diverge | **Fix the platform.** This is the deliverable. |
| A configure probe reports a function exists when it does not | **SDK gap.** `--allow-undefined` lets link probes succeed for missing symbols. Seeding cache answers is a stopgap; the finding is that probes are dishonest. |
| FFmpeg's generic detection does not recognize the target | **Fix Kandelo's generic detectability** (libc completeness, sysroot headers, honest probes). Not a patch to FFmpeg. |
| Upstream is wrong for all generic Unix targets | Patch, upstreamable as written, with no mention of Kandelo. |
| A genuine WebAssembly limit (for example, no page protection, no preemptive thread cancellation) | Disable the affected feature and name the boundary in the build script. |
| Hardware that cannot exist (capture devices, hardware acceleration) | Disable it, with the reason written down. |

This is deliberately slower than the alternative. Some FFmpeg features will
wait on generic Kandelo gaps that have nothing to do with FFmpeg. That is the
chosen cost.

The in-tree `sdl2` and `sdl3` packages each carry a small patch teaching their
platform detector that Kandelo is Unix, which this rule now forbids. This
campaign does not extend that pattern and does not rewrite those patches;
retiring them is a separate campaign if wanted. The SDL2 render change in §6
must not add to that patch.

## §5. Package structure and build script

### Layout

```
packages/registry/ffmpeg/
  package.toml     kind = "program", version "9.0", kernel_abi = 43
  build.toml       revision 1, commit "UNPUBLISHED"
  build-ffmpeg.sh
  test/            package-owned tests and fixtures (§8)
```

- `depends_on = ["zlib@1.3.1", "sdl2@2.32.10", "libiconv@1.17", "libxml2@2.13.8"]`
- `arches = ["wasm32"]` — `sdl2`, `libiconv`, and `libxml2` are wasm32-only.
- Three `[[outputs]]`: `ffmpeg.wasm`, `ffprobe.wasm`, `ffplay.wasm`.
- License: **LGPL-2.1-or-later**. No dependency forces `--enable-gpl` or
  `--enable-nonfree`.
- `kernel_abi` is whatever `ABI_VERSION` is in `crates/shared/src/lib.rs` when
  the package commit lands (43 at time of writing; a platform fix in this
  campaign may bump it).

### Dependencies considered

| Dependency | Decision | Reason |
|---|---|---|
| `zlib`, `libiconv`, `libxml2`, `sdl2` | Take | Existing `kind = "library"` packages with declared outputs. They add PNG/Matroska/FLV support, subtitle charset conversion, the DASH demuxer, and ffplay. |
| `bzip2`, `xz` | Skip | In this registry they are `kind = "program"` and ship only CLI tools, not `libbz2.a`/`liblzma.a`. Enabling them needs new library outputs for small gain (Matroska bzip2 compression, the TIFF decoder). |
| `openssl` | Skip (`--disable-openssl`) | FFmpeg's configure requires `--enable-nonfree` to link OpenSSL, because OpenSSL 3's Apache-2.0 patent terms conflict with LGPL-2.1. That licensing decision deserves its own discussion. |

### Target configure

```
./configure --prefix=/usr \
  --enable-cross-compile --arch=wasm --target-os=none \
  --cc=wasm32posix-cc --cxx=wasm32posix-c++ --ar=wasm32posix-ar \
  --nm=wasm32posix-nm --ranlib=wasm32posix-ranlib \
  --pkg-config=wasm32posix-pkg-config \
  --extra-cflags="-msimd128 -O3" \
  --enable-static --disable-shared --disable-doc \
  --disable-autodetect \
  --enable-pthreads --enable-zlib --enable-sdl2 --enable-iconv --enable-libxml2
```

Each choice, with the evidence behind it (from FFmpeg n9.0's `configure`):

- **`--arch=wasm`.** Upstream n9.0 knows the wasm architecture (`wasm*)`
  maps to `arch="wasm"`), with a `simd128` extension probed through
  `wasm_simd128.h`, and hand-written simd128 code in `libavcodec/wasm/hevc/`
  (IDCT and SAO). This is the truthful architecture, unlike ffmpeg.wasm's
  `--arch=x86_32`.
- **Never `--disable-asm`.** `configure` line 8258 is
  `enabled asm || { arch=c; disable $ARCH_LIST $ARCH_EXT_LIST; }`, so
  disabling asm would silently turn simd128 off. With `arch=wasm` there is no
  x86 assembly to disable.
- **`--target-os=none`.** In n9.0 the `none)` case in configure's OS section is
  empty: no OS-specific assumptions, every feature decided by probes. That is
  FFmpeg's generic path and satisfies §4 without naming Kandelo. It must be
  passed explicitly: the default is `uname -s` of the build machine, which on a
  Mac would call the target `darwin`.
- **`-msimd128 -O3`.** Required for the `wasm_simd128.h` probe to succeed and
  for clang to auto-vectorize. Scoped to this package (D8).
- **`--disable-autodetect` plus explicit enables.** Without it, configure
  enables whatever it happens to find, and the package's real inputs drift from
  its declared `depends_on`. An explicit `--enable-X` makes configure fail
  loudly when a declared dependency is missing.
- **`--enable-pthreads` is mandatory with `--disable-autodetect`.** FFmpeg's
  `AUTODETECT_LIBS` includes `$THREADS_LIST`, so disabling autodetection
  silently disables threading unless it is enabled explicitly. Kandelo supports
  `pthread_create` (through `clone`) and deferred cancellation.
- **Devices stay enabled.** Kandelo ships `linux/fb.h` and `sys/soundcard.h`,
  so FFmpeg's `fbdev` and `oss` input/output devices are enabled by probe.
  They exercise Kandelo's devices directly. Only devices that cannot exist are
  disabled, each with a stated reason.

### Build script contract

`build-ffmpeg.sh` follows the resolver contract as `build-libxml2.sh` does:
sources `sdk/activate.sh`; verifies the source tarball's sha256; reads
dependencies only from `WASM_POSIX_DEP_<NAME>_DIR`; installs only into
`WASM_POSIX_DEP_OUT_DIR`; produces exactly the declared outputs.

After configure, the script **asserts the result, not the exit status**: it
reads the generated `config.h` / `ffbuild/config.mak` and fails unless
`HAVE_SIMD128`, pthreads, and each of the four dependencies are enabled.

Comments in the script state why each flag is set, which alternatives were
rejected (`--disable-asm`, an invented target OS, autodetection), and what risk
remains.

Fork instrumentation (`scripts/run-wasm-fork-instrument.sh`) is added only if
the linked programs are found to call fork-like functions.

## §6. SDL2 render subsystem (ffplay video)

`packages/registry/sdl2/build-sdl2.sh` configures SDL2 with `--disable-render`.
ffplay draws every video frame through SDL's render API (`SDL_CreateRenderer`,
`SDL_CreateTexture`, `SDL_RenderCopy`). With it compiled out, ffplay cannot
create a renderer and exits with "Failed to create window or renderer"; it runs
only with `-nodisp` (audio only).

Work in this campaign:

1. **Find out why render is disabled.** The build script gives no reason.
   Determine whether it was disabled because it failed or because nothing
   needed it. If it failed, the failure is a ledger gap.
2. **Enable the render subsystem with its OpenGL ES 2 renderer**, confirming
   the exact flags against SDL 2.32.10's configure. SDL2 video on Kandelo is
   KMSDRM + GLES2, which the browser host bridges to WebGL.
3. **Determine whether a software renderer path works over KMSDRM** without
   GL. If it does, ffplay can show video on the Node host too; if not, that is
   the boundary below.
4. **Rebuild and re-verify every SDL2 consumer.** Today the packages that
   declare `sdl2` are `sdl2-demo`, `sdl2-mixer-playwave`, and `sdl-dsp-test`;
   the resolver's reverse-dependency closure is the authority at the time of
   the change. The render change must not alter their behavior.
5. **Document the boundary.** The Node host has no GL context
   (`host/test/sdl2.test.ts` already records that `host_gl_query` returns -1).
   Unless step 3 finds a software path, ffplay video is browser-only, and the
   docs must say so.

The render change must not add to SDL2's existing platform patch (§4).

## §7. Aperture ladder

The rungs are a **development instrument, not commits**. The branch history
reads: platform fix, platform fix, …, FFmpeg package at the §5 target
configure. The package commit lands last, once it builds and runs, so every
commit in the rebase-merge is buildable and trimmed builds never enter `main`.
Rungs are run by hand-editing configure in a build directory preserved with
`WASM_POSIX_KEEP_BUILD_DIR=1`. No aperture switch is added to the committed
script.

| Rung | Configure | Proves | Built to find |
|---|---|---|---|
| **0 — honest configure** | The full §5 target | Configure completes and every result it reports is true | Misleading probes. FFmpeg's `check_func` links a test program; under `--allow-undefined` that link succeeds whether or not the function exists. Every `HAVE_<func> 1` in `config.h` is checked against the symbols `libc.a` actually defines. Every `HAVE_<func> 0` for a POSIX function is a candidate gap. |
| **1 — running binaries** | `--disable-everything` plus the `file`/`pipe` protocols, `mov`/`wav`/`null` (de)muxers, PCM and MPEG-4 Part 2 decoders, rawvideo/PCM encoders | `ffmpeg -version`; `ffprobe` on a WAV and a small MP4; a transcode through a pipe | Process runtime: exec and argv, file read and seek, pipes, `-threads N` decode, terminal raw mode (ffmpeg polls stdin for `q`), SIGINT, clocks |
| **2 — full codec set** | Drop `--disable-everything`; `zlib`, `iconv`, `libxml2` on | FFmpeg's full default component set | Compile and link gaps across the whole tree; binary size and memory ceilings; the HEVC simd128 path |
| **3 — devices and ffplay** | `sdl2` and ffplay on; `fbdev`/`oss` by probe | `-f fbdev /dev/fb0`, `-f oss /dev/dsp`, ffplay | Device semantics; Node/browser parity for framebuffer and audio |

Rung 3's configure is exactly the §5 target.

Rules:

- **Findings never wait.** A gap found at one rung goes in the ledger
  immediately, and discovery may continue at the next rung while the fix is in
  progress. This is ordering, not relaxation: the package commit does not land
  while any gap is open, and deferral needs maintainer approval.
- **Each platform fix proves itself at its own layer** (§9). "FFmpeg works now"
  is not evidence for a kernel or libc fix.
- **Rung 2 proves the SIMD is present.** A SIMD compile flag alone proves
  nothing — PHP's Kandelo build produced no SIMD instructions at all. The exit
  check counts v128 instructions in `ffmpeg.wasm` with `wasm-objdump` and
  confirms `HAVE_SIMD128 1` in `config.h`.
- **Branch hygiene.** When a new platform fix appears after the package commit
  exists, the package commit is rebased back to the tip, and the draft PR is
  updated with `git push --force-with-lease`.

## §8. Tests and acceptance

**Principle.** "It did not crash" is not acceptance. FFmpeg's decoders are
bit-exact, so the reference is **native FFmpeg n9.0 on the build host**:
Kandelo's `ffmpeg` must produce identical per-frame checksums
(`-bitexact -f framecrc`) on the same input. Audio codecs that FFmpeg's own
tests compare with tolerance get the same tolerance here.

**No silent skips.** Existing host tests use `it.skipIf(!binary)`, which passes
when nothing ran. In the acceptance run, a missing binary or an unreachable
pinned resource is a **failure**, and every tier reports the list of tests it
executed.

### Tier 1 — small fixture, committed

A clip under 100 KB, generated by native FFmpeg n9.0 from its synthetic
sources (`testsrc` video and `sine` audio), encoded with FFmpeg's **native**
MPEG-4 Part 2 and AAC encoders in an MP4 container so anyone can regenerate it
without external libraries, and committed under
`packages/registry/ffmpeg/test/` with the exact generating command, its
sha256, and the expected native framecrc output beside it.

- `ffprobe -show_streams -of json` reports exactly the expected fields.
- Decode to framecrc matches native.
- `-threads 4` produces the same framecrc as `-threads 1`.
- Pipe transcode inside a Kandelo shell:
  `ffmpeg -i fixture.mp4 -f wav pipe:1 | ffprobe -` (pipes plus fork/exec from
  dash).
- SIGINT during a long transcode leaves a valid truncated file and the
  expected exit status.
- `q` typed on a PTY stdin stops the run cleanly.

### Tier 2 — large pinned file, fetched

**Big Buck Bunny** (Blender Foundation, CC-BY 3.0), MP4 edition (H.264 video,
AAC audio), from the Blender Foundation's official distribution. The exact
file is chosen in implementation against these criteria: stable URL,
redistributable licence, tens of megabytes. It is sha256-pinned, cached, and
never committed. The test decodes the **whole file** and requires framecrc
parity with native. Wall time is recorded as an observation, not a
performance claim.

### Tier 3 — FATE, host-driven

FATE is FFmpeg's own regression suite: thousands of tests with bit-exact
reference outputs. FFmpeg's `configure --target-exec=CMD` makes FATE run each
built program through a wrapper command. FATE's `make` and shell run on the
host; every `ffmpeg`/`ffprobe` it launches runs as a **real Kandelo process**.

- **Wrapper.** Built on `examples/run-example.ts`, which already runs an
  arbitrary `.wasm` with arguments under `NodeKernelHost`. Requirements: argv
  passthrough, host-path access for FATE's sample and output directories, stdio
  passthrough, and exit status passthrough (including signal termination). Any
  capability it lacks is added as platform tooling.
- **Scope.** The FATE groups for the families we build: h264, hevc (including
  the simd128 path), aac, mpeg4, vp9, opus, flac, pcm, the mov and matroska
  (de)muxers, and filters.
- **Samples.** The subset of `fate-suite` those groups need, pinned by a
  recorded sha256 manifest.
- **Report.** Pass/fail counts per group, with every failure triaged per §4.

Running FATE entirely inside Kandelo (make, sh, and ffmpeg all as Kandelo
processes) is a stronger follow-on and is out of scope here.

### Playback

- **`ffmpeg` to devices.** Decoded video to the framebuffer and audio to OSS in
  one process:

  ```
  ffmpeg -re -i fixture.mp4 \
    -map 0:v -vf scale=<fb size> -pix_fmt bgra -f fbdev /dev/fb0 \
    -map 0:a -f oss /dev/dsp
  ```

  Checked in the browser (framebuffer screenshot shows the fixture's test
  pattern) and on Node wherever the Node host exposes the same devices.
- **`ffplay`.** Browser: a Playwright screenshot of the Modeset pane shows the
  test pattern; audio verified manually with `./run.sh browser`. Node: audio
  with `-nodisp`; video per the §6 boundary.

### Node and browser

Tiers 1–3 run on the Node host. For browser parity FFmpeg ships as a **lazy
archive in the shell product**, as python, ruby, and perl do. A Playwright spec
runs the Tier 1 framecrc comparison inside a booted browser machine, plus the
playback checks above.

## §9. Validation, performance, and the ledger

### Validation of platform fixes

Each fix is validated at its own layer, per `docs/agent-guidance/validation.md`:

- Kernel, syscall, libc glue, or VFS changes: consider libc-test, the POSIX
  suite, sortix os-test, cargo tests, and host Vitest; add browser tests when
  shared host code changes.
- After any edit to `libc/musl-overlay/` or `libc/glue/`, run
  `scripts/build-musl.sh` before trusting any other result.
- An ABI change bumps `ABI_VERSION` and regenerates `abi/snapshot.json` in the
  same commit. A bump invalidates every binary, so it is recorded in the ledger
  as a cost.
- Rebuilding one artifact proves only that artifact is current. After libc
  fixes, confirm the FFmpeg build consumed the new sysroot.

### Performance

- No speed claim without a benchmark, and any claim is **bounded to FFmpeg
  decode**, not Kandelo generally.
- The SIMD benchmark compares builds with and without `-msimd128` on the full
  Big Buck Bunny decode and an HEVC sample from FATE, over several runs, on
  both Node and browser. Results are reported whatever they show.
- Thread scaling is recorded as an observation only.
- The rung-2 v128 instruction count feeds the separate SIMD audit.

### The ledger

`docs/plans/2026-09-26-ffmpeg-gap-ledger.md`, committed on the branch. One
entry per gap: what failed, the layer it traced to, its §4 disposition, the
closing commit, and the tests that prove the fix. Each fix also updates the
authoritative docs for the behavior it changes (for example,
`docs/posix-status.md` when a POSIX gap closes), explaining why this design,
what alternatives were rejected, and what risk remains. The ledger is the
backbone of the PR description.

## §10. Risks and open items

- **Open-ended duration.** "Fix the platform" means the campaign's length is
  set by the gaps FFmpeg finds, not by FFmpeg. The ledger and the §2 early-stop
  report keep that visible.
- **Binary size and memory.** A full-default `ffmpeg.wasm` is large; size has
  not been measured. Memory budgets must be requested by the guest through
  `RLIMIT_AS`, not by raising a host ceiling — WebKit charges declared maxima
  against a process-wide pool.
- **SDL2 render may be disabled for a reason** we have not found yet (§6.1).
- **Node video for ffplay** depends on whether a software render path exists
  over KMSDRM (§6.3).
- **FATE wrapper capability.** `run-example.ts` has not been verified against
  FATE's needs (§8, Tier 3).
- **Stale threading docs.** `docs/wasm-limitations.md` §1–§2,
  `docs/posix-status.md`'s "Known Unfixable Failures", and the rationale
  comment in `scripts/run-libc-tests.sh` understate Kandelo's thread support.
  A separate worktree is correcting them; this campaign relies on the source,
  not those docs.

## §11. References

- FFmpeg n9.0 `configure`: `wasm` arch and `simd128` extension, the asm gate at
  line 8258, the empty `none)` OS case, `AUTODETECT_LIBS` including
  `$THREADS_LIST`, `fbdev`/`oss` device dependencies.
- `libc/musl-overlay/src/thread/wasm32posix/clone.c`, `pthread_cancel.c`:
  thread creation and deferred cancellation.
- `crates/fork-instrument/`: already handles `v128` values.
- `sdk/src/lib/flags.ts` and `scripts/build-programs.sh`: the two copies of the
  base compile flags. This campaign does not change them.
- `packages/registry/libxml2/build-libxml2.sh`: resolver-contract exemplar.
- `packages/registry/sdl2/build-sdl2.sh`: SDL2 backends and `--disable-render`.
- `examples/run-example.ts`: basis for the FATE `--target-exec` wrapper.
