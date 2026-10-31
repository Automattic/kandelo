import { expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { NodeKernelHost } from "../../../../host/src/node-kernel-host";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../../..");

// A libcrypto configured with `no-threads` passes single-threaded tests and
// then corrupts its global property and decoder state when a threaded client
// decodes keys from several threads at once (musl's allocator traps on the
// damaged heap). Exercise the library the way such a client does.
it("decodes keys concurrently from several pthreads", async () => {
  const temp = mkdtempSync(join(tmpdir(), "kandelo-openssl-threads-"));
  let output = "";
  const record = (_pid: number, bytes: Uint8Array) => { output += new TextDecoder().decode(bytes); };
  const host = new NodeKernelHost({ onStdout: record, onStderr: record });
  try {
    // Enter through the resolver, including its active cache policy and
    // receipt checks; never scan caches or assume a staged library prefix.
    const xtask = process.env.WASM_POSIX_XTASK_BIN;
    const command = xtask ?? "cargo";
    const hostTarget = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)![1];
    const prefix = xtask ? [] : ["run", "-p", "xtask", "--target", hostTarget, "--quiet", "--"];
    const openssl = execFileSync(command, [...prefix, "build-deps", "resolve", "openssl", "--arch", "wasm32"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim().split("\n").at(-1)!;
    const configuration = readFileSync(join(openssl, "include/openssl/configuration.h"), "utf8");
    expect(configuration, "OpenSSL must be configured with thread support").toMatch(/#\s*define OPENSSL_THREADS\b/);
    const wasm = join(temp, "threads.wasm");
    execFileSync(join(root, "sdk/bin/wasm32posix-cc"), [
      "-O2", `-I${openssl}/include`, join(here, "threads.c"), `-L${openssl}/lib`,
      "-lssl", "-lcrypto", "-lpthread", "-o", `${wasm}.linked`,
    ], { cwd: root, stdio: "inherit" });
    execFileSync("bash", [join(root, "scripts/run-wasm-fork-instrument.sh"), `${wasm}.linked`, "-o", wasm],
      { cwd: root, stdio: "inherit" });
    execFileSync(command, [...prefix, "stamp-abi-contract", wasm], { cwd: root, stdio: "inherit" });
    await host.init();
    const bytes = readFileSync(wasm);
    // The race is timing dependent; several runs make a silent pass unlikely.
    for (let run = 0; run < 3; run++) {
      output = "";
      const status = await host.spawn(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        ["openssl-threads"]);
      expect({ status, output }).toEqual({ status: 0, output: expect.stringContaining("OPENSSL_THREADS_OK") });
    }
  } finally {
    host.destroy();
    rmSync(temp, { recursive: true, force: true });
  }
}, 300_000);
