/** Real pipe bytes/EOF and pending-reader lifetime, without a model or network. */
export const nodeStdinCommand = `
set -eu
cat > /tmp/node-stdin-case.cjs <<'JS'
const fs = require('fs');
const cp = require('child_process');
const mode = process.argv[2];
if (mode === 'read') {
  const chunks = [];
  process.stdin.on('data', bytes => {
    if (!Buffer.isBuffer(bytes)) throw Error('stdin data is not a Buffer');
    chunks.push(bytes);
  });
  process.stdin.on('end', () => console.log('stdin-eof:[' + Buffer.concat(chunks).toString('hex') + ']'));
  process.stdin.resume();
} else if (mode === 'pipe') {
  process.stdin.pipe(process.stdout);
} else if (mode === 'resume' || mode === 'ref') {
  let output = '';
  process.stdin.on('data', bytes => { output += bytes; });
  process.stdin.on('end', () => console.log('stdin-' + mode + '-read:[' + output + ']'));
  queueMicrotask(() => {
    if (mode === 'resume') process.stdin.pause().resume();
    else process.stdin.unref().ref();
    console.log('stdin-' + mode + '-ready');
  });
} else if (mode === 'pause' || mode === 'unref') {
  process.stdin.on('end', () => { console.error('unexpected EOF'); process.exit(13); });
  process.stdin.resume();
  queueMicrotask(() => {
    process.stdin[mode]();
    fs.fstatSync(0); // Must remain open; native Node may use a socketpair.
    console.log('stdin-' + mode + '-fd-open');
  });
} else {
  (async () => {
    for (const operation of ['pause', 'unref', 'resume', 'ref']) {
      const child = cp.spawn('node', ['/tmp/node-stdin-case.cjs', operation]);
      let output = '';
      let sent = false;
      child.stdout.on('data', bytes => {
        output += bytes;
        if (!sent && output.includes('stdin-' + operation + '-ready')) {
          sent = true;
          child.stdin.end('hello');
        }
      });
      child.stderr.on('data', bytes => process.stderr.write(bytes));
      // Keep the writer open: the child's exit must come from cancellation or
      // unref, rather than a parent-supplied EOF.
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => {
          child.stdin.end();
          const marker = operation === 'pause' || operation === 'unref'
            ? 'stdin-' + operation + '-fd-open' : 'stdin-' + operation + '-read:[hello]';
          if (code !== 0 || !output.includes(marker)) reject(Error(output));
          else resolve();
        });
      });
      console.log('stdin-' + operation + '-exit-ok');
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
JS
printf '' | node /tmp/node-stdin-case.cjs read
printf hello | node /tmp/node-stdin-case.cjs read
printf 'stdin-pipe:['
printf hello | node /tmp/node-stdin-case.cjs pipe
printf ']\n'
node /tmp/node-stdin-case.cjs lifetime
`;
