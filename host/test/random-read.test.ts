import { join } from "node:path";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { NodeKernelHost } from "../src/node-kernel-host";
import { runCentralizedProgram } from "./centralized-test-helper";

it("reads random devices across host entropy quotas as uid 1000", async () => {
  const result = await runCentralizedProgram({
    programPath: join(import.meta.dirname, "../../examples/random_read_test.wasm"),
    argv: ["random-read-test"],
    useDefaultRootfs: false,
    timeout: 30_000,
  });
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain("RANDOM_READ_PASS uid=1000");
  expect(result.stderr).toBe("");
}, 40_000);

it.each([
  ["--interrupt", "RANDOM_INTERRUPT_PASS"],
  ["--pending-exit", "RANDOM_PENDING_EXIT"],
])("retires pending entropy through %s", async (mode, marker) => {
  const result = await runCentralizedProgram({
    programPath: join(import.meta.dirname, "../../examples/random_read_test.wasm"),
    argv: ["random-read-test", mode], useDefaultRootfs: false, timeout: 30_000,
  });
  expect(result.exitCode, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toContain(marker);
  expect(result.stderr).toBe("");
}, 40_000);

it("keeps kernel memory flat as entropy reads grow and repeat", async () => {
  const pages: number[] = [];
  let output = "";
  let failure: unknown;
  let checks = Promise.resolve();
  const host = new NodeKernelHost({
    onStdout: (pid, bytes) => {
      output += new TextDecoder().decode(bytes);
      const phases = [...output.matchAll(/RANDOM_MEMORY_PHASE (\d+)\n/g)].length;
      while (pages.length < phases) {
        // Reserve the slot synchronously; callbacks can contain several lines.
        const index = pages.length;
        pages.push(-1);
        checks = checks.then(async () => {
          pages[index] = await host.getKernelMemoryPages();
          host.appendStdinData(pid, new Uint8Array([1]));
        }).catch(error => { failure = error; });
      }
    },
    onStderr: (_pid, bytes) => { output += new TextDecoder().decode(bytes); },
  });
  try {
    await host.init();
    const bytes = new Uint8Array(readFileSync(join(import.meta.dirname, "../../examples/random_read_test.wasm")));
    const exitCode = await host.spawn(bytes.buffer,
      ["random-read-test", "--memory"], { onStarted: () => {} });
    expect(exitCode, output).toBe(0);
    await checks;
    expect(failure).toBeUndefined();
    expect(pages).toHaveLength(5);
    expect(Math.max(...pages.slice(1)), JSON.stringify(pages)).toBeLessThanOrEqual(pages[0] + 4);
    expect(pages[4], JSON.stringify(pages)).toBe(pages[3]);
  } finally { await host.destroy(); }
}, 120_000);

it("copies large random blocks with canonical shell dd as uid 1000", async () => {
  const coreutils = new Uint8Array(readFileSync(resolveBinary("programs/wasm32/coreutils.wasm")));
  let output = "";
  const host = new NodeKernelHost({
    rootfsImage: new Uint8Array(readFileSync(resolveBinary("programs/wasm32/shell.vfs.zst"))),
    rootfsLazyUrlBase: "https://kandelo.invalid/",
    rootfsLazyAssets: [{
      url: "https://kandelo.invalid/binaries/programs/wasm32/coreutils.wasm",
      sha256: createHash("sha256").update(coreutils).digest("hex"),
      size: coreutils.byteLength,
      bytes: coreutils,
    }],
    onStdout: (_pid, data) => { output += new TextDecoder().decode(data); },
    onStderr: (_pid, data) => { output += new TextDecoder().decode(data); },
  });
  try {
    await host.init();
    const run = async (script: string, uid: number) => {
      const { exit } = await host.spawnFromVfs("/bin/bash", ["bash", "-ec", script], {
        uid, gid: uid, env: ["PATH=/usr/bin:/bin"],
      });
      expect(await exit, output).toBe(0);
    };
    await run("mkdir -p /run/user/1000; chown 1000:1000 /run/user/1000", 0);
    await run(`
      for size in 65536 1048576 65537 3145757; do
        dd if=/dev/urandom of=/run/user/1000/random bs=$size count=1
        test "$(stat -c %s /run/user/1000/random)" = "$size"
      done
      rm /run/user/1000/random
      printf 'RANDOM_DD_PASS\\n'
    `, 1000);
    expect(output).toContain("RANDOM_DD_PASS");
    expect(output.match(/1\+0 records in/g)).toHaveLength(4);
    expect(output.match(/1\+0 records out/g)).toHaveLength(4);
  } finally {
    await host.destroy();
  }
}, 60_000);
