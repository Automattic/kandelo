/**
 * The `[[runtime_files]]` a live demo installs beside a program's `.wasm`.
 *
 * A program package declares in its `package.toml` the non-Wasm files it needs
 * at runtime, each with the guest path and mode it must land on. The resolver
 * then mirrors the whole package closure — executable plus runtime files —
 * under `{local-,}binaries/programs/<arch>/<package>/`, so both halves carry
 * the same cache key, the same provenance root, and the same SourceOnly
 * projection. That mirror is the only admitted channel for a program's data
 * files; see docs/package-management.md.
 *
 * The browser app cannot run `xtask build-deps runtime-file-metadata` to read
 * those declarations, so it restates them here.
 * `tests/package-system/browser-binary-dependencies.test.ts` fails if a table
 * below drifts from the manifest it mirrors.
 */

export interface PackageRuntimeFile {
  /** Artifact path inside the package's resolver mirror directory. */
  artifact: string;
  /** Absolute path the manifest declares for it in a guest filesystem. */
  guestPath: string;
  /** Permission bits the manifest declares. */
  mode: number;
}

/**
 * ScummVM's GUI data. The launcher reads its theme, its game icons, and its
 * fonts from /usr/share/scummvm on startup; without them it falls back to a
 * compiled-in skin with no icons and a bitmap font.
 */
export const SCUMMVM_RUNTIME_FILES: readonly PackageRuntimeFile[] = [
  {
    artifact: "share/scummvm/scummremastered.zip",
    guestPath: "/usr/share/scummvm/scummremastered.zip",
    mode: 0o644,
  },
  {
    artifact: "share/scummvm/scummmodern.zip",
    guestPath: "/usr/share/scummvm/scummmodern.zip",
    mode: 0o644,
  },
  {
    artifact: "share/scummvm/scummclassic.zip",
    guestPath: "/usr/share/scummvm/scummclassic.zip",
    mode: 0o644,
  },
  {
    artifact: "share/scummvm/gui-icons.dat",
    guestPath: "/usr/share/scummvm/gui-icons.dat",
    mode: 0o644,
  },
  {
    artifact: "share/scummvm/fonts.dat",
    guestPath: "/usr/share/scummvm/fonts.dat",
    mode: 0o644,
  },
];
