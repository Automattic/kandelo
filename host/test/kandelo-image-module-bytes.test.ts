import { describe, expect, it, vi } from "vitest";

/**
 * The module bytes a host installs once at boot.
 *
 * `create()` is synchronous — it instantiates a `WebAssembly.Module` and
 * returns a tree — while fetching an asset is not, so a browser cannot supply
 * the bytes at the call the way Node can. It installs them first, and
 * `installModuleBytes` refuses a SECOND, DIFFERENT module rather than swapping
 * it: two trees in one session built by different writers is not a state
 * anything downstream can notice, and it would surface much later as an
 * unreadable image.
 *
 * That refusal had no test. It is the third guard this lane has found untested
 * by sitting down to write its perturbation trial, after the 32-byte digest
 * length check and the `lazy_sha256=` format check.
 *
 * Each case re-imports the module through `vi.resetModules()`, because the
 * installed bytes are module-level state by design — one writer per session is
 * the property — so a test that installed real-looking bytes would change what
 * every later test in the process builds with.
 */
async function freshBridge() {
  vi.resetModules();
  return (await import("../../images/vfs/lib/kandelo-image-fs")).KandeloImageFs;
}

describe("the image writer is installed once per session", () => {
  it("refuses a second, different module rather than swapping it", async () => {
    const KandeloImageFs = await freshBridge();
    KandeloImageFs.installModuleBytes(new Uint8Array(64));
    expect(() => KandeloImageFs.installModuleBytes(new Uint8Array(128)))
      .toThrow(/already has module bytes installed and they differ/);
  });

  it("is idempotent for the same module, so two boots on a page are fine", async () => {
    const KandeloImageFs = await freshBridge();
    KandeloImageFs.installModuleBytes(new Uint8Array(64));
    expect(() => KandeloImageFs.installModuleBytes(new Uint8Array(64)))
      .not.toThrow();
  });

  it("names both sizes, so the report says which module disagreed", async () => {
    const KandeloImageFs = await freshBridge();
    KandeloImageFs.installModuleBytes(new Uint8Array(64));
    expect(() => KandeloImageFs.installModuleBytes(new Uint8Array(128)))
      .toThrow(/64 bytes vs 128/);
  });

  it("still reads from disk under Node when nothing was installed", async () => {
    // The Node path is what every build-time caller uses, and it must not be
    // disturbed by the existence of an install hook. A tree it can create is
    // the whole assertion.
    const KandeloImageFs = await freshBridge();
    const fs = KandeloImageFs.create();
    fs.mkdir("/probe", 0o755);
    expect(fs.lstat("/probe").mode & 0o7777).toBe(0o755);
  });
});
