/**
 * Tests for Git 2.47.1 running on the kandelo.
 *
 * Git is built with wpk_fork_* instrumentation for fork() support so that
 * subprocesses (git gc --auto, git-remote-http, index-pack) work correctly.
 *
 * Persistent native paths are rooted in random, test-owned directories so
 * append ownership remains explicit across the complete guest lifetime.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { execSync } from "node:child_process";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { FetchNetworkBackend } from "../../../../host/src/networking/fetch-backend";
import { tryResolveBinary } from "../../../../host/src/binary-resolver";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";
import { createSessionOwnedHostFileSystem } from "../../../../host/src/vfs/host-fs";
import { NodeTimeProvider } from "../../../../host/src/vfs/time";
import { VirtualPlatformIO } from "../../../../host/src/vfs/vfs";

const gitBinary = tryResolveBinary("programs/git/git.wasm");
const gitRemoteHttpBinary = tryResolveBinary(
  "programs/git/git-remote-http.wasm",
);

// Phase 7: skip git tests when the resolved binaries predate the
// wasm-fork-instrument flip (i.e. they still export asyncify_* instead
// of wpk_fork_*). Detect by reading the wasm module and looking for
// the new export name; a stale binary causes kernel ABI mismatch at
// launch and the test hangs on startup rather than producing a clean skip.
function hasWpkForkExports(path: string | null): boolean {
  if (!path) return false;
  try {
    const bytes = readFileSync(path);
    return bytes.includes(Buffer.from("wpk_fork_state"));
  } catch {
    return false;
  }
}

const hasGit = !!gitBinary && hasWpkForkExports(gitBinary);
const hasGitRemoteHttp =
  !!gitRemoteHttpBinary && hasWpkForkExports(gitRemoteHttpBinary);

function createOwnedGuestIo(root: string): VirtualPlatformIO {
  mkdirSync(root, { recursive: true });
  // WHY: the random root is exclusively owned by this test for the complete
  // guest lifetime, so the backend can truthfully publish exact append ends.
  return new VirtualPlatformIO(
    [
      {
        mountPoint: "/",
        backend: createSessionOwnedHostFileSystem(root),
      },
    ],
    new NodeTimeProvider(),
  );
}

// Git config via environment
const gitEnv = [
  "GIT_CONFIG_NOSYSTEM=1",
  "GIT_CONFIG_COUNT=4",
  "GIT_CONFIG_KEY_0=gc.auto",
  "GIT_CONFIG_VALUE_0=0",
  "GIT_CONFIG_KEY_1=user.name",
  "GIT_CONFIG_VALUE_1=Test",
  "GIT_CONFIG_KEY_2=user.email",
  "GIT_CONFIG_VALUE_2=test@wasm.local",
  "GIT_CONFIG_KEY_3=init.defaultBranch",
  "GIT_CONFIG_VALUE_3=main",
];

describe.skipIf(!hasGit)("Git", () => {
  it("reports version", async () => {
    const result = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "--version"],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("git version 2.");
  });

  it("initializes a repository", async () => {
    const dir = `/tmp/git-test-init-${Date.now()}`;
    const result = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "init", dir],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("nitialized");
  });

  it(
    "creates a commit without spurious help output (wpk_fork instrumentation)",
    { timeout: 30_000 },
    async () => {
      // git commit triggers fork+exec for `git gc --auto`. Without fork
      // instrumentation, the fork child restarts from _start() with empty argv
      // and prints help.
      const dir = "/tmp/repo";
      const program = readFileSync(gitBinary!);
      const programBytes = program.buffer.slice(
        program.byteOffset,
        program.byteOffset + program.byteLength,
      );
      let output = "";
      const host = new NodeKernelHost({
        rootfsImage: "default",
        onStdout: (_pid, data) => {
          output += new TextDecoder().decode(data);
        },
        onStderr: (_pid, data) => {
          output += new TextDecoder().decode(data);
        },
      });
      try {
        await host.init();
        expect(
          await host.spawn(programBytes, ["git", "init", dir], {
            env: gitEnv,
          }),
        ).toBe(0);
        output = "";
        // WHY: both operations share one dedicated kernel session, so /tmp
        // retains its lifecycle-owned append authority across the process exit.
        expect(
          await host.spawn(
            programBytes,
            ["git", "-C", dir, "commit", "--allow-empty", "-m", "test commit"],
            { env: gitEnv },
          ),
        ).toBe(0);
        expect(output).toContain("test commit");
        expect(output).not.toContain("usage: git");
      } finally {
        await host.destroy();
      }
    },
  );
});

/**
 * Git HTTP clone tests — verifies git can clone from a dumb HTTP server.
 *
 * Setup:
 * 1. Creates a bare git repo with one commit on the host filesystem
 * 2. Runs `git update-server-info` to generate dumb-HTTP metadata
 * 3. Serves the repo via a local Node.js HTTP server
 * 4. Wasm git clones from a host-only test alias
 *
 * The FetchNetworkBackend converts git's raw TCP socket operations into
 * fetch() calls. git-remote-http (fork+exec'd by git) handles the HTTP
 * transport protocol.
 */
describe.skipIf(!hasGit || !hasGitRemoteHttp)("Git HTTP clone", () => {
  let httpServer: Server;
  let httpPort: number;
  let tmpBase: string;
  let guestRoot: string;
  const hostAlias = "kandelo-host.test";

  beforeAll(async () => {
    tmpBase = mkdtempSync(join(tmpdir(), "kandelo-git-http-"));
    guestRoot = join(tmpBase, "guest");
    mkdirSync(guestRoot);
    const workDir = `${tmpBase}/work`;
    const bareRepoDir = `${tmpBase}/repo.git`;

    const gitOpts = {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_COMMITTER_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    };

    execSync(`git init "${workDir}"`, gitOpts);
    execSync(`echo "hello from kandelo" > "${workDir}/test.txt"`, gitOpts);
    execSync(`git -C "${workDir}" add test.txt`, gitOpts);
    execSync(`git -C "${workDir}" commit -m "initial commit"`, gitOpts);
    execSync(`git clone --bare "${workDir}" "${bareRepoDir}"`, gitOpts);
    execSync(`git -C "${bareRepoDir}" repack -ad`, gitOpts);
    execSync(`git -C "${bareRepoDir}" update-server-info`, gitOpts);

    // Serve the bare repo as static files (dumb HTTP protocol)
    httpServer = createServer((req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      const filePath = join(bareRepoDir, urlPath);
      try {
        if (!existsSync(filePath)) {
          res.writeHead(404);
          res.end("Not found\n");
          return;
        }
        const stat = statSync(filePath);
        if (stat.isDirectory()) {
          res.writeHead(404);
          res.end("Not found\n");
          return;
        }
        const data = readFileSync(filePath);
        res.writeHead(200);
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end("Not found\n");
      }
    });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    httpPort = (httpServer.address() as any).port;
  });

  afterAll(() => {
    httpServer?.close();
    try {
      rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it(
    "clones a repository via HTTP (dumb protocol)",
    { timeout: 60_000 },
    async () => {
      const io = createOwnedGuestIo(guestRoot);
      io.network = new FetchNetworkBackend({
        hostAliases: { [hostAlias]: "127.0.0.1" },
      });

      const cloneDir = `/clone-${Date.now()}`;
      const cloneHostDir = join(guestRoot, cloneDir.slice(1));

      // Git's prepare_cmd() resolves helper commands via locate_in_PATH(),
      // which uses access() against the host filesystem.  We create a
      // temporary GIT_EXEC_PATH with placeholder executables so that
      // access() succeeds, then register those paths in execPrograms so
      // the kernel's exec handler maps them to the correct .wasm binary.
      const gitExecPath = "/exec";
      const hostGitExecPath = join(guestRoot, "exec");
      mkdirSync(hostGitExecPath, { recursive: true });
      writeFileSync(join(hostGitExecPath, "git-remote-http"), "placeholder", {
        mode: 0o755,
      });
      // Also create a "git" placeholder so git can re-exec itself
      writeFileSync(join(hostGitExecPath, "git"), "placeholder", {
        mode: 0o755,
      });

      const execPrograms = new Map<string, string>([
        [`${gitExecPath}/git-remote-http`, gitRemoteHttpBinary!],
        [`${gitExecPath}/git`, gitBinary!],
        // Fallback paths git may also try
        ["/usr/libexec/git-core/git-remote-http", gitRemoteHttpBinary!],
        ["/usr/bin/git-remote-http", gitRemoteHttpBinary!],
        ["/usr/bin/git", gitBinary!],
      ]);

      const cloneEnv = [...gitEnv, `GIT_EXEC_PATH=${gitExecPath}`];

      const result = await runCentralizedProgram({
        programPath: gitBinary!,
        argv: ["git", "clone", `http://${hostAlias}:${httpPort}/`, cloneDir],
        env: cloneEnv,
        io,
        execPrograms,
        timeout: 60_000,
      });

      const output = result.stdout + result.stderr;
      if (result.exitCode !== 0) {
        console.error("Git clone failed with exit code:", result.exitCode);
        console.error("stdout:", result.stdout);
        console.error("stderr:", result.stderr);
      }
      expect(result.exitCode).toBe(0);
      expect(output).toContain("Cloning into");

      // Verify the cloned repo has the expected file
      expect(existsSync(join(cloneHostDir, ".git"))).toBe(true);
      const testFile = readFileSync(join(cloneHostDir, "test.txt"), "utf-8");
      expect(testFile.trim()).toBe("hello from kandelo");

      // Cleanup
      try {
        rmSync(cloneHostDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  );
});
