# kandelo-retro license map

The `kandelo-retro` package archive contains three separately linked program
outputs and three starter ROMs. Its package-level license expression is the
aggregate of the labels below. The build copies the notice from each pinned
core source into the archive under the listed stable path.

| Output | Pinned core source | License label | Notice in package archive |
|---|---|---|---|
| `kandelo-retro.wasm` | [FCEUmm `0d610d9a6401`](https://github.com/libretro/libretro-fceumm/tree/0d610d9a6401697157f693a5407adf450a0e52fb) | `GPL-2.0-or-later` | `licenses/FCEUMM-COPYING.txt` |
| `kandelo-retro-genesis.wasm` | [Genesis Plus GX `fa4dca561e08`](https://github.com/libretro/Genesis-Plus-GX/tree/fa4dca561e08d5be9077419f7b255e1da213ed21) | `LicenseRef-Genesis-Plus-GX` | `licenses/GENESIS-PLUS-GX-LICENSE.txt` |
| `kandelo-retro-snes.wasm` | [Snes9x `185488cd83aa`](https://github.com/libretro/snes9x/tree/185488cd83aaf274752a742c94d45561cbecb7af) | `LicenseRef-Snes9x` | `licenses/SNES9X-LICENSE.txt` |

The shared Kandelo frontend is part of this repository and is labeled
`GPL-2.0-or-later`; see the repository `LICENSE` and `COPYING` files. The
upstream notice files copied into the archive remain the authoritative text
for their respective pinned core sources.

## Starter ROMs

Each ROM is installed unmodified from the upstream release named here and
checked against a pinned SHA-256 in `build-kandelo-retro.sh`. They are test
suites, not games: each exercises video, audio and input on its system.

| Runtime file | Upstream release | License label | Notice in package archive |
|---|---|---|---|
| `share/kandelo-retro/roms/240pee.nes` | [240p Test Suite for NES v0.23](https://github.com/pinobatch/240p-test-mini/releases/tag/v0.23) (Damian Yerrick and contributors) | `GPL-2.0-or-later` | upstream `LICENSE`; same text as `licenses/240P-TEST-SUITE-GPLv2.txt` |
| `share/kandelo-retro/roms/240pSuite-md-1.21.bin` | 240p Test Suite for Mega Drive 1.21 (Artemio Urbina and contributors), `240pSuite-GenesisMD-1.21.zip` | `GPL-2.0-only` | `licenses/240P-TEST-SUITE-GPLv2.txt` |
| `share/kandelo-retro/roms/240pSuite-snes-1.03.sfc` | 240p Test Suite for SNES 1.03 (Artemio Urbina and contributors), `240pSuite-SNES-1.03.zip` | `GPL-2.0-only` | `licenses/240P-TEST-SUITE-GPLv2.txt` |

The NES release is fetched by the build script because upstream publishes it
only as a bare file. The other two are `retro-rom-240p-md` and
`retro-rom-240p-snes`, source packages the resolver verifies.
