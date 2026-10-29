/** Optional real-artifact acceptance for the packaged Bun execution path.
 * Supply CLAUDE_BUN_ELF explicitly; the upstream binary is not vendored.
 * Synthetic shell tests cover the normal path without this large input.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { runCentralizedProgram } from "./centralized-test-helper";

const executable = process.env.CLAUDE_BUN_ELF;

describe("packaged bun-run with a real Claude Code standalone", () => {
  it.runIf(executable !== undefined).each(["--version", "--help"])(
    "runs Claude %s as the ordinary guest user",
    async (argument) => {
      // Account for input growth across releases, plus extracted source and
      // runtime files. This fixture does not change the product memory budget.
      const fs = KandeloImageFs.create();
      fs.setImageCapacity(readFileSync(executable!).byteLength + 245 * 1024 * 1024);
      const image = await fs.saveImage();
      const launcher = resolveBinary("programs/bun-run/bun-run.wasm");
      const result = await runCentralizedProgram({
        programPath: launcher,
        argv: ["bun-run", "/usr/bin/claude", argument],
        uid: 1000, gid: 1000,
        env: ["HOME=/home/maker", "CLAUDE_CONFIG_DIR=/home/maker/.claude", "PATH=/usr/bin:/bin"],
        rootfsImage: image,
        execPrograms: new Map([
          ["/usr/bin/claude", executable!],
          ["/usr/bin/node", resolveBinary("programs/node.wasm")],
          ["/usr/bin/bun-extract", resolveBinary("programs/bun-run/bun-extract.wasm")],
          ["/usr/lib/kandelo/bun-run.js", resolveBinary("programs/bun-run/bun-run.js")],
          ["/bin/sh", resolveBinary("programs/bash.wasm")],
        ]),
        useDefaultRootfs: false,
        stdin: "",
        timeout: 120_000,
      });
      console.log("Claude", argument, "exit", result.exitCode, "stdout", result.stdout, "stderr", result.stderr);
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toMatch(argument === "--version"
        ? /2\.1\.\d+ \(Claude Code\)/ : /Usage: claude/);
    },
    150_000,
  );
});

// This acceptance uses a local protocol fixture, not a live model or account.
// It exercises the real CLI's startup, config writes, HTTP client and SSE path.
it.runIf(executable !== undefined)("runs a headless prompt against a local Messages API fixture", async () => {
  const { createHash } = await import("node:crypto");
  const { NodeKernelHost } = await import("../src/node-kernel-host");
  const lazyBase = "https://kandelo.invalid/";
  const assets = ([
    ["assets/programs/wasm32/node.zip", "programs/wasm32/node.zip"],
    ["assets/programs/wasm32/coreutils.wasm", "programs/coreutils.wasm"],
    ["assets/programs/wasm32/git/git.wasm", "programs/git/git.wasm"],
    ["assets/programs/wasm32/curl.wasm", "programs/curl.wasm"],
  ] as const).map(([url, path]) => {
    const bytes = new Uint8Array(readFileSync(resolveBinary(path)));
    return { url: lazyBase + url, bytes, size: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex") };
  });
  let stdout = "", stderr = "";
  let readyResolve!: () => void;
  const ready = new Promise<void>(resolve => {readyResolve = resolve;});
  const host = new NodeKernelHost({
    rootfsImage:new Uint8Array(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst"))),
    rootfsLazyUrlBase: lazyBase,
    rootfsLazyAssets: assets,
    rootfsLazyAssetDirectory: lazyBase,
    onStdout:(_pid, bytes) => {
      stdout += new TextDecoder().decode(bytes);
      if (stdout.includes("claude-api-fixture-ready")) readyResolve();
    },
    onStderr:(_pid, bytes) => {stderr += new TextDecoder().decode(bytes);},
  });
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let serverPid: number | undefined;
  try {
    await host.init();
    await host.writeFileToVfs("/tmp/claude-native", new Uint8Array(readFileSync(executable!)));
    const serverPath = new URL("./fixtures/claude-api-fixture.wasm", import.meta.url);
    const timeout = new Promise<never>((_resolve,reject) => {
      timeoutId = setTimeout(() => reject(new Error("Claude fixture timed out")), 120_000);
    });
    const serverBytes = new Uint8Array(readFileSync(serverPath));
    const server = host.spawn(serverBytes.buffer, ["claude-api-fixture"], {
      uid:1000,gid:1000,stdin:new Uint8Array(),
      onStarted:pid => {serverPid = pid;},
    });
    await Promise.race([ready, timeout, server.then(code => {throw new Error(`API fixture exited ${code}`);})]);
    const {exit} = await host.spawnFromVfs("/usr/bin/bash", ["bash","-lc",
      'exec bun-run /tmp/claude-native --debug-file /tmp/claude-debug.log -p "say hi" --model claude-sonnet-4-6 --tools "" --no-session-persistence'], {
      uid:1000,gid:1000,cwd:"/home/maker",stdin:new Uint8Array(),
      env:["PATH=/usr/local/bin:/usr/bin:/bin","HOME=/home/maker","USER=maker","TERM=dumb","TMPDIR=/tmp",
        "CLAUDE_CONFIG_DIR=/home/maker/.claude","ANTHROPIC_API_KEY=sk-ant-kandelo-local-fixture",
        "ANTHROPIC_BASE_URL=http://127.0.0.1:34321","CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"],
    });
    const status = await Promise.race([exit,timeout]);
    console.log("HEADLESS stdout",stdout,"stderr",stderr);
    expect(status,`${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain("claude-api-fixture-messages");
    expect(stdout).toContain("claude-api-fixture-stream");
    expect(stdout).not.toContain("claude-api-fixture-nonstream");
    expect(stdout).toContain("kandelo-mock-response");
    const config = await host.readFileFromVfs("/home/maker/.claude/.claude.json");
    expect(config).not.toBeNull();
    expect(() => JSON.parse(new TextDecoder().decode(config!))).not.toThrow();
  } finally {
    clearTimeout(timeoutId);
    try {
      const debug = await host.readFileFromVfs("/tmp/claude-debug.log");
      if(debug) console.log("HEADLESS DEBUG",new TextDecoder().decode(debug).slice(-16000));
    } catch { /* Preserve the original startup failure if the host is gone. */ }
    if(serverPid!==undefined) await host.signalProcess(serverPid,15).catch(()=>false);
    await host.destroy();
  }
}, 150_000);
