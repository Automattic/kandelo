// The Rust GL driver's toolchain contract on Node: an ordinary SDK-built C
// program (programs/kgpu-gl-link.c) links local-binaries/libkandelo_gl.a,
// passes fork instrumentation and the memory-group conversion, and runs
// grouped on the real kernel. The driver archive is built by
// crates/kandelo-gl/build-archive.sh; it is not part of the sysroot yet.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { KandeloImageFs } from '../../images/vfs/lib/kandelo-image-fs';
import { resolveBinary } from '../src/binary-resolver';
import { compileSdkFixture } from './support/compile-sdk-fixture';

const root = resolve(import.meta.dirname, '../..');
const archive = join(root, 'local-binaries/libkandelo_gl.a');
const shared = fileURLToPath(new URL('../../sdk/bin/wasm32posix-shared-memory', import.meta.url));
const KGPU_IMPORT = 'kandelo.kgpu.v1.__kandelo_kgpu_v1';
let directory: string, image: string, linked: Uint8Array, control: Uint8Array;

/** Build `source` the normal way (SDK, fork instrumentation, ABI stamp)
 * and convert it to a memory-group module. */
function grouped(source: URL, linkArgs: string[]): Uint8Array {
  const fixture = compileSdkFixture(source, linkArgs, { forkInstrument: true });
  try {
    const out = fixture.programPath + '.grouped.wasm';
    execFileSync(shared, [fixture.programPath, '-o', out], { stdio: 'pipe' });
    return new Uint8Array(readFileSync(out));
  } finally { fixture.cleanup(); }
}

beforeAll(async () => {
  if (!existsSync(archive)) {
    throw Error(`${archive} is missing; build it with scripts/dev-shell.sh bash crates/kandelo-gl/build-archive.sh`);
  }
  mkdirSync(join(root, '.scratch'), { recursive: true });
  directory = mkdtempSync(join(root, '.scratch/kgpu-gl-link-'));
  linked = grouped(new URL('../../programs/kgpu-gl-link.c', import.meta.url), [archive]);
  // The control prints the same line without the driver, so its imports
  // are exactly what an ordinary program needs from the host.
  const controlSource = join(directory, 'control.c');
  writeFileSync(controlSource, '#include <stdio.h>\nint main(void) { printf("egl error 0x%x\\n", 0x3000u); return 0; }\n');
  control = grouped(pathToFileURL(controlSource), []);
  const fs = KandeloImageFs.create();
  try {
    fs.mkdir('/tmp', 0o1777); fs.mkdir('/bin', 0o755);
    fs.writeFile('/bin/kgpu-gl-link', linked, 0o755);
    image = join(directory, 'rootfs.vfs');
    writeFileSync(image, await fs.saveImage());
  } finally { fs.reset(); }
}, 300_000);
afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

const importNames = (bytes: Uint8Array) =>
  WebAssembly.Module.imports(new WebAssembly.Module(bytes)).map(i => `${i.module}.${i.name}`);

describe('kandelo-gl link', () => {
  it('runs a C program linked with the driver grouped on Node', async () => {
    const registration = new URL('../node_modules/tsx/dist/esm/api/index.mjs', import.meta.url).href;
    const entry = new URL('./fixtures/kgpu-host-worker.ts', import.meta.url).href;
    const worker = new Worker(`import{register}from ${JSON.stringify(registration)};register();await import(${JSON.stringify(entry)});`, {
      eval: true,
      workerData: {
        scenario: 'run', program: '/bin/kgpu-gl-link', renderer: 'webgl2', image,
        kernel: resolveBinary('kernel.wasm'),
        webgl2Factory: new URL('./support/kgpu-webgl2-double.ts', import.meta.url).href,
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const r: any = await new Promise((yes, no) => {
        timer = setTimeout(() => no(Error('kernel Worker deadline')), 150_000);
        worker.once('message', yes);
        worker.once('error', no);
        worker.once('exit', code => no(Error(`worker exit ${code}`)));
      });
      expect(r.failure, `${r.failure}\n${r.stack}`).toBeUndefined();
      expect(r.fatal).toBeUndefined();
      expect(r.stderr).toBe('');
      expect(r.code, r.stdout).toBe(0);
      expect(r.stdout).toBe('egl error 0x3000\n');
    } finally {
      clearTimeout(timer);
      await worker.terminate();
    }
  }, 240_000);

  it('adds no import beyond an ordinary program and the kgpu extension', () => {
    expect(WebAssembly.validate(linked)).toBe(true);
    // The conversion replaces env.memory with the memory group's memory;
    // the driver must not bring a memory of its own.
    const memories = (bytes: Uint8Array) => WebAssembly.Module.imports(new WebAssembly.Module(bytes))
      .filter(i => i.kind === 'memory').map(i => `${i.module}.${i.name}`);
    expect(memories(linked)).toEqual(['kandelo.memory-group.v3.memory']);
    expect(memories(control)).toEqual(memories(linked));
    const ordinary = new Set(importNames(control));
    const extra = importNames(linked).filter(name => !ordinary.has(name));
    expect(extra.filter(name => name !== KGPU_IMPORT)).toEqual([]);
    // The driver defines its entry points; none may become a host import.
    expect(importNames(linked).filter(name => /\.egl|\.gl[A-Z]/.test(name))).toEqual([]);
  });
});
