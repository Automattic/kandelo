export const nodeSpawnPathCommand = `
set -eu
cat > /tmp/node-spawn-path.cjs <<'JS'
const cp = require('child_process');
const fs = require('fs');
fs.mkdirSync('/tmp/path-tools', { recursive: true });
fs.mkdirSync('/tmp/path-denied', { recursive: true });
fs.symlinkSync('/bin/sh', '/tmp/path-tools/path-shell');
fs.writeFileSync('/tmp/path-tools/blocked', 'not executable', { mode: 0o644 });
fs.writeFileSync('/tmp/path-denied/sh', 'not executable', { mode: 0o644 });
fs.writeFileSync('/tmp/path-not-a-dir', 'file');
fs.chmodSync('/tmp/path-tools/blocked', '600');
for (const [mode, code] of [['600junk', 'ERR_INVALID_ARG_VALUE'], ['888', 'ERR_INVALID_ARG_VALUE'],
  [undefined, 'ERR_INVALID_ARG_TYPE'], [null, 'ERR_INVALID_ARG_TYPE'],
  [-1, 'ERR_OUT_OF_RANGE'], [1.5, 'ERR_OUT_OF_RANGE'], [NaN, 'ERR_OUT_OF_RANGE'],
  [0x100000000, 'ERR_OUT_OF_RANGE']]) {
  let error;
  try { fs.chmodSync('/tmp/path-tools/blocked', mode); } catch (caught) { error = caught; }
  if (!error || error.code !== code) throw Error('chmod accepted invalid mode ' + mode);
}
console.log('CHMOD invalid modes rejected');
console.log('CHMOD mode', (fs.statSync('/tmp/path-tools/blocked').mode & 0o777).toString(8));
function run(file, options) {
  return new Promise((resolve) => {
    const child = cp.spawn(file, ['-c', 'printf path-ok'], options);
    let output = '';
    if (child.stdout) child.stdout.on('data', (data) => { output += data; });
    if (child.stdin) child.stdin.end();
    child.on('error', (error) => resolve(error.code));
    child.on('close', (code) => resolve(code + ':' + output));
  });
}
(async () => {
  process.env.PATH = '/bin';
  console.log('PATH inherited', await run('sh'));
  console.log('PATH child', await run('path-shell', { env: { PATH: '/missing:/tmp/path-not-a-dir:/tmp/path-tools' } }));
  console.log('PATH default', await run('sh', { env: {} }));
  console.log('PATH denied-first', await run('sh', { env: { PATH: '/tmp/path-denied:/bin' } }));
  console.log('PATH relative', await run('path-shell', { cwd: '/tmp', env: { PATH: 'path-tools' } }));
  console.log('PATH empty', await run('path-shell', { cwd: '/tmp/path-tools', env: { PATH: '' } }));
  console.log('PATH explicit', await run('/bin/sh', { env: { PATH: '/missing' } }));
  console.log('PATH missing', await run('sh', { env: { PATH: '/missing' } }));
  console.log('PATH denied', await run('blocked', { env: { PATH: '/tmp/path-tools:/missing' } }));
  console.log('PATH execFile', await new Promise((resolve) => cp.execFile('path-shell', ['-c', 'printf exec-ok'],
    { env: { PATH: '/tmp/path-tools' } }, (error, stdout) => resolve(error ? error.code : stdout))));
})();
JS
node /tmp/node-spawn-path.cjs
`;

export const nodeSpawnPathExpected = [
  "CHMOD invalid modes rejected",
  "CHMOD mode 600",
  ...["inherited", "child", "default", "denied-first", "relative", "empty", "explicit"]
    .map((kind) => `PATH ${kind} 0:path-ok`),
  "PATH missing ENOENT", "PATH denied EACCES", "PATH execFile exec-ok",
];
