// Record the core SDK outputs so copying an older archive over a stamped
// sysroot cannot make stale installed bytes look current.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [mode, sysroot] = process.argv.slice(2);
const required = ['lib/libc.a', 'lib/crt1.o', 'lib/crti.o', 'lib/crtn.o',
  'lib/libkandelo-ucontext-unsupported.a', 'include/stdio.h',
  'include/bits/alltypes.h', 'include/bits/kandelo_thread_syscalls.h'];
const digest = (relative) => {
  const path = join(sysroot, relative);
  if (!lstatSync(path).isFile()) throw new Error(`SDK output is not a regular file: ${relative}`);
  return createHash('sha256').update(readFileSync(path)).digest('hex');
};
if (mode === 'write') {
  const paths = ['lib/libc.a', 'lib/crt1.o', 'lib/crti.o', 'lib/crtn.o', 'lib/libkandelo-ucontext-unsupported.a'];
  function headers(relative) {
    for (const name of readdirSync(join(sysroot, relative)).sort()) {
      const child = `${relative}/${name}`;
      if (lstatSync(join(sysroot, child)).isDirectory()) headers(child);
      else paths.push(child);
    }
  }
  headers('include');
  process.stdout.write(`${JSON.stringify(Object.fromEntries(paths.map(path => [path, digest(path)])))}\n`);
} else if (mode === 'check') {
  const outputs = JSON.parse(readFileSync(join(sysroot, '.kandelo-musl.outputs.json'), 'utf8'));
  if (!outputs || Array.isArray(outputs) || typeof outputs !== 'object' ||
      required.some(path => !Object.hasOwn(outputs, path))) {
    throw new Error('SDK output receipt is incomplete');
  }
  for (const [path, expected] of Object.entries(outputs)) {
    if (path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') ||
        typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(`Invalid SDK output receipt entry: ${path}`);
    }
    if (digest(path) !== expected) throw new Error(`SDK output changed: ${path}`);
  }
} else throw new Error('usage: musl-output-state.mjs <write|check> <sysroot>');
