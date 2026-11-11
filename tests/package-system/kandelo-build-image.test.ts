import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { LLVM_BINARY_TOOL_SPECS } from "../../images/vfs/lib/init/shell-binaries";
import {
  installGuestToolchain,
  installLlvmBinaryTools,
} from "../../images/vfs/scripts/build-kandelo-build-image";
import { writeVfsBinary } from "../../host/src/vfs/image-helpers";

const text = (value: string) => new TextEncoder().encode(value);
const unix = (mode: number) => ({ os: 3, attrs: (mode << 16) >>> 0 });

function sdkZip(): Uint8Array {
  return zipSync({
    "lib/": [new Uint8Array(0), unix(0o040755)],
    "lib/llvm/bin/clang": [text("clang bytes"), unix(0o100755)],
    "lib/kandelo/wasm32posix/sysroot/include/stdio.h": [text("stdio declarations"), unix(0o100644)],
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

function dependsOn(manifest: string): string[] {
  const text = readFileSync(new URL(`../../${manifest}`, import.meta.url), "utf8");
  const list = /^depends_on = \[([\s\S]*?)\]/m.exec(text)?.[1] ?? "";
  return [...list.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("kandelo-build-image package", () => {
  it("depends on the rootfs's packages and the guest toolchain", () => {
    // The image rebuilds the canonical rootfs with every output resident;
    // a package the rootfs gains must reach the image too.
    expect(dependsOn("packages/registry/kandelo-build-image/package.toml")).toEqual([
      ...dependsOn("packages/registry/rootfs/package.toml"),
      "kandelo-sdk-browser-bundle@21.1.7",
      "clang@21.1.7",
    ]);
  });
});

describe("installGuestToolchain", () => {
  it("expands the SDK archive under /usr with its modes and symlinks", () => {
    const fs = eagerRootfs();
    installGuestToolchain(fs, sdkZip());
    expect(new TextDecoder().decode(fs.readFile("/usr/lib/llvm/bin/clang"))).toBe("clang bytes");
    expect(fs.stat("/usr/lib/llvm/bin/clang").mode & 0o7777).toBe(0o755);
    expect(fs.stat("/usr/share/doc/README").mode & 0o7777).toBe(0o644);
    expect(fs.readlink("/usr/bin/cc")).toBe("wasm32posix-cc");
    expect(fs.isPathDeferred("/usr/lib/llvm/bin/clang")).toBe(false);
    expect(new TextDecoder().decode(fs.readFile("/usr/lib/kandelo/wasm32posix/sysroot/include/stdio.h"))).toBe("stdio declarations");
    expect(() => fs.stat("/usr/wasm32posix")).toThrow();
  });

  it("refuses a base image that still defers files", () => {
    const fs = eagerRootfs();
    fs.registerLazyFile("/bin/sed", "binaries/programs/wasm32/sed.wasm", 10, 0o755);
    expect(() => installGuestToolchain(fs, sdkZip())).toThrow(/\/bin\/sed/);
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

describe("installLlvmBinaryTools", () => {
  function clangOutputs(): string {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-clang-outputs-"));
    for (const spec of LLVM_BINARY_TOOL_SPECS) {
      writeFileSync(join(dir, basename(spec.resolverPath)), `${spec.id} bytes`);
    }
    return dir;
  }

  it("replaces the rootfs placeholders with the LLVM tools and their names", () => {
    const fs = eagerRootfs();
    // posix-utils-lite's stand-ins, as the eager rootfs installs them.
    for (const name of ["ar", "nm", "strip", "strings"]) {
      writeVfsBinary(fs, `/usr/bin/${name}`, text("posix-utils-lite"), 0o755);
    }
    const dir = clangOutputs();
    try {
      installLlvmBinaryTools(fs, dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    const read = (path: string) => new TextDecoder().decode(fs.readFile(path));
    expect(read("/usr/bin/ar")).toBe("llvm-ar bytes");
    expect(read("/usr/bin/ranlib")).toBe("llvm-ar bytes");
    expect(read("/usr/bin/nm")).toBe("llvm-nm bytes");
    expect(read("/usr/bin/strip")).toBe("llvm-objcopy bytes");
    expect(read("/usr/bin/strings")).toBe("llvm-strings bytes");
    expect(read("/usr/bin/llvm-readelf")).toBe("llvm-readobj bytes");
    expect(() => fs.lstat("/usr/bin/readelf")).toThrow();
    expect(read("/usr/bin/addr2line")).toBe("llvm-symbolizer bytes");
    expect(fs.readlink("/usr/bin/objdump")).toBe("/usr/bin/llvm-objdump");
    expect(fs.stat("/usr/bin/llvm-objdump").mode & 0o7777).toBe(0o755);
  });

  it("refuses to replace a base file that is not a named placeholder", () => {
    const fs = eagerRootfs();
    writeVfsBinary(fs, "/usr/bin/objdump", text("someone else's objdump"), 0o755);
    const dir = clangOutputs();
    try {
      expect(() => installLlvmBinaryTools(fs, dir)).toThrow(/\/usr\/bin\/objdump/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
