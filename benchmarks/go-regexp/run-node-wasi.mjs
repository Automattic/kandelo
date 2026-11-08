import { WASI } from 'node:wasi';
import { readFile } from 'node:fs/promises';
const [path, name] = process.argv.slice(2);
const wasi = new WASI({ version: 'preview1', args: [path], env: { REGEXP_BENCH_CASE: name, GOMAXPROCS: '1' }, preopens: {} });
const module = await WebAssembly.compile(await readFile(path));
const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi.wasiImport });
wasi.start(instance);
