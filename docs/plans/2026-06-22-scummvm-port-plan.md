# ScummVM port to Kandelo — design + bring-up plan

**Status: scratch / findings doc (uncommitted).** Captured from a design
session on 2026-06-22. Not built, not scaffolded — this is the sketch a
future session implements. Brandon-style: design first, then impl PRs.

## TL;DR

- **ScummVM is a `kind = "program"` package depending on the existing
  `sdl2` library.** It needs **no new DRI/kernel phase** — it rides on the
  SDL2 port (roadmap item 5 / validation **milestone D**, **PR #709**,
  currently a draft) + ALSA (**PR #698**, open). It is a single fullscreen
  SDL2 + GLES2 + PCM-audio + mouse app — exactly the "milestone-D-class"
  category the SDL2 port was built to validate.
- **One binary runs the whole catalogue.** `--enable-engine=scumm`
  compiles *all* SCUMM versions v0–v8 into one `scummvm.wasm`; ScummVM
  auto-detects each game at runtime from its data files. "Run on demand"
  = swap the *data*, never the binary.
- **Goal corpus: the Monkey Island trilogy + Day of the Tentacle, on
  demand.** SCUMM versions: MI1 = **v5** (EGA floppy is v4), MI2 = **v5**,
  CoMI/MI3 = **v8**, DOTT = **v6**. (Note: v6 is DOTT/Sam&Max, *not* the
  first two Monkey Islands — a common mix-up.) All run on the one binary.
- **The real per-game gate is DATA, not the engine.** Use the repo's
  existing "fetch game data at page load, SHA-256-verified, Cache-API
  cached" pattern (the fbDOOM `doom1.wad` precedent — see
  `docs/browser-support.md` doom row). Game data stays *external* to the
  package archive.
- **Pivotal build decision:** the `sdl2` package is built
  `--disable-render` (no SDL 2D renderer), so ScummVM **must use its
  OpenGL graphics backend (GLES2)**, not the SurfaceSDL backend.

## §1. Why this needs no new DRI phase

ScummVM owns the whole screen and manages its own UI, so it skips the
compositor (item 7), `wpkdraw` (item 6), shell/panel (item 9), seat/
clipboard (item 8). It only consumes what SDL2-on-Kandelo already exposes:

| ScummVM needs | Provided by | Phase / PR |
|---|---|---|
| Fullscreen window + GLES2 blit | SDL2 → KMSDRM on `/dev/dri/card0` | item 5 / #709 |
| Audio (PCM SFX + music) | SDL2 audio → ALSA | item 4 / #698 |
| Keyboard | evdev `/dev/input/event0` | item 3 (landed) |
| **Mouse / pointer** (point-and-click) | evdev `/dev/input/event1` + Modeset pane `sendPointerAbs` peg-and-move | item 3 + #709 |
| Game data + saves | VFS (writable paths) | already there |
| C++ stdlib | `libcxx@21` (`libc++.a`+`libc++abi.a`, in build matrix) | already there |

Gates to land first: **#709 (SDL2)** merges (video/GLES2), **#698 (ALSA)**
merges (audio). Both can be spiked against *now* on their branches.

## §2. Package sketch

Layout:

```
packages/registry/scummvm/
├── package.toml          # recipe
├── build.toml            # publish state
├── build-scummvm.sh      # cross-compile + fork-scan + stage output + data dir
└── patches/              # wasm32 fixups discovered during the iterate-until-it-builds loop
```

`package.toml` (recipe):

```toml
kind = "program"
name = "scummvm"
version = "2.8.1"                      # pin a release tag
kernel_abi = 16                        # match ABI_VERSION at port time

depends_on = ["sdl2@2.30.0", "libcxx@21", "zlib@1.3.1", "libpng@1.6.43"]

[source]
url = "https://github.com/scummvm/scummvm/archive/refs/tags/v2.8.1.tar.gz"
sha256 = "..."                         # fill after first fetch

[license]
spdx = "GPL-3.0-or-later"
url = "https://github.com/scummvm/scummvm/blob/v2.8.1/COPYING"

[build]
script_path = "packages/registry/scummvm/build-scummvm.sh"

[[outputs]]
name = "scummvm"
wasm = "scummvm.wasm"
```

`build.toml` (publish state): mirror `packages/registry/sdl2/build.toml`
(`repo_url`, `commit`, `revision = 1`, `[binary].index_url` templating
`{abi}`).

`build-scummvm.sh` — ScummVM uses a **hand-written `./configure`** (NOT
autoconf), so overrides are direct var/flag, not `ac_cv_*`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/sdk/activate.sh"          # worktree-local SDK (CLAUDE.md)
command -v wasm32posix-c++ >/dev/null || { echo "ERROR: SDK not active"; exit 1; }

SDL2_PREFIX="${WASM_POSIX_DEP_SDL2_DIR:?}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:?}"
ZLIB_PREFIX="${WASM_POSIX_DEP_ZLIB_DIR:?}"
PNG_PREFIX="${WASM_POSIX_DEP_LIBPNG_DIR:?}"
SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"

# libc++ into sysroot, mirroring dinit/build-dinit.sh
install -D "$LIBCXX_DIR/lib/libc++.a"    "$SYSROOT/lib/libc++.a"
install -D "$LIBCXX_DIR/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"
cp -RL "$LIBCXX_DIR/include/c++/v1" "$SYSROOT/include/c++/v1"

# fetch+verify source (curl --retry…; shasum -c); untar into $SRC_DIR

cd "$BUILD_DIR"
SDL_CONFIG="$SDL2_PREFIX/bin/sdl2-config" \
CXX=wasm32posix-c++ \
CXXFLAGS="-O2 -fno-exceptions -fno-rtti -matomics -mbulk-memory \
          -I$SDL2_PREFIX/include -I$ZLIB_PREFIX/include -I$PNG_PREFIX/include" \
LDFLAGS="-L$SDL2_PREFIX/lib -L$ZLIB_PREFIX/lib -L$PNG_PREFIX/lib \
         -L$SYSROOT/lib -lc++ -lc++abi" \
"$SRC_DIR/configure" \
    --host=wasm32-unknown-linux-musl \
    --backend=sdl \
    --opengl-mode=gles2 \                # GLES2 output — NOT SurfaceSDL (sdl2 is --disable-render)
    --enable-static --disable-shared \
    --disable-all-engines --enable-engine=scumm \  # one engine, covers v0–v8
    --enable-zlib --enable-png \
    --disable-mt32emu --disable-fluidsynth \       # AdLib/OPL is built-in & stays; defer ROM/SoundFont MIDI
    --disable-freetype2 --disable-flac --disable-mad --disable-vorbis \
    --disable-debug --enable-release
make -j"$(nproc)"

# fork-scan: ScummVM core shouldn't fork/system/popen. PROVE it; only run
# scripts/run-wasm-fork-instrument.sh if a fork-like symbol is present.
install -D scummvm "$OUT/scummvm.wasm"
cp -R "$SRC_DIR/dists/engine-data" "$OUT/share/scummvm/"   # themes, gui-icons.dat
```

## §3. Key technical decisions (the ones that bite)

1. **OpenGL/GLES2 backend, not SurfaceSDL.** `sdl2` is `--disable-render`
   → `SDL_CreateRenderer`/`SDL_Texture` gone → ScummVM's SurfaceSDL
   manager won't work. Its OpenGL manager (`--opengl-mode=gles2`) draws
   via `SDL_GL_CreateContext` → GLES2, matching the playground's path.
   Load-bearing.
2. **Single-threaded.** `sdl2` is `--disable-pthreads`; ScummVM's mixer is
   pulled from SDL's audio callback, which the polling-audio patch pumps
   from the main loop. Confirm ScummVM isn't compiled `USE_THREADS`.
3. **`-fno-exceptions -fno-rtti`** (ScummVM's default) sidesteps the
   `-fwasm-exceptions`/exnref toolchain tail the SDL2 audit commit had to
   special-case.
4. **`--enable-engine=scumm` = all SCUMM versions.** No version selection;
   runtime auto-detect. One binary for MI1/MI2/MI3/DOTT/etc.
5. **Audio:** built-in **AdLib/OPL emulation** stays enabled (software, no
   ROMs/soundfont) → covers MIDI-era games (MI1/MI2/DOTT). MT-32 ROM +
   FluidSynth SoundFont MIDI deferred (each is more data/work). CoMI uses
   digital PCM (no MIDI) — already fine.
6. **`libGLESv2` stub will need extending** — sized for the playground;
   ScummVM's GL manager may call beyond it (same pattern as the
   playground's `glPixelStorei`/`glTexImage2D` additions).

## §4. The catalogue (one binary, runtime auto-detect)

| Game | SCUMM ver | Res | Cutscenes | Music | Speech | Port risk |
|---|---|---|---|---|---|---|
| Secret of Monkey Island (MI1) | v5 (EGA floppy v4) | 320×200 | scripted | iMUSE MIDI → AdLib | none (orig) | **low** |
| MI2: LeChuck's Revenge | v5 | 320×200 | scripted | iMUSE MIDI → AdLib | none (orig) | **low** |
| Day of the Tentacle (DOTT) | v6 | 320×200 | scripted | iMUSE MIDI → AdLib | PCM (talkie) | low |
| Curse of Monkey Island (CoMI/MI3) | **v8** | **640×480** | **SMUSH video** | digital PCM | PCM | **medium** |

Note: voice/HD remasters (2009/2010 Special Editions) are *different data*
ScummVM does not use — irrelevant here.

## §5. Data strategy — fetch on demand (the fbDOOM-WAD pattern)

Per `docs/browser-support.md`, fbDOOM fetches `doom1.wad` at page load
(SHA-256 verified, Cache API cached) — game data is NOT in the package
archive. Mirror per ScummVM game:

1. Launcher menu lists the games.
2. On select → fetch that game's zip (SHA-256 pinned), Cache-API cache,
   unzip (host-side JS or the `unzip` package) into `/home/games/<id>/`.
3. Launch the one `scummvm.wasm` with `--path=/home/games/<id>` (or add to
   ScummVM's own launcher GUI). Writable `scummvm.ini` + savegames in VFS.
4. Cached games launch instantly on revisit.
5. CORS: in-browser fetch from scummvm.org needs the repo CORS proxy
   (`VITE_CORS_PROXY_URL`) or a mirror — same as the DOOM WAD.

## §6. RESOLVED — which games are shippable (recorded 2026-06-22 from scummvm.org/demos)

All demos hosted on `https://www.scummvm.org/demos/` are **freely
redistributable** (that's the point of the page — direct public download),
so *licensing* is fine for every entry below. The real distinction is
**interactive/playable** vs **non-interactive/unsupported** — the latter
run as attract-mode showcases (or don't run), not as hands-on gameplay.

**Target catalogue (MI trilogy + DOTT):**

| Game | Demo(s) on page | Shippable? | Playable? |
|---|---|---|---|
| **MI1 — Secret of Monkey Island** | Amiga (EN); **DOS EGA (EN / DE)** | ✅ yes | ✅ **interactive** (use DOS EGA, SCUMM v4) |
| **MI2 — LeChuck's Revenge** | "DOS **Unsupported** Demo" (EN); "DOS **Non-Engine Slideshow**" (EN) | ⚠️ data is free, but… | ❌ **no clean playable engine demo** — one is unsupported, the other is a slideshow, not SCUMM gameplay |
| **MI3 — Curse of Monkey Island** | Windows **Large** (EN); Windows **Small** (EN) | ✅ yes | ✅ **interactive** (SCUMM v8, incl. SMUSH) |
| **DOTT — Day of the Tentacle** | DOS **Non-Interactive** (EN/DE/FR); Mac Non-Interactive (EN) | ✅ yes | ⚠️ **non-interactive only** — auto-play showcase, not hands-on |

**Other LucasArts SCUMM demos available (all freely shippable, mostly
interactive — good bring-up corpus):**

- **Sam & Max: Hit the Road** — DOS CD Demo (EN), DOS Demo (EN/DE) → **interactive**; plus non-interactive + WIP + Mac variants. (SCUMM v6, 320×200.)
- **Full Throttle** — DOS Demo (EN), Mac Demo (EN), Mac Trailer → **interactive** DOS demo. (SCUMM v7, SMUSH.)
- **The Dig** — DOS CD Demo (EN), Mac Demo (EN) → **interactive**. (SCUMM v7, SMUSH.)
- **Indiana Jones and the Fate of Atlantis** — multiple DOS demos (EN/JP), FM-Towns JP non-interactive, Mac → **interactive** DOS demos. (SCUMM v5, 320×200.)

**Verdict for the trilogy goal:**
- **MI1 ✅ and MI3 ✅** have shippable, *playable* demos → public-demo-ready.
- **MI2 ❌** has no clean playable ScummVM demo. For interactive MI2 you need
  **user-supplied data** (owned GOG/Steam/CD) → fine for a *personal/local*
  on-demand launcher, **not** a public shippable demo.
- **DOTT ⚠️** ships freely but only as a *non-interactive* showcase;
  interactive DOTT needs owned data.

**Best fully-shippable + fully-playable bring-up set:** MI1 (DOS EGA, v4/v5,
easy) → Sam & Max or Indy4 (v5/v6, easy) → **MI3/CoMI** (v8, the SMUSH/hi-res
showcase). MI2 and interactive DOTT are "bring-your-own-data" tier.

## §7. Risks, ranked

1. **Per-game data licensing/availability** (§6) — the only true blocker
   for a *public* demo; solved per-game by the demos page where a demo
   exists.
2. **SMUSH cutscene perf (CoMI only)** — single-threaded wasm software
   video decode at 640×480; gameplay smooth, cutscenes may stutter. The
   CoMI demo (includes the intro) is the perfect stress test.
3. **Continuous PCM audio under polling-audio** — underrun risk if a heavy
   frame (SMUSH) stalls the main loop.
4. **Absolute mouse precision** — point-and-click needs pixel-accurate
   cursor; the playground runs keyboard+wheel only (`{pointer:false}`) and
   leans on the Modeset pane's `sendPointerAbs`. #1 thing to verify.
5. **`.wasm` size** — large C++; even one engine may be multi-MB. Measure
   early.
6. **`./configure` host-detection** — ScummVM's hand-rolled configure
   probes the host; expect a few overrides (the SDL2 "iterate until it
   builds" loop).
7. **`libGLESv2` stub coverage** (§3.6).

## §8. Bring-up matrix (de-risk easy → hard, one binary)

1. **MI1 or MI2 (v5) or DOTT (v6) demo first** — 320×200, AdLib, no SMUSH —
   validates SDL2→GLES2→PCM audio→mouse cheaply.
2. **CoMI (v8) demo** — the hi-res + SMUSH + digital-audio showcase.
3. Same `scummvm.wasm`; only the fetched data changes.

## §9. Validation / test plan (per CLAUDE.md checklist)

- `cargo xtask build-deps resolve scummvm` builds clean through the graph.
- `host/test/scummvm.test.ts` (mirror `sdl2.test.ts`): boot, assert
  launcher renders (canvas PNG byte-variance), inject keys/pointer, clean
  exit.
- Kandelo preset (mirror `sdl2`/`modeset`): `features: ["kms"]`,
  `runShellCommand("/usr/local/bin/scummvm")`, dual-host.
- `./run.sh browser`: launcher → fetch a game → render + audio + mouse
  (item 6 browser verification).
- No `ABI_VERSION` bump (pure user-space package).

## §10. Rollout — Brandon-style PR breakdown

| PR | Scope |
|---|---|
| `pkg(scummvm): recipe + cross-compile (--enable-engine=scumm, GLES2)` | package files + build script + iterate-until-it-builds; produces `scummvm.wasm`; vitest boot/launcher render |
| `demo(scummvm): on-demand game-data fetch + Kandelo preset` | fetch-at-load (SHA-256 + Cache API + CORS proxy) + unzip-to-VFS + launcher menu + dual-host preset + browser-support.md row |
| (follow-up) `pkg(scummvm): libGLESv2 stub gaps + perf` | extend GL stub for ScummVM's calls; SMUSH/audio perf pass |

Depends on #709 + #698 landing first.
