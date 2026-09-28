# Third-party vendored assets

Upstream files vendored once and shared by every in-tree consumer. Both
ship under permissive licenses compatible with this repo. Neither file is
modified from upstream.

Keep one copy here. A consumer that needs one of these references this
directory rather than vendoring its own — two byte-identical copies can
drift apart silently, and each one doubles the checkout.

## `stb_truetype.h`

- Upstream: <https://github.com/nothings/stb/blob/master/stb_truetype.h>
- Version: v1.26 (header self-reports the version at line 1).
- License: dual-licensed under MIT and public-domain Unlicense — see the
  trailing `ALTERNATIVE A` / `ALTERNATIVE B` license block in the file
  itself. We use the public-domain leg.
- Author: Sean Barrett / RAD Game Tools, 2009-2021.

`stb_truetype` is header-only. Each consumer defines
`STB_TRUETYPE_IMPLEMENTATION` in exactly one translation unit before
including it, so the implementation lands once per binary.

## `Inconsolata-Regular.ttf`

- Upstream: <https://github.com/google/fonts/tree/main/ofl/inconsolata>
- License: SIL Open Font License v1.1
  (<https://openfontlicense.org/open-font-license-official-text/>).
- Authors: Raph Levien with The Inconsolata Project Authors.

Inconsolata is a monospace face. Each consumer converts the TTF to a C byte
array at build time; the generated header is git-ignored, and this `.ttf`
is the source of truth.

We do not modify the font binary, so the SIL OFL reserved-name clause does
not apply. The OFL requires attribution wherever the font is distributed,
which this NOTICE provides.

## Consumers

**SDL2 GLSL playground** (`programs/sdl2/`). `renderer.c` defines
`STB_TRUETYPE_IMPLEMENTATION` and includes `stb_truetype.h` from this
directory. The package build (`packages/registry/sdl2-demo`) generates
`inconsolata_ttf.h` into its work directory; `scripts/build-programs.sh`
generates it into `programs/sdl2/third_party/` for the local fixture.

**wpkdraw** (`examples/libs/wpkdraw/`), the font engine behind `libkwl` and
the Wayland desktop's `wlterm`. `build.sh` generates
`build/wpk_stb_impl.c`, the one translation unit that defines
`STB_TRUETYPE_IMPLEMENTATION`, and generates `wpk_font_ttf.h` into
`examples/libs/wpkdraw/third_party/` whenever this `.ttf` is newer.
