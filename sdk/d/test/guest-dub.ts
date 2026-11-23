import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ABI_CONTRACT_SECTION, readWasmCustomSectionPayload } from "../../../host/src/constants";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import { readRustCompilerJob as readGuestJob } from "../../../host/test/fixtures/rust-guest-job";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";
import { installGuestToolchain } from "../../../images/vfs/scripts/build-kandelo-build-image";
import { walkAndWrite } from "../../../images/vfs/scripts/vfs-image-helpers";

const args = process.argv.slice(2);
if (args.length !== 4) {
  console.error("Usage: guest-dub.ts <kernel.wasm> <kandelo-sdk.zip> <wasm-fork-instrument.wasm> <guest D usr tree>");
  process.exit(2);
}
const [kernelFile, cSdk, instrumenter, dSdk] = args;
const bytes = (path: string | URL) => Uint8Array.from(readFileSync(path));
const kernel = bytes(kernelFile).buffer;
const kernelAbi = readWasmCustomSectionPayload(kernel, ABI_CONTRACT_SECTION);
assert.equal(kernelAbi?.byteLength, 32, "kernel is missing its program ABI contract");

const fs = KandeloImageFs.create();
fs.setImageCapacity(1024 ** 3);
fs.mkdir("/usr", 0o755);
fs.mkdir("/usr/bin", 0o755);
fs.mkdir("/root", 0o755);
fs.mkdir("/tmp", 0o1777);
fs.mkdir("/work", 0o755);
installGuestToolchain(fs, bytes(cSdk));
fs.writeFile("/usr/bin/wasm-fork-instrument", bytes(instrumenter), 0o755);
walkAndWrite(fs, dSdk, "/usr", { preserveMode: true, preserveSymlinks: true });
walkAndWrite(fs, fileURLToPath(new URL("dub-project", import.meta.url)), "/work");
fs.writeFile("/work/quad_precision.d", bytes(new URL("quad_precision.d", import.meta.url)), 0o644);

let commandNumber = 0;
async function run(host: NodeKernelHost, argv: string[]) {
  const id = `d-guest-${++commandNumber}`;
  const timeoutMs = 600_000;
  console.log(argv.join(" "));
  const { exit } = await host.spawnFromVfs(argv[0], argv, {
    cwd: "/work",
    env: ["PATH=/usr/bin:/bin", "HOME=/root", "TMPDIR=/tmp"],
    ownedJob: { id, timeoutMs },
  });
  void exit.catch(() => {});
  const result = await readGuestJob(host, id, timeoutMs + 30_000);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  assert.equal(result.status, "completed");
  assert.equal(result.exitCode, 0, argv.join(" "));
  return result;
}

const dub = (host: NodeKernelHost, ...args: string[]) => run(host, ["/usr/bin/dub", ...args]);
const assertProgramAbi = async (host: NodeKernelHost, path: string) => {
  const program = await host.readFileFromVfs(path);
  assert(program, `${path} is missing`);
  const programAbi = readWasmCustomSectionPayload(Uint8Array.from(program).buffer, ABI_CONTRACT_SECTION);
  assert.deepEqual(programAbi, kernelAbi, `${path} has a different program ABI contract`);
};

const image = await fs.saveImage();
const online = new NodeKernelHost({ rootfsImage: image, maxWorkers: 10, enableTcpNetwork: true });
let cachedImage: Uint8Array;
try {
  await online.init(kernel.slice(0));
  const version = await run(online, ["/usr/bin/ldc2", "--version"]);
  assert.match(version.stdout, /Default target: wasm32-unknown-kandelo-musl/);
  await run(online, ["/usr/bin/ldc2", "-o-", "quad_precision.d"]);
  const fetch = await dub(online, "fetch", "taggedalgebraic@1.0.1", "--verbose");
  assert.match(fetch.stdout, /1 packages fetched, 0 already present, 0 failed/);
  const build = await dub(online, "run", "--verbose");
  assert.match(build.stdout, /DUB guest result 42/);
  const test = await dub(online, "test", "--verbose");
  assert.match(test.stdout, /DUB dependency unittest passed/);
  await assertProgramAbi(online, "/work/kandelo-dub-check.wasm");
  await assertProgramAbi(online, "/work/kandelo-dub-check-test-application.wasm");
  cachedImage = await online.exportRootfsImage();
} finally {
  await online.destroy();
}

const offline = new NodeKernelHost({ rootfsImage: cachedImage, maxWorkers: 10, offlineEgressLink: true });
try {
  await offline.init(kernel.slice(0));
  const rebuild = await dub(offline, "run", "--skip-registry=all", "--force", "--verbose");
  assert.match(rebuild.stdout, /Building taggedalgebraic 1\.0\.1/);
  assert.match(rebuild.stdout, /DUB guest result 42/);
  await assertProgramAbi(offline, "/work/kandelo-dub-check.wasm");
} finally {
  await offline.destroy();
}
