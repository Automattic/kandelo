'use strict';
const fs = require('node:fs');
const [operation, pathHex, modeText, recursiveText, variant] = process.argv.slice(2);
const path = Buffer.from(pathHex, 'hex');
const options = operation === 'mkdir' ? { mode: Number(modeText), recursive: recursiveText === 'true' } : undefined;
async function main() {
  try {
    let value;
    if (variant === 'sync') value = operation === 'mkdir' ? fs.mkdirSync(path, options) : fs[operation + 'Sync'](path);
    else if (variant === 'promise') value = operation === 'mkdir' ? await fs.promises.mkdir(path, options) : await fs.promises[operation](path);
    else value = await new Promise((resolve, reject) => {
      const complete = (error, result) => error ? reject(error) : resolve(result);
      if (operation === 'mkdir') fs.mkdir(path, options, complete); else fs[operation](path, complete);
    });
    console.log(JSON.stringify({ status: 0, firstPathHex: value === undefined ? '' : Buffer.from(value).toString('hex') }));
  } catch (e) {
    if (typeof e.errno !== 'number') throw e;
    console.log(JSON.stringify({ status: e.errno, firstPathHex: '' }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
