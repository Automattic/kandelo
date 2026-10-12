import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { NodeKernelHost } from "../../../host/src/node-kernel-host.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";

const [programPath, kernelPath, pwdPath, filter, skipFilter, sourcePackage = "os"] = process.argv.slice(2);
if (!programPath || !kernelPath || !pwdPath || !filter) {
  throw new Error("usage: node --import tsx run-full-vfs.ts <test.wasm> <kernel.wasm> <pwd.wasm> <test-filter> [skip-filter] [source-package]");
}

const programBytes = readFileSync(programPath);
const pwdBytes = readFileSync(pwdPath);
const goSourceRoot = resolve("../go-kandelo/src", sourcePackage);
const image = KandeloImageFs.create();
image.setImageCapacity(32 * 1024 * 1024);
for (const directory of [
  "/bin", "/tmp", "/etc", "/usr", "/usr/bin", "/work", "/work/exec",
  "/work/testdata", "/work/testdata/dirfs", "/work/testdata/dirfs/dir",
  "/work/testdata/issue37161",
]) {
  image.mkdir(directory, 0o755);
}
image.createFileWithOwner("/bin/os-test.wasm", 0o755, 0, 0, new Uint8Array(programBytes));
image.createFileWithOwner("/bin/pwd", 0o755, 0, 0, new Uint8Array(pwdBytes));
for (const name of readdirSync(goSourceRoot).filter((name) => name.endsWith(".go"))) {
  image.createFileWithOwner(`/work/${name}`, 0o644, 0, 0, new Uint8Array(readFileSync(resolve(goSourceRoot, name))));
}
if (sourcePackage === "os") {
  for (const name of [
    "hello", "dirfs/a", "dirfs/b", "dirfs/dir/x",
    "issue37161/a", "issue37161/b", "issue37161/c",
  ]) {
    image.createFileWithOwner(`/work/testdata/${name}`, 0o644, 0, 0, new Uint8Array(readFileSync(resolve(goSourceRoot, "testdata", name))));
  }
}
if (sourcePackage === "archive/tar") {
  for (const name of readdirSync(resolve(goSourceRoot, "testdata"))) {
    image.createFileWithOwner(`/work/testdata/${name}`, 0o644, 0, 0, new Uint8Array(readFileSync(resolve(goSourceRoot, "testdata", name))));
  }
}
for (const [name, contents] of [
  ["passwd", "root:x:0:0:Root:/root:/bin/sh\n"],
  ["group", "root:x:0:\n"],
  ["hosts", "127.0.0.1 localhost\n"],
]) {
  image.createFileWithOwner(`/etc/${name}`, 0o644, 0, 0, new TextEncoder().encode(contents));
}

let stdout = "";
let stderr = "";
const diagnostics: unknown[] = [];
const syscallTrace: unknown[] = [];
const host = new NodeKernelHost({
  rootfsImage: new Uint8Array(await image.saveImage()),
  rootfsMountSpec: process.env.KANDELO_GO_IMAGE_TMP === "1" ? [{ path: "/", source: "image" }] : undefined,
  onStdout: (_pid, data) => { stdout += new TextDecoder().decode(data); },
  onStderr: (_pid, data) => { stderr += new TextDecoder().decode(data); },
  onHostDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
});
let unsubscribe = () => {};
try {
  const kernelBytes = readFileSync(kernelPath);
  await host.init(kernelBytes.buffer.slice(
    kernelBytes.byteOffset,
    kernelBytes.byteOffset + kernelBytes.byteLength,
  ) as ArrayBuffer);
  if (process.env.KANDELO_GO_TRACE === "1") {
    unsubscribe = host.subscribeSyscalls((event) => {
      if (event.nr === 40) return;
      syscallTrace.push(event);
      if (syscallTrace.length > 2000) syscallTrace.shift();
    });
  }
  const { exit } = await host.spawnFromVfs(
    "/bin/os-test.wasm",
    [sourcePackage === "os/exec" ? "/bin/os-test.wasm" : "go-os-test", `-test.run=${filter}`, ...(skipFilter ? [`-test.skip=${skipFilter}`] : []), ...(process.env.KANDELO_GO_SHORT === "1" ? ["-test.short"] : []), "-test.v"],
    { cwd: "/work", env: ["PATH=/bin:/usr/bin"] },
  );
  const timeout = Number(process.env.KANDELO_GO_TEST_TIMEOUT_MS ?? 180_000);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const exitCode = await Promise.race([
    exit,
    new Promise<number>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Go os VFS suite timed out")), timeout);
    }),
  ]).finally(() => clearTimeout(timeoutHandle));
  console.log(JSON.stringify(
    { exitCode, stdout, stderr, diagnostics, syscallTrace: process.env.KANDELO_GO_TRACE === "1" ? syscallTrace.slice(-40) : undefined },
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
  ));
  if (exitCode !== 0 || !stdout.includes("PASS\n") || stderr !== "" || diagnostics.length !== 0) {
    process.exitCode = 1;
  }
} catch (error) {
  console.log(JSON.stringify(
    { exitCode: -1, stdout, stderr, diagnostics, syscallTrace, error: String(error) },
    (_key, value) => typeof value === "bigint" ? value.toString() : value,
  ));
  process.exitCode = 1;
} finally {
  unsubscribe();
  await host.destroy();
}
