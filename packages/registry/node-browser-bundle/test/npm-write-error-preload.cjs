// Cause an actual OS error at one package-entry write, without filling a disk.
const fs = require('node:fs');
const readonly = fs.openSync(__filename, 'r');
const tracked = new Set();
const open = fs.open;
const close = fs.close;

fs.open = function (path, ...args) {
  const cb = args.pop();
  return open.call(this, path, ...args, (error, fd) => {
    if (!error && String(path).endsWith('/blocked.txt')) tracked.add(fd);
    cb(error, fd);
  });
};
fs.close = function (fd, ...args) {
  tracked.delete(fd);
  return close.call(this, fd, ...args);
};
for (const name of ['write', 'writev']) {
  const write = fs[name];
  fs[name] = function (fd, ...args) {
    if (tracked.has(fd)) {
      process.stderr.write('repro: writing the package entry through a real readonly descriptor\n');
      fd = readonly;
    }
    return write.call(this, fd, ...args);
  };
}
