import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "../../apps/browser-demos/playwright-test";
import { resolveBinary } from "../../host/src/binary-resolver";
import { NodeKernelHost } from "../../host/src/node-kernel-host";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";

const artifacts = process.env.KANDELO_ZIG_TEST_ARTIFACTS;
if (!artifacts) throw new Error("Set KANDELO_ZIG_TEST_ARTIFACTS to the built Zig test directory");

const timeoutMs = 45_000;
const env = ["PATH=/", "HOME=/"];
const cases = [
  { name: "fs" },
  { name: "thread" },
  { name: "process" },
  { name: "threaded-io" },
  { name: "posix" },
  { name: "smoke" },
  { name: "spawn", args: ["/zig-child"] },
  { name: "spawn", args: ["/zig-child", "/tmp"], cwd: "/tmp" },
];

for (const { name, args, cwd } of cases) {
  const executable = `/zig-${name}`;
  const argv = [executable, ...(args ?? [])];
  const label = cwd ? `${name} with a relative child path` : name;

  async function readArtifacts() {
    const program = new Uint8Array(await readFile(join(artifacts!, `${name}.wasm`)));
    const child = args ? await readFile(join(artifacts!, "child.wasm")) : null;
    return { program, child, argv, cwd };
  }

  async function check(result: { exitCode: number; stdout: string; stderr: string }) {
    const output = result.stdout + result.stderr;
    await test.info().attach("guest output", { body: output, contentType: "text/plain" });
    expect(result.exitCode, output).toBe(0);
    if (name === "smoke") {
      expect(result.stdout).toContain("Zig SDK smoke passed");
    } else if (!args) {
      // The upstream runner emits the result for every test and its summary.
      expect(output).toMatch(/\b(?:All [1-9]\d* tests? passed|[1-9]\d* passed; \d+ skipped; 0 failed)\./);
    }
  }

  test(`Node | ${label}`, async () => {
    const { program, child } = await readArtifacts();
    const fs = KandeloImageFs.create(await readFile(resolveBinary("kandelo_image_module32.wasm")));
    let rootfsImage: Uint8Array;
    try {
      fs.mkdir("/tmp", 0o1777);
      fs.createFileWithOwner(executable, 0o755, 0, 0, program);
      if (child) fs.createFileWithOwner("/zig-child", 0o755, 0, 0, child);
      rootfsImage = await fs.saveImage();
    } finally {
      fs.reset();
    }
    let stdout = "";
    let stderr = "";
    const host = new NodeKernelHost({
      rootfsImage,
      onStdout: (_pid, bytes) => { stdout += Buffer.from(bytes).toString(); },
      onStderr: (_pid, bytes) => { stderr += Buffer.from(bytes).toString(); },
    });
    await host.init();
    try {
      const exitCode = await host.spawn(program.buffer, argv, { cwd, env });
      await check({ exitCode, stdout, stderr });
    } finally {
      await host.destroy();
    }
  });

  test(`Browser | ${label}`, async ({ page }) => {
    const { program, child } = await readArtifacts();
    await page.goto("/pages/test-runner/?minimal=1");
    await page.waitForFunction(() => window.__testRunnerReady === true);
    const result = await page.evaluate(
      async ({ bytes, childBytes, argv, cwd, env, timeoutMs }) => {
        const dataFiles = [
          { path: argv[0], useWasmBytes: true },
          { path: "/tmp/.fixture", data: [] },
        ];
        return window.__runTest(Uint8Array.from(bytes).buffer, argv, timeoutMs, {
          cwd,
          env,
          seedEtc: false,
          dataFiles: childBytes
            ? [...dataFiles, { path: "/zig-child", data: childBytes }]
            : dataFiles,
        });
      },
      {
        bytes: Array.from(program),
        childBytes: child ? Array.from(child) : null,
        argv,
        cwd,
        env,
        timeoutMs,
      },
    );
    await check(result);
  });
}
