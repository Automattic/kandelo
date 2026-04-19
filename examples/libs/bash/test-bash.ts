/**
 * test-bash.ts — smoke tests for the bash port.
 *
 * Run: npx tsx examples/libs/bash/test-bash.ts
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { NodeKernelHost } from "../../../host/src/node-kernel-host";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../../..");

function loadBytes(path: string): ArrayBuffer {
  const buf = readFileSync(path);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

async function runCase(script: string): Promise<{ code: number; out: string; err: string }> {
  const bashBin = resolve(repoRoot, "examples/libs/bash/bin/bash.wasm");
  let out = "";
  let err = "";
  const host = new NodeKernelHost({
    maxWorkers: 8,
    execPrograms: {
      "/bin/bash": bashBin,
      "/bin/sh": bashBin,
    },
    onStdout: (_pid, data) => { out += Buffer.from(data).toString("utf8"); },
    onStderr: (_pid, data) => { err += Buffer.from(data).toString("utf8"); },
  });
  await host.init();
  const code = await host.spawn(loadBytes(bashBin), ["bash", "-c", script], {
    env: ["HOME=/tmp", "PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", "TERM=dumb"],
    cwd: "/",
    stdin: new Uint8Array(0),
  });
  await host.destroy().catch(() => {});
  return { code, out, err };
}

const cases: [string, string, string][] = [
  ["echo hello", "hello\n", "simple echo"],
  ["echo $((2+3))", "5\n", "arithmetic"],
  ["x=world; echo hi $x", "hi world\n", "variable expansion"],
  ["for i in a b c; do echo -n $i; done; echo", "abc\n", "for loop"],
  ["if [[ 5 -gt 3 ]]; then echo yes; fi", "yes\n", "[[ ]] test (bashism)"],
  ["arr=(one two three); echo ${arr[1]}", "two\n", "indexed array (bashism)"],
  ["declare -A h=([a]=1 [b]=2); echo ${h[b]}", "2\n", "associative array (bashism)"],
  ["echo {1..5}", "1 2 3 4 5\n", "brace expansion"],
  ["s=hello; echo ${s^^}", "HELLO\n", "case-mod expansion (bashism)"],
];

async function main() {
  let pass = 0;
  let fail = 0;
  for (const [script, expected, desc] of cases) {
    try {
      const { code, out, err } = await runCase(script);
      const ok = code === 0 && out === expected;
      if (ok) {
        console.log(`  PASS: ${desc}`);
        pass++;
      } else {
        console.log(`  FAIL: ${desc}`);
        console.log(`    script:   ${JSON.stringify(script)}`);
        console.log(`    expected: ${JSON.stringify(expected)} (exit 0)`);
        console.log(`    got:      ${JSON.stringify(out)} (exit ${code})`);
        if (err) console.log(`    stderr:   ${JSON.stringify(err)}`);
        fail++;
      }
    } catch (e) {
      console.log(`  ERROR: ${desc}: ${(e as Error).message}`);
      fail++;
    }
  }
  console.log(`\n${pass}/${pass + fail} passed`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
