import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bunStandalone } from "./bun-standalone";
import { bufferValidationSource } from "./node-buffer-validation";

const root = mkdtempSync(join(tmpdir(), "kandelo-bun-package-"));
let archive: string;
try {
  mkdirSync(join(root, "package"));
  writeFileSync(join(root, "package/package.json"), JSON.stringify({
    name: "@kandelo/bun-payload", version: "1.0.0", os: ["linux"], cpu: ["x64"], libc: ["glibc"],
  }));
  writeFileSync(join(root, "package/app"), bunStandalone(`
    import { tag } from "/$bunfs/root/helper.js";
    import { isUtf8, isAscii } from "node:buffer";
    import { existsSync } from "node:fs";
    ${bufferValidationSource}
    if (Bun.isStandaloneExecutable !== true || Bun.main !== process.argv[1] ||
        !existsSync(Bun.main)) throw Error('standalone origin or entry missing');
    if (Bun.unsafe.setJITPolicy !== undefined) throw Error('JSC control must be absent');
    Bun.unsafe.setJITPolicy?.(1);
    console.log('bun-shell-ok', tag, process.arch, JSON.stringify(process.argv.slice(2)));
    if (process.argv[2] === 'fail') process.exit(23);
  `));
  archive = execFileSync("tar", ["-czf", "-", "-C", root, "package"]).toString("base64");
} finally { rmSync(root, {recursive:true, force:true}); }

/** Install a native-labelled data package explicitly, then run its embedded JS. */
export const bunShellCommand = `
set -eu
mkdir -p /tmp/bun-shell/project
cd /tmp/bun-shell/project
printf '%s' '${archive}' | base64 -d > /tmp/bun-shell/payload.tgz
if npm install --offline /tmp/bun-shell/payload.tgz; then exit 73; fi
printf 'bun-default-platform-rejected\n'
if npm install --offline --cpu=arm64 --libc=glibc /tmp/bun-shell/payload.tgz; then exit 74; fi
printf 'bun-wrong-target-rejected\n'
npm install --offline --cpu=x64 --libc=glibc /tmp/bun-shell/payload.tgz
binary=./node_modules/@kandelo/bun-payload/app
bun-run "$binary" concurrent-one > /tmp/bun-shell/one.log &
one=$!
bun-run "$binary" concurrent-two > /tmp/bun-shell/two.log &
two=$!
wait "$one"
wait "$two"
cat /tmp/bun-shell/one.log /tmp/bun-shell/two.log
bun-run "$binary" 'two words' --flag
bun-run "$binary" cache-hit
set +e
bun-run "$binary" fail
status=$?
set -e
printf 'bun-exit-status %s\n' "$status"
test "$status" -eq 23
# An attacker-owned or shared cache must never be used as executable input.
mv /tmp/kandelo-bun-run-1000 /tmp/bun-shell/private-cache
ln -s /tmp/bun-shell/private-cache /tmp/kandelo-bun-run-1000
if bun-run "$binary"; then exit 71; fi
rm /tmp/kandelo-bun-run-1000
mkdir -m 755 /tmp/kandelo-bun-run-1000
if bun-run "$binary"; then exit 72; fi
printf 'bun-shell-complete\n'
`;
