# Retro console emulation as a shell-image machine — design

Date: 2026-09-30. Status: awaiting maintainer review.
Donor: branch `emdash/consider-video-game-emulators-3ksig` (52 commits,
forked at #853). This is a re-implementation against current main using the
donor as reference, not a rebase.

## Goal

Ship NES, SNES and Genesis/Mega Drive emulation as one Kandelo machine, with
bring-your-own ROMs, an Internet Archive ROM library, and shareable
checkpoints — without the browser app learning anything about emulators.

The governing rule, from review: **Kandelo has one way to do each thing.**
Where the donor added an emulator-specific path beside a platform one, this
design uses the platform path, and where the platform has none it adds a
general, image-declared one.

## Decisions already made

| Topic | Decision |
|---|---|
| Scope | Everything: emulator, ROM library, shared checkpoints |
| Shipping shape | A `retro` profile on the shell image (`browser-main-shell`), not a new product |
| Profiles | One `retro` profile, one gallery tile |
| Starter ROMs | Package runtime files, present in the image as lazy references |
| ROM library | Curated seeds plus open archive.org search; no licensing distinction |
| Ranged reads | `fetchByteRange` (#1425); no `If-Range`; strong-ETag comparison |
| Link trust | Ephemerality argument; consent required before persistent machines |
| `readFile` fix | Separate prerequisite PR |
| Delivery | One large PR for the rest |

## 1. Shipping shape

A `retro` entry in
`packages/registry/shell/source-rootfs-shell-demo-profiles.json`, beside
`doom`, `quake`, `modeset` and `scummvm`, and one line in
`gallery-roster.json`: `{ "product": "browser-main-shell", "profile": "retro" }`.

ScummVM is the template. Its engine and data files are lazy references in
the shell image, so a machine nobody opens costs the image a directory entry
per file and costs a visitor nothing. Wiring, all following that precedent:

- `packages/registry/shell/package.toml`,
  `source-rootfs-shell-dependencies.json`, `packages/sets/local-supported.toml`
- `images/vfs/lib/init/shell-binaries.ts` (lazy specs) and
  `apps/browser-demos/lib/init/shell-lazy-files.ts` (URL imports)
- `images/vfs/scripts/build-source-rootfs-shell-image.ts` (launchers written
  eagerly to `/usr/local/bin`, as for `quake` and `scummvm`)
- `web-libs/kandelo-session/src/demo-guides.ts`

Profile: `runtime.features: ["framebuffer"]`; presentation as Quake's
(`touchControls: true`); `init.shellCommand: "/usr/local/bin/retro-run"`;
`ingest` accepting `.nes .sfc .smc .bin .md .gen .smd .sms .gg .sg` to a fixed
`targetPath` with `onLoad.restart: "/usr/local/bin/retro-run"`.

Consequence to accept: the shell image's build now depends on three emulator
cores building. A broken core blocks the main image, not a side product.

## 2. Package and cores

`packages/registry/kandelo-retro/` plus source manifests
`genesis-plus-gx-source` and `snes9x-source`. One core-agnostic
`frontend/main.c` (~660 lines, ported from the donor) links three outputs:

| Output | Core (pinned) | Guest path |
|---|---|---|
| `kandelo-retro.wasm` | FCEUmm `0d610d9a6401` | `/usr/bin/kandelo-retro` |
| `kandelo-retro-genesis.wasm` | Genesis Plus GX `fa4dca561e08` | `/usr/bin/kandelo-retro-genesis` |
| `kandelo-retro-snes.wasm` | Snes9x `185488cd83aa` | `/usr/bin/kandelo-retro-snes` |

The frontend maps libretro onto device contracts Kandelo already has:
`/dev/fb0` (640×400 BGRA32, `mmap`), `/dev/dsp` (OSS S16_LE), MEDIUMRAW stdin
to `RETRO_DEVICE_JOYPAD`. No kernel or host change is expected. If a core
fails to build or run, that is platform feedback to trace, not something to
patch around in the package.

Everything is rebuilt against the current ABI (45 at time of writing; strict
equality means no donor artifact is reusable). Known build requirements,
carried from the donor script: build cores with the Kandelo SDK and
`platform=unix`, never emscripten; with `STATIC_LINKING=1` the frontend must
compile the libretro-common sources itself; Snes9x needs
`STATIC_LINKING_LINK=1`, `LTO=`, `make -C <core>/libretro` and C++ exception
flags; Genesis needs zlib declared as `zlib@<version>`. The script asserts
zero unresolved non-kernel imports, because the SDK links with
`--allow-undefined` and a missing symbol otherwise traps at run time and
reads as a segmentation fault.

License notices are copied into the package archive per output, as in the
donor's `LICENSE-MAP.md`.

## 3. Launcher: `/usr/local/bin/retro-run`

One launcher picks the core by **content**, then `exec`s it. It cannot use
the filename: `ingest.targetPath` is fixed and the schema guarantees the
uploaded name never reaches `onLoad.restart`.

| System | Offset | Signature |
|---|---|---|
| NES | `0x000` | `4e 45 53 1a` |
| Genesis / Mega Drive | `0x100` | `SEGA` |
| SMS / Game Gear | `0x1ff0`, `0x3ff0`, `0x7ff0` | `TMR SEGA` |
| SNES | `0x7fc0` / `0xffc0` (+512 with a copier header) | header checksum + complement = `0xffff` |

The NES, Mega Drive and SNES rows were checked against the three starter
ROMs with no cross-matches; the SMS/Game Gear row is from the format's
documentation and is untested until such a ROM is loaded. An
unrecognised file exits non-zero with a message on stderr, which the syslog
pane shows; it never falls through to an arbitrary core.

Selection order: a ROM named by the boot-input manifest (section 6.4), else
the ingested file at `targetPath` if present, else the default starter ROM.

## 4. Starter ROMs

Three GPL test suites, declared as `[[runtime_files]]` of `kandelo-retro` and
therefore present in the image as lazy references under
`/usr/share/kandelo-retro/roms/`. Only the ROM the emulator opens is fetched.

| File | Upstream | sha256 |
|---|---|---|
| `240pee.nes` | pinobatch/240p-test-mini v0.23 | `04f01d73…d2e62e` |
| `240pSuite-md-1.21.bin` | 240p Test Suite MD 1.21 | `1776009a…ebae28f` |
| `240pSuite-snes-1.03.sfc` | 240p Test Suite SNES 1.03 | `40491750…36c22a` |

The package build downloads each pinned upstream release and verifies the
extracted ROM's digest; nothing binary is committed. To confirm during
planning: that the package source schema can pin these extra downloads, and
each suite's redistribution terms from its own release (GitHub reports the
240pTestSuite repository license as unasserted).

## 5. ROM library

A pane that finds ROMs on the Internet Archive and hands them to the same
ingest path a dropped file uses.

**Image-declared, not app-declared.** The curated seeds, per-system search
clauses and bundled-ROM list live in the profile (`/etc/kandelo/demo.json`)
as a new optional `library` block, validated in
`web-libs/kandelo-session/src/demo-config.ts` with the caps the rest of that
schema uses. The app renders whatever a machine declares. No emulator table
exists in `apps/browser-demos`.

**Transport.** Search (`advancedsearch.php`) and metadata (`/metadata/<id>`)
are CORS-enabled and fetched directly, with bounded response sizes. File
bytes go through the CORS proxy. The download host is taken from metadata
(`d1`, `d2`, `dir`) so no request depends on the `/download/` redirect.

**ZIP contents.** No second ZIP reader. `host/src/vfs/zip.ts` already reads a
remote index by range with strong-ETag consistency and a whole-archive
fallback. It gains what the library needs:

- ZIP64 end-of-central-directory records and `0xffffffff` sentinels, with
  bounds checked before any offset arithmetic
- encrypted or unsupported-method entries listed as present but not
  extractable, instead of failing the index
- a hard cap on entries parsed

Member extraction is one ranged read of the local header plus data, inflated
with the existing `fflate` path, size-capped by `ingest.maxBytes`.

**Degradation.** Until the proxy's front end forwards `Range`, the
`x-cors-proxy-range` alias carries it. A `whole-entity` answer falls back to
a whole-file fetch only under a stated cap; above it the pane says the
archive is too large to open without ranged reads. Never a hang, never a
truncated index.

`rom-archive.ts` (discovery, bounded parsing) and `archive-browser.ts`
(pagination and drill-in state) land in `web-libs/kandelo-session`; nested
archives are limited to one level.

## 6. One way to load, read, capture and share

### 6.1 Loading a file: everything converges on ingest

A dropped file, the file picker, a library download and a bundled ROM all end
in the existing `demo-ingest` sequence: write `targetPath`, stop the owning
process, run `onLoad.restart`. The library and bundled sources are new
*inputs* to that function, not new code paths beside it. Ingest records the
provenance of what it wrote (`resolver` locator + digest, image path, or
none) so a later share knows whether the file can be named in a link.

### 6.2 Reading a guest file: the RPC, only (prerequisite PR)

`LiveKernelHost.readFile()` reads through `requireFs()`, the synchronous
main-thread VFS, which does not exist under kernel-owned filesystems.
`writeFile()` already uses the worker RPC and nothing else. The prerequisite
PR makes `readFile()` and `readFileText()` use `readFileFromVfs` — which both
hosts implement — as the single implementation, with a loud error if the
attached kernel lacks it. No "prefer one, fall back to the other".

To settle in that PR: the remaining `requireFs()` callers (directory listing
and `/proc` parsing). They are the same asymmetry; whether they move in the
same PR is the maintainer's call.

### 6.3 Capturing machine state: an image-declared `checkpoint`

The inverse of `ingest`. A profile may declare:

```json
"checkpoint": {
  "capture": { "argv": ["/usr/local/bin/retro-checkpoint"],
               "path": "/tmp/kandelo-retro.state", "maxBytes": 2097152 },
  "inputId": "state"
}
```

The host spawns `capture.argv`, waits for it to exit, and on status 0 reads
`path` (6.2) under `maxBytes`. Exit status is the completion signal; the host
polls nothing and injects no keystrokes. For this machine the helper asks the
running frontend to serialise (SIGUSR1; F5 remains as the in-emulator key),
and the frontend writes atomically by rename. Any machine can declare a
checkpoint; the app has no emulator-specific capture code.

### 6.4 Sharing: the Share dialog and boot inputs

One share surface (`ShareDialog`), one payload mechanism (`boot.inputs` +
`boot.parameters` on descriptor v1, from #1386), one guest-visible record
(`/run/kandelo/boot-input.json`).

- The state travels as an `inline` gzip input with the declared `inputId`,
  inside the existing 2 MiB inflated / 32 KiB carried caps. A state that does
  not fit fails the share with its real size, not silently.
- A library ROM travels as a `resolver` input. The registry #1386 left empty
  gains one resolver, `internet-archive`, whose locator is
  `{ item, file, member? }` — never a URL. It is registered by the app for
  every machine, and its bytes are verified against the descriptor's
  `byteLength` and `sha256` before anything is written, as all inputs are.
- A bundled ROM is named by a boot parameter; the launcher accepts it only
  if it resolves inside the package's ROM directory.
- A locally uploaded ROM has no shareable provenance. The dialog says so.

Restore needs no host logic: the launcher reads the manifest and starts the
right core with `--state`. `share-url*.ts`, `shared-boot-policy.ts`,
`boot-input-resolvers.ts` and `retro-save-state.ts` from the donor are not
ported.

### 6.5 Trust

Auto-booting a checkpoint link rests on the same argument as script links:
every machine is ephemeral, so a hostile link can only waste the visitor's
own tab. Data inputs are strictly less powerful than the scripts already
permitted, so no emulator-specific allowlist is added.

**Required before persistent machines** (recorded here and in the warning
comment at the link-execution site in `live-setup.ts`): an explicit consent
step before (a) running link-supplied content and (b) fetching third-party
bytes on the visitor's behalf. The second is new with the resolver: opening a
link causes a request to the Internet Archive that the visitor did not
initiate.

## 7. Testing

- Vitest: `zip.ts` ZIP64, bounds and unextractable-entry cases; archive
  discovery and bounded parsing; pagination state; `library` and `checkpoint`
  schema validation including rejections; resolver locator validation.
- Guest-level: launcher signature detection for each system and the
  unrecognised-file failure.
- Playwright: each core renders its suite and takes input; an ingested ROM
  switches cores; a library ROM loads; a checkpoint link restores. Serial
  workers; assert on the per-test list, not only the exit code.
- Manual: `./run.sh browser`, chromium and WebKit, before any "works" claim.
- Conformance suites are considered if any kernel, libc or host file changes.

## 8. Out of scope

A dedicated VFS product; per-system profiles; multi-range requests;
`If-Range`; nested archives beyond one level; a Kandelo-operated relay; a
consent UI (required before persistence, not built here); overlay snapshots
of the writable filesystem (`snapshot.ts` remains as it is).

## 9. Risks

1. Three cores against a moving ABI: each bump forces a full rebuild, and a
   bad link shows up as a run-time trap.
2. Archive search returns non-playable items; ranking will need iteration.
3. Production ranged reads depend on the proxy deployment; large archives
   stay capped until then.
4. The shell image's build gains three cores as dependencies.
5. `library` and `checkpoint` are new image schema. They are general by
   design, but this machine is their only consumer at first.
