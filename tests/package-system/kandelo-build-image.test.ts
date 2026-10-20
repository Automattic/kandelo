import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { installGuestToolchain } from "../../images/vfs/scripts/build-kandelo-build-image";
import { writeVfsBinary } from "../../host/src/vfs/image-helpers";

const text = (value: string) => new TextEncoder().encode(value);
const unix = (mode: number) => ({ os: 3, attrs: (mode << 16) >>> 0 });

function sdkZip(): Uint8Array {
  return zipSync({
    "lib/": [new Uint8Array(0), unix(0o040755)],
    "lib/llvm/bin/clang": [text("clang bytes"), unix(0o100755)],
    "share/doc/README": [text("readme"), unix(0o100644)],
    "bin/cc": [text("wasm32posix-cc"), unix(0o120777)],
    "bin/wasm32posix-cc": [text("#!/bin/sh\n"), unix(0o100755)],
  });
}

function eagerRootfs(): KandeloImageFs {
  const fs = KandeloImageFs.create();
  for (const dir of ["/bin", "/usr", "/usr/bin"]) fs.mkdir(dir, 0o755);
  writeVfsBinary(fs, "/usr/bin/make", text("make bytes"), 0o755);
  return fs;
}

describe("installGuestToolchain", () => {
  it("expands the SDK archive under /usr with its modes and symlinks", () => {
    const fs = eagerRootfs();
    installGuestToolchain(fs, sdkZip());
    expect(new TextDecoder().decode(fs.readFile("/usr/lib/llvm/bin/clang"))).toBe("clang bytes");
    expect(fs.stat("/usr/lib/llvm/bin/clang").mode & 0o7777).toBe(0o755);
    expect(fs.stat("/usr/share/doc/README").mode & 0o7777).toBe(0o644);
    expect(fs.readlink("/usr/bin/cc")).toBe("wasm32posix-cc");
    expect(fs.isPathDeferred("/usr/lib/llvm/bin/clang")).toBe(false);
  });

  it("refuses a base image that still defers files", () => {
    const fs = eagerRootfs();
    fs.registerLazyFile("/usr/bin/sed", "binaries/programs/wasm32/sed.wasm", 10, 0o755);
    expect(() => installGuestToolchain(fs, sdkZip())).toThrow(/\/usr\/bin\/sed/);
  });

  it("refuses an archive entry that would replace a base file", () => {
    const fs = eagerRootfs();
    const clash = zipSync({ "bin/make": [text("other"), unix(0o100755)] });
    expect(() => installGuestToolchain(fs, clash)).toThrow(/\/usr\/bin\/make/);
  });

  it("produces identical images from identical inputs", () => {
    const build = () => {
      const fs = eagerRootfs();
      installGuestToolchain(fs, sdkZip());
      fs.setExportTimestamp(1704067200_000);
      return fs.exportImage();
    };
    expect(build()).toEqual(build());
  });
});
