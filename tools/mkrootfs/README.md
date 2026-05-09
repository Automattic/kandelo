# mkrootfs

CLI for building, inspecting, extracting, and augmenting wasm-posix-kernel
VFS rootfs images.

## Usage

```
mkrootfs build   <sourceTree> <manifest> -o <image>
mkrootfs inspect <image>
mkrootfs extract <image> <outDir>
mkrootfs add     <image> <path> <src> [--mode=0644] [--uid=0] [--gid=0]
```

Run via `npx tsx tools/mkrootfs/src/index.ts ...` from the repo root, or
install the bin shim with `npm install` and invoke `mkrootfs ...`.

## Status

Scaffold only. Subcommands print "not yet implemented" — manifest parser,
image builder, and per-command logic land in subsequent tasks of the
"VFS source of truth" PR series.
