# FFmpeg Port to Kandelo — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build upstream FFmpeg n9.0 as real Kandelo `ffmpeg`, `ffprobe`, and `ffplay` processes, fixing every Kandelo platform gap it exposes, and prove correctness bit-exactly against a native FFmpeg of the same version.

**Architecture:** A new `packages/registry/ffmpeg` program package built through the normal resolver path with a truthful configure (`--arch=wasm --target-os=none`, package-scoped `-msimd128`). Development climbs an "aperture ladder" of hand-run configures (§7 of the spec) to reach running binaries early; each Kandelo gap found is fixed in its own commit below the package commit. Acceptance compares Kandelo output with committed native reference outputs, runs a pinned Big Buck Bunny decode, and runs FFmpeg's own FATE suite with each program executed as a Kandelo process.

**Tech Stack:** FFmpeg n9.0 (C, hand-written configure), Kandelo SDK (`wasm32posix-*`), cargo xtask resolver, Vitest host tests, Playwright browser tests, wabt (`wasm-objdump`), SDL2 2.32.10.

**Spec:** `docs/plans/2026-09-26-ffmpeg-port-design.md` (read it before any task; section numbers below refer to it).

## Global Constraints

- FFmpeg version: **n9.0** from `https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz`, sha256-pinned in `package.toml`.
- Target configure (spec §5), exactly: `--enable-cross-compile --arch=wasm --target-os=none`, SDK tools, `--extra-cflags="-msimd128 -O3"`, `--enable-static --disable-shared --disable-doc`, `--disable-autodetect`, `--enable-pthreads --enable-zlib --enable-sdl2 --enable-iconv --enable-libxml2`, `--disable-openssl`.
- **Never pass `--disable-asm`** (FFmpeg `configure` line 8258 disables simd128 with it).
- `depends_on = ["zlib@1.3.1", "sdl2@2.32.10", "libiconv@1.17", "libxml2@2.13.8"]`; `arches = ["wasm32"]`; license `LGPL-2.1-or-later`; no `--enable-gpl`, no `--enable-nonfree`.
- Outputs: `ffmpeg.wasm`, `ffprobe.wasm`, `ffplay.wasm`. Two-or-more-member packages resolve nested: `programs/ffmpeg/<name>.wasm`.
- `kernel_abi` = the current `ABI_VERSION` in `crates/shared/src/lib.rs` when the package commit lands (43 at time of writing).
- **No Kandelo-named branch or patch in upstream code.** A patch must pass: "could this go upstream without the word Kandelo in it?" Target: no `patches/` directory.
- `-msimd128` is scoped to this package. Do not edit `sdk/src/lib/flags.ts` or `scripts/build-programs.sh`.
- One PR, rebase-merged. Each platform fix is its own commit **below** the FFmpeg package commit, which stays at the tip.
- Commit subjects use `Area: Purpose` (`Packages:`, `Kernel:`, `POSIX:`, `SDK:`, `Docs:`, `Browser:`, `Tests:`). Commit bodies wrap at 72 columns. PR description: one line per paragraph, no hard wrap, `## Why` before `## What changed`.
- All build and verification commands run under `scripts/dev-shell.sh`.
- Acceptance runs set `KANDELO_FFMPEG_ACCEPTANCE=1`; with it set, a missing binary or unreachable pinned resource is a **failure**, never a skip.
- Performance claims only with benchmark evidence, bounded to FFmpeg decode.

## Review Focus

These are the inputs a real user will hit that the spec implies but does not spell out. Each has a test in the task named.

1. **An MP4 whose index (`moov`) is at the end, read through a pipe.** Big Buck Bunny is laid out this way. `ffprobe -i pipe:0` must still report its streams, not hang or crash. Test: Task 5, "probes a moov-at-end MP4 through a pipe".
2. **File names with spaces and non-ASCII characters.** `ffmpeg … "out ü.wav"` must create exactly that file. Test: Task 4, "writes an output path containing a space and UTF-8".
3. **Writing over an existing file without `-y` when stdin is not a terminal.** FFmpeg must refuse and exit non-zero, as natively, not hang waiting for an answer. Test: Task 4, "refuses to overwrite without -y".
4. **Seeking into the middle of a large file (`-ss`).** Output must match native from the seek point. Test: Task 5, "seeks to 300 s and matches native".
5. **More threads than Kandelo's default thread slots (`-threads 16`).** Must either produce the same output as `-threads 1` or fail with a clear error, never trap. Test: Task 5, "decodes with 16 threads".

---

## Gap-Fix Protocol

Tasks 2, 3, 5, 6, and 7 are discovery tasks: they will hit failures whose fixes cannot be known in advance. Every failure goes through this procedure. Do not improvise around it.

**G1. Record it first.** Add an entry to `docs/plans/2026-09-26-ffmpeg-gap-ledger.md` (created in Task 2) before touching code:

```markdown
### G<n>. <one-line symptom>

- **Found at:** rung <0-3> / task <n>, command: `<exact command>`
- **Symptom:** <exact error text or wrong output>
- **Traced layer:** <user program | package build | SDK | libc/glue | syscall | kernel | VFS | host runtime | Node/browser adapter>
- **Disposition (spec §4):** <fix the platform | SDK probe gap | generic detectability | upstreamable patch | named wasm boundary | nonexistent hardware>
- **Fix commit:** <filled in when closed>
- **Proof:** <test file(s) and suites run>
- **Status:** open | closed | deferral requested
```

**G2. Trace to the real layer.** Reproduce with the smallest program that shows the failure. Write it as a C test under `examples/<name>_test.c` (Kandelo's existing convention for syscall probes) and run it with `npx tsx examples/run-example.ts <name>` after `scripts/build-programs.sh`. If a native build of the same C file behaves differently, that difference is the gap.

**G3. Stop and ask before cross-cutting fixes.** If the fix changes an SDK flag, a libc contract used by every package, the ABI, or the host worker protocol, write the options into the ledger entry and ask the maintainer before implementing. Do not defer a gap yourself; deferral needs the maintainer's explicit approval.

**G4. Write the failing test at the fix's own layer.** Kernel/syscall: a Rust test in `crates/kernel` and/or a host Vitest test in `host/test/`. libc: an `examples/*_test.c` driven by a host test, and consider libc-test. Package build: an assertion in the build script. Run it and confirm it fails for the recorded reason.

**G5. Fix, then validate at that layer.** After editing `libc/musl-overlay/` or `libc/glue/`, run `scripts/build-musl.sh` first. Run the layer's test, then consider the suites in `docs/agent-guidance/validation.md` (libc-test via `scripts/run-libc-tests.sh`, POSIX suite, sortix, `cargo test`, host Vitest, and browser tests if shared host code changed). If the ABI changed: bump `ABI_VERSION`, regenerate `abi/snapshot.json` in the same commit, and note in the ledger that every binary must be rebuilt.

**G6. Update the docs that describe the behavior** (for example `docs/posix-status.md`), stating why this design, what was rejected, and what risk remains.

**G7. Commit the fix below the package commit.** While the package commit does not exist yet (before Task 2 step 9), just commit. Afterwards, keep the package commit at the tip:

```bash
git add <explicit paths>
git commit -F /tmp/gap-commit-msg.txt          # fix commit F lands above package commit P
P=$(git log --format=%H -1 --grep='^Packages: Add FFmpeg' HEAD~1)
F=$(git rev-parse HEAD)
git rebase --onto "$P~1" "$P" "$F"             # replay F without P
git cherry-pick "$P"                           # put P back on top
git log --oneline -3                           # expect: P, F, …
git push --force-with-lease
```

**G8. Close the ledger entry** with the fix commit subject, the proof, and status `closed`, in the same commit as the fix.

---

### Task 1: Native reference build and committed fixtures

**Why first:** every correctness test compares Kandelo's output with native FFmpeg n9.0. The host has no FFmpeg (`command -v ffmpeg` fails), so we build one from the same pinned tarball.

**Files:**
- Create: `packages/registry/ffmpeg/test/reference/build-native-ffmpeg.sh`
- Create: `packages/registry/ffmpeg/test/reference/generate-fixtures.sh`
- Create: `packages/registry/ffmpeg/test/fixtures/` (generated files listed in Step 5)
- Create: `packages/registry/ffmpeg/test/fixtures/README.md`
- Create: `packages/registry/ffmpeg/test/fixtures-manifest.test.ts`
- Modify: `scripts/ci-vitest-evidence-classes.tsv` (add the new test, keep sorted)

**Interfaces:**
- Produces: native binaries at `${KANDELO_FFMPEG_NATIVE_PREFIX:-$HOME/.cache/kandelo/ffmpeg-native-9.0}/bin/{ffmpeg,ffprobe}`; fixture files and `fixtures/manifest.json` mapping file name → sha256, consumed by Tasks 3–5 and 9.

- [ ] **Step 1: Get the n9.0 tarball hash.**

```bash
mkdir -p ~/.cache/kandelo/ffmpeg-src && cd ~/.cache/kandelo/ffmpeg-src
curl -fsSLO https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz
shasum -a 256 ffmpeg-9.0.tar.xz
```

Record the hash; it is used here and in Task 2's `package.toml`. If the URL 404s, check `https://ffmpeg.org/releases/` for the exact n9.0 tarball name and use that — do not substitute a different version.

- [ ] **Step 2: Write `build-native-ffmpeg.sh`.**

```bash
#!/usr/bin/env bash
# Build native FFmpeg n9.0 on the build host from the same pinned tarball
# the Kandelo package uses. Its only job is to produce reference outputs
# for bit-exact comparison; it is never shipped.
#
# -ffp-contract=off: clang may fuse multiply-adds on arm64 by default,
# which changes float results. Kandelo's wasm build cannot fuse, so the
# reference must not either, or float codecs would differ for reasons
# that have nothing to do with Kandelo.
set -euo pipefail

VERSION=9.0
SHA256="${FFMPEG_SOURCE_SHA256:?set FFMPEG_SOURCE_SHA256 to the pinned n9.0 tarball hash}"
PREFIX="${KANDELO_FFMPEG_NATIVE_PREFIX:-$HOME/.cache/kandelo/ffmpeg-native-$VERSION}"
SRC_CACHE="$HOME/.cache/kandelo/ffmpeg-src"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/ffmpeg-native.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

if [ -x "$PREFIX/bin/ffmpeg" ] && "$PREFIX/bin/ffmpeg" -version | head -1 | grep -q "version $VERSION"; then
    echo "native ffmpeg $VERSION already at $PREFIX"
    exit 0
fi

mkdir -p "$SRC_CACHE"
TARBALL="$SRC_CACHE/ffmpeg-$VERSION.tar.xz"
[ -f "$TARBALL" ] || curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$VERSION.tar.xz" -o "$TARBALL"
echo "$SHA256  $TARBALL" | shasum -a 256 -c -
tar xJf "$TARBALL" -C "$WORK" --strip-components=1
cd "$WORK"
./configure --prefix="$PREFIX" \
    --disable-doc --disable-autodetect --enable-pthreads \
    --extra-cflags="-ffp-contract=off"
make -j"$(getconf _NPROCESSORS_ONLN)"
make install
"$PREFIX/bin/ffmpeg" -version | head -1
```

- [ ] **Step 3: Run it.**

```bash
scripts/dev-shell.sh bash -c 'FFMPEG_SOURCE_SHA256=<hash from step 1> bash packages/registry/ffmpeg/test/reference/build-native-ffmpeg.sh'
```

Expected: last line `ffmpeg version 9.0 …`.

- [ ] **Step 4: Write `generate-fixtures.sh`.** Every command here must stay identical to the test commands in Tasks 3–5; the README records them.

```bash
#!/usr/bin/env bash
# Regenerate the committed FFmpeg fixtures and native reference outputs.
# Run only when a fixture or reference must change; commit the results.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../fixtures"
BIN="${KANDELO_FFMPEG_NATIVE_PREFIX:-$HOME/.cache/kandelo/ffmpeg-native-9.0}/bin"
FF="$BIN/ffmpeg"; FP="$BIN/ffprobe"
BBB="${KANDELO_FFMPEG_MEDIA_CACHE:-$HOME/.cache/kandelo/ffmpeg-test-media}/BigBuckBunny_320x180.mp4"
BX=(-flags +bitexact -fflags +bitexact)
mkdir -p "$OUT"

# 2 s, 176x144, 10 fps MPEG-4 Part 2 with B-frames + 22.05 kHz mono AAC.
# Native encoders only, single-threaded encode for a deterministic bitstream,
# moov first (+faststart) so the file is readable from a pipe.
"$FF" -nostdin -y -v error \
  -f lavfi -i testsrc=duration=2:size=176x144:rate=10 \
  -f lavfi -i sine=frequency=440:beep_factor=4:duration=2:sample_rate=22050 \
  -threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 \
  -c:a aac -b:a 32k -ac 1 \
  "${BX[@]}" -map_metadata -1 -movflags +faststart \
  "$OUT/fixture.mp4"

"$FP" -v error -show_entries \
  stream=index,codec_name,codec_type,width,height,pix_fmt,sample_rate,channels \
  -of json "$OUT/fixture.mp4" > "$OUT/fixture.ffprobe.json"
"$FF" -nostdin -v error -threads 1 -i "$OUT/fixture.mp4" -map 0:v "${BX[@]}" \
  -f framecrc - > "$OUT/fixture.video.framecrc"
"$FF" -nostdin -v error -c:a aac_fixed -i "$OUT/fixture.mp4" -map 0:a "${BX[@]}" \
  -f framecrc - > "$OUT/fixture.audio-fixed.framecrc"
"$FF" -nostdin -v error -i "$OUT/fixture.mp4" -map 0:a -f s16le - \
  > "$OUT/fixture.audio-float.s16le"
# Browser check: encode the same video in-machine and decode it.
"$FF" -nostdin -v error -f lavfi -i testsrc=duration=2:size=176x144:rate=10 \
  -threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 "${BX[@]}" \
  -f framecrc - > "$OUT/fixture.browser-encode.framecrc"

if [ -f "$BBB" ]; then
  "$FF" -nostdin -v error -threads 1 -i "$BBB" -map 0:v "${BX[@]}" \
    -f streamhash -hash sha256 - > "$OUT/bbb.video.streamhash"
  "$FF" -nostdin -v error -c:a aac_fixed -i "$BBB" -map 0:a "${BX[@]}" \
    -f streamhash -hash sha256 - > "$OUT/bbb.audio-fixed.streamhash"
  "$FF" -nostdin -v error -ss 300 -i "$BBB" -frames:v 5 -map 0:v "${BX[@]}" \
    -f framecrc - > "$OUT/bbb.seek300.framecrc"
else
  echo "BBB not cached at $BBB; run the Task 5 fetch first to generate bbb.* references" >&2
  exit 1
fi

( cd "$OUT" && node -e '
  const fs=require("fs"),c=require("crypto");
  const files=fs.readdirSync(".").filter(f=>f!=="manifest.json"&&f!=="README.md").sort();
  const m={};for(const f of files)m[f]=c.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  fs.writeFileSync("manifest.json",JSON.stringify(m,null,2)+"\n");' )
ls -l "$OUT"
```

- [ ] **Step 5: Fetch Big Buck Bunny, then generate.** The pinned values below were verified on 2026-09-26 (Blender now serves the file zipped; the unzipped direct URL returns 404).

```bash
mkdir -p ~/.cache/kandelo/ffmpeg-test-media && cd ~/.cache/kandelo/ffmpeg-test-media
curl -fsSLO https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip
echo "109e3ede8790bd633f374ca311d9cc61dce8d7f98f5b0797ca98199c9fbceedf  BigBuckBunny_320x180.mp4.zip" | shasum -a 256 -c -
unzip -o -q BigBuckBunny_320x180.mp4.zip
echo "f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508  BigBuckBunny_320x180.mp4" | shasum -a 256 -c -
cd - && bash packages/registry/ffmpeg/test/reference/generate-fixtures.sh
```

Expected files in `test/fixtures/`: `fixture.mp4` (under 100 KB), `fixture.ffprobe.json`, `fixture.video.framecrc`, `fixture.audio-fixed.framecrc`, `fixture.audio-float.s16le`, `fixture.browser-encode.framecrc`, `bbb.video.streamhash`, `bbb.audio-fixed.streamhash`, `bbb.seek300.framecrc`, `manifest.json`. Check `du -k fixture.mp4` is under 100; if not, lower `-q:v` quality (raise the number) and regenerate.

- [ ] **Step 6: Record native behaviors the process tests will assert.** Run each and write the observed exit status into `fixtures/README.md` under "Native behaviors":

```bash
B=~/.cache/kandelo/ffmpeg-native-9.0/bin
cd "$(mktemp -d)"
# a) overwrite refusal
touch out.wav; $B/ffmpeg -nostdin -v error -i <repo>/packages/registry/ffmpeg/test/fixtures/fixture.mp4 -map 0:a out.wav; echo "overwrite: $?"
# b) SIGINT during a long encode
$B/ffmpeg -nostdin -v error -f lavfi -i testsrc=size=320x240:rate=25 -c:v mpeg4 out.mp4 & p=$!; sleep 2; kill -INT $p; wait $p; echo "sigint: $?"
$B/ffprobe -v error -show_entries format=duration -of csv=p=0 out.mp4
```

Expected (to confirm, not assume): overwrite exits `1`; SIGINT exits `255`; the probe prints a positive duration. Tasks 4 uses whatever you observe here.

- [ ] **Step 7: Write `fixtures/README.md`** with: what each file is, the exact commands (copy from `generate-fixtures.sh`), the BBB URL and both sha256 values, the licence (Big Buck Bunny © Blender Foundation, CC-BY 3.0; only hashes of its decoded output are committed, not the video), and the native behaviors from Step 6.

- [ ] **Step 8: Write the manifest test** `packages/registry/ffmpeg/test/fixtures-manifest.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("ffmpeg fixtures", () => {
  it("every committed fixture matches its recorded sha256", () => {
    const manifest = JSON.parse(
      readFileSync(join(fixtures, "manifest.json"), "utf8"),
    ) as Record<string, string>;
    const onDisk = readdirSync(fixtures)
      .filter((f) => f !== "manifest.json" && f !== "README.md")
      .sort();
    expect(Object.keys(manifest).sort()).toEqual(onDisk);
    for (const [name, sha] of Object.entries(manifest)) {
      const actual = createHash("sha256")
        .update(readFileSync(join(fixtures, name)))
        .digest("hex");
      expect(actual, name).toBe(sha);
    }
  });

  it("keeps the committed clip small", () => {
    expect(readFileSync(join(fixtures, "fixture.mp4")).byteLength)
      .toBeLessThan(100 * 1024);
  });
});
```

- [ ] **Step 9: Run it; add its evidence class.**

```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run ../packages/registry/ffmpeg/test/fixtures-manifest.test.ts'
```

Expected: 2 passed. Add `packages/registry/ffmpeg/test/fixtures-manifest.test.ts	source-only` to `scripts/ci-vitest-evidence-classes.tsv` in sorted position (tab-separated).

- [ ] **Step 10: Commit.**

```bash
git add packages/registry/ffmpeg/test scripts/ci-vitest-evidence-classes.tsv
git commit -m "Tests: Add native FFmpeg n9.0 reference fixtures" -m "<72-col body: why native references, -ffp-contract=off, BBB pin>" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Package skeleton, honest configure (rung 0), and the ledger

**Files:**
- Create: `packages/registry/ffmpeg/package.toml`
- Create: `packages/registry/ffmpeg/build.toml`
- Create: `packages/registry/ffmpeg/configure-flags.sh` (the one copy of the configure flags; sourced by the build script and by the FATE runner in Task 8)
- Create: `packages/registry/ffmpeg/audit-configure.sh` (post-configure and post-link assertions)
- Create: `packages/registry/ffmpeg/build-ffmpeg.sh`
- Create: `docs/plans/2026-09-26-ffmpeg-gap-ledger.md`
- Modify: `packages/sets/local-supported.toml` (add `ffmpeg`, class `user-software`)

**Interfaces:**
- Produces: `ffmpeg_configure_flags <mode>` bash function in `configure-flags.sh`, where `<mode>` is `target` or `rung1`; writes the flag list into the global array `FFMPEG_CONFIGURE_FLAGS`. Consumes `ZLIB_PREFIX`, `LIBICONV_PREFIX`, `LIBXML2_PREFIX`, `SDL2_PREFIX`.
- Produces: `audit-configure.sh config <build-dir> <sysroot>` and `audit-configure.sh link <wasm>`; exit non-zero on any violation.

- [ ] **Step 1: Write `package.toml`.**

```toml
kind = "program"
name = "ffmpeg"
version = "9.0"
# Upstream FFmpeg built as real ffmpeg/ffprobe/ffplay Kandelo processes.
# The port is a platform campaign: gaps it exposes are fixed in Kandelo,
# not patched around here. See docs/plans/2026-09-26-ffmpeg-port-design.md.
kernel_abi = 43
depends_on = ["zlib@1.3.1", "sdl2@2.32.10", "libiconv@1.17", "libxml2@2.13.8"]
arches = ["wasm32"]

[source]
url = "https://ffmpeg.org/releases/ffmpeg-9.0.tar.xz"
sha256 = "<hash from Task 1 step 1>"
provider = "archive"

[license]
spdx = "LGPL-2.1-or-later"
url = "https://git.ffmpeg.org/gitweb/ffmpeg.git/blob/refs/tags/n9.0:/LICENSE.md"

[build]
script_path = "packages/registry/ffmpeg/build-ffmpeg.sh"

[[outputs]]
name = "ffmpeg"
wasm = "ffmpeg.wasm"

[[outputs]]
name = "ffprobe"
wasm = "ffprobe.wasm"

[[outputs]]
name = "ffplay"
wasm = "ffplay.wasm"
```

Check `kernel_abi` against `git grep -n "ABI_VERSION: u32 =" crates/shared/src/lib.rs` and use that value.

- [ ] **Step 2: Write `build.toml`.**

```toml
script_path = "packages/registry/ffmpeg/build-ffmpeg.sh"
inputs = [
  "packages/registry/ffmpeg/build-ffmpeg.sh",
  "packages/registry/ffmpeg/configure-flags.sh",
  "packages/registry/ffmpeg/audit-configure.sh",
]
repo_url = "https://github.com/Automattic/kandelo.git"
commit = "UNPUBLISHED"
revision = 1
```

- [ ] **Step 3: Write `configure-flags.sh`.**

```bash
# Sourced, not executed. The single definition of FFmpeg's configure flags,
# shared by build-ffmpeg.sh and test/fate/run-fate.sh so the two can never
# build different FFmpegs (see memory: same rules, different inputs).
#
# WHY each flag (spec §5):
#   --arch=wasm           upstream n9.0 knows wasm and its simd128 extension;
#                         ffmpeg.wasm's --arch=x86_32 was a lie we do not tell.
#   --target-os=none      configure's empty `none)` case: no OS assumptions,
#                         every feature probed. The default is `uname -s` of
#                         the build machine, which would say darwin on a Mac.
#   (no --disable-asm)    configure:8258 disables every arch extension,
#                         including simd128, when asm is disabled.
#   --disable-autodetect  the external dependency set must equal depends_on;
#                         autodetect would pick up anything in the sysroot.
#   --enable-pthreads     AUTODETECT_LIBS includes $THREADS_LIST, so
#                         --disable-autodetect silently disables threads.
#   --disable-openssl     linking OpenSSL requires --enable-nonfree.
ffmpeg_configure_flags() {
    local mode="$1"
    FFMPEG_CONFIGURE_FLAGS=(
        --prefix=/usr
        --enable-cross-compile --arch=wasm --target-os=none
        --cc=wasm32posix-cc --cxx=wasm32posix-c++ --ar=wasm32posix-ar
        --nm=wasm32posix-nm --ranlib=wasm32posix-ranlib
        --pkg-config=wasm32posix-pkg-config
        --extra-cflags="-msimd128 -O3 -I$ZLIB_PREFIX/include -I$LIBICONV_PREFIX/include -I$LIBXML2_PREFIX/include"
        --extra-ldflags="-L$ZLIB_PREFIX/lib -L$LIBICONV_PREFIX/lib -L$LIBXML2_PREFIX/lib"
        --enable-static --disable-shared --disable-doc
        --disable-autodetect --disable-openssl
        --enable-pthreads
    )
    case "$mode" in
        target)
            FFMPEG_CONFIGURE_FLAGS+=(
                --enable-zlib --enable-sdl2 --enable-iconv --enable-libxml2
            )
            ;;
        rung1)
            # Development instrument only (spec §7). Never committed as the
            # package's build: build-ffmpeg.sh always passes `target`.
            FFMPEG_CONFIGURE_FLAGS+=(
                --disable-everything
                --enable-protocol=file,pipe
                --enable-demuxer=mov,wav,nut
                --enable-muxer=mp4,mov,wav,nut,framecrc,streamhash,null,rawvideo
                --enable-decoder=mpeg4,aac,aac_fixed,pcm_s16le,rawvideo
                --enable-encoder=mpeg4,pcm_s16le,rawvideo
                --enable-parser=mpeg4video,aac
                --enable-indev=lavfi
                --enable-filter=testsrc,sine,scale,format,aformat,aresample,null,anull,buffer,buffersink,abuffer,abuffersink
            )
            ;;
        *) echo "ffmpeg_configure_flags: unknown mode $mode" >&2; return 1 ;;
    esac
}
```

- [ ] **Step 4: Write `audit-configure.sh`.**

```bash
#!/usr/bin/env bash
# Assert what FFmpeg's configure and link actually produced. A configure
# that exits 0 with a feature silently missing, or that claims a libc
# function Kandelo does not provide, is the misleading-probe failure from
# spec §4: --allow-undefined lets link probes succeed for missing symbols.
set -euo pipefail
cmd="$1"; shift
case "$cmd" in
config)
    build="$1"; sysroot="$2"
    h="$build/config.h"
    for want in HAVE_SIMD128 HAVE_PTHREADS; do
        grep -q "^#define $want 1" "$h" || { echo "audit: $want not enabled" >&2; exit 1; }
    done
    for want in CONFIG_ZLIB CONFIG_ICONV CONFIG_LIBXML2 CONFIG_SDL2; do
        # rung1 builds legitimately lack these; the build script passes
        # FFMPEG_AUDIT_EXPECT_DEPS=0 only in that mode.
        [ "${FFMPEG_AUDIT_EXPECT_DEPS:-1}" = 1 ] || break
        grep -q "^#define $want 1" "$build/config_components.h" "$h" 2>/dev/null \
            || { echo "audit: $want not enabled" >&2; exit 1; }
    done
    # Every system function configure claims must be defined in libc.a.
    funcs=$(awk '/^SYSTEM_FUNCS="/{f=1;next} f&&/^"/{exit} f{print $1}' "$build/configure")
    defined=$(wasm32posix-nm --defined-only "$sysroot/lib/libc.a" 2>/dev/null | awk '{print $NF}' | sort -u)
    bad=0
    for fn in $funcs; do
        up=$(printf '%s' "$fn" | tr '[:lower:]' '[:upper:]')
        if grep -q "^#define HAVE_$up 1" "$h" && ! printf '%s\n' "$defined" | grep -qx "$fn"; then
            echo "audit: config.h claims HAVE_$up but libc.a does not define $fn" >&2
            bad=1
        fi
    done
    exit $bad
    ;;
link)
    wasm="$1"
    n=$(wasm-objdump -d "$wasm" | grep -cE '\b(v128|i8x16|i16x8|i32x4|i64x2|f32x4|f64x2)\.' || true)
    echo "audit: $(basename "$wasm") contains $n SIMD instructions"
    [ "$n" -gt 0 ] || { echo "audit: no SIMD instructions in $wasm" >&2; exit 1; }
    ;;
*) echo "usage: audit-configure.sh config <build> <sysroot> | link <wasm>" >&2; exit 2 ;;
esac
```

Before relying on it, confirm FFmpeg n9.0's configure names its list `SYSTEM_FUNCS` (`grep -n '^SYSTEM_FUNCS=' configure` in the extracted source). If it is named differently, fix the awk pattern — the audit must find a non-empty list, so also add `[ -n "$funcs" ] || { echo "audit: SYSTEM_FUNCS list not found" >&2; exit 1; }` right after computing it.

- [ ] **Step 5: Write `build-ffmpeg.sh`.**

```bash
#!/usr/bin/env bash
# Build upstream FFmpeg n9.0 as Kandelo programs: ffmpeg, ffprobe, ffplay.
# Resolver contract: see docs/package-management.md and build-libxml2.sh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-ffmpeg.XXXXXX")"
cleanup() {
    if [ "${WASM_POSIX_KEEP_BUILD_DIR:-0}" = "1" ]; then
        echo "==> Preserving FFmpeg build directory: $WORK_DIR" >&2
    else
        rm -rf "$WORK_DIR"
    fi
}
trap cleanup EXIT

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

VERSION="${WASM_POSIX_DEP_VERSION:?resolve through cargo xtask build-deps resolve ffmpeg}"
SOURCE_URL="${WASM_POSIX_DEP_SOURCE_URL:?}"
SOURCE_SHA256="${WASM_POSIX_DEP_SOURCE_SHA256:?}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
[ "$TARGET_ARCH" = wasm32 ] || { echo "ERROR: ffmpeg supports only wasm32" >&2; exit 1; }

ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?}"
LIBICONV_PREFIX="${WASM_POSIX_DEP_LIBICONV_DIR:?}"
LIBXML2_PREFIX="${WASM_POSIX_DEP_LIBXML2_DIR:?}"
SDL2_PREFIX="${WASM_POSIX_DEP_SDL2_DIR:?}"

echo "==> Fetching FFmpeg $VERSION"
TARBALL="$WORK_DIR/ffmpeg.tar.xz"
curl --retry 10 --retry-delay 5 --retry-all-errors -fsSL "$SOURCE_URL" -o "$TARBALL"
echo "$SOURCE_SHA256  $TARBALL" | shasum -a 256 -c -
SRC="$WORK_DIR/src"; mkdir -p "$SRC"
tar xJf "$TARBALL" -C "$SRC" --strip-components=1

export PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$LIBICONV_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig:$SDL2_PREFIX/lib/pkgconfig${WASM_POSIX_DEP_PKG_CONFIG_PATH:+:$WASM_POSIX_DEP_PKG_CONFIG_PATH}"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/configure-flags.sh"
ffmpeg_configure_flags target

cd "$SRC"
echo "==> Configuring FFmpeg (target configure, spec §5)"
./configure "${FFMPEG_CONFIGURE_FLAGS[@]}" || { tail -50 ffbuild/config.log >&2; exit 1; }
bash "$SCRIPT_DIR/audit-configure.sh" config "$SRC" "$WASM_POSIX_SYSROOT"

echo "==> Building"
make -j"$(getconf _NPROCESSORS_ONLN)" ffmpeg ffprobe ffplay

for p in ffmpeg ffprobe ffplay; do
    cp "$p" "$WORK_DIR/$p.wasm"
    bash "$SCRIPT_DIR/audit-configure.sh" link "$WORK_DIR/$p.wasm"
done
ls -l "$WORK_DIR"/*.wasm

# Fork instrumentation: FFmpeg's programs are not expected to fork. If the
# link ever pulls in fork/vfork/posix_spawn/system/popen, this check fails
# so instrumentation is added deliberately (scripts/run-wasm-fork-instrument.sh).
for p in ffmpeg ffprobe ffplay; do
    if wasm-objdump -x "$WORK_DIR/$p.wasm" | grep -qE '<(fork|_Fork|vfork|system|popen|posix_spawn)>'; then
        echo "ERROR: $p.wasm references a fork-like function; add fork instrumentation" >&2
        exit 1
    fi
done

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary ffmpeg "$WORK_DIR/ffmpeg.wasm" ffmpeg.wasm
install_local_binary ffmpeg "$WORK_DIR/ffprobe.wasm" ffprobe.wasm
install_local_binary ffmpeg "$WORK_DIR/ffplay.wasm" ffplay.wasm
```

Static SDL2 links need libdrm, libgbm, libEGL, and libGLESv2 (`sdl2.pc` lists them). If FFmpeg's link cannot find `-ldrm`, the package is using an undeclared transitive dependency: add `libdrm@2.4.120` to `depends_on` and its prefix to `PKG_CONFIG_PATH`/`--extra-ldflags` rather than pointing at another package's cache directory. Record which way it went in the ledger.

Compare the tail with `packages/registry/tyrquake/build-tyrquake.sh` and one multi-output package (for example `packages/registry/git/build-git.sh`) and match how they write outputs into `WASM_POSIX_DEP_OUT_DIR`; `install_local_binary` handles `local-binaries/`, but the resolver's output directory must also receive the three wasm files at the paths `cargo xtask build-deps output-path ffmpeg ffmpeg.wasm` reports. Copy exactly what the multi-output exemplar does.

- [ ] **Step 6: Add the package to `packages/sets/local-supported.toml`**, alphabetically:

```toml
[[packages]]
name = "ffmpeg"
class = "user-software"
```

- [ ] **Step 7: Create the ledger** `docs/plans/2026-09-26-ffmpeg-gap-ledger.md`:

```markdown
# FFmpeg Port — Gap Ledger

Running record of every Kandelo gap the FFmpeg port exposes. Procedure:
`docs/plans/2026-09-26-ffmpeg-port-plan.md`, "Gap-Fix Protocol".
Design: `docs/plans/2026-09-26-ffmpeg-port-design.md` §4 and §9.

## Status

| Rung | Reached | Open gaps |
|---|---|---|
| 0 honest configure | no | — |
| 1 running binaries | no | — |
| 2 full codec set | no | — |
| 3 devices + ffplay | no | — |

## Known non-gaps

- **SDL2 `--disable-render`** — not a failure. It dates from SDL2's
  audio-only package (`313cfdfeb`); video was enabled later (`2bef9f783`)
  for a demo that draws with GLES2 directly, so nothing needed SDL's
  renderer. Enabled in Task 6.

## Gaps
```

- [ ] **Step 8: Run rung 0.** Build through the resolver, keeping the build directory:

```bash
scripts/dev-shell.sh bash -c 'WASM_POSIX_KEEP_BUILD_DIR=1 cargo xtask build-deps resolve ffmpeg' 2>&1 | tee /tmp/ffmpeg-rung0.log
```

Rung 0 passes when `configure` completes **and** `audit-configure.sh config` passes. The compile step after it will very likely fail at this stage — that is rung 2's business. Expected first findings: `audit: config.h claims HAVE_<X> but libc.a does not define <x>` lines (the dishonest-probe gap). Each distinct root cause gets a ledger entry per the Gap-Fix Protocol. The link-probe dishonesty itself is an SDK-contract gap: apply **G3** (write options, ask the maintainer) before changing SDK behavior; until then, record which `HAVE_*` values are false claims.

- [ ] **Step 9: Commit the package as the tip commit and open the draft PR.**

```bash
git add packages/registry/ffmpeg/package.toml packages/registry/ffmpeg/build.toml \
  packages/registry/ffmpeg/configure-flags.sh packages/registry/ffmpeg/audit-configure.sh \
  packages/registry/ffmpeg/build-ffmpeg.sh packages/sets/local-supported.toml \
  docs/plans/2026-09-26-ffmpeg-gap-ledger.md
git commit -m "Packages: Add FFmpeg n9.0" -m "<72-col body>" -m "Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
git push -u origin brandonpayton/ffmpeg-on-kandelo
gh pr create --draft --base main --title "Packages: Port FFmpeg n9.0 as real Kandelo programs" --body-file /tmp/ffmpeg-pr-body.md
```

The PR body starts with `## Why` (from spec §1), then `## What changed`, then a link-free summary of the ledger. From here on, every gap fix uses **G7** to stay below this commit.

---

### Task 3: Rung 1 — running binaries and bit-exact decode

**Files:**
- Create: `packages/registry/ffmpeg/test/ffmpeg-support.ts`
- Create: `packages/registry/ffmpeg/test/ffmpeg-tier1.test.ts`
- Modify: `scripts/ci-vitest-evidence-classes.tsv`

**Interfaces:**
- Consumes: fixtures from Task 1; `configure-flags.sh` `rung1` mode from Task 2.
- Produces (in `ffmpeg-support.ts`): `ACCEPTANCE: boolean`, `FIXTURES: string`, `ffmpegProgram(name: "ffmpeg" | "ffprobe" | "ffplay"): string | null`, `run(program: string, argv: string[], opts?: { stdinBytes?: Uint8Array; timeout?: number; env?: string[] }): Promise<RunProgramResult>`, `fixture(name: string): string`, `maxAbsSampleDiff(a: Uint8Array, b: Uint8Array): number`.

- [ ] **Step 1: Build rung 1 by hand in the kept build directory.** Rung builds are never committed (spec §7).

```bash
D=<the "Preserving FFmpeg build directory" path from Task 2 step 8>/src
scripts/dev-shell.sh bash -c "
  source sdk/activate.sh
  export ZLIB_PREFIX=\$(cargo xtask build-deps path zlib) LIBICONV_PREFIX=\$(cargo xtask build-deps path libiconv) \
         LIBXML2_PREFIX=\$(cargo xtask build-deps path libxml2) SDL2_PREFIX=\$(cargo xtask build-deps path sdl2)
  source packages/registry/ffmpeg/configure-flags.sh && ffmpeg_configure_flags rung1
  cd $D && make distclean >/dev/null 2>&1 || true
  ./configure \"\${FFMPEG_CONFIGURE_FLAGS[@]}\" && FFMPEG_AUDIT_EXPECT_DEPS=0 bash $PWD/packages/registry/ffmpeg/audit-configure.sh config $D $PWD/sysroot
  make -j8 ffmpeg ffprobe
"
```

Every compile or link failure goes through the Gap-Fix Protocol. When it links, point the tests at these binaries: `mkdir -p local-binaries/programs/ffmpeg` is **not** allowed by hand (the mirror is manifest-driven); instead set `KANDELO_FFMPEG_BIN_DIR=$D` for the test run, which `ffmpegProgram()` honors (next step).

- [ ] **Step 2: Write `ffmpeg-support.ts`.**

```ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import {
  runCentralizedProgram,
  type RunProgramResult,
} from "../../../../host/test/centralized-test-helper";

/** Acceptance runs forbid skips: a missing binary or resource is a failure. */
export const ACCEPTANCE = process.env.KANDELO_FFMPEG_ACCEPTANCE === "1";
export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function fixture(name: string): string {
  return join(FIXTURES, name);
}

/**
 * Resolve an FFmpeg program. KANDELO_FFMPEG_BIN_DIR points at a hand-built
 * rung tree (spec §7) whose programs have no .wasm suffix; otherwise the
 * package output is resolved normally.
 */
export function ffmpegProgram(name: "ffmpeg" | "ffprobe" | "ffplay"): string | null {
  const dir = process.env.KANDELO_FFMPEG_BIN_DIR;
  const path = dir ? join(dir, name) : tryResolveBinary(`programs/ffmpeg/${name}.wasm`);
  if (!path && ACCEPTANCE) {
    throw new Error(
      `acceptance run requires programs/ffmpeg/${name}.wasm; build it with cargo xtask build-deps resolve ffmpeg`,
    );
  }
  return path ?? null;
}

/**
 * Run with the host filesystem visible (no rootfs image), so fixtures and
 * scratch files are addressed by their host paths.
 */
export function run(
  program: string,
  argv: string[],
  opts: { stdinBytes?: Uint8Array; timeout?: number; env?: string[] } = {},
): Promise<RunProgramResult> {
  return runCentralizedProgram({
    programPath: program,
    argv,
    useDefaultRootfs: false,
    stdinBytes: opts.stdinBytes,
    env: opts.env,
    timeout: opts.timeout ?? 120_000,
  });
}

function toInt16(bytes: Uint8Array): Int16Array {
  const copy = bytes.slice();
  return new Int16Array(copy.buffer, 0, copy.byteLength >> 1);
}

/** Largest per-sample difference between two s16le PCM buffers. */
export function maxAbsSampleDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.byteLength !== b.byteLength) {
    throw new Error(`PCM length differs: ${a.byteLength} vs ${b.byteLength}`);
  }
  const x = toInt16(a);
  const y = toInt16(b);
  let max = 0;
  for (let i = 0; i < x.length; i++) max = Math.max(max, Math.abs(x[i] - y[i]));
  return max;
}

export function readFixtureText(name: string): string {
  return readFileSync(fixture(name), "utf8");
}
```

Check that `RunProgramResult` is exported from `host/test/centralized-test-helper.ts` (`grep -n "export interface RunProgramResult"`); if not, export it in this step.

- [ ] **Step 3: Write `ffmpeg-tier1.test.ts`.**

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ffmpegProgram, fixture, maxAbsSampleDiff, readFixtureText, run,
} from "./ffmpeg-support";

const ffmpeg = ffmpegProgram("ffmpeg");
const ffprobe = ffmpegProgram("ffprobe");
const BX = ["-flags", "+bitexact", "-fflags", "+bitexact"];
const clip = fixture("fixture.mp4");

describe.skipIf(!ffmpeg || !ffprobe)("ffmpeg tier 1: bit-exact against native n9.0", () => {
  it("reports its version", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-hide_banner", "-version"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^ffmpeg version 9\.0/);
  });

  it("ffprobe reports the fixture's streams exactly", async () => {
    const r = await run(ffprobe!, [
      "ffprobe", "-v", "error", "-show_entries",
      "stream=index,codec_name,codec_type,width,height,pix_fmt,sample_rate,channels",
      "-of", "json", clip,
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(JSON.parse(readFixtureText("fixture.ffprobe.json")));
  });

  it("decodes video to the native framecrc", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-i", clip,
      "-map", "0:v", ...BX, "-f", "framecrc", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("fixture.video.framecrc"));
  });

  it("frame-threaded decode is identical to single-threaded", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-threads", "4", "-i", clip,
      "-map", "0:v", ...BX, "-f", "framecrc", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("fixture.video.framecrc"));
  });

  it("fixed-point AAC decode matches native exactly", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-c:a", "aac_fixed", "-i", clip,
      "-map", "0:a", ...BX, "-f", "framecrc", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("fixture.audio-fixed.framecrc"));
  });

  it("float AAC decode is within one LSB of native", async () => {
    const r = await run(ffmpeg!, [
      "ffmpeg", "-nostdin", "-v", "error", "-i", clip, "-map", "0:a", "-f", "s16le", "-",
    ]);
    expect(r.exitCode, r.stderr).toBe(0);
    const native = new Uint8Array(readFileSync(fixture("fixture.audio-float.s16le")));
    expect(maxAbsSampleDiff(r.stdoutBytes, native)).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 4: Run against the rung-1 binaries.**

```bash
scripts/dev-shell.sh bash -c "cd host && KANDELO_FFMPEG_BIN_DIR=$D npx vitest run ../packages/registry/ffmpeg/test/ffmpeg-tier1.test.ts"
```

Expected on first run: failures. Each failure that is not a test bug is a gap → Gap-Fix Protocol. Rung 1's decode half is reached when all 6 pass. Note: the tests read fixtures by host path — if `ffprobe` reports "No such file or directory" for an existing host path, that is itself a gap in the raw host-filesystem mode; record it, and use `io: new NodePlatformIO()` in `run()` (the `curl` package test's approach) only if the maintainer agrees under **G3**.

- [ ] **Step 5: Add evidence class and commit (tests only; rung flags are not committed).**

Add `packages/registry/ffmpeg/test/ffmpeg-tier1.test.ts	prepared-product` to `scripts/ci-vitest-evidence-classes.tsv`, sorted. Then use **G7** (the tests live with the package, so amend them into the package commit instead of a separate commit: `git add …; git commit --amend --no-edit` while HEAD is the package commit).

---

### Task 4: Rung 1 — process runtime behaviors

**Files:**
- Create: `packages/registry/ffmpeg/test/ffmpeg-process-runtime.test.ts`
- Modify: `scripts/ci-vitest-evidence-classes.tsv`

**Interfaces:**
- Consumes: `ffmpeg-support.ts` from Task 3; native behaviors recorded in `fixtures/README.md` (Task 1 step 6).

- [ ] **Step 1: Write the test.** Replace `NATIVE_OVERWRITE_STATUS` and `NATIVE_SIGINT_STATUS` with the values recorded in Task 1 step 6.

```ts
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { ffmpegProgram, fixture, run } from "./ffmpeg-support";

const NATIVE_OVERWRITE_STATUS = 1;   // from fixtures/README.md "Native behaviors"
const NATIVE_SIGINT_STATUS = 255;    // from fixtures/README.md "Native behaviors"
const SIGINT = 2;

const ffmpeg = ffmpegProgram("ffmpeg");
const ffprobe = ffmpegProgram("ffprobe");
const dash = tryResolveBinary("programs/dash.wasm");
const clip = fixture("fixture.mp4");
const scratch: string[] = [];
afterAll(() => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "kandelo-ffmpeg-"));
  scratch.push(d);
  return d;
}
function bytes(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
}

/** Run ffmpeg under NodeKernelHost directly so the test can signal it or type into its PTY. */
async function interactive(
  argv: string[],
  drive: (host: NodeKernelHost, pid: number, output: () => string) => Promise<void>,
  pty: boolean,
): Promise<number> {
  let out = "";
  const host = new NodeKernelHost({
    maxWorkers: 4,
    onStderr: (_p, d) => { out += new TextDecoder().decode(d); },
    onStdout: (_p, d) => { out += new TextDecoder().decode(d); },
    onPtyOutput: (_p, d) => { out += new TextDecoder().decode(d); },
  });
  await host.init();
  try {
    let started!: (pid: number) => void;
    const pidReady = new Promise<number>((r) => { started = r; });
    const exit = host.spawn(bytes(ffmpeg!), argv, { pty, onStarted: (pid) => started(pid) });
    const pid = await pidReady;
    await drive(host, pid, () => out);
    return await exit;
  } finally {
    await host.destroy();
  }
}

async function until(pred: () => boolean, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!ffmpeg || !ffprobe || !dash)("ffmpeg process runtime", () => {
  it("transcodes through a pipe between two processes in a shell", async () => {
    const r = await runCentralizedProgram({
      programPath: dash!,
      argv: ["sh", "-c",
        "ffmpeg -nostdin -v error -i pipe:0 -map 0:v -c:v rawvideo -f nut pipe:1 | " +
        "ffprobe -v error -show_entries stream=codec_name,width,height -of csv=p=0 pipe:0"],
      env: ["PATH=/usr/bin:/bin"],
      execPrograms: new Map([["/usr/bin/ffmpeg", ffmpeg!], ["/usr/bin/ffprobe", ffprobe!]]),
      stdinBytes: new Uint8Array(readFileSync(clip)),
      timeout: 120_000,
    });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim()).toBe("rawvideo,176,144");
  });

  it("writes an output path containing a space and UTF-8", async () => {
    const out = join(tmp(), "out ü.wav");
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-i", clip, "-map", "0:a", "-c:a", "pcm_s16le", out]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(44);
  });

  it("refuses to overwrite without -y when stdin is not a terminal", async () => {
    const out = join(tmp(), "exists.wav");
    writeFileSync(out, "keep");
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-i", clip, "-map", "0:a", out], { timeout: 30_000 });
    expect(r.exitCode).toBe(NATIVE_OVERWRITE_STATUS);
    expect(readFileSync(out, "utf8")).toBe("keep");
  });

  it("SIGINT stops a long encode and leaves a valid file", async () => {
    const out = join(tmp(), "sigint.mp4");
    const status = await interactive(
      ["ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25",
       "-c:v", "mpeg4", out],
      async (host, pid) => {
        await until(() => existsSync(out) && statSync(out).size > 0, 60_000);
        expect(await host.signalProcess(pid, SIGINT)).toBe(true);
      },
      false,
    );
    expect(status).toBe(NATIVE_SIGINT_STATUS);
    const probe = await run(ffprobe!, ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
    expect(probe.exitCode, probe.stderr).toBe(0);
    expect(Number(probe.stdout.trim())).toBeGreaterThan(0);
  });

  it("typing q on a terminal stops the run cleanly", async () => {
    const out = join(tmp(), "q.mp4");
    const status = await interactive(
      ["ffmpeg", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=25", "-c:v", "mpeg4", out],
      async (host, pid, output) => {
        await until(() => /frame=\s*\d+/.test(output()), 60_000);
        host.ptyWrite(pid, new TextEncoder().encode("q"));
      },
      true,
    );
    expect(status).toBe(0);
    const probe = await run(ffprobe!, ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out]);
    expect(Number(probe.stdout.trim())).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run against rung 1.**

```bash
scripts/dev-shell.sh bash -c "cd host && KANDELO_FFMPEG_BIN_DIR=$D npx vitest run ../packages/registry/ffmpeg/test/ffmpeg-process-runtime.test.ts"
```

Expected: all 5 pass, or each failure becomes a ledger gap. Likely layers: PTY raw mode and non-blocking stdin polling (the `q` test), signal delivery during a blocking write (SIGINT), pipe EOF propagation (pipe test). A test that passes only after changing its expectation away from native behavior is not a pass.

- [ ] **Step 3: Update the ledger status table** (rung 1 reached, or open gaps listed), add the evidence class (`prepared-product`), and amend into the package commit (Task 3 step 5).

---

### Task 5: Rung 2 — full codec set, SIMD proof, Big Buck Bunny

**Files:**
- Create: `packages/registry/ffmpeg/test/ffmpeg-tier2-bbb.test.ts`
- Modify: `scripts/ci-vitest-evidence-classes.tsv`, the ledger

**Interfaces:**
- Consumes: `ffmpeg-support.ts`; `bbb.*` references from Task 1; the `unzip` package (`programs/unzip.wasm`).

- [ ] **Step 1: Build the full default set.** Configure the kept tree in `target` mode but build only `ffmpeg ffprobe` (ffplay is rung 3):

```bash
scripts/dev-shell.sh bash -c "
  source sdk/activate.sh
  export ZLIB_PREFIX=\$(cargo xtask build-deps path zlib) LIBICONV_PREFIX=\$(cargo xtask build-deps path libiconv) \
         LIBXML2_PREFIX=\$(cargo xtask build-deps path libxml2) SDL2_PREFIX=\$(cargo xtask build-deps path sdl2)
  source packages/registry/ffmpeg/configure-flags.sh && ffmpeg_configure_flags target
  cd $D && make distclean >/dev/null 2>&1 || true
  ./configure \"\${FFMPEG_CONFIGURE_FLAGS[@]}\" && bash $PWD/packages/registry/ffmpeg/audit-configure.sh config $D $PWD/sysroot
  make -j8 -k ffmpeg ffprobe 2>&1 | tee /tmp/ffmpeg-rung2.log
"
grep -E 'error:|undefined symbol' /tmp/ffmpeg-rung2.log | sort | uniq -c | sort -rn | head -40
```

`make -k` keeps going so one run reveals every failing file. Group the errors by root cause (usually a handful of missing headers or libc functions) and run each cause through the Gap-Fix Protocol.

- [ ] **Step 2: Prove SIMD is present and record size.**

```bash
bash packages/registry/ffmpeg/audit-configure.sh link $D/ffmpeg
ls -l $D/ffmpeg $D/ffprobe
```

Expected: a non-zero SIMD instruction count. Record count and sizes in the ledger (they feed the separate SIMD audit and the spec §10 size risk).

- [ ] **Step 3: Re-run Tier 1 and process-runtime tests against the full build** (same commands as Tasks 3–4). Any regression versus rung 1 is a gap.

- [ ] **Step 4: Write `ffmpeg-tier2-bbb.test.ts`.**

```ts
import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { ACCEPTANCE, ffmpegProgram, readFixtureText, run } from "./ffmpeg-support";

// Big Buck Bunny (c) Blender Foundation, CC-BY 3.0. Pinned 2026-09-26.
const ZIP_URL = "https://download.blender.org/peach/bigbuckbunny_movies/BigBuckBunny_320x180.mp4.zip";
const ZIP_SHA256 = "109e3ede8790bd633f374ca311d9cc61dce8d7f98f5b0797ca98199c9fbceedf";
const MP4_SHA256 = "f78f39603e6774907f2faafabf26a667f4a6fc31769ec304a8a8f7c62d280508";
const CACHE = process.env.KANDELO_FFMPEG_MEDIA_CACHE ?? join(homedir(), ".cache/kandelo/ffmpeg-test-media");
const MP4 = join(CACHE, "BigBuckBunny_320x180.mp4");
const FULL_DECODE_MS = 30 * 60_000;
const BX = ["-flags", "+bitexact", "-fflags", "+bitexact"];

const ffmpeg = ffmpegProgram("ffmpeg");
const ffprobe = ffmpegProgram("ffprobe");
const unzip = tryResolveBinary("programs/unzip.wasm");
const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let available = false;

describe.skipIf(!ffmpeg || !ffprobe || !unzip)("ffmpeg tier 2: Big Buck Bunny", () => {
beforeAll(async () => {
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(MP4) || sha256(readFileSync(MP4)) !== MP4_SHA256) {
    const zip = join(CACHE, "BigBuckBunny_320x180.mp4.zip");
    if (!existsSync(zip) || sha256(readFileSync(zip)) !== ZIP_SHA256) {
      try {
        const res = await fetch(ZIP_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        writeFileSync(zip, new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        if (ACCEPTANCE) throw new Error(`Big Buck Bunny unreachable: ${String(e)}`);
        return;
      }
    }
    expect(sha256(readFileSync(zip))).toBe(ZIP_SHA256);
    // Extract with Kandelo's own unzip rather than an ambient host tool.
    const r = await run(unzip!, ["unzip", "-o", "-q", zip, "-d", CACHE], { timeout: 300_000 });
    expect(r.exitCode, r.stderr).toBe(0);
  }
  expect(sha256(readFileSync(MP4))).toBe(MP4_SHA256);
  available = true;
}, 900_000);

  it("decodes the whole video to the native stream hash", async () => {
    if (!available) return;
    const t0 = Date.now();
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-threads", "1", "-i", MP4,
      "-map", "0:v", ...BX, "-f", "streamhash", "-hash", "sha256", "-"], { timeout: FULL_DECODE_MS });
    console.log(`BBB full video decode: ${((Date.now() - t0) / 1000).toFixed(1)} s (observation, not a benchmark)`);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("bbb.video.streamhash"));
  }, FULL_DECODE_MS);

  it("decodes the whole soundtrack (fixed-point AAC) to the native stream hash", async () => {
    if (!available) return;
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-c:a", "aac_fixed", "-i", MP4,
      "-map", "0:a", ...BX, "-f", "streamhash", "-hash", "sha256", "-"], { timeout: FULL_DECODE_MS });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("bbb.audio-fixed.streamhash"));
  }, FULL_DECODE_MS);

  it("seeks to 300 s and matches native", async () => {
    if (!available) return;
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-ss", "300", "-i", MP4,
      "-frames:v", "5", "-map", "0:v", ...BX, "-f", "framecrc", "-"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toBe(readFixtureText("bbb.seek300.framecrc"));
  }, 300_000);

  it("decodes with 16 threads to the same result or fails cleanly", async () => {
    if (!available) return;
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-threads", "16", "-i", MP4,
      "-map", "0:v", ...BX, "-f", "streamhash", "-hash", "sha256", "-"], { timeout: FULL_DECODE_MS });
    if (r.exitCode === 0) {
      expect(r.stdout).toBe(readFixtureText("bbb.video.streamhash"));
    } else {
      // A clean failure names the resource; a trap or signal death is a gap.
      expect(r.exitCode).toBeLessThan(128);
      expect(r.stderr).toMatch(/thread|resource|memory/i);
    }
  }, FULL_DECODE_MS);

  it("probes a moov-at-end MP4 through a pipe", async () => {
    if (!available) return;
    const r = await run(ffprobe!, ["ffprobe", "-v", "error", "-show_entries", "stream=codec_name",
      "-of", "csv=p=0", "pipe:0"], { stdinBytes: new Uint8Array(readFileSync(MP4)), timeout: 600_000 });
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout.trim().split("\n").sort()).toEqual(["aac", "h264"]);
  }, 600_000);
});
```

Note on "fails cleanly" in the 16-thread test: if it fails, that is still a ledger entry — the question is whether 16 threads *should* fit. Record Kandelo's thread-slot limit (`defaultThreadSlots` in `host/src/node-kernel-host.ts`) and whether native FFmpeg would have succeeded.

- [ ] **Step 5: Run it.**

```bash
scripts/dev-shell.sh bash -c "cd host && KANDELO_FFMPEG_BIN_DIR=$D npx vitest run ../packages/registry/ffmpeg/test/ffmpeg-tier2-bbb.test.ts"
```

Expected: 5 passed. Record the wall-time observation in the ledger. Add the evidence class (`prepared-product`), update the ledger's rung-2 row, and amend into the package commit.

---

### Task 6: Enable SDL2's render subsystem

**Files:**
- Modify: `packages/registry/sdl2/build-sdl2.sh` (configure flag and feature assertion)
- Modify: `packages/registry/sdl2/build.toml` (`revision = 3`)
- Modify: ledger

**Interfaces:**
- Produces: `libSDL2.a` with `SDL_VIDEO_RENDER_OGL_ES2` and the software renderer compiled in; consumed by Task 7's ffplay.

- [ ] **Step 1: Confirm the flag names against SDL 2.32.10's configure.**

```bash
cd "$(mktemp -d)" && curl -fsSL https://github.com/libsdl-org/SDL/releases/download/release-2.32.10/SDL2-2.32.10.tar.gz | tar xz --strip-components=1
grep -nE 'enable-render|RENDER_OGL_ES2|RENDER_SW' configure include/SDL_config.h.in | head -20
```

Expected: `--enable-render` exists; `SDL_VIDEO_RENDER_OGL_ES2` and `SDL_VIDEO_RENDER_SW` appear in `SDL_config.h.in`. Use exactly what you find.

- [ ] **Step 2: Write the failing assertion first.** In `build-sdl2.sh`, extend the existing feature loop:

```bash
for feature in SDL_VIDEO_DRIVER_KMSDRM SDL_VIDEO_OPENGL_ES2 \
    SDL_VIDEO_OPENGL_EGL SDL_INPUT_LINUXEV SDL_AUDIO_DRIVER_OSS \
    SDL_VIDEO_RENDER_OGL_ES2 SDL_VIDEO_RENDER_SW; do
```

Run `cargo xtask build-deps resolve sdl2` (after bumping `revision` to 3 so the cache key changes). Expected: `ERROR: configure did not enable SDL_VIDEO_RENDER_OGL_ES2`.

- [ ] **Step 3: Enable render.** Replace `--disable-render \` with:

```bash
        # ffplay (and any SDL program using SDL_CreateRenderer) draws through
        # SDL's render API. It was disabled only because this package began
        # audio-only (313cfdfeb) and the first video consumer drew with GLES2
        # directly (2bef9f783). GLES2 renders in the browser via WebGL; the
        # Node host has no GL, where only the software renderer can work.
        --enable-render \
```

Rebuild: `scripts/dev-shell.sh bash -c 'cargo xtask build-deps resolve sdl2'`. Expected: build completes, both features asserted. A failure here is a ledger gap (Gap-Fix Protocol), most likely in the GLES2 stubs (`libc/glue/libglesv2_stub.c`) if SDL's renderer uses GL entry points the stub lacks.

- [ ] **Step 4: Rebuild and re-verify every SDL2 consumer.** Get the authoritative list, rebuild, and run their tests:

```bash
grep -l 'sdl2@' packages/registry/*/package.toml          # today: sdl2-demo, sdl2-mixer-playwave, sdl-dsp-test
scripts/dev-shell.sh bash -c 'for p in sdl2-demo sdl2-mixer-playwave sdl-dsp-test; do cargo xtask build-deps resolve $p || exit 1; done'
scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/sdl2.test.ts test/sdl2-evdev-smoke.test.ts test/sdl2-kmsdrm-smoke.test.ts test/audio-integration.test.ts ../tests/package-system/sdl-dsp-packages.test.ts'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test test/kandelo-sdl2.spec.ts'
```

Expected: all pass as before (report per-test counts). Also check that `packages/registry/sdl2/patches/0001-recognize-kandelo-as-unix.patch` is unchanged (`git diff --stat -- packages/registry/sdl2/patches` is empty) — spec §4/§6.

- [ ] **Step 5: Commit below the package commit (G7).** Subject: `Packages: Enable SDL2's render subsystem`. Update the ledger's "Known non-gaps" entry with the commit subject.

---

### Task 7: Rung 3 — devices and ffplay

**Files:**
- Create: `packages/registry/ffmpeg/test/ffmpeg-devices.test.ts`
- Modify: evidence classes, ledger

**Interfaces:**
- Consumes: Task 6's SDL2; `ffmpeg-support.ts`.

- [ ] **Step 1: Build the complete target (all three programs) through the resolver** — this is exactly the committed build:

```bash
scripts/dev-shell.sh bash -c 'cargo xtask build-deps resolve ffmpeg'
```

Expected: configure audit, link audits (3 SIMD counts), no fork-like references, three outputs installed. From now on tests run **without** `KANDELO_FFMPEG_BIN_DIR`.

- [ ] **Step 2: Write `ffmpeg-devices.test.ts`.**

```ts
import { describe, expect, it } from "vitest";
import { ffmpegProgram, fixture, run } from "./ffmpeg-support";

// What ffplay does on the Node host when asked to show video (spec §6.3).
// Step 3 measures it and replaces this value; the ledger entry records why.
const NODE_FFPLAY_VIDEO_EXPECTATION = { status: 0, err: "" };

const ffmpeg = ffmpegProgram("ffmpeg");
const ffplay = ffmpegProgram("ffplay");
const clip = fixture("fixture.mp4");

describe.skipIf(!ffmpeg || !ffplay)("ffmpeg devices and ffplay (Node host)", () => {
  it("lists the fbdev and oss devices it was built with", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-hide_banner", "-devices"]);
    expect(r.exitCode, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\bD?E\s+fbdev\b/);
    expect(r.stdout).toMatch(/\bD?E\s+oss\b/);
  });

  it("plays audio to /dev/dsp through FFmpeg's OSS output", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-i", clip,
      "-map", "0:a", "-f", "oss", "/dev/dsp"], { timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
  });

  it("writes video frames to /dev/fb0 through FFmpeg's fbdev output", async () => {
    const r = await run(ffmpeg!, ["ffmpeg", "-nostdin", "-v", "error", "-i", clip,
      "-map", "0:v", "-pix_fmt", "bgra", "-f", "fbdev", "/dev/fb0"], { timeout: 60_000 });
    expect(r.exitCode, r.stderr).toBe(0);
  });

  it("ffplay plays the soundtrack with -nodisp", async () => {
    const r = await run(ffplay!, ["ffplay", "-v", "error", "-nodisp", "-autoexit", clip],
      { timeout: 60_000, env: ["SDL_AUDIODRIVER=dsp"] });
    expect(r.exitCode, r.stderr).toBe(0);
  });

  it("ffplay video on Node follows the documented boundary", async () => {
    const r = await run(ffplay!, ["ffplay", "-v", "error", "-autoexit", clip],
      { timeout: 60_000, env: ["SDL_AUDIODRIVER=dsp"] });
    expect({ status: r.exitCode, err: r.stderr.trim() }).toEqual(NODE_FFPLAY_VIDEO_EXPECTATION);
  });
});
```

- [ ] **Step 3: Determine the Node ffplay video behavior (spec §6.3).** Run the last test; its failure diff shows the actual `{ status, err }`. If ffplay shows video via SDL's software renderer on Node, the initial `{ status: 0, err: "" }` is right. If it fails with "Failed to create window or renderer", decide with the maintainer (**G3**) whether that is the documented Node boundary; if yes, define the constant as that exact result, add the boundary to `docs/browser-support.md` (Node/browser differences) with why and the residual risk, and record it in the ledger, and set the constant to that exact result with a comment naming the ledger entry.

- [ ] **Step 4: Run it.**

```bash
scripts/dev-shell.sh bash -c 'cd host && npx vitest run ../packages/registry/ffmpeg/test/ffmpeg-devices.test.ts'
```

Expected: 5 passed. Gaps via the protocol. Add evidence class, update ledger rung 3 (Node half), amend into the package commit.

---

### Task 8: FATE through Kandelo

**Files:**
- Modify: `examples/run-example.ts` (accept an absolute path to an existing program without a `.wasm` suffix)
- Modify: `host/test/run-example-resolver.test.ts` (test for that)
- Create: `packages/registry/ffmpeg/test/fate/kandelo-target-exec.sh`
- Create: `packages/registry/ffmpeg/test/fate/run-fate.sh`
- Create: `packages/registry/ffmpeg/test/fate/groups.txt`

**Interfaces:**
- Consumes: `configure-flags.sh` (`target` mode), resolved dependency prefixes.
- Produces: `run-fate.sh` writes `$FATE_OUT/fate-report.json`: `{ "groups": string[], "run": number, "failed": string[] }`; exit status non-zero if any test failed.

- [ ] **Step 1: Write the failing runner test.** FATE names programs like `…/ffmpeg` (no suffix; `--target-os=none` has no executable suffix). Add to `host/test/run-example-resolver.test.ts`:

```ts
  it("runs an absolute program path that has no .wasm suffix", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-example-nosuffix-"));
    try {
      const program = join(dir, "hello");
      writeFileSync(program, readFileSync(join(repoRoot, "examples", "hello.wasm")));
      const result = spawnSync(
        process.execPath,
        ["--experimental-wasm-exnref", "--import", "tsx/esm", runExample, program],
        { cwd: repoRoot, encoding: "utf8", timeout: 60_000 },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Hello from musl on kandelo!");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
```

Run: `scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/run-example-resolver.test.ts -t "no .wasm suffix"'`. Expected: FAIL (it tries `examples/<abs>.wasm`).

- [ ] **Step 2: Fix `examples/run-example.ts`.** Replace the program-path selection:

```ts
    let programPath: string;
    if (name.endsWith(".wasm") || (isAbsolute(name) && existsSync(name))) {
        // WHY: cross-built programs on a target without an executable
        // suffix (FFmpeg's FATE runs `…/ffmpeg` via --target-exec) are
        // still Wasm modules; an explicit absolute path is unambiguous.
        programPath = resolve(name);
    } else if (builtinPrograms[name]) {
```

Re-run step 1's command. Expected: PASS. Then run the whole file: `npx vitest run test/run-example-resolver.test.ts` — all pass.

- [ ] **Step 3: Commit below the package commit (G7).** Subject: `Tests: Let run-example launch suffixless Wasm programs`.

- [ ] **Step 4: Write `kandelo-target-exec.sh`.**

```bash
#!/usr/bin/env bash
# FATE --target-exec wrapper: run one target program as a Kandelo process.
# FATE's make and shell run on the host; every program it launches runs
# here, in a fresh Kandelo kernel, with the host filesystem visible.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
TSX_ESM="$REPO_ROOT/node_modules/tsx/dist/esm/index.mjs"
[ -f "$TSX_ESM" ] || { echo "kandelo-target-exec: $TSX_ESM missing; run npm install" >&2; exit 127; }
export TIMEOUT="${KANDELO_FATE_TIMEOUT_MS:-600000}"
exec node --experimental-wasm-exnref --import "file://$TSX_ESM" \
    "$REPO_ROOT/examples/run-example.ts" "$@"
```

Verify the tsx ESM entry path after `npm install` (`node -p 'require.resolve("tsx/esm")'` from the repo root); use the resolved path if it differs.

- [ ] **Step 5: Write `groups.txt`** (one FATE target per line; spec §8 Tier 3):

```
fate-h264
fate-hevc
fate-aac
fate-mpeg4
fate-vp9
fate-opus
fate-flac
fate-pcm
fate-mov
fate-matroska
fate-filter-video
fate-filter-audio
```

Before first use, confirm each target exists: `make -n <target> >/dev/null` in a configured FFmpeg tree. Replace any name that n9.0 spells differently (for example if `fate-filter-video` is not a top-level target, list its `FATE_FILTER_*` equivalents from `tests/fate/filter-video.mak`).

- [ ] **Step 6: Write `run-fate.sh`.**

```bash
#!/usr/bin/env bash
# Run FFmpeg's FATE groups with every target program executed by Kandelo.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../../../.." && pwd)"
PKG="$REPO_ROOT/packages/registry/ffmpeg"
SAMPLES="${KANDELO_FATE_SAMPLES:-$HOME/.cache/kandelo/fate-suite}"
FATE_OUT="${FATE_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/kandelo-fate.XXXXXX")}"
WORK="$FATE_OUT/build"; mkdir -p "$WORK"

cd "$REPO_ROOT"
source sdk/activate.sh
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
export ZLIB_PREFIX=$(cargo xtask build-deps path zlib) LIBICONV_PREFIX=$(cargo xtask build-deps path libiconv)
export LIBXML2_PREFIX=$(cargo xtask build-deps path libxml2) SDL2_PREFIX=$(cargo xtask build-deps path sdl2)
export PKG_CONFIG_PATH="$ZLIB_PREFIX/lib/pkgconfig:$LIBICONV_PREFIX/lib/pkgconfig:$LIBXML2_PREFIX/lib/pkgconfig:$SDL2_PREFIX/lib/pkgconfig"

URL=$(awk -F'"' '/^url *=/{print $2; exit}' "$PKG/package.toml")
SHA=$(awk -F'"' '/^sha256 *=/{print $2; exit}' "$PKG/package.toml")
curl -fsSL "$URL" -o "$WORK/ffmpeg.tar.xz"
echo "$SHA  $WORK/ffmpeg.tar.xz" | shasum -a 256 -c -
tar xJf "$WORK/ffmpeg.tar.xz" -C "$WORK" --strip-components=1

source "$PKG/configure-flags.sh"; ffmpeg_configure_flags target
cd "$WORK"
./configure "${FFMPEG_CONFIGURE_FLAGS[@]}" \
    --target-exec="$HERE/kandelo-target-exec.sh" --samples="$SAMPLES"
make -j"$(getconf _NPROCESSORS_ONLN)"

# Not GROUPS: that is a bash special variable and ignores assignment.
mapfile -t FATE_GROUPS < <(grep -v '^\s*$' "$HERE/groups.txt")
# Fetch only the samples the chosen groups need is not supported by
# fate-rsync, so sync the suite once into the cache.
[ -d "$SAMPLES" ] || make fate-rsync SAMPLES="$SAMPLES"
( cd "$SAMPLES" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 ) > "$FATE_OUT/fate-samples.sha256"

set +e
make -k "${FATE_GROUPS[@]}" SAMPLES="$SAMPLES" 2>&1 | tee "$FATE_OUT/fate.log"
set -e

run=$(grep -c '^TEST ' "$FATE_OUT/fate.log" || true)
node -e '
  const fs=require("fs"); const log=fs.readFileSync(process.argv[1],"utf8");
  const failed=[...new Set([...log.matchAll(/\[[^\]]*?(fate-[\w.-]+)\] Error/g)].map(m=>m[1]))].sort();
  fs.writeFileSync(process.argv[2], JSON.stringify({groups:process.argv.slice(4), run:Number(process.argv[3]), failed}, null, 2)+"\n");
  console.log(`FATE: ${process.argv[3]} run, ${failed.length} failed`); process.exit(failed.length?1:0);
' "$FATE_OUT/fate.log" "$FATE_OUT/fate-report.json" "$run" "${FATE_GROUPS[@]}"
```

Note: FATE also runs helper programs built for the target (for example `libavutil/tests/*`); they go through the same wrapper. Host-side helpers (built with the host compiler, such as `tests/tiny_psnr`) run natively — that is FATE's design, not a bypass.

- [ ] **Step 7: Run FATE.**

```bash
scripts/dev-shell.sh bash -c 'bash packages/registry/ffmpeg/test/fate/run-fate.sh' 2>&1 | tail -5
```

Expected first time: failures. Triage **every** failed test per spec §4: a Kandelo gap (ledger + protocol), an upstream defect (patch per §4 test), or a test that is inherently host-specific (record why in the ledger with the maintainer's agreement). Commit `fate-samples.sha256` next to `groups.txt` as the pinned sample manifest once the run is green. Record the final `run`/`failed` counts in the ledger.

- [ ] **Step 8: Amend the FATE scripts and sample manifest into the package commit.**

---

### Task 9: Browser delivery and browser checks

**Files:**
- Modify: `packages/registry/shell/package.toml` (`depends_on`: add `"ffmpeg@9.0"`)
- Modify: `packages/registry/shell/source-rootfs-shell-dependencies.json` (add `{ "name": "ffmpeg", "version": "9.0", "role": "lazy-file" }` after `sqlite-cli`)
- Modify: `images/vfs/lib/init/shell-binaries.ts` (`SHELL_LAZY_BINARY_SPECS`)
- Modify: `apps/browser-demos/lib/init/shell-lazy-files.ts`
- Modify: `packages/registry/shell/source-rootfs-shell-demo-profiles.json` (two test profiles)
- Modify: `tests/package-system/source-rootfs-shell-bridge.test.ts`
- Create: `apps/browser-demos/test/kandelo-ffmpeg.spec.ts`

Delivery is per-binary lazy files, the way `git` ships `git.wasm` and `git-remote-http.wasm`; this is what the spec calls "lazy archive in the shell product".

- [ ] **Step 1: Register the lazy binaries.** In `images/vfs/lib/init/shell-binaries.ts`:

```ts
  { id: "ffmpeg", resolverPath: "programs/ffmpeg/ffmpeg.wasm", vfsPath: "/usr/bin/ffmpeg", symlinks: ["/bin/ffmpeg"] },
  { id: "ffprobe", resolverPath: "programs/ffmpeg/ffprobe.wasm", vfsPath: "/usr/bin/ffprobe", symlinks: ["/bin/ffprobe"] },
  { id: "ffplay", resolverPath: "programs/ffmpeg/ffplay.wasm", vfsPath: "/usr/bin/ffplay", symlinks: ["/bin/ffplay"] },
```

In `apps/browser-demos/lib/init/shell-lazy-files.ts`:

```ts
import ffmpegWasmUrl from "@binaries/programs/wasm32/ffmpeg/ffmpeg.wasm?url";
import ffprobeWasmUrl from "@binaries/programs/wasm32/ffmpeg/ffprobe.wasm?url";
import ffplayWasmUrl from "@binaries/programs/wasm32/ffmpeg/ffplay.wasm?url";
// …in SHELL_LAZY_ASSET_URLS:
  ffmpeg: ffmpegWasmUrl,
  ffprobe: ffprobeWasmUrl,
  ffplay: ffplayWasmUrl,
```

- [ ] **Step 2: Add two presentation profiles** (not added to the gallery roster) to `source-rootfs-shell-demo-profiles.json`, so the framebuffer and KMS panes exist:

```json
    "ffmpeg-fbdev": {
      "identity": { "title": "FFmpeg to /dev/fb0", "summary": "FFmpeg drawing a test pattern into the framebuffer with audio on /dev/dsp.", "accent": "#2e7d32", "glyph": "F", "packages": ["ffmpeg@local", "bash@local", "coreutils@local"] },
      "runtime": { "features": ["framebuffer"] },
      "init": { "shellCommand": "/usr/bin/ffmpeg -nostdin -re -f lavfi -i testsrc=duration=60:size=320x240:rate=10 -f lavfi -i sine=duration=60 -map 0:v -pix_fmt bgra -f fbdev /dev/fb0 -map 1:a -f oss /dev/dsp" },
      "presentation": { "bootPrimary": "syslog", "runningPrimary": ["framebuffer", "terminal", "syslog"], "terminalAccess": "drawer", "internalsAccess": "drawer" }
    },
    "ffplay": {
      "identity": { "title": "ffplay", "summary": "ffplay showing a test pattern through SDL2 on /dev/dri/card0.", "accent": "#1565c0", "glyph": "P", "packages": ["ffmpeg@local", "bash@local", "coreutils@local"] },
      "runtime": { "features": ["kms"] },
      "init": { "shellCommand": "/usr/bin/ffplay -autoexit -f lavfi testsrc=duration=60:size=320x240:rate=10[out0];sine=duration=60[out1]" },
      "presentation": { "bootPrimary": "syslog", "runningPrimary": ["kms", "terminal", "syslog"], "terminalAccess": "drawer", "internalsAccess": "drawer" }
    }
```

If `shellCommand` is executed without a shell (check how the quake profile's `/usr/local/bin/quake` is launched in `images/vfs/scripts/build-source-rootfs-shell-image.ts`), the `[out0];…` graph needs quoting; confirm and adjust.

- [ ] **Step 3: Extend `tests/package-system/source-rootfs-shell-bridge.test.ts`** following the quake additions from commit `d4d691782` (`git show d4d691782 -- tests/package-system/source-rootfs-shell-bridge.test.ts`): assert the three lazy specs are present and that `resolveDemoInit(demo!, "ffmpeg-fbdev")` and `resolveDemoInit(demo!, "ffplay")` return the commands above. Run it; expected to fail before steps 1–2 and pass after.

- [ ] **Step 4: Write `apps/browser-demos/test/kandelo-ffmpeg.spec.ts`.**

```ts
import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gotoMachine, gotoMachineOrSkip } from "./support/kandelo-machine";
import { runTerminalCommand } from "./support/terminal-command";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(__dirname, "../../../packages/registry/ffmpeg/test/fixtures");
const ACCEPTANCE = process.env.KANDELO_FFMPEG_ACCEPTANCE === "1";

/** In acceptance runs an unavailable machine is a failure, not a skip. */
function open(page: Page, profile: string): Promise<void> {
  return ACCEPTANCE ? gotoMachine(page, profile) : gotoMachineOrSkip(page, profile);
}

function distinctColors(canvas: Locator): Promise<number> {
  return canvas.evaluate((el: HTMLCanvasElement) => {
    const ctx = el.getContext("2d");
    if (!ctx) return 0;
    const { data } = ctx.getImageData(0, 0, el.width, el.height);
    const seen = new Set<number>();
    for (let i = 0; i < data.length; i += 4) {
      seen.add((data[i] << 16) | (data[i + 1] << 8) | data[i + 2]);
      if (seen.size > 8) break;
    }
    return seen.size;
  });
}

test("ffmpeg encodes and decodes bit-exactly in a browser machine", async ({ page }) => {
  test.setTimeout(600_000);
  await open(page, "shell");
  const enc = await runTerminalCommand(page,
    "ffmpeg -nostdin -v error -f lavfi -i testsrc=duration=2:size=176x144:rate=10 " +
    "-threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 -flags +bitexact -fflags +bitexact -f framecrc -");
  expect(enc.exitCode, enc.output).toBe(0);
  expect(enc.output.trim()).toBe(readFileSync(join(FIXTURES, "fixture.browser-encode.framecrc"), "utf8").trim());

  const dec = await runTerminalCommand(page,
    "ffmpeg -nostdin -v error -f lavfi -i testsrc=duration=2:size=176x144:rate=10 " +
    "-threads 1 -c:v mpeg4 -q:v 5 -g 5 -bf 1 -flags +bitexact -fflags +bitexact " +
    "-f mp4 -movflags frag_keyframe+empty_moov pipe:1 | " +
    "ffmpeg -nostdin -v error -threads 1 -i pipe:0 -map 0:v -flags +bitexact -fflags +bitexact -f framecrc -");
  expect(dec.exitCode, dec.output).toBe(0);
  expect(dec.output.trim()).toBe(readFileSync(join(FIXTURES, "fixture.video.framecrc"), "utf8").trim());
});

test("ffmpeg draws into the framebuffer pane", async ({ page }) => {
  test.setTimeout(600_000);
  await open(page, "ffmpeg-fbdev");
  const canvas = page.locator("canvas.kframebuffer-canvas").first();
  await expect(canvas).toBeVisible({ timeout: 300_000 });
  await canvas.click(); // audio-autoplay gesture
  await expect.poll(() => distinctColors(canvas), { timeout: 240_000 }).toBeGreaterThan(8);
});

test("ffplay shows video in the KMS pane", async ({ page }) => {
  test.setTimeout(600_000);
  await open(page, "ffplay");
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible({ timeout: 300_000 });
  await canvas.click();
  // Same gate as kandelo-modeset.spec.ts: a blank pane screenshot is tiny.
  await expect.poll(async () => (await canvas.screenshot()).byteLength,
    { timeout: 240_000, intervals: [1_000, 2_000, 5_000] }).toBeGreaterThan(5_000);
});
```

The "decodes" half is valid because encoding with identical parameters produces the identical MPEG-4 bitstream as the committed fixture's video stream; if that equality ever fails while the encode framecrc passes, the decode path (not the encoder) differs.

- [ ] **Step 5: Build the browser assets and run.** Provisioning per memory "browser-app fresh-worktree provision": musl submodule → sysroots → `npm install` → `./run.sh prepare-browser`. Then:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test test/kandelo-ffmpeg.spec.ts --reporter=list'
```

Run without the source-only environment variable (memory: Playwright source-only env trap), and read the per-test list: all 3 must say passed, not skipped. Then run `./run.sh browser --port <free port> --strictPort`, open the `ffplay` and `ffmpeg-fbdev` profiles, and **listen**: record in the ledger whether audio plays (DoD 3).

- [ ] **Step 6: Commit** below the package commit only if it contains platform fixes; the delivery and test changes themselves go into the package commit (amend) since they depend on it.

---

### Task 10: SIMD benchmark

**Files:**
- Create: `packages/registry/ffmpeg/test/bench/simd-bench.sh`
- Modify: ledger (results section)

- [ ] **Step 1: Build a no-SIMD variant** in a kept tree: same `target` flags but `--extra-cflags` without `-msimd128` and with `--disable-simd128`. This is a measurement build only; never installed.

- [ ] **Step 2: Write `simd-bench.sh`.**

```bash
#!/usr/bin/env bash
# Decode-time comparison of two ffmpeg.wasm builds (with/without simd128)
# on Node. Results are bounded to FFmpeg decode on these inputs.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../../../.." && pwd)"
WITH="$1"; WITHOUT="$2"; INPUT="$3"; RUNS="${RUNS:-5}"
for label in with without; do
  bin=$([ $label = with ] && echo "$WITH" || echo "$WITHOUT")
  for i in $(seq "$RUNS"); do
    s=$EPOCHREALTIME
    node --experimental-wasm-exnref --import tsx/esm "$REPO_ROOT/examples/run-example.ts" "$bin" \
      -nostdin -v error -threads 1 -i "$INPUT" -map 0:v -f null - >/dev/null
    e=$EPOCHREALTIME
    echo "$label,$i,$(awk -v a="$s" -v b="$e" 'BEGIN{printf "%.3f", b-a}')"
  done
done
```

- [ ] **Step 3: Run on Node** with two inputs: Big Buck Bunny (H.264) and one HEVC sample from the FATE cache (pick one under `$KANDELO_FATE_SAMPLES/hevc-conformance/`; record its path and sha256). `RUNS=5 bash packages/registry/ffmpeg/test/bench/simd-bench.sh <with> <without> <input>`.

- [ ] **Step 4: Run in the browser.** The browser loads the package output, so each variant must be the resolved package build in turn:
  1. With the normal package built, `./run.sh prepare-browser`, start `./run.sh browser --port <free> --strictPort`, open the `shell` machine, and run each decode 5 times as `time ffmpeg -nostdin -v error -threads 1 -i <input> -map 0:v -f null -` (fetch the inputs into the machine with `curl` from a local static server you start for this, and record their sha256 inside the machine with `sha256sum`).
  2. Perturb, don't check out (memory: perturb without git checkout): `cp packages/registry/ffmpeg/configure-flags.sh /tmp/cf.bak`, remove `-msimd128` and add `--disable-simd128`, rebuild with `cargo xtask build-deps resolve ffmpeg`, record the cache key it reports, `./run.sh prepare-browser`, repeat the runs.
  3. Restore: `cp /tmp/cf.bak packages/registry/ffmpeg/configure-flags.sh`, confirm `git diff --quiet -- packages/registry/ffmpeg`, rebuild, and confirm the cache key matches the original.

- [ ] **Step 5: Report** in the ledger's results section: per input and host, the median and spread for each build, the ratio, and the statement "bounded to FFmpeg decode of these inputs". Report whatever the numbers show (DoD 8).

---

### Task 11: Acceptance run, docs, and finishing the PR

**Files:**
- Create: `packages/registry/ffmpeg/test/run-acceptance.sh`
- Modify: `docs/porting-guide.md` (a short FFmpeg note under porting examples: `--arch=wasm --target-os=none`, never `--disable-asm`, `--disable-autodetect` needs `--enable-pthreads`)
- Modify: ledger (final status), `packages/registry/ffmpeg/package.toml` (`kernel_abi` check)

- [ ] **Step 1: Write `run-acceptance.sh`.**

```bash
#!/usr/bin/env bash
# The FFmpeg acceptance run (spec §2, §8). Skips are failures here.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"
export KANDELO_FFMPEG_ACCEPTANCE=1
cd "$REPO_ROOT/host"
npx vitest run --reporter=verbose \
  ../packages/registry/ffmpeg/test/fixtures-manifest.test.ts \
  ../packages/registry/ffmpeg/test/ffmpeg-tier1.test.ts \
  ../packages/registry/ffmpeg/test/ffmpeg-process-runtime.test.ts \
  ../packages/registry/ffmpeg/test/ffmpeg-tier2-bbb.test.ts \
  ../packages/registry/ffmpeg/test/ffmpeg-devices.test.ts 2>&1 | tee /tmp/ffmpeg-acceptance-node.log
grep -qE '\b(skipped|todo)\b' /tmp/ffmpeg-acceptance-node.log && { echo "acceptance: a test was skipped" >&2; exit 1; }
cd "$REPO_ROOT"
bash packages/registry/ffmpeg/test/fate/run-fate.sh
cd "$REPO_ROOT/apps/browser-demos"
npx playwright test test/kandelo-ffmpeg.spec.ts --reporter=list 2>&1 | tee /tmp/ffmpeg-acceptance-browser.log
grep -q ' skipped' /tmp/ffmpeg-acceptance-browser.log && { echo "acceptance: a browser test was skipped" >&2; exit 1; }
echo "acceptance: all tiers ran and passed"
```

Check the vitest verbose reporter's actual wording for skipped tests (`↓` marker and/or the word "skipped" in the summary line) against one deliberately skipped run, and make the grep match it — a gate that cannot match is a false negative (memory: gate on exit codes, not greps).

- [ ] **Step 2: Run it** under `scripts/dev-shell.sh`. Save both logs; the PR's validation section quotes the per-test lists and FATE counts.

- [ ] **Step 3: Check the definition of done** (spec §2) item by item against the ledger. Every gap closed or deferral approved; `patches/` absent; conformance suites recorded per fix.

- [ ] **Step 4: Re-derive `kernel_abi`** from `crates/shared/src/lib.rs`; if a fix in this branch bumped the ABI, update `package.toml` and rebuild everything (memory: ABI bump invalidates all binaries).

- [ ] **Step 5: Write the porting-guide note and final PR description** (no hard wrap; `## Why`, `## What changed`, `## Validation`, the ledger summary). Force-push with `--force-with-lease`, confirm the PR is still open (`gh pr view --json state`), mark it ready only when the maintainer asks.

---

## Self-Review Notes

- **Spec coverage:** §2 DoD 1 → Tasks 2/7 (audits); 2 → Task 11 step 3; 3 → Tasks 3–5, 7–9, 11; 4 → Tasks 6, 7, 9; 5 → Task 11 step 1; 6 → Gap-Fix Protocol + Task 11; 7 → G5; 8 → Task 10. §4 → Gap-Fix Protocol. §5 → Task 2. §6 → Tasks 6–7, 9. §7 → Tasks 2–5, 7. §8 Tiers 1–3 → Tasks 3–5, 8; playback → Tasks 7, 9. §9 → G5, Task 10, ledger. §10 risks → ledger entries (size in Task 5, SDL render in Task 6, Node video in Task 7, FATE wrapper in Task 8).
- **Deliberate deviation from spec wording:** "lazy archive" is implemented as per-binary `lazy-file` entries, the pattern `git` uses for multiple programs.
- **Known discovery points, not placeholders:** the n9.0 tarball hash (Task 1 step 1), native exit statuses (Task 1 step 6), and the Node ffplay-video expectation (Task 7 step 3) are measured, with the exact command to measure each.
