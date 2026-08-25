import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEMO_LOGIN_PASSWORD,
  DEMO_LOGIN_PASSWORD_HASH,
} from "../../images/vfs/lib/demo-login";
import { DeviceFileSystem } from "../src/vfs/device-fs";
import { ensureDirRecursive } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeTimeProvider } from "../src/vfs/time";
import { VirtualPlatformIO } from "../src/vfs/vfs";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const sudoWasm = join(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/sudo-lite.wasm",
);
const shellWasm = join(repoRoot, "local-binaries/programs/wasm32/sh.wasm");
const identityDir = mkdtempSync(join(tmpdir(), "kandelo-sudo-identity-"));
const identitySource = join(identityDir, "sudo-identity.c");
const identityWasm = join(identityDir, "sudo-identity.wasm");
const ttyFailureSource = join(identityDir, "sudo-tty-failure.c");
const ttyFailureWasm = join(identityDir, "sudo-tty-failure.wasm");
const execArgvSource = join(repoRoot, "host/test/fixtures/exec-argv.c");
const execArgvWasm = join(identityDir, "exec-argv.wasm");
const safePath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const wheelPolicy = "%wheel ALL=(ALL:ALL) ALL\n";

const identityProgram = String.raw`
#define _GNU_SOURCE
#include <grp.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

static const char *env_value(const char *name) {
    const char *value = getenv(name);
    return value ? value : "";
}

int main(int argc, char **argv) {
    uid_t ruid, euid, suid;
    gid_t rgid, egid, sgid;
    gid_t groups[32];
    int count = getgroups(32, groups);
    if (getresuid(&ruid, &euid, &suid) != 0 ||
        getresgid(&rgid, &egid, &sgid) != 0 || count < 0) return 90;
    printf("ARGV0=%s argc=%d\n", argv[0], argc);
    printf("UID r=%u e=%u s=%u\n", ruid, euid, suid);
    printf("GID r=%u e=%u s=%u\n", rgid, egid, sgid);
    printf("GROUPS count=%d", count);
    for (int i = 0; i < count; i++) printf(" %u", groups[i]);
    printf("\n");
    const char *names[] = {
        "HOME", "USER", "LOGNAME", "SHELL", "PATH", "TERM",
        "KANDELO_UNTRUSTED", NULL
    };
    for (int i = 0; names[i]; i++)
        printf("%s=%s\n", names[i], env_value(names[i]));
    return 0;
}
`;

const ttyFailureProgram = String.raw`
#define main sudo_program_main
#include "${join(repoRoot, "programs/sudo-lite.c")}"
#undef main

static int stdin_reads;
char *__real_fgets(char *, int, FILE *);

uid_t __wrap_getuid(void) { return 1000; }
uid_t __wrap_geteuid(void) { return 0; }
gid_t __wrap_getgid(void) { return 10; }
gid_t __wrap_getegid(void) { return 10; }

int __wrap_isatty(int fd) {
    (void)fd;
    return 1;
}

int __wrap_tcgetattr(int fd, struct termios *attrs) {
    (void)fd;
    memset(attrs, 0, sizeof(*attrs));
    return 0;
}

int __wrap_tcsetattr(int fd, int action, const struct termios *attrs) {
    (void)fd;
    (void)action;
    (void)attrs;
    errno = EIO;
    return -1;
}

char *__wrap_fgets(char *buf, int size, FILE *stream) {
    if (stream == stdin) {
        stdin_reads++;
        return NULL;
    }
    return __real_fgets(buf, size, stream);
}

unsigned __wrap_sleep(unsigned seconds) {
    (void)seconds;
    return 0;
}

int main(void) {
    char *argv[] = {"sudo-lite", "/bin/sudo-identity", NULL};
    int result = sudo_program_main(2, argv);
    printf("STDIN_READS=%d\n", stdin_reads);
    return result;
}
`;

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function sudoPlatform(
  options: {
    wheelMember?: boolean;
    sudoers?: string;
    sudoMode?: number;
  } = {},
): VirtualPlatformIO {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
  const enc = new TextEncoder();
  for (const path of [
    "/etc",
    "/bin",
    "/home",
    "/root",
    "/usr/bin",
    "/var",
    "/tmp",
  ]) {
    ensureDirRecursive(fs, path);
  }
  fs.mkdirWithOwner("/home/maker", 0o755, 1000, 1000);
  fs.chmod("/root", 0o700);
  fs.createFileWithOwner(
    "/etc/passwd",
    0o644,
    0,
    0,
    enc.encode(
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
    enc.encode(
      [
        "root:*:0:0:99999:7:::",
        `maker:${DEMO_LOGIN_PASSWORD_HASH}:0:0:99999:7:::`,
        "",
      ].join("\n"),
    ),
  );
  fs.createFileWithOwner(
    "/etc/group",
    0o644,
    0,
    0,
    enc.encode(
      [
        "root:x:0:",
        `wheel:x:10:${options.wheelMember === false ? "" : "maker"}`,
        "maker:x:1000:",
        "",
      ].join("\n"),
    ),
  );
  fs.createFileWithOwner(
    "/etc/nsswitch.conf",
    0o644,
    0,
    0,
    enc.encode("passwd: files\ngroup: files\nshadow: files\n"),
  );
  fs.createFileWithOwner(
    "/etc/sudoers",
    0o440,
    0,
    0,
    enc.encode(options.sudoers ?? wheelPolicy),
  );
  fs.createFileWithOwner("/bin/sh", 0o755, 0, 0, bytes(shellWasm));
  fs.createFileWithOwner(
    "/usr/bin/sudo-lite",
    options.sudoMode ?? 0o4755,
    0,
    0,
    bytes(sudoWasm),
  );
  fs.createFileWithOwner(
    "/bin/sudo-identity",
    0o755,
    0,
    0,
    bytes(identityWasm),
  );
  return new VirtualPlatformIO(
    [
      { mountPoint: "/", backend: fs },
      { mountPoint: "/dev", backend: new DeviceFileSystem(), nosuid: true },
    ],
    new NodeTimeProvider(),
  );
}

async function runSudo(
  options: {
    args?: string;
    stdin?: string;
    uid?: number;
    gid?: number;
    env?: string[];
    wheelMember?: boolean;
    sudoers?: string;
    sudoMode?: number;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCentralizedProgram({
    programPath: execArgvWasm,
    argv: [
      "exec-argv",
      "/usr/bin/sudo-lite",
      ...(options.args ?? "/bin/sudo-identity").split(" "),
    ],
    uid: options.uid ?? 1000,
    // A login session supplies wheel as a supplementary group. Using it as
    // the effective group exercises the same kernel membership predicate
    // without adding host-only supplementary-group setup.
    gid: options.gid ?? (options.wheelMember === false ? 1000 : 10),
    env: options.env ?? [
      "TERM=xterm-kandelo",
      "KANDELO_UNTRUSTED=must-not-survive",
    ],
    stdin: options.stdin ?? `${DEMO_LOGIN_PASSWORD}\n`,
    io: sudoPlatform(options),
    timeout: 20_000,
  });
  return result;
}

beforeAll(() => {
  writeFileSync(identitySource, identityProgram);
  writeFileSync(ttyFailureSource, ttyFailureProgram);
  execFileSync("wasm32posix-cc", [identitySource, "-o", identityWasm], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  execFileSync("wasm32posix-cc", [execArgvSource, "-o", execArgvWasm], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  execFileSync(
    "wasm32posix-cc",
    [
      ttyFailureSource,
      "-Wl,--wrap=getuid",
      "-Wl,--wrap=geteuid",
      "-Wl,--wrap=getgid",
      "-Wl,--wrap=getegid",
      "-Wl,--wrap=isatty",
      "-Wl,--wrap=tcgetattr",
      "-Wl,--wrap=tcsetattr",
      "-Wl,--wrap=fgets",
      "-Wl,--wrap=sleep",
      "-o",
      ttyFailureWasm,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
});

afterAll(() => {
  rmSync(identityDir, { recursive: true, force: true });
});

describe("first-party guest sudo-lite", () => {
  it("authenticates a wheel user and establishes root groups, IDs, and a safe environment", async () => {
    const result = await runSudo();
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).toContain("[sudo-lite] password for maker: ");
    expect(result.stdout).toContain("ARGV0=/bin/sudo-identity argc=1");
    expect(result.stdout).toContain("UID r=0 e=0 s=0");
    expect(result.stdout).toContain("GID r=0 e=0 s=0");
    expect(result.stdout).toContain("GROUPS count=1 0");
    expect(result.stdout).toContain("HOME=/root");
    expect(result.stdout).toContain("USER=root");
    expect(result.stdout).toContain("LOGNAME=root");
    expect(result.stdout).toContain("SHELL=/bin/sh");
    expect(result.stdout).toContain(`PATH=${safePath}`);
    expect(result.stdout).toContain("TERM=xterm-kandelo");
    expect(result.stdout).toContain("KANDELO_UNTRUSTED=\n");
  });

  it("rejects a wrong password before running the command", async () => {
    const result = await runSudo({ stdin: "wrong\n" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sudo-lite: authentication failed");
    expect(result.stdout).not.toContain("UID r=");
  });

  it("refuses to read a TTY password when echo cannot be disabled", async () => {
    const result = await runCentralizedProgram({
      programPath: ttyFailureWasm,
      argv: ["sudo-tty-failure"],
      uid: 0,
      gid: 0,
      io: sudoPlatform(),
      timeout: 20_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sudo-lite: tcsetattr: I/O error");
    expect(result.stdout).toContain("STDIN_READS=0");
  });

  it("rejects a user outside wheel before asking for a password", async () => {
    const result = await runSudo({ wheelMember: false });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("current wheel membership is required");
    expect(result.stderr).not.toContain("password for maker");
    expect(result.stdout).not.toContain("UID r=");
  });

  it("lists the parsed wheel policy after authentication", async () => {
    const result = await runSudo({ args: "-l" });
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain(
      "User maker may run the following commands",
    );
    expect(result.stdout).toContain("(ALL:ALL) ALL");
  });

  it("fails closed on malformed sudoers policy", async () => {
    const result = await runSudo({ sudoers: "wheel can do anything\n" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("sudo-lite: malformed /etc/sudoers");
    expect(result.stderr).not.toContain("password for maker");
    expect(result.stdout).not.toContain("UID r=");
  });

  it("rejects a wheel user when sudoers does not grant wheel policy", async () => {
    const result = await runSudo({ sudoers: "root ALL=(ALL:ALL) ALL\n" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "sudo-lite: wheel is not allowed by /etc/sudoers",
    );
    expect(result.stderr).not.toContain("password for maker");
  });

  it("reports execvp failure with the conventional not-found status", async () => {
    const result = await runSudo({ args: "/bin/missing-command" });
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain(
      "sudo-lite: exec /bin/missing-command: No such file or directory",
    );
  });

  it("fails loudly if the reviewed set-ID projection was not applied", async () => {
    const result = await runSudo({ sudoMode: 0o755 });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("effective uid is not root");
    expect(result.stderr).toContain("mount nosuid policy");
  });
});
