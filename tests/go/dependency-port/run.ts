import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCentralizedProgram } from "../../../host/test/centralized-test-helper.ts";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs.ts";

const [fixtureDir, kernelPath] = process.argv.slice(2);
if (!fixtureDir || !kernelPath) {
  throw new Error("usage: node --import tsx run.ts <fixture-dir> <kernel.wasm>");
}

const cases = [
  { name: "bbolt", test: "TestKandeloReopen", stderr: /^seed: \d+\nquick settings: count=\d+, items=\d+, ksize=\d+, vsize=\d+\n$/ },
  { name: "readline", test: "TestKandeloTerminal", stderr: /^tmpdir: \/tmp\n$/ },
  { name: "logrus", test: "TestKandeloTerminalCheck", stderr: /^$/ },
  { name: "ct-x509", test: "TestKandeloSystemRoots", stderr: /^$/ },
];

const kernelWasmBytes = readFileSync(kernelPath);
for (const probe of cases) {
  const image = KandeloImageFs.create();
  image.setImageCapacity(8 * 1024 * 1024);
  image.mkdir("/tmp", 0o777);
  const result = await runCentralizedProgram({
    programPath: join(fixtureDir, `${probe.name}-test.wasm`),
    kernelWasmBytes,
    rootfsImage: new Uint8Array(await image.saveImage()),
    argv: [probe.name, `-test.run=^${probe.test}$`, "-test.v"],
    timeout: 90_000,
  });
  const passed = result.exitCode === 0 &&
    result.stdout.includes(`--- PASS: ${probe.test}`) &&
    result.stdout.includes("PASS\n") &&
    probe.stderr.test(result.stderr) &&
    result.hostDiagnostics.length === 0;
  console.log(JSON.stringify({
    name: probe.name,
    passed,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    hostDiagnostics: result.hostDiagnostics,
  }));
  if (!passed) process.exitCode = 1;
}
