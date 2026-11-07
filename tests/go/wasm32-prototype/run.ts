import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolveBinary } from "../../../host/src/binary-resolver.ts";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";

const result = await runCentralizedProgram({
  programPath: ".context/go-wasm32-prototype/runtime.wasm",
  kernelWasmBytes: readFileSync(resolveBinary("kernel.wasm")),
  timeout: 30000,
  useDefaultRootfs: false,
});
writeFileSync(".context/go-wasm32-prototype/node.json", JSON.stringify(result, null, 2) + "\n");
assert.equal(result.exitCode, 0, JSON.stringify(result));
assert.equal(result.stderr, "");
assert.deepEqual(result.hostDiagnostics, []);
const probe = JSON.parse(result.stdout);
assert.equal(probe.goos, "kandelo");
assert.equal(probe.goarch, "wasm32");
assert.equal(probe.checks.length, 9);
assert.deepEqual(probe.layout, {
  pointerBytes: 4, intBytes: 4, int64Align: 8,
  sampleBytes: 24, sampleAlign: 8, pointerOffset: 4,
  wideOffset: 8, chainOffset: 16, tailOffset: 20,
  alignedBytes: 24, alignedWideOffset: 8,
});
console.log("Kandelo/wasm32 runtime, layout and concurrent-M probe PASS");

const { KandeloImageFs } = await import("../../../images/vfs/lib/kandelo-image-fs.ts");
const image = KandeloImageFs.create();
image.setImageCapacity(2 * 1024 * 1024);
image.mkdir("/etc", 0o755);
image.mkdir("/tmp", 0o777);
image.createFileWithOwner("/etc/go-browser-input", 0o644, 0, 0, new TextEncoder().encode("browser fixture\n"));
const basic = await runCentralizedProgram({
  programPath: ".context/go-wasm32-prototype/basic.wasm",
  kernelWasmBytes: readFileSync(resolveBinary("kernel.wasm")),
  rootfsImage: await image.saveImage(),
  argv: ["go-basic", "alpha", "beta"],
  env: ["KANDELO_GO_BROWSER=present"],
  timeout: 30000,
});
writeFileSync(".context/go-wasm32-prototype/basic-node.json", JSON.stringify(basic, null, 2) + "\n");
assert.equal(basic.exitCode, 0, JSON.stringify(basic));
assert.equal(basic.stderr, "");
assert.deepEqual(basic.hostDiagnostics, []);
assert.match(basic.stdout, /GO BASIC PASS/);
console.log("Kandelo/wasm32 VFS, startup, clocks and randomness probe PASS");

if (process.env.KANDELO_GO_WASM32_CGO_TESTS === "1") {
  for (const [fixture, marker] of [
    ["cgo-basic", "CGO ABS PASS"],
    ["cgo-typed", "WASM32 TYPED CGO PASS"],
    ["cgo-callback-same", "CGO CALLBACK PASS"],
    ["cgo-callback-pthread", "CGO CALLBACK PASS"],
    ["cgo-callback-stress", "CGO CALLBACK STRESS PASS"],
  ]) {
    const result = await runCentralizedProgram({
      programPath: `.context/go-wasm32-prototype/${fixture === "cgo-callback-stress" ? "cgo-callback-pthread" : fixture}.wasm`,
      argv: fixture === "cgo-callback-stress" ? ["callback", "stress"] : [fixture],
      kernelWasmBytes: readFileSync(resolveBinary("kernel.wasm")),
      useDefaultRootfs: false,
      env: ["KANDELO_CGO_PROBE=cgo-startup"],
      timeout: 30000,
    });
    writeFileSync(`.context/go-wasm32-prototype/${fixture}-node.json`, JSON.stringify(result, null, 2) + "\n");
    assert.equal(result.exitCode, 0, JSON.stringify(result));
    assert.equal(result.stderr, "");
    assert.deepEqual(result.hostDiagnostics, []);
    assert.ok(result.stdout.includes(marker), result.stdout);
    console.log(`Kandelo/wasm32 ${fixture} PASS`);
  }
}
