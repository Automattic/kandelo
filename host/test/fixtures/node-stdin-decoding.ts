/** Real fd-0 reads across the native 4096-byte boundary and final partial units. */
export const nodeStdinDecodingCommand = `
set -eu
cat > /tmp/node-stdin-decoding.cjs <<'JS'
const cp = require('child_process');
if (process.argv[2] === 'read') {
  let text = '';
  process.stdin.setEncoding(process.argv[3]);
  if (process.stdin.readableEncoding !== process.argv[3]) throw Error('readableEncoding state');
  process.stdin.on('data', part => {
    if (typeof part !== 'string' || !part.length) throw Error('invalid decoded data event');
    text += part;
  });
  process.stdin.on('end', () => console.log(JSON.stringify(text)));
} else {
  (async () => {
    const cases = [
      ['utf8', Buffer.from('a'.repeat(4095) + '€'), 'a'.repeat(4095) + '€'],
      ['utf8', Buffer.from([0xef,0xbb,0xbf,97]), '\\ufeffa'],
      ['utf8', Buffer.from([0xe2,0x82]), '\\ufffd'],
      ['utf8', Buffer.from([0xc0]), '\\ufffd'],
      ['utf8', Buffer.from([0xe2,0x82,97]), '\\ufffda'],
      ['utf16le', Buffer.from([0x3d,0xd8,0x4d,0xdc]), '\\ud83d\\udc4d'],
      ['utf16le', Buffer.from([0,0xd8,97]), '\\ud800'],
      ['latin1', Buffer.from([0x80,0xff]), '\\u0080\\u00ff'],
      ['ascii', Buffer.from([0x80,0xff]), '\\u0000\\u007f'],
      ['base64', Buffer.from([0,0xd8]), 'ANg='],
      ['base64url', Buffer.from([0,0xd8]), 'ANg'],
      ['hex', Buffer.from([0,0xd8]), '00d8'],
    ];
    for (const [encoding, input, expected] of cases) {
      const child = cp.spawn(process.execPath, ['/tmp/node-stdin-decoding.cjs', 'read', encoding]);
      const chunks = [];
      let errorOutput = '';
      child.stdout.on('data', bytes => chunks.push(bytes));
      child.stderr.on('data', bytes => { errorOutput += bytes.toString(); });
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', code => {
          const output = Buffer.concat(chunks).toString('utf8');
          if (code !== 0 || output !== JSON.stringify(expected) + '\\n') reject(Error(encoding + ': ' + output + errorOutput));
          else resolve();
        });
        child.stdin.end(input);
      });
    }
    console.log('node-stdin-decoding-ok');
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
JS
node /tmp/node-stdin-decoding.cjs
`;
