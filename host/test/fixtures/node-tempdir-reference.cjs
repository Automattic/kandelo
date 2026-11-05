'use strict';
const fs = require('node:fs');
const [prefix, repetitions, maskText] = process.argv.slice(2);
const mask = parseInt(maskText, 8), previous = process.umask(mask);
const names = new Set();
let status = 0, created = 0, shape = true, directories = true, modes = true;
try {
  for (let i = 0; i < Number(repetitions); i++) {
    let name;
    try { name = fs.mkdtempSync(prefix); }
    catch (error) { status = error.errno; break; }
    created++;
    shape &&= name.startsWith(prefix) && Buffer.byteLength(name) === Buffer.byteLength(prefix) + 6;
    names.add(name);
    const metadata = fs.statSync(name);
    directories &&= metadata.isDirectory();
    modes &&= (metadata.mode & 0o777) === (0o700 & ~mask);
    fs.chmodSync(name, 0o700);
  }
} finally { process.umask(previous); }
console.log(JSON.stringify({ status, created, unique: names.size === created, shape, directories, modes }));
