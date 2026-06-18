# Third-party vendored assets — SDL2 playground

Two files are vendored here for the editor implementation introduced in
Phase 4 of the GLSL playground. Both ship under permissive licenses
compatible with this repo. Neither file is modified from upstream.

## `stb_truetype.h`

- Upstream: <https://github.com/nothings/stb/blob/master/stb_truetype.h>
- Version: v1.26 (header self-reports the version at line 1).
- License: dual-licensed under MIT and public-domain Unlicense — see the
  trailing `ALTERNATIVE A` / `ALTERNATIVE B` license block in the file
  itself. We use the public-domain leg.
- Author: Sean Barrett / RAD Game Tools, 2009-2021.

`stb_truetype` is included as a header-only library. Exactly one
translation unit (`renderer.c`) defines `STB_TRUETYPE_IMPLEMENTATION`
before including the header so the implementation lands once.

## `Inconsolata-Regular.ttf`

- Upstream: <https://github.com/google/fonts/tree/main/ofl/inconsolata>
- License: SIL Open Font License v1.1
  (<https://openfontlicense.org/open-font-license-official-text/>).
- Authors: Raph Levien with The Inconsolata Project Authors.

The TTF is converted to a C byte array at build time by
`scripts/build-programs.sh` (which emits `inconsolata_ttf.h` next to
this file). The generated header is git-ignored — the `.ttf` is the
source of truth. To regenerate the header manually:

```bash
python3 - <<'PY'
import pathlib, textwrap
src = pathlib.Path("programs/sdl2/third_party/Inconsolata-Regular.ttf").read_bytes()
dst = pathlib.Path("programs/sdl2/third_party/inconsolata_ttf.h")
chunks = textwrap.wrap(",".join(f"0x{b:02x}" for b in src), width=88)
dst.write_text(
    "/* Auto-generated from Inconsolata-Regular.ttf — see NOTICE.md */\n"
    "#pragma once\n"
    f"static const unsigned char inconsolata_ttf[] = {{\n"
    + "\n".join(chunks) + "\n};\n"
    f"static const unsigned int inconsolata_ttf_len = {len(src)};\n"
)
PY
```

The SIL OFL requires that derived font files carry a reserved-name
clause; we do not modify the font binary, so no reserved-name handling
applies. The OFL also requires attribution wherever the font is
distributed, which this NOTICE provides.
