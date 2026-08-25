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
const loginWasm = join(
  repoRoot,
  "local-binaries/test-fixtures/wasm32/login.wasm",
);
const shellWasm = join(repoRoot, "local-binaries/programs/wasm32/sh.wasm");
const identityDir = mkdtempSync(join(tmpdir(), "kandelo-login-identity-"));
const identitySource = join(identityDir, "login-identity.c");
const identityWasm = join(identityDir, "login-identity.wasm");
const ttyFailureSource = join(identityDir, "login-tty-failure.c");
const ttyFailureWasm = join(identityDir, "login-tty-failure.wasm");
const execArgvSource = join(repoRoot, "host/test/fixtures/exec-argv.c");
const execArgvWasm = join(identityDir, "exec-argv.wasm");

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
    char cwd[256];
    int count = getgroups(32, groups);
    if (getresuid(&ruid, &euid, &suid) != 0 ||
        getresgid(&rgid, &egid, &sgid) != 0 ||
        count < 0 || getcwd(cwd, sizeof(cwd)) == NULL) return 90;
    printf("ARGV0=%s argc=%d\n", argv[0], argc);
    printf("UID r=%u e=%u s=%u\n", ruid, euid, suid);
    printf("GID r=%u e=%u s=%u\n", rgid, egid, sgid);
    printf("GROUPS count=%d", count);
    for (int i = 0; i < count; i++) printf(" %u", groups[i]);
    printf("\nCWD=%s\n", cwd);
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
#define main login_program_main
#include "${join(repoRoot, "programs/login.c")}"
#undef main

#include <errno.h>

static int stdin_reads;
char *__real_fgets(char *, int, FILE *);

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

int main(void) {
    char *argv[] = {"login", "maker", NULL};
    int result = login_program_main(2, argv);
    printf("STDIN_READS=%d\n", stdin_reads);
    return result;
}
`;

function bytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

function loginPlatform(
  shell = "/bin/login-identity",
  createHome = true,
  accountHome = "/home/maker",
): VirtualPlatformIO {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024));
  const enc = new TextEncoder();
  for (const path of ["/etc", "/bin", "/home", "/usr/bin", "/var", "/tmp"]) {
    ensureDirRecursive(fs, path);
  }
  if (createHome) {
    fs.mkdirWithOwner("/home/maker", 0o755, 1000, 1000);
  }
  fs.createFileWithOwner(
    "/etc/passwd",
    0o644,
    0,
    0,
    enc.encode(
      [
        "root:x:0:0:root:/root:/bin/sh",
        `maker:x:1000:1000:maker:${accountHome}:${shell}`,
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
        "wheel:x:10:maker",
        "audio:x:20:maker",
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
    "/etc/motd",
    0o644,
    0,
    0,
    enc.encode("Ordinary login message\n"),
  );
  fs.createFileWithOwner(
    "/etc/motd.autologin",
    0o644,
    0,
    0,
    enc.encode("Preauthenticated login message\n"),
  );
  fs.createFileWithOwner("/bin/sh", 0o755, 0, 0, bytes(shellWasm));
  fs.createFileWithOwner(
    "/bin/login-identity",
    0o755,
    0,
    0,
    bytes(identityWasm),
  );
  fs.createFileWithOwner(
    "/usr/bin/login",
    0o4755,
    0,
    0,
    bytes(loginWasm),
  );
  return new VirtualPlatformIO(
    [
      { mountPoint: "/", backend: fs },
      { mountPoint: "/dev", backend: new DeviceFileSystem(), nosuid: true },
    ],
    new NodeTimeProvider(),
  );
}

async function runLogin(
  options: {
    args?: string;
    stdin?: string;
    uid?: number;
    gid?: number;
    env?: string[];
    accountShell?: string;
    createHome?: boolean;
    accountHome?: string;
  } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runCentralizedProgram({
    programPath: execArgvWasm,
    argv: [
      "exec-argv",
      "/usr/bin/login",
      ...(options.args ?? "maker").split(" "),
    ],
    uid: options.uid ?? 1000,
    gid: options.gid ?? 1000,
    env: options.env,
    stdin: options.stdin ?? `${DEMO_LOGIN_PASSWORD}\n`,
    io: loginPlatform(
      options.accountShell,
      options.createHome,
      options.accountHome,
    ),
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
      "-Wl,--wrap=isatty",
      "-Wl,--wrap=tcgetattr",
      "-Wl,--wrap=tcsetattr",
      "-Wl,--wrap=fgets",
      "-o",
      ttyFailureWasm,
    ],
    { cwd: repoRoot, stdio: "pipe" },
  );
});

afterAll(() => {
  rmSync(identityDir, { recursive: true, force: true });
});

describe("first-party guest login", () => {
  it("authenticates from shadow before changing groups, IDs, CWD, and environment", async () => {
    const result = await runLogin({
      env: ["TERM=xterm-kandelo", "KANDELO_UNTRUSTED=must-not-survive"],
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Password: ");
    expect(result.stdout).toContain("ARGV0=-login-identity argc=1");
    expect(result.stdout).toContain("UID r=1000 e=1000 s=1000");
    expect(result.stdout).toContain("GID r=1000 e=1000 s=1000");
    expect(result.stdout).toContain("GROUPS count=3 1000 10 20");
    expect(result.stdout).toContain("CWD=/home/maker");
    expect(result.stdout).toContain("HOME=/home/maker");
    expect(result.stdout).toContain("USER=maker");
    expect(result.stdout).toContain("LOGNAME=maker");
    expect(result.stdout).toContain("SHELL=/bin/login-identity");
    expect(result.stdout).toContain("PATH=/usr/local/bin:/usr/bin:/bin");
    expect(result.stdout).toContain("TERM=xterm-kandelo");
    expect(result.stdout).toContain("KANDELO_UNTRUSTED=\n");
    expect(result.stdout).toContain("Ordinary login message\n");
    expect(result.stdout).not.toContain("Preauthenticated login message");
  });

  it("fails instead of starting a shell outside the account's missing canonical home", async () => {
    const result = await runLogin({
      args: "-f maker",
      stdin: "",
      uid: 0,
      gid: 0,
      createHome: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("login: chdir: No such file or directory");
    expect(result.stdout).not.toContain("ARGV0=-login-identity");
    expect(result.stdout).not.toContain("Ordinary login message");
    expect(result.stdout).not.toContain("Preauthenticated login message");
  });

  it("rejects an account without a canonical home instead of using the root directory", async () => {
    const result = await runLogin({
      args: "-f maker",
      stdin: "",
      uid: 0,
      gid: 0,
      accountHome: "",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("login: account has no home directory");
    expect(result.stdout).not.toContain("ARGV0=-login-identity");
    expect(result.stdout).not.toContain("Ordinary login message");
  });

  it.each([
    ["an incorrect password", "maker", "wrong\n"],
    ["an unknown user", "missing-user", "irrelevant\n"],
  ])("rejects %s without starting a shell", async (_label, user, stdin) => {
    const result = await runLogin({ args: user, stdin });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Login incorrect");
    expect(result.stdout).not.toContain("ARGV0=-login-identity");
  });

  it("allows a real-root manager to preserve a trusted environment and preauthenticate", async () => {
    const result = await runLogin({
      args: "-p -f maker",
      stdin: "",
      uid: 0,
      gid: 0,
      env: [
        "TERM=xterm-256color",
        "PATH=/trusted/bin",
        "KANDELO_UNTRUSTED=trusted-manager-value",
      ],
    });

    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).not.toContain("Password: ");
    expect(result.stdout).toContain("PATH=/trusted/bin");
    expect(result.stdout).toContain("KANDELO_UNTRUSTED=trusted-manager-value");
    expect(result.stdout).toContain("Ordinary login message\n");
    expect(result.stdout).toContain("Preauthenticated login message\n");
  });

  it.each(["-p maker", "-f maker"])(
    "rejects non-root use of %s",
    async (args) => {
      const result = await runLogin({ args, stdin: "" });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("require a root caller");
      expect(result.stdout).not.toContain("ARGV0=-login-identity");
    },
  );

  it("refuses to read a TTY password when echo cannot be disabled", async () => {
    const result = await runCentralizedProgram({
      programPath: ttyFailureWasm,
      argv: ["login-tty-failure"],
      timeout: 20_000,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("login: tcsetattr: I/O error");
    expect(result.stdout).toContain("STDIN_READS=0");
  });

  it("reports a missing account shell after completing the real login transition", async () => {
    const result = await runLogin({
      args: "-f maker",
      stdin: "",
      uid: 0,
      gid: 0,
      accountShell: "/bin/missing-shell",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("Ordinary login message\n");
    expect(result.stdout).toContain("Preauthenticated login message\n");
    expect(result.stderr).toContain("login: exec: No such file or directory");
  });
});
