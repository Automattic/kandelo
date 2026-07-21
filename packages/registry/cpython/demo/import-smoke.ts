/**
 * import-smoke.ts — kd-mt3u CPython stdlib import smoke on Kandelo.
 *
 * Runs the built python.wasm under the Node kernel host (host-fs passthrough so
 * PYTHONHOME resolves) and checks representative stdlib imports (re, json, zlib,
 * ...) plus a json round-trip and a re match.
 *
 * Usage:
 *   bash build.sh && bash packages/registry/cpython/build-cpython.sh
 *   npx tsx packages/registry/cpython/demo/import-smoke.ts [PYTHONHOME]
 *
 * PYTHONHOME defaults to the built cpython-install; pass an arg to override
 * (e.g. a packaged stdlib bundle) to smoke the shippable layout.
 */
import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { runCentralizedProgram } from "../../../../host/test/centralized-test-helper";
import { NodePlatformIO } from "../../../../host/src/platform/node";

const scriptDir = dirname(new URL(import.meta.url).pathname);
const repoRoot = resolve(scriptDir, "../../../..");

const PY = [
  "import sys",
  "mods=['re','json','zlib','os','functools','enum','collections','datetime','base64','hashlib','textwrap','argparse']",
  "res=[]",
  "for m in mods:",
  "    try:",
  "        __import__(m); res.append(m+'=ok')",
  "    except Exception as e:",
  "        res.append(m+'=FAIL('+type(e).__name__+')')",
  "print('PYVER='+sys.version.split()[0])",
  "print('MODS='+','.join(res))",
  "import json as j",
  "assert j.loads(j.dumps({'a':[1,2,3],'b':True,'c':None}))=={'a':[1,2,3],'b':True,'c':None}, 'json roundtrip'",
  "import re as r",
  "assert r.match(r'(\\d+)-(\\w+)','42-foo').group(2)=='foo', 're match'",
  "print('IMPORT_SMOKE_PASS' if all('=ok' in x for x in res) else 'IMPORT_SMOKE_PARTIAL')",
].join("\n");

async function main() {
  const pythonWasm = resolve(repoRoot, "packages/registry/cpython/bin/python.wasm");
  const pythonHome = process.argv[2] ||
    resolve(repoRoot, "packages/registry/cpython/cpython-install");
  if (!existsSync(pythonWasm)) {
    console.error("python.wasm not found. Run: bash packages/registry/cpython/build-cpython.sh");
    process.exit(1);
  }

  const result = await runCentralizedProgram({
    programPath: pythonWasm,
    argv: ["python", "-c", PY],
    env: [`PYTHONHOME=${pythonHome}`, `HOME=/tmp`, `TMPDIR=/tmp`, `PYTHONDONTWRITEBYTECODE=1`],
    io: new NodePlatformIO(),
    timeout: 300_000,
  });

  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const ok = result.exitCode === 0 && result.stdout.includes("IMPORT_SMOKE_PASS");
  process.exit(ok ? 0 : (result.exitCode || 1));
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
