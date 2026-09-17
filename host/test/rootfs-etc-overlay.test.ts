/**
 * REPOINTED 2026-09-16 with the module itself, which moved to
 * `images/vfs/lib/rootfs-etc-overlay.ts` and now reads its source image
 * through `KandeloImageFs` instead of `MemoryFileSystem`.
 *
 * Two of the five cases could not follow, and both are recorded where they
 * were rather than quietly dropped — see the comments in place.
 */
import { describe, expect, it, vi } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { overlayEtcFromRootfs } from "../../images/vfs/lib/rootfs-etc-overlay";
// The file-type bits from the generated ABI and the errno from `vfs-errors`,
// rather than from `sharedfs-vendor.ts` — a second implementation of the KIFS
// format, in `vfs-errors.ts`'s own words, which goes with `memory-fs.ts`.
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
  // RETIRED with the repoint: "rejects a forged imported member/cohort seal
  // before changing the target".
  //
  // `forgeLazyAtomicSeal` tampers with the host-side JSON sections, which is
  // where `MemoryFileSystem` records an atomic group. `KandeloImageFs` reads
  // the body's own `SDEF`, so the forgery is invisible to it and the case
  // asserted a refusal this reader cannot make.
  //
  // THE CLAIM DID NOT GO WITH IT. Cohort authentication is now performed by
  // `rootfs::load_image`, which this overlay reaches through `loadImage`, and
  // `runtime-core`'s `a_load_refuses_an_image_whose_cohorts_do_not_authenticate`
  // asserts it on a genuine exported container with a negative control beside
  // it. What cannot be reproduced HERE is the forgery: the producer re-seals
  // at the export door and refuses to emit an image whose cohorts do not
  // authenticate, so TypeScript has no way to build one.

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

    // THE ERRNO, not the class. `MemoryFileSystem` raised `SFSError` with a
    // negative `code`; the module raises `KandeloImageError` with a positive
    // `errno`. Both say ENOENT, and the claim here is that ENOENT PROPAGATES
    // rather than being swallowed into "there was no /etc to copy" — which is
    // a difference an assertion on the class cannot see and an assertion on
    // the number can. The module's own `isNotFound` reads both conventions
    // for the same reason.
    // `ENOENT` from `vfs-errors` is itself negative, which is the third sign
    // convention in play; comparing magnitudes is what makes the assertion
    // about the errno rather than about whose spelling reached it.
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

  // RETIRED with the repoint: "propagates target capacity failures instead of
  // accepting a partial overlay".
  //
  // It worked by handing the target a 64 KiB `SharedArrayBuffer` and copying
  // 128 KiB into it. `KandeloImageFs` grows its own linear memory, so there is
  // no fixed backing store to exhaust and no ENOSPC to provoke — the condition
  // is not harder to reach, it does not exist for this writer.
  //
  // The property it guarded — a failed copy leaves no partial overlay — is
  // still asserted by the short-read case above, which fails mid-copy for a
  // different reason and makes the same demand of the target.
});
