import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { buildSqliteTestVfsImage } from "../../images/vfs/scripts/build-sqlite-test-vfs-image";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { assertKandeloFilesystemLayout } from "../../images/vfs/scripts/filesystem-layout";

it("serializes the SQLite test work tree under /var with canonical tool paths", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kandelo-sqlite-layout-"));
  try {
    const source = join(directory, "source");
    const tcl = join(directory, "tcl");
    mkdirSync(join(source, "test"), { recursive: true });
    mkdirSync(tcl);
    writeFileSync(join(source, "test/layout.test"), "# upstream test fixture\n");
    writeFileSync(join(source, "discard.o"), "build output");
    writeFileSync(join(tcl, "init.tcl"), "# Tcl runtime fixture\n");
    const outputPath = join(directory, "sqlite-test.vfs.zst");
    // This is a layout test: empty Wasm modules stand in for program bytes.
    // Runtime execution belongs to the upstream SQLite suite.
    const program = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
    await buildSqliteTestVfsImage({
      sqlite3: program, testfixture: program, bash: program, coreutils: program,
      sqliteSourceDirectory: source, tclLibraryDirectory: tcl, outputPath,
    });
    const fs = KandeloImageFs.create();
    fs.loadImage(new Uint8Array(readFileSync(outputPath)));
    assertKandeloFilesystemLayout(fs);
    expect(new TextDecoder().decode(fs.readFile("/var/lib/kandelo-tests/sqlite/test/layout.test"))).toBe("# upstream test fixture\n");
    expect(fs.readlink("/var/lib/kandelo-tests/sqlite/testfixture")).toBe("/usr/bin/testfixture");
    expect(fs.readlink("/bin/sh")).toBe("/bin/bash");
    expect(fs.readlink("/usr/sbin/chroot")).toBe("/bin/coreutils");
    expect(fs.stat("/tmp").mode & 0o7777).toBe(0o1777);
    expect(() => fs.stat("/var/lib/kandelo-tests/sqlite/discard.o")).toThrow();
    expect(() => fs.stat("/sqlite")).toThrow();
    expect(() => fs.stat("/usr/bin/sh")).toThrow();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
