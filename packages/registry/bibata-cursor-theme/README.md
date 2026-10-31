# Bibata cursor runtime data

This package installs the unmodified compiled **Bibata Modern Ice 2.0.7**
Xcursor theme through the normal package/image path. It is data only: no
Wasm program, SVG renderer, `xcursorgen`, or additional host tool is built.
The default theme inherits Bibata at `/usr/share/icons/default/index.theme`.
Both wlroots compositor cursors and libwayland client cursors find it through
standard Xcursor lookup, including `default`, `left_ptr`, `text`, `pointer`,
resize, grab and animated wait aliases. No host cursor magnification is used.

The official [release asset](https://github.com/ful1e5/Bibata_Cursor/releases/tag/v2.0.7)
is the manifest-pinned source. Its SHA256 is
`a68cae60c4dc706350e194ebc91c5fe48bc7bc9d59e119555834a2a7ee5078ef`.
It contains 56 regular compiled cursor files and 89 relative aliases, each
with these real nominal image sizes: 16, 20, 22, 24, 28, 32, 40, 48, 56,
64, 72, 80, 88 and 96. The [upstream size inventory](https://github.com/ful1e5/Bibata_Cursor/blob/35ccfe209a808e40d6c2ca60a46cbe4faf68b690/README.md#cursor-sizes)
is checked against the actual Xcursor table of contents during packaging.

Abdulkaiz Khatri (ful1e5) designed the artwork. The package includes the exact
upstream GPLv3 text and a notice with the full pinned editable-artwork/build
source reference. Compiled cursor bytes, upstream names and alias targets are
unchanged. Only the standard default-theme inheritance file and distribution
license notices are added. `COPYING` was fetched from the pinned source
commit; its hash is recorded in `NOTICE`.

`pack-theme.py` validates the binary Xcursor header, all image table/chunk
entries, dimensions, hotspots, size inventory and alias containment before
creating a deterministic ZIP. File sizes are bounded at 16 MiB, the complete
uncompressed theme at 64 MiB, image dimensions at 96 and TOC entries at 4096.
The current ZIP is roughly 4.5 MB, with 28.1 MB of uncompressed file bytes;
it is lazy data in the canonical shell, loaded through normal archive reads.
The archive root is mounted at `/usr/share/`, so artwork appears beneath
`icons/` and attribution beneath `licenses/bibata-cursor-theme/`.

At the compositor default of 24 logical pixels, 2x outputs select real48
images. Requested72/96 images exceed Kandelo's truthful64 hardware-cursor
capability. wlroots must use its ordinary software fallback there; the data
package does not enlarge the hardware contract. Native loader controls alone
do not establish guest rendering or that software fallback's acceptance.

## Focused validation

Prepare the pinned source archives (without building packages), then run in
the declared dev shell:

```sh
scripts/dev-shell.sh python3 packages/registry/bibata-cursor-theme/pack-theme.py \
  /path/to/verified/Bibata-Modern-Ice /path/to/new/theme.zip
scripts/dev-shell.sh bash packages/registry/bibata-cursor-theme/tests/check-theme-loaders.sh \
  /path/to/wlroots-0.20.2 /path/to/wayland-1.24.0 \
  /path/to/theme.zip /path/to/fresh/control-directory
```

The control compiles the actual pinned wlroots and libwayland Xcursor file
parsers. It mounts the produced ZIP as a native tree with the real relative
symlinks, resolves `default` inheritance and checks every cursor name/alias
at24/48/64/72/96, plus nearest-size selection at25. Empty theme roots must
fail in both parsers. The package also validates every compiled image frame,
including its hotspot bounds; no generated substitute bitmap is tested.

Normal package and shell rebuilds, Node sessions, three-engine DPR1/2/3
cursor and Cage-scale checks, >64 software cursor rendering, hotspot/click
geometry, and combined browser-memory cycles remain required. Source controls
are not evidence that the rebuilt Kandelo desktop already renders correctly.
