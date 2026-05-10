/**
 * Task 4.6 — getpwent + friends round-trip via the rootfs.vfs mount.
 *
 * After Task 4.5 removed `synthetic_file_content`, the only path for a
 * user program to read /etc/passwd, /etc/group, /etc/services et al. is
 * through the rootfs image mounted at / by the default Node host setup.
 *
 * This test runs `examples/getpwent_smoke.wasm` (which calls the libc
 * NSS-style readers — getpwent/getpwnam/getpwuid/getgrent/getservbyname)
 * and asserts the bytes it sees match `rootfs/etc/passwd`, `…/group`
 * and `…/services` from PR 3/5.
 *
 * If the mount router silently dropped these reads, getpwent() would
 * return NULL on the first call and the iteration count would be 0 —
 * the substring assertions below would catch that.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const smokeWasm = join(repoRoot, "examples/getpwent_smoke.wasm");
const rootfsImage = join(repoRoot, "host/wasm/rootfs.vfs");

const haveSmoke = existsSync(smokeWasm);
const haveRootfs = existsSync(rootfsImage);

describe.skipIf(!haveSmoke || !haveRootfs)("getpwent via rootfs.vfs mount", () => {
  it("iterates all 7 /etc/passwd entries and looks up by name + uid", async () => {
    const result = await runCentralizedProgram({
      programPath: smokeWasm,
      argv: ["getpwent_smoke"],
      timeout: 15_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);

    // Iteration: must see all 7 entries from rootfs/etc/passwd, in order.
    expect(result.stdout).toContain("PWENT 0 name=root uid=0 gid=0 home=/root shell=/bin/sh");
    expect(result.stdout).toContain(
      "PWENT 1 name=daemon uid=1 gid=1 home=/usr/sbin shell=/usr/sbin/nologin",
    );
    expect(result.stdout).toContain(
      "PWENT 2 name=nobody uid=65534 gid=65534 home=/nonexistent shell=/usr/sbin/nologin",
    );
    expect(result.stdout).toContain(
      "PWENT 3 name=www-data uid=33 gid=33 home=/var/www shell=/usr/sbin/nologin",
    );
    expect(result.stdout).toContain(
      "PWENT 4 name=redis uid=100 gid=100 home=/var/lib/redis shell=/usr/sbin/nologin",
    );
    expect(result.stdout).toContain(
      "PWENT 5 name=mysql uid=101 gid=101 home=/var/lib/mysql shell=/usr/sbin/nologin",
    );
    expect(result.stdout).toContain(
      "PWENT 6 name=user uid=1000 gid=1000 home=/home/user shell=/bin/sh",
    );
    expect(result.stdout).toContain("PWENT count=7");

    // Targeted name lookups.
    expect(result.stdout).toContain("PWNAM name=root uid=0 gid=0 home=/root shell=/bin/sh");
    expect(result.stdout).toContain(
      "PWNAM name=user uid=1000 gid=1000 home=/home/user shell=/bin/sh",
    );

    // Missing entries must surface as NULL — proves we're not silently
    // synthesizing fallback data anywhere.
    expect(result.stdout).toContain("PWNAM name=nonexistent-user-xyz result=NULL");

    // Targeted uid lookups.
    expect(result.stdout).toContain("PWUID uid=0 name=root gid=0 home=/root shell=/bin/sh");
    expect(result.stdout).toContain(
      "PWUID uid=1000 name=user gid=1000 home=/home/user shell=/bin/sh",
    );
  });

  it("reads /etc/group entries via getgrent", async () => {
    const result = await runCentralizedProgram({
      programPath: smokeWasm,
      argv: ["getpwent_smoke"],
      timeout: 15_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("GRENT 0 name=root gid=0");
    expect(result.stdout).toContain("GRENT 1 name=daemon gid=1");
    expect(result.stdout).toContain("GRENT 7 name=user gid=1000");
    expect(result.stdout).toContain("GRENT count=8");
  });

  it("resolves service names from /etc/services via getservbyname", async () => {
    const result = await runCentralizedProgram({
      programPath: smokeWasm,
      argv: ["getpwent_smoke"],
      timeout: 15_000,
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("SERV name=ssh proto=tcp port=22");
    expect(result.stdout).toContain("SERV name=http proto=tcp port=80");
  });
});
