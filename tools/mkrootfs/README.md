# mkrootfs

CLI for building, inspecting, extracting, and augmenting kandelo
VFS rootfs images.

## Usage

```
mkrootfs build   <manifest> <sourceTree> -o <image>
mkrootfs build   <manifest> <sourceTree> -o <image> --kernel-abi <n>
mkrootfs inspect <image> [--metadata]
mkrootfs extract <image> <outDir>
mkrootfs add     <image> <path> <src> [--mode=0644] [--uid=0] [--gid=0]
```

Run via `npx tsx tools/mkrootfs/src/index.ts ...` from the repo root, or
install the bin shim with `npm install` and invoke `mkrootfs ...`.

## ZIP archive ingestion

Every manifest node path must be a canonical absolute POSIX path. `mkrootfs`
rejects repeated separators plus `.` and `..` components instead of allowing
SharedFS to resolve a spelling that validation did not inspect.

`archive` manifest entries accept canonical relative POSIX member paths. The
builder rejects absolute paths, backslashes, NUL bytes, empty components, and
`.` or `..` components rather than normalizing archive input into a different
VFS path. The `base` mount point must likewise be a canonical absolute POSIX
path. The builder also rejects file-type collisions and members nested below
an archive file or symlink before writing any filesystem state.

ZIP member names must be valid UTF-8 that round-trips to the exact central
directory bytes. Lossy replacement-character decoding is rejected.

Unix ZIP symlinks are stored as VFS symlinks. Their target payload must be
non-empty, NUL-free, valid UTF-8 that round-trips to the original bytes. The
target itself is preserved verbatim, so relative targets such as
`../../shared/curl` retain their POSIX resolution semantics. Archive `uid` and
`gid` apply to links; symlink permissions use the VFS's fixed `0777` mode.
