#!/usr/bin/env tsx
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const BROWSER_DIR = resolve(REPO_ROOT, "apps/browser-demos");
const VFS_IMAGE = resolve(BROWSER_DIR, "public/sqlite-test.vfs.zst");
const VITE_HOST = "127.0.0.1";
const VITE_BASE_PORT = Number(process.env.SQLITE_TEST_VITE_PORT ?? 5200);
const SQLITE_TEST_UID = Number(process.env.SQLITE_TEST_UID ?? 1000);
const SQLITE_TEST_GID = Number(process.env.SQLITE_TEST_GID ?? 1000);

interface BrowserArtifact {
  path: string;
  base64: string;
}

interface BrowserSqliteResult {
  test: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
  durationMs: number;
  artifacts?: BrowserArtifact[];
}

interface BrowserArtifactSnapshot {
  durationMs: number;
  artifacts?: BrowserArtifact[];
}

interface PersistedArtifactSnapshot {
  source: string;
  durationMs: number;
  artifacts?: BrowserArtifact[];
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once("error", () => resolvePromise(false));
    server.once("listening", () => {
      server.close(() => resolvePromise(true));
    });
    server.listen(port, VITE_HOST);
  });
}

async function findVitePort(): Promise<number> {
  for (let port = VITE_BASE_PORT; port < VITE_BASE_PORT + 50; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available Vite port found starting at ${VITE_BASE_PORT}`);
}

async function startViteServer(port: number): Promise<ChildProcess> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "npx",
      [
        "vite",
        "--config", resolve(BROWSER_DIR, "vite.config.ts"),
        "--host", VITE_HOST,
        "--port", String(port),
        "--strictPort",
      ],
      {
        cwd: BROWSER_DIR,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          KANDELO_BROWSER_DEMO_INPUTS: "sqlite-test",
          KANDELO_BROWSER_TEST_NO_HMR: "1",
        },
      },
    );
    let started = false;
    const timeout = setTimeout(() => {
      if (!started) {
        proc.kill();
        reject(new Error("Vite server did not start within 30s"));
      }
    }, 30_000);
    proc.stdout!.on("data", (data: Buffer) => {
      const text = data.toString();
      process.stderr.write(`[vite] ${text}`);
      if (!started && text.includes("Local:")) {
        started = true;
        clearTimeout(timeout);
        setTimeout(() => resolvePromise(proc), 500);
      }
    });
    proc.stderr!.on("data", (data: Buffer) => process.stderr.write(`[vite] ${data}`));
    proc.on("exit", (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`Vite exited with code ${code}`));
      }
    });
  });
}

function writeArtifacts(resultsDir: string, artifacts: BrowserArtifact[] | undefined): void {
  if (!resultsDir || !artifacts) return;
  mkdirSync(resultsDir, { recursive: true });
  for (const artifact of artifacts) {
    const basename = artifact.path.split("/").pop();
    if (!basename) continue;
    writeFileSync(resolve(resultsDir, basename), Buffer.from(artifact.base64, "base64"));
  }
}

function writeArtifactSnapshotMetadata(resultsDir: string, snapshot: PersistedArtifactSnapshot): void {
  if (!resultsDir) return;
  mkdirSync(resultsDir, { recursive: true });
  writeFileSync(resolve(resultsDir, "artifact-snapshot.json"), `${JSON.stringify({
    writtenAt: new Date().toISOString(),
    source: snapshot.source,
    durationMs: snapshot.durationMs,
    artifactCount: snapshot.artifacts?.length ?? 0,
    artifactPaths: snapshot.artifacts?.map((artifact) => artifact.path) ?? [],
  }, null, 2)}\n`);
}

async function main() {
  const argv = process.argv.slice(2);
  let timeoutMs = 600_000;
  let resultsDir = "";
  const command: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--timeout-ms") {
      timeoutMs = Number(argv[++i]);
    } else if (argv[i] === "--results-dir") {
      resultsDir = resolve(argv[++i]);
    } else {
      command.push(argv[i]);
    }
  }
  if (command.length === 0) {
    console.error("Usage: browser-sqlite-official-runner.ts [--timeout-ms N] testfixture-argv...");
    process.exit(1);
  }

  if (!existsSync(VFS_IMAGE) || process.env.SQLITE_OFFICIAL_REBUILD_VFS === "1") {
    await new Promise<void>((resolveDone, reject) => {
      const proc = spawn("bash", [resolve(REPO_ROOT, "images/vfs/scripts/build-sqlite-test-vfs-image.sh")], {
        cwd: REPO_ROOT,
        stdio: "inherit",
        env: { ...process.env },
      });
      proc.on("exit", (code) => code === 0 ? resolveDone() : reject(new Error(`VFS build exited ${code}`)));
    });
  }

  let vite: ChildProcess | null = null;
  let browser: Browser | null = null;
  let latestArtifacts: BrowserArtifact[] | undefined;
  let latestSnapshot: BrowserArtifactSnapshot | undefined;
  try {
    const vitePort = await findVitePort();
    vite = await startViteServer(vitePort);
    browser = await chromium.launch({ args: ["--enable-features=SharedArrayBuffer"] });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.exposeFunction("__sqliteArtifactSnapshot", (snapshot: BrowserArtifactSnapshot) => {
      if (snapshot.artifacts?.length) {
        latestArtifacts = snapshot.artifacts;
        latestSnapshot = snapshot;
      }
    });
    page.on("console", (msg) => {
      if (msg.text().startsWith("[sqlite-progress]")) {
        console.error(`[browser] ${msg.text()}`);
      } else if (msg.type() === "error" || msg.type() === "warning") {
        console.error(`[browser:${msg.type()}] ${msg.text()}`);
      }
    });
    page.on("pageerror", (err) => {
      console.error(`[browser:pageerror] ${err.stack || err.message}`);
    });
    page.on("crash", () => {
      console.error("[browser:crash] page crashed");
    });
    page.on("close", () => {
      console.error("[browser:close] page closed");
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        console.error(`[browser:navigation] ${frame.url()}`);
      }
    });
    page.on("requestfailed", (request) => {
      const failure = request.failure();
      console.error(`[browser:requestfailed] ${request.url()} ${failure?.errorText ?? ""}`);
    });
    await page.goto(`http://${VITE_HOST}:${vitePort}/pages/sqlite-test/`);
    await page.waitForFunction(() => (window as any).__sqliteTestReady === true, {}, { timeout: 180_000 });
    let result: BrowserSqliteResult;
    try {
      result = await page.evaluate(
        ({ command, timeoutMs, uid, gid }) => (window as any).__runSqliteCommand(command, timeoutMs, { uid, gid }),
        { command, timeoutMs, uid: SQLITE_TEST_UID, gid: SQLITE_TEST_GID },
      );
    } catch (err) {
      writeArtifacts(resultsDir, latestArtifacts);
      writeArtifactSnapshotMetadata(resultsDir, {
        source: "evaluate-error-latest-periodic-snapshot",
        durationMs: latestSnapshot?.durationMs ?? 0,
        artifacts: latestArtifacts,
      });
      throw err;
    }
    let artifactSource = "post-teardown-result";
    if (!result.artifacts && latestArtifacts) {
      result.artifacts = latestArtifacts;
      artifactSource = "latest-periodic-snapshot";
    }
    writeArtifacts(resultsDir, result.artifacts);
    writeArtifactSnapshotMetadata(resultsDir, {
      source: artifactSource,
      durationMs: result.durationMs,
      artifacts: result.artifacts,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.error) process.stderr.write(`${result.error}\n`);
    process.exit(result.exitCode === 0 ? 0 : 1);
  } finally {
    await browser?.close().catch(() => {});
    if (vite) {
      vite.kill();
      await new Promise<void>((resolveDone) => {
        vite!.on("exit", () => resolveDone());
        setTimeout(resolveDone, 2000);
      });
    }
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
