export const nodePositionedSource = `
const fs = require('fs');
function check(value, label) { if (!value) throw Error(label); }
function next(fd) { const b = Buffer.alloc(1); check(fs.readSync(fd, b, 0, 1, null) === 1, 'sequential read'); return b.toString(); }
async function main() {
  const path = '/tmp/node-positioned-data';
  fs.writeFileSync(path, 'abcdefgh');
  let fd = fs.openSync(path, 'r+');
  try {
    check(next(fd) === 'a', 'initial cursor');
    const b = Buffer.alloc(2);
    check(fs.readSync(fd, b, 0, 2, 4) === 2 && b.toString() === 'ef', 'positioned contents');
    check(next(fd) === 'b', 'pread changed cursor');
    check(fs.writeSync(fd, Buffer.from('XY'), 0, 2, 5) === 2, 'positioned write');
    check(next(fd) === 'c', 'pwrite changed cursor');
    check(fs.writeSync(fd, 'Z', 7, 'utf8') === 1, 'positioned string');
    check(next(fd) === 'd', 'string write changed cursor');
    check(fs.readSync(fd, b, 0, 1, 4294967296) === 0, '32-bit truncation');
    check(next(fd) === 'e', 'large position changed cursor');
    try { check(fs.readSync(fd, b, 0, 1, 9007199254740993n) === 0, '64-bit truncation'); }
    catch (error) { if (!['EOVERFLOW', 'EFBIG'].includes(error.code)) throw error; }
    check(next(fd) === 'X', 'bigint position changed cursor');
    check(fs.readSync(fd, b, Object.freeze({ offset: 0, length: 1, position: 0n })) === 1 && b[0] === 97, 'options read');
    check(next(fd) === 'Y', 'options changed cursor');
    check(fs.readFileSync(path, 'utf8') === 'abcdeXYZ', 'write contents');
    let sync = true;
    const read = new Promise((resolve, reject) => fs.read(fd, { buffer: b, position: 0n, length: 2 }, (error, count, buffer) => {
      if (error) return reject(error);
      try { check(!sync && count === 2 && buffer === b && b.toString() === 'ab', 'callback read'); resolve(); }
      catch (failure) { reject(failure); }
    }));
    sync = false;
    await read;
    check(next(fd) === 'Z', 'callback changed cursor');
    let error;
    try { fs.read(fd, { buffer: b, position: 'invalid' }, () => { throw Error('invalid read reached callback'); }); }
    catch (failure) { error = failure; }
    check(error && error.code === 'ERR_INVALID_ARG_TYPE', 'callback validation must throw');
  } finally { fs.closeSync(fd); }
  const handle = await fs.promises.open(path, 'r+');
  try {
    const buffer = Buffer.alloc(2);
    const result = await handle.read(Object.freeze({ buffer, length: 2, position: 4n }));
    check(result.buffer === buffer && result.bytesRead === 2 && buffer.toString() === 'eX', 'file handle options');
    check(next(handle.fd) === 'a', 'file handle changed cursor');
    await handle.write(Buffer.from('Q'), 0, 1, 6);
    check(next(handle.fd) === 'b', 'file handle write changed cursor');
  } finally { await handle.close(); }
  await new Promise((resolve, reject) => {
    const child = require('child_process').spawn(process.execPath, ['-e',
      "const fs = require('fs'); let error; try { fs.readSync(0, Buffer.alloc(1), 0, 1, 0); } catch (e) { error = e; } if (!error || error.code !== 'ESPIPE') throw Error('positioned pipe must fail with ESPIPE');"]);
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve() : reject(Error('pipe child status ' + code)));
    child.stdin.end();
  });
  fs.unlinkSync(path);
  console.log('node-positioned-io-ok');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
`;
export const nodePositionedCommand = `set -eu
cat > /tmp/node-positioned-io.cjs <<'JS'
${nodePositionedSource}
JS
node /tmp/node-positioned-io.cjs
`;
