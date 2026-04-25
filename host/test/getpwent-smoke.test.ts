/**
 * End-to-end smoke test: the kernel reads /etc/passwd through the mount-
 * table → MemFsBackend → rootfs.vfs chain. Replaces the previous
 * kernel-side synthetic_file_content interception.
 *
 * The C program (examples/getpwent_test.c) exercises setpwent,
 * getpwent, getpwnam, getpwuid. This test asserts the output matches
 * rootfs/etc/passwd byte-for-byte (via the expected-entries list below).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const binary = join(__dirname, "../../examples/getpwent_test.wasm");

describe.skipIf(!existsSync(binary))("/etc/passwd via rootfs.vfs mount", () => {
  it("walks the passwd database and looks up root + user", async () => {
    const r = await runCentralizedProgram({
      programPath: binary,
      argv: ["getpwent_test"],
      timeout: 15_000,
    });

    expect(r.exitCode).toBe(0);

    // Walk: every entry the rootfs image declared.
    expect(r.stdout).toContain("ENT 0: name=root uid=0 gid=0 home=/root shell=/bin/sh");
    expect(r.stdout).toContain("ENT 1: name=daemon uid=1 gid=1 home=/usr/sbin shell=/usr/sbin/nologin");
    expect(r.stdout).toContain("ENT 2: name=user uid=1000 gid=1000 home=/home/user shell=/bin/sh");
    expect(r.stdout).toContain("ENT 3: name=nobody uid=65534 gid=65534 home=/nonexistent shell=/usr/sbin/nologin");
    expect(r.stdout).toContain("TOTAL 4");

    // Lookup by name.
    expect(r.stdout).toContain("BYNAME root: uid=0 shell=/bin/sh");
    expect(r.stdout).toContain("BYNAME user: uid=1000 shell=/bin/sh");

    // Lookup by uid.
    expect(r.stdout).toContain("BYUID 0: name=root");
    expect(r.stdout).toContain("BYUID 1000: name=user");
    expect(r.stdout).toContain("BYUID 99999: NOT FOUND");
  });

  it("/etc/passwd content matches rootfs/etc/passwd on disk", () => {
    // Direct byte comparison: the image builder should have embedded the
    // source file verbatim. Guards against a future "what did I actually
    // ship in the image" question.
    const onDisk = readFileSync(
      join(__dirname, "../../rootfs/etc/passwd"),
      "utf8",
    );
    expect(onDisk).toContain("root:x:0:0:root:/root:/bin/sh\n");
    expect(onDisk).toContain("user:x:1000:1000:user:/home/user:/bin/sh\n");
    expect(onDisk).toContain("daemon:x:1:1:");
    expect(onDisk).toContain("nobody:x:65534:65534:");
  });
});
