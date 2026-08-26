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
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function writeText(fs: MemoryFileSystem, path: string, content: string): void {
  const bytes = encoder.encode(content);
  const fd = fs.open(path, 0o1101, 0o644);
  try {
    fs.write(fd, bytes, 0, bytes.length);
  } finally {
    fs.close(fd);
  }
}

function readText(fs: MemoryFileSystem, path: string): string {
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
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
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
    const fs = MemoryFileSystem.create(new SharedArrayBuffer(2 * 1024 * 1024));
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
});
