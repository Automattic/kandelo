import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function archive(name: string, script: string): string {
  const root = mkdtempSync(join(tmpdir(), "kandelo-npm-lifecycle-"));
  try {
    mkdirSync(join(root, "package"));
    writeFileSync(join(root, "package/package.json"), JSON.stringify({
      name: `@kandelo/lifecycle-${name}`, version: "1.0.0",
      ...(name === "extract-error" ? {} : { scripts: { postinstall: "node install.cjs" } }),
      ...(name === "success" ? { bin: { "lifecycle-tool": "tool.cjs" } } : {}),
    }));
    writeFileSync(join(root, "package/install.cjs"), script);
    if (name === "extract-error") {
      writeFileSync(join(root, "package/blocked.txt"), "This entry must be completely written.");
    }
    if (name === "success") {
      writeFileSync(join(root, "package/tool.cjs"),
        "#!/usr/bin/node\nprocess.stdout.write('package-bin-ok');\n");
    }
    return execFileSync("tar", ["-czf", "-", "-C", root, "package"]).toString("base64");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const success = archive("success", `
const fs = require('fs');
require('child_process').execFile('sh', ['-c', 'printf nested-shell-ok'], (error, stdout) => {
  if (error) { console.error(error); process.exit(1); }
  require('child_process').execFile('lifecycle-tool', [], (binError, binOutput) => {
    if (binError) { console.error(binError); process.exit(1); }
    fs.writeFileSync('installed.json', JSON.stringify({
      cwd: process.cwd(), event: process.env.npm_lifecycle_event, output: stdout, binOutput,
    }));
  });
});
`);
const failure = archive("failure", "console.error('npm-lifecycle-child-error'); process.exit(23);");
const full = archive("full", "require('fs').writeFileSync('/dev/full', 'must fail');");
const extractError = archive("extract-error", "");

/** Offline acceptance through the shipped npm launcher, shell and Node runtime. */
export const npmLifecycleCommand = `
set -eu
mkdir -p /tmp/npm-lifecycle/project
cd /tmp/npm-lifecycle/project
printf '%s\n' '{"name":"lifecycle-project","version":"1.0.0","private":true}' > package.json
printf '%s' '${success}' | base64 -d > /tmp/npm-lifecycle/success.tgz
printf '%s' '${failure}' | base64 -d > /tmp/npm-lifecycle/failure.tgz
printf '%s' '${full}' | base64 -d > /tmp/npm-lifecycle/full.tgz
printf '%s' '${extractError}' | base64 -d > /tmp/npm-lifecycle/extract-error.tgz
npm install --offline --foreground-scripts /tmp/npm-lifecycle/success.tgz
node -e 'const r=require("./node_modules/@kandelo/lifecycle-success/installed.json"); if(r.cwd!==process.cwd()+"/node_modules/@kandelo/lifecycle-success"||r.event!=="postinstall"||r.output!=="nested-shell-ok"||r.binOutput!=="package-bin-ok")throw new Error(JSON.stringify(r)); console.log("npm-lifecycle-success")'
if npm install --offline --foreground-scripts /tmp/npm-lifecycle/failure.tgz; then
  printf '%s\n' 'npm incorrectly accepted a failed postinstall' >&2
  exit 1
else
  npm_status=$?
  test "$npm_status" -eq 23
  printf '%s %s\n' npm-lifecycle-failure-status "$npm_status"
fi
mkdir -p /tmp/npm-lifecycle/full-project
cd /tmp/npm-lifecycle/full-project
printf '%s\n' '{"name":"full-project","version":"1.0.0","private":true}' > package.json
if npm install --offline --foreground-scripts /tmp/npm-lifecycle/full.tgz > /tmp/npm-lifecycle/full.log 2>&1; then
  cat /tmp/npm-lifecycle/full.log >&2
  printf '%s\n' 'npm incorrectly accepted a filesystem write failure' >&2
  exit 1
else
  npm_status=$?
  cat /tmp/npm-lifecycle/full.log
  printf '%s %s\n' npm-lifecycle-enospc-status "$npm_status"
  test "$npm_status" -ne 0
  node -e 'if(!require("fs").readFileSync("/tmp/npm-lifecycle/full.log","utf8").includes("ENOSPC"))process.exit(1)'
  printf '%s\n' npm-lifecycle-enospc-rejected
fi
mkdir -p /tmp/npm-lifecycle/extract-project
cd /tmp/npm-lifecycle/extract-project
printf '%s\n' '{"name":"extract-project","version":"1.0.0","private":true}' > package.json
cat > /tmp/npm-lifecycle/extract-failure.cjs <<'JS'
// Redirect just the package entry write through the real /dev/full device.
// This exercises npm's extraction policy without filling the machine's RAM.
const fs = require('fs');
const full = fs.openSync('/dev/full', 'w');
const tracked = new Set();
const open = fs.open, close = fs.close;
fs.open = function(path, ...args) {
  const cb = args.pop();
  return open.call(this, path, ...args, (error, fd) => {
    if (!error && String(path).endsWith('/blocked.txt')) tracked.add(fd);
    cb(error, fd);
  });
};
fs.close = function(fd, ...args) {
  tracked.delete(fd);
  return close.call(this, fd, ...args);
};
for (const name of ['write', 'writev']) {
  const write = fs[name];
  fs[name] = function(fd, ...args) {
    return write.call(this, tracked.has(fd) ? full : fd, ...args);
  };
}
process.argv = [process.argv[0], '/usr/bin/npm', 'install', '--offline',
  '/tmp/npm-lifecycle/extract-error.tgz'];
require('/usr/bin/npm');
JS
if node /tmp/npm-lifecycle/extract-failure.cjs > /tmp/npm-lifecycle/extract.log 2>&1; then
  cat /tmp/npm-lifecycle/extract.log >&2
  printf '%s\n' 'npm incorrectly accepted a failed package extraction' >&2
  exit 1
else
  cat /tmp/npm-lifecycle/extract.log
  node -e 'if(!require("fs").readFileSync("/tmp/npm-lifecycle/extract.log","utf8").includes("ENOSPC"))process.exit(1)'
  printf '%s\n' npm-extraction-enospc-rejected
fi
`;
