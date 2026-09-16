import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEMO_AUTOLOGIN_MOTD,
  configureDemoLogin,
  DEMO_AUTOLOGIN_MOTD_PATH,
  DEMO_LOGIN_PASSWORD,
  DEMO_LOGIN_PASSWORD_HASH,
  DEMO_LOGIN_PROGRAM_PATH,
  DEMO_LOGIN_USERNAME,
  DEMO_SUDOERS,
  DEMO_SUDOERS_PATH,
  hasConfiguredDemoLogin,
} from "../../images/vfs/lib/demo-login";
import { ensureDirRecursive } from "../src/vfs/image-helpers";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function writeText(fs: KandeloImageFs, path: string, content: string): void {
  const bytes = encoder.encode(content);
  const fd = fs.open(path, 0o1101, 0o644);
  try {
    fs.write(fd, bytes, 0, bytes.length);
  } finally {
    fs.close(fd);
  }
}

function readText(fs: KandeloImageFs, path: string): string {
  const st = fs.stat(path);
  const fd = fs.open(path, 0, 0);
  try {
    const bytes = new Uint8Array(st.size);
    const count = fs.read(fd, bytes, null, bytes.length);
    return decoder.decode(bytes.subarray(0, count));
  } finally {
    fs.close(fd);
  }
}

describe("canonical demo login image policy", () => {
  it("derives the maker account, wheel policy, and autologin message from one credential source", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/etc");
    ensureDirRecursive(fs, "/usr/bin");
    fs.createFileWithOwner(
      DEMO_LOGIN_PROGRAM_PATH,
      0o4755,
      0,
      0,
      new Uint8Array([0]),
    );
    fs.createFileWithOwner(
      "/etc/passwd",
      0o644,
      0,
      0,
      encoder.encode(
        [
          "root:x:0:0:root:/root:/bin/sh",
          "maker:x:1000:1000:maker:/home/maker:/bin/sh",
          "",
        ].join("\n"),
      ),
    );
    fs.createFileWithOwner(
      "/etc/shadow",
      0o640,
      0,
      0,
      encoder.encode(
        ["root:*:0:0:99999:7:::", "maker:*:0:0:99999:7:::", ""].join("\n"),
      ),
    );
    fs.createFileWithOwner(
      "/etc/group",
      0o644,
      0,
      0,
      encoder.encode("root:x:0:\nmaker:x:1000:\n"),
    );
    fs.createFileWithOwner("/etc/motd", 0o644, 0, 0, new Uint8Array());

    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    configureDemoLogin(fs, { home: "/work", shell: "/bin/bash" });
    // This predicate certifies configuration staging. Task 7's reviewed
    // privileged-product publisher separately proves the executable bytes and
    // trusted mount provenance before set-ID execution is possible.
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    configureDemoLogin(fs, { home: "/home/user", shell: "/bin/sh" });
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    configureDemoLogin(fs, { home: "/home/maker", shell: "/bin/sh" });
    expect(hasConfiguredDemoLogin(fs)).toBe(true);

    expect(DEMO_LOGIN_USERNAME).toBe("maker");
    expect(DEMO_LOGIN_PASSWORD).toBe("kandelo");
    expect(DEMO_LOGIN_PASSWORD_HASH).toBe(
      "$6$kandelo$DKNPruix37YeUx9j4kJIGJ2NvXdqzxDr5b1D3xJZzbwFsNYuep8j3AtxB7OaTD6HWnz/adonyTamRx4XQwJ06/",
    );
    expect(readText(fs, "/etc/passwd")).toContain(
      "maker:x:1000:1000:maker:/home/maker:/bin/sh",
    );
    expect(readText(fs, "/etc/shadow")).toContain(
      `maker:${DEMO_LOGIN_PASSWORD_HASH}:`,
    );
    expect(readText(fs, "/etc/shadow")).toContain("root:*:");
    expect(readText(fs, "/etc/group")).toContain("wheel:x:10:maker");
    expect(readText(fs, "/etc/sudoers")).toBe("%wheel ALL=(ALL:ALL) ALL\n");
    expect(readText(fs, DEMO_AUTOLOGIN_MOTD_PATH)).toContain(
      `login: ${DEMO_LOGIN_USERNAME}`,
    );
    expect(readText(fs, DEMO_AUTOLOGIN_MOTD_PATH)).toContain(
      `password: ${DEMO_LOGIN_PASSWORD}`,
    );

    expect(fs.stat("/etc/shadow")).toMatchObject({ uid: 0, gid: 0 });
    expect(fs.stat("/etc/shadow").mode & 0o7777).toBe(0o640);
    expect(fs.stat("/etc/sudoers")).toMatchObject({ uid: 0, gid: 0 });
    expect(fs.stat("/etc/sudoers").mode & 0o7777).toBe(0o440);

    fs.chmod("/etc/sudoers", 0o644);
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    fs.chmod("/etc/sudoers", 0o440);
    expect(hasConfiguredDemoLogin(fs)).toBe(true);

    writeText(
      fs,
      "/etc/shadow",
      "root:*:0:0:99999:7:::\n" +
        "maker:$6$other$still-an-unlocked-hash:0:0:99999:7:::\n",
    );
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    writeText(
      fs,
      "/etc/shadow",
      "root:*:0:0:99999:7:::\n" +
        `maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n`,
    );
    expect(hasConfiguredDemoLogin(fs)).toBe(true);

    writeText(fs, DEMO_AUTOLOGIN_MOTD_PATH, "forged credential hint\n");
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    writeText(fs, DEMO_AUTOLOGIN_MOTD_PATH, DEMO_AUTOLOGIN_MOTD);
    expect(hasConfiguredDemoLogin(fs)).toBe(true);

    fs.chmod(DEMO_AUTOLOGIN_MOTD_PATH, 0o600);
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    fs.chmod(DEMO_AUTOLOGIN_MOTD_PATH, 0o644);
    expect(hasConfiguredDemoLogin(fs)).toBe(true);

    fs.chown(DEMO_AUTOLOGIN_MOTD_PATH, 1000, 1000);
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
  });

  it("rejects ambiguous account, password, and wheel records", () => {
    const fs = KandeloImageFs.create();
    ensureDirRecursive(fs, "/etc");
    ensureDirRecursive(fs, "/usr/bin");
    fs.createFileWithOwner(
      DEMO_LOGIN_PROGRAM_PATH,
      0o4755,
      0,
      0,
      new Uint8Array([0]),
    );
    fs.createFileWithOwner(
      "/etc/passwd",
      0o644,
      0,
      0,
      encoder.encode("maker:x:1000:1000:maker:/home/maker:/bin/sh\n"),
    );
    fs.createFileWithOwner(
      "/etc/shadow",
      0o640,
      0,
      0,
      encoder.encode(`maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n`),
    );
    fs.createFileWithOwner(
      "/etc/group",
      0o644,
      0,
      0,
      encoder.encode("wheel:x:10:maker\n"),
    );
    fs.createFileWithOwner(
      DEMO_SUDOERS_PATH,
      0o440,
      0,
      0,
      encoder.encode(DEMO_SUDOERS),
    );
    fs.createFileWithOwner(
      DEMO_AUTOLOGIN_MOTD_PATH,
      0o644,
      0,
      0,
      encoder.encode(DEMO_AUTOLOGIN_MOTD),
    );
    expect(hasConfiguredDemoLogin(fs)).toBe(true);

    writeText(
      fs,
      "/etc/passwd",
      "maker:x:1000:1000:maker:/home/maker:/bin/sh\n" +
        "maker:x:1000:1000:maker:/home/user:/bin/sh\n",
    );
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    writeText(
      fs,
      "/etc/passwd",
      "maker:x:1000:1000:maker:/home/maker:/bin/sh\n",
    );

    writeText(
      fs,
      "/etc/shadow",
      `maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n` +
        `maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n`,
    );
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    writeText(
      fs,
      "/etc/shadow",
      `maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::\n`,
    );

    writeText(fs, "/etc/group", "wheel:x:10:maker\nwheel:x:10:maker\n");
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
    writeText(fs, "/etc/group", "wheel:x:10:maker,root\n");
    expect(hasConfiguredDemoLogin(fs)).toBe(false);
  });

  it("keeps canonical rootfs data truthful and product binaries outside local compiler paths", () => {
    const passwd = readFileSync(
      join(repoRoot, "images/rootfs/etc/passwd"),
      "utf8",
    );
    const group = readFileSync(
      join(repoRoot, "images/rootfs/etc/group"),
      "utf8",
    );
    const shadow = readFileSync(
      join(repoRoot, "images/rootfs/etc/shadow"),
      "utf8",
    );
    const sudoers = readFileSync(
      join(repoRoot, "images/rootfs/etc/sudoers"),
      "utf8",
    );
    expect(passwd).toContain("maker:x:1000:1000:maker:/home/maker:/bin/bash");
    expect(group).toContain("wheel:x:10:maker");
    expect(shadow).toContain(`maker:${DEMO_LOGIN_PASSWORD_HASH}:`);
    expect(sudoers).toBe("%wheel ALL=(ALL:ALL) ALL\n");

    for (const name of ["login", "sudo-lite"]) {
      const fixture = join(
        repoRoot,
        `local-binaries/test-fixtures/wasm32/${name}.wasm`,
      );
      const productMirror = join(
        repoRoot,
        `local-binaries/programs/wasm32/${name}.wasm`,
      );
      expect(existsSync(fixture), fixture).toBe(true);
      if (existsSync(productMirror)) {
        expect(lstatSync(productMirror).isSymbolicLink(), productMirror).toBe(
          true,
        );
      }
    }
  });

  it("refuses a login program whose bytes are not in the image", () => {
    // A setuid login program that is DEFERRED is not a configured login: the
    // machine boots, the program is a stub, and the first authentication
    // depends on a fetch. Nothing exercised that branch, so both halves of the
    // eagerness union could be deleted and this file stayed green -- found by
    // perturbation, not by reading.
    const stage = (deferLogin: boolean) => {
      const fs = KandeloImageFs.create();
      ensureDirRecursive(fs, "/etc");
      ensureDirRecursive(fs, "/usr/bin");
      if (deferLogin) {
        // A url-backed single file: the case `isPathDeferred` alone does not
        // see, which is why the predicate asks both questions.
        //
        // WITH a digest, because the producer refuses to register set-user-ID
        // deferred bytes it cannot vouch for, and that refusal is a different
        // guard with its own test. Declaring one puts this fixture on the
        // legal side of it, so what is left under test here is only the
        // predicate: bytes that must be FETCHED are not bytes in the image,
        // digest or no digest, and a login that depends on a fetch is not a
        // configured login.
        fs.registerLazyFile(
          DEMO_LOGIN_PROGRAM_PATH, "https://example.invalid/login", 1, 0o4755,
          "0".repeat(64),
        );
      } else {
        fs.createFileWithOwner(
          DEMO_LOGIN_PROGRAM_PATH, 0o4755, 0, 0, new Uint8Array([0]),
        );
      }
      writeText(fs, "/etc/passwd",
        "root:x:0:0:root:/root:/bin/sh\nmaker:x:1000:1000:maker:/home/maker:/bin/sh\n");
      writeText(fs, "/etc/shadow", "root:*:0:0:99999:7:::\nmaker:*:0:0:99999:7:::\n");
      writeText(fs, "/etc/group", "root:x:0:\nmaker:x:1000:\n");
      writeText(fs, "/etc/motd", "");
      configureDemoLogin(fs, { home: "/home/maker", shell: "/bin/sh" });
      return fs;
    };

    // The premise, proved rather than assumed: this fixture IS a configured
    // login when the program is eager. Without it the deferred assertion below
    // passes for whatever other reason the fixture happens to fail -- which is
    // exactly what the first version of this test did, and two perturb trials
    // went on surviving because of it.
    expect(hasConfiguredDemoLogin(stage(false))).toBe(true);
    expect(hasConfiguredDemoLogin(stage(true))).toBe(false);
  });
});

describe("hasConfiguredDemoLogin distinguishes absent from broken", () => {
  // The predicate answers a QUESTION about an image, and its `catch` used to
  // answer it `false` for any reason at all. "There is no /etc/shadow" is the
  // answer; "I could not ask" is not, and reporting a configured image as
  // unconfigured is indistinguishable from the real verdict.
  //
  // This matters most where it is least visible: a filesystem the predicate
  // does not fully recognise raises a TypeError, and the old catch turned that
  // into a plausible "no login here". Same shape as B45, where a loss looked
  // like a successful boot.
  function throwing(error: unknown) {
    return { stat() { throw error; } } as never;
  }

  it("answers false when the image simply has no login files", () => {
    // ENOENT under BOTH conventions: the image bridge raises a positive errno,
    // `vfs-errors.ts` a negative code. Either must read as "not there".
    for (const notFound of [
      Object.assign(new Error("ENOENT: stat"), { errno: 2 }),
      Object.assign(new Error("ENOENT: stat"), { code: -2 }),
      Object.assign(new Error("ENOENT: stat"), { code: "ENOENT" }),
    ]) {
      expect(hasConfiguredDemoLogin(throwing(notFound))).toBe(false);
    }
  });

  it("propagates anything else, rather than reporting an unreadable image as unconfigured", () => {
    for (const broken of [
      new TypeError("fs.isPathDeferred is not a function"),
      Object.assign(new Error("EACCES: stat"), { errno: 13 }),
      Object.assign(new Error("EIO: stat"), { errno: 5 }),
    ]) {
      expect(() => hasConfiguredDemoLogin(throwing(broken)))
        .toThrow(broken.message);
    }
  });
});
