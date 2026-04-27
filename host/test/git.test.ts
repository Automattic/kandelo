/**
 * Tests for Git 2.47.1 running on the wasm-posix-kernel.
 *
 * Git is built with full asyncify for fork() support so that
 * subprocesses (git gc --auto, git-remote-http, index-pack) work correctly.
 *
 * Each runCentralizedProgram call creates a fresh kernel instance,
 * but the host filesystem persists, so we use unique temp dirs.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { existsSync, rmSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { runCentralizedProgram } from "./centralized-test-helper";
import { NodePlatformIO } from "../src/platform/node";
import { FetchNetworkBackend } from "../src/networking/fetch-backend";
import { tryResolveBinary } from "../src/binary-resolver";

const gitBinary = tryResolveBinary("programs/git/git.wasm");
const gitRemoteHttpBinary = tryResolveBinary("programs/git/git-remote-http.wasm");

const hasGit = !!gitBinary;
const hasGitRemoteHttp = !!gitRemoteHttpBinary;

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

  it("creates a commit without spurious help output (asyncify fork)", { timeout: 30_000 }, async () => {
    // git commit triggers fork+exec for `git gc --auto`. Without asyncify,
    // the fork child restarts from _start() with empty argv and prints help.
    const dir = `/tmp/git-commit-test-${Date.now()}`;
    // Init repo on host filesystem first
    const initResult = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "init", dir],
      env: gitEnv,
      timeout: 15_000,
    });
    expect(initResult.exitCode).toBe(0);
    // Commit with fork
    const result = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "-C", dir, "commit", "--allow-empty", "-m", "test commit"],
      env: gitEnv,
      timeout: 20_000,
    });
    expect(result.exitCode).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain("test commit");
    expect(output).not.toContain("usage: git");
  });
});

/**
 * Git HTTP clone tests — verifies git can clone from a dumb HTTP server.
 *
 * Setup:
 * 1. Creates a bare git repo with one commit on the host filesystem
 * 2. Runs `git update-server-info` to generate dumb-HTTP metadata
 * 3. Serves the repo via a local Node.js HTTP server
 * 4. Wasm git clones from http://localhost:<port>/
 *
 * The FetchNetworkBackend converts git's raw TCP socket operations into
 * fetch() calls. git-remote-http (fork+exec'd by git) handles the HTTP
 * transport protocol.
 */
describe.skipIf(!hasGit || !hasGitRemoteHttp)("Git HTTP clone", () => {
  let httpServer: Server;
  let httpPort: number;
  let tmpBase: string;

  beforeAll(async () => {
    tmpBase = `/tmp/git-http-test-${Date.now()}`;
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
    execSync(`echo "hello from wasm-posix-kernel" > "${workDir}/test.txt"`, gitOpts);
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
    try { rmSync(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("clones a repository via HTTP (dumb protocol)", { timeout: 60_000 }, async () => {
    const io = new NodePlatformIO();
    (io as any).network = new FetchNetworkBackend();

    const cloneDir = `/tmp/git-clone-http-${Date.now()}`;

    // Git's prepare_cmd() resolves helper commands via locate_in_PATH(),
    // which uses access() against the host filesystem.  We create a
    // temporary GIT_EXEC_PATH with placeholder executables so that
    // access() succeeds, then register those paths in execPrograms so
    // the kernel's exec handler maps them to the correct .wasm binary.
    const gitExecPath = `${tmpBase}/exec`;
    mkdirSync(gitExecPath, { recursive: true });
    writeFileSync(join(gitExecPath, "git-remote-http"), "placeholder", { mode: 0o755 });
    // Also create a "git" placeholder so git can re-exec itself
    writeFileSync(join(gitExecPath, "git"), "placeholder", { mode: 0o755 });

    const execPrograms = new Map<string, string>([
      [`${gitExecPath}/git-remote-http`, gitRemoteHttpBinary!],
      [`${gitExecPath}/git`, gitBinary!],
      // Fallback paths git may also try
      ["/usr/libexec/git-core/git-remote-http", gitRemoteHttpBinary!],
      ["/usr/bin/git-remote-http", gitRemoteHttpBinary!],
      ["/usr/bin/git", gitBinary!],
    ]);

    const cloneEnv = [
      ...gitEnv,
      `GIT_EXEC_PATH=${gitExecPath}`,
    ];

    const result = await runCentralizedProgram({
      programPath: gitBinary!,
      argv: ["git", "clone", `http://localhost:${httpPort}/`, cloneDir],
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
    expect(existsSync(join(cloneDir, ".git"))).toBe(true);
    const testFile = readFileSync(join(cloneDir, "test.txt"), "utf-8");
    expect(testFile.trim()).toBe("hello from wasm-posix-kernel");

    // Cleanup
    try { rmSync(cloneDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

