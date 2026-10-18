// Hash SDK source content, not mtimes or build products in the musl checkout.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const [repo, arch, compiler, plugin] = process.argv.slice(2);
const hash = createHash('sha256');
const add = (name, bytes) => hash.update(name).update('\0').update(bytes).update('\0');
function visit(relative) {
  const path = join(repo, relative);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) add(relative, readlinkSync(path));
  else if (stat.isDirectory()) {
    for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
  } else if (stat.isFile()) add(relative, readFileSync(path));
  else throw new Error(`unsupported musl input: ${path}`);
}
for (const path of [
  'scripts/build-musl.sh', 'scripts/musl-build-state.sh',
  'scripts/musl-input-hash.mjs', 'scripts/musl-output-state.mjs', 'scripts/build-step-input-hash.sh',
  'scripts/install-overlay-headers.sh', 'libc/musl/Makefile',
  'libc/musl/tools', 'libc/musl/include', 'libc/musl/src',
  'libc/musl/arch', 'libc/musl/crt', 'libc/musl-overlay', 'libc/glue',
  'sdk/src/lib/calltypes-plugin.ts', 'sdk/src/plugin',
]) visit(path);
add('musl-revision', execFileSync('git', ['-C', join(repo, 'libc/musl'), 'rev-parse', 'HEAD']));
add('arch', arch);
add('compiler', realpathSync(compiler));
add('compiler-version', execFileSync(compiler, ['--version']));
for (const tool of ['llvm-ar', 'llvm-ranlib']) {
  const path = join(compiler, '..', tool);
  add(tool, realpathSync(path));
  add(`${tool}-version`, execFileSync(path, ['--version']));
}
add('plugin', readFileSync(plugin));
process.stdout.write(`${hash.digest('hex')}\n`);
