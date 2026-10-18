import { readFileSync } from "node:fs";
import { tryResolveBinary } from "../src/binary-resolver";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import type { VfsImageFilesystem } from "../src/vfs/vfs-image-filesystem";
import { extractZipEntry, parseZipCentralDirectory } from "../src/vfs/zip";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

type Compositor = "cage" | "sway";

/** The card has a render node, so wlroots' automatic choice is its GLES2
 *  renderer, which draws through the host's WebGL2 bridge. The Node host
 *  has no WebGL2, so these sessions ask for the pixman renderer. */
export const WLROOTS_ENV = [
  "LIBSEAT_BACKEND=noop",
  "WLR_RENDERER=pixman",
  "XDG_RUNTIME_DIR=/tmp",
];

interface SessionFile {
  path: string;
  bytes: Uint8Array;
  mode: number;
}

function sessionArtifacts(compositor: Compositor) {
  return {
    program: tryResolveBinary(`programs/${compositor}/${compositor}.wasm`),
    xkb: tryResolveBinary(`programs/${compositor}/xkeyboard-config.zip`),
    quirks: tryResolveBinary(`programs/${compositor}/libinput-quirks.zip`),
  };
}

export function hasSession(compositor: Compositor): boolean {
  const { program, xkb, quirks } = sessionArtifacts(compositor);
  return !!program && !!xkb && !!quirks;
}

export function compositorBytes(compositor: Compositor): ArrayBuffer {
  const buf = readFileSync(sessionArtifacts(compositor).program!);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function unpackZip(fs: VfsImageFilesystem, root: string, zipPath: string): void {
  const zip = new Uint8Array(readFileSync(zipPath));
  for (const entry of parseZipCentralDirectory(zip)) {
    if (entry.isDirectory) continue;
    const target = `${root}/${entry.fileName}`;
    ensureDirRecursive(fs, target.slice(0, target.lastIndexOf("/")));
    writeVfsBinary(fs, target, extractZipEntry(zip, entry), 0o644);
  }
}

/** A machine root for a wlroots session: /tmp for the Wayland socket, the
 *  keymap rules and libinput quirks the compositor's libraries read, and
 *  `files`. */
export function sessionRootfs(
  compositor: Compositor,
  files: SessionFile[],
): Promise<Uint8Array> {
  const { xkb, quirks } = sessionArtifacts(compositor);
  const fs = KandeloImageFs.create();
  fs.mkdir("/tmp", 0o1777);
  for (const file of files) {
    ensureDirRecursive(fs, file.path.slice(0, file.path.lastIndexOf("/")));
    writeVfsBinary(fs, file.path, file.bytes, file.mode);
  }
  unpackZip(fs, "/usr/share/X11/xkb", xkb!);
  unpackZip(fs, "/usr/share/libinput", quirks!);
  return fs.saveImage();
}
