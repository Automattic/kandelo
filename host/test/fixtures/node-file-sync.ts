export const nodeFileSyncCommand = `
set -eu
cat > /tmp/node-file-sync.cjs <<'JS'
const fs = require('fs');
async function expectError(operation, code) {
  let caught;
  try { await operation(); } catch (error) { caught = error; }
  if (!caught || caught.code !== code) throw new Error('expected '+code+', got '+caught);
}
(async () => {
  const file = await fs.promises.open('/tmp/sync-original', 'w', 0o600);
  await file.write('synchronized data');
  await file.sync();
  await file.datasync();
  fs.fsyncSync(file.fd);
  fs.fdatasyncSync(file.fd);
  await new Promise((resolve,reject) => fs.fsync(file.fd, error => error ? reject(error) : resolve()));
  await new Promise((resolve,reject) => fs.fdatasync(file.fd, error => error ? reject(error) : resolve()));
  fs.renameSync('/tmp/sync-original', '/tmp/sync-renamed');
  await file.sync();
  if(fs.readFileSync('/tmp/sync-renamed','utf8') !== 'synchronized data') throw Error('contents');
  fs.unlinkSync('/tmp/sync-renamed');
  await file.datasync();
  await file.close();
  await expectError(() => file.sync(), 'EBADF');
  await expectError(() => file.datasync(), 'EBADF');
  await expectError(() => fs.fsyncSync(123456), 'EBADF');
  await expectError(() => fs.fdatasyncSync(123456), 'EBADF');
  await expectError(() => fs.fsyncSync('1'), 'ERR_INVALID_ARG_TYPE');
  await expectError(() => fs.fsyncSync(-1), 'ERR_OUT_OF_RANGE');
  await expectError(() => fs.fsyncSync(0), 'EINVAL');
  const dir = fs.openSync('/tmp', 'r');
  fs.fsyncSync(dir);
  fs.closeSync(dir);
  const full = await fs.promises.open('/dev/full', 'w');
  const bytes = Buffer.from('not stored');
  await expectError(() => fs.writeSync(full.fd, bytes), 'ENOSPC');
  await expectError(() => fs.writevSync(full.fd, [bytes, bytes]), 'ENOSPC');
  await expectError(() => fs.writeFileSync('/dev/full', bytes), 'ENOSPC');
  await expectError(() => fs.promises.writeFile('/dev/full', bytes), 'ENOSPC');
  await expectError(() => full.write(bytes), 'ENOSPC');
  await expectError(() => full.writev([bytes]), 'ENOSPC');
  await expectError(() => new Promise((resolve,reject) =>
    fs.write(full.fd, bytes, 0, bytes.length, null,
      error => error ? reject(error) : resolve())), 'ENOSPC');
  await expectError(() => new Promise((resolve,reject) =>
    fs.writev(full.fd, [bytes], error => error ? reject(error) : resolve())), 'ENOSPC');
  const closedFd = full.fd;
  await full.close();
  await expectError(() => fs.writeSync(closedFd, bytes), 'EBADF');
  await expectError(() => fs.readSync(closedFd, bytes, 0, 1, null), 'EBADF');
  await expectError(() => fs.closeSync(closedFd), 'EBADF');
  const zero = await fs.promises.open('/tmp/zero-length-io', 'w+');
  if (fs.writeSync(zero.fd, bytes, 0, 0) !== 0) throw Error('zero write');
  if (fs.fstatSync(zero.fd).size !== 0) throw Error('zero write changed file');
  await zero.write('abc');
  await zero.close();
  const reader = await fs.promises.open('/tmp/zero-length-io', 'r');
  if (fs.readSync(reader.fd, bytes, 0, 0, null) !== 0) throw Error('zero read');
  if (fs.readSync(reader.fd, bytes, 0, 1, null) !== 1 || bytes[0] !== 97)
    throw Error('zero read consumed data');
  await reader.close();
  console.log('node-file-io-errors-ok');
  console.log('node-file-sync-ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
JS
node /tmp/node-file-sync.cjs
`;
