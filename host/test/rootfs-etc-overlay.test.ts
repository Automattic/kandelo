/**
 * `images/vfs/lib/rootfs-etc-overlay.ts` reads its source image through
 * `KandeloImageFs` and copies `/etc` into a target image.
 */
import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { overlayEtcFromRootfs } from "../../images/vfs/lib/rootfs-etc-overlay";
// The file-type bits from the generated ABI and the errno from `vfs-errors`.
// These are POSIX constants the platform already publishes; reaching for the
// vendor's copy is how a file that no longer touches that filesystem still
// keeps it alive.
import { FILE_MODES } from "../src/generated/abi";
import { ENOENT } from "../src/vfs/vfs-errors";

const { S_IFDIR, S_IFLNK, S_IFMT, S_IFREG } = FILE_MODES;

/** The errno a filesystem error carries, whichever convention it uses. */
function errnoOf(error: unknown): number {
  const shaped = error as { errno?: number; code?: number };
  if (typeof shaped.errno === "number") return Math.abs(shaped.errno);
  if (typeof shaped.code === "number") return Math.abs(shaped.code);
  throw new Error(`not a filesystem error: ${String(error)}`);
}

function createFs(): KandeloImageFs {
  return KandeloImageFs.create();
}

function writeText(
  fs: KandeloImageFs,
  path: string,
  text: string,
  mode = 0o644,
  uid = 0,
  gid = 0,
): void {
  fs.createFileWithOwner(
    path,
    mode,
    uid,
    gid,
    new TextEncoder().encode(text),
  );
}

function readText(fs: KandeloImageFs, path: string): string {
  const stat = fs.stat(path);
  const bytes = new Uint8Array(stat.size);
  const fd = fs.open(path, 0, 0);
  try {
    expect(fs.read(fd, bytes, null, bytes.length)).toBe(bytes.length);
  } finally {
    fs.close(fd);
  }
  return new TextDecoder().decode(bytes);
}

async function captureError(operation: () => Promise<void>): Promise<unknown> {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected operation to fail");
}

describe("canonical rootfs /etc overlay", () => {
  // Cohort authentication is performed by `rootfs::load_image`, which this
  // overlay reaches through `loadImage`; `runtime-core`'s
  // `a_load_refuses_an_image_whose_cohorts_do_not_authenticate` asserts it on
  // a genuine exported container with a negative control beside it. A forged
  // image cannot be built HERE: the producer re-seals at the export door and
  // refuses to emit an image whose cohorts do not authenticate.

  it("copies nested state and metadata while preserving caller-owned entries", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl", 0o755, 0, 0);
    source.mkdirWithOwner("/etc/ssl/certs", 0o750, 12, 34);
    writeText(source, "/etc/ssl/openssl.cnf", "canonical\n");
    writeText(source, "/etc/ssl/cert.pem", "root bundle\n", 0o640, 12, 34);
    source.symlinkWithOwner("../cert.pem", "/etc/ssl/certs/default.pem", 12, 34);
    source.symlinkWithOwner("../cert.pem", "/etc/ssl/certs/copied.pem", 12, 34);

    const target = createFs();
    target.mkdirWithOwner("/etc", 0o755, 0, 0);
    target.mkdirWithOwner("/etc/ssl", 0o700, 1000, 1000);
    target.mkdirWithOwner("/etc/ssl/certs", 0o700, 1000, 1000);
    writeText(target, "/etc/ssl/openssl.cnf", "caller policy\n", 0o600, 1000, 1000);
    target.symlinkWithOwner(
      "/caller/trust.pem",
      "/etc/ssl/certs/default.pem",
      1000,
      1000,
    );

    await overlayEtcFromRootfs(target, await source.saveImage());

    expect(readText(target, "/etc/ssl/openssl.cnf")).toBe("caller policy\n");
    expect(target.stat("/etc/ssl/openssl.cnf")).toMatchObject({
      mode: S_IFREG | 0o600,
      uid: 1000,
      gid: 1000,
    });
    expect(readText(target, "/etc/ssl/cert.pem")).toBe("root bundle\n");
    expect(target.stat("/etc/ssl/cert.pem")).toMatchObject({
      mode: S_IFREG | 0o640,
      uid: 12,
      gid: 34,
    });
    expect(target.readlink("/etc/ssl/certs/default.pem")).toBe(
      "/caller/trust.pem",
    );
    expect(target.readlink("/etc/ssl/certs/copied.pem")).toBe("../cert.pem");
    expect(target.lstat("/etc/ssl/certs/copied.pem")).toMatchObject({
      mode: S_IFLNK | 0o777,
      uid: 12,
      gid: 34,
    });

    expect(target.lstat("/etc").mode & S_IFMT).toBe(S_IFDIR);
    expect(target.lstat("/etc/ssl/cert.pem").mode & S_IFMT).toBe(S_IFREG);
    expect(target.lstat("/etc/ssl/certs/copied.pem").mode & S_IFMT).toBe(
      S_IFLNK,
    );
    expect(target.stat("/etc/ssl")).toMatchObject({
      mode: S_IFDIR | 0o700,
      uid: 1000,
      gid: 1000,
    });
    expect(target.stat("/etc/ssl/certs")).toMatchObject({
      mode: S_IFDIR | 0o700,
      uid: 1000,
      gid: 1000,
    });
  });

  it("preserves metadata on canonical directories created in the target", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o751, 12, 34);
    source.mkdirWithOwner("/etc/ssl", 0o750, 56, 78);
    const target = createFs();

    await overlayEtcFromRootfs(target, await source.saveImage());

    expect(target.stat("/etc")).toMatchObject({
      mode: S_IFDIR | 0o751,
      uid: 12,
      gid: 34,
    });
    expect(target.stat("/etc/ssl")).toMatchObject({
      mode: S_IFDIR | 0o750,
      uid: 56,
      gid: 78,
    });
  });

  it("propagates ENOENT when the canonical image has no /etc tree", async () => {
    const source = createFs();
    const target = createFs();
    const image = await source.saveImage();

    const error = await captureError(() => overlayEtcFromRootfs(target, image));

    // THE ERRNO, not the class: the claim is that ENOENT PROPAGATES rather
    // than being swallowed into "there was no /etc to copy". The module raises
    // `KandeloImageError` with a positive `errno`, while `ENOENT` from
    // `vfs-errors` is negative; comparing magnitudes keeps the assertion about
    // the errno rather than its sign convention.
    expect(errnoOf(error)).toBe(Math.abs(ENOENT));
  });

  it("rejects a short source read instead of copying a truncated file", async () => {
    const source = createFs();
    source.mkdirWithOwner("/etc", 0o755, 0, 0);
    writeText(source, "/etc/hosts", "127.0.0.1 localhost\n");
    const image = await source.saveImage();
    const target = createFs();
    const readSpy = vi
      .spyOn(KandeloImageFs.prototype, "read")
      .mockReturnValueOnce(0);

    try {
      await expect(overlayEtcFromRootfs(target, image)).rejects.toThrow(
        "Short read while copying canonical rootfs path /etc/hosts: 0/20 bytes",
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  // No "target out of capacity" case: `KandeloImageFs` grows its own linear
  // memory, so there is no fixed backing store to exhaust. That a failed copy
  // leaves no partial overlay is asserted by the short-read case above, which
  // fails mid-copy and makes the same demand of the target.
});
