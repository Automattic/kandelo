/** Opt-in desktop image derived from an ordinary SDK/package-built image. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveLazyAssetPath } from '../../../host/src/binary-resolver';
import { KandeloImageFs } from '../lib/kandelo-image-fs';
import { saveImage, writeVfsBinary, type VfsWasmArtifactPolicy } from './vfs-image-helpers';
import { parseKandeloDemoConfig, validateKandeloDemoConfig, type KandeloDemoConfig } from '../../../web-libs/kandelo-session/src/demo-config';
import { SHARED_DESKTOP_PROGRAMS, SHARED_DESKTOP_LOGIN_PROGRAMS } from './shared-desktop-contract';
export { SHARED_DESKTOP_PROGRAMS, SHARED_DESKTOP_LOGIN_PROGRAMS } from './shared-desktop-contract';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
type LazyProgram = ReturnType<KandeloImageFs['lazyEntries']>['files'][number];

export async function prepareSharedDesktopImage(input: string, output: string, options: {
  /** Also prepare the normal image-owned login/syslog boot chain. */
  includeLoginSession?: boolean;
  /** Explicit source provider for retained image/package fixtures. Default:
   * the normal resolver's validated package closure. Never fetch arbitrary URLs. */
  readDeferredProgram?: (entry: LazyProgram) => Uint8Array;
} = {}) {
  input = realpathSync(input); output = resolve(output);
  if (!output.endsWith('.vfs.zst') || input === output) throw Error('Select a distinct .vfs.zst output');
  try { if (realpathSync(output) === input) throw Error('Output aliases the ordinary image'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  mkdirSync(dirname(output), { recursive: true });
  const stage = mkdtempSync(join(dirname(output), '.shared-desktop-'));
  const fs = KandeloImageFs.create();
  const original = readFileSync(input);
  const sdk = fileURLToPath(new URL('../../../sdk/bin/wasm32posix-shared-memory', import.meta.url));
  const manifest: { input: string; inputSha256: string; programs: unknown[]; profiles?: unknown; output?: unknown } = {
    input, inputSha256: hash(original), programs: [],
  };
  let succeeded = false;
  try {
    fs.loadImage(original);
    const demoPath = '/etc/kandelo/demo.json';
    const demo = parseKandeloDemoConfig(new TextDecoder().decode(fs.readFile(demoPath)));
    const sway = demo?.profiles?.sway;
    if (!demo || !sway) throw Error('Trusted desktop preview requires an image-owned Sway profile');
    // The prepared closure supports this desktop. Ordinary profiles still in
    // the source image must not advertise incompatible applications here.
    const preview: KandeloDemoConfig = { ...demo, image: { title: 'Trusted desktop preview' }, defaultProfile: 'sway', profiles: {
      sway: { ...sway, identity: sway.identity === undefined ? undefined : { ...sway.identity, title: 'Sway and Foot preview',
        summary: 'Temporary desktop preview with Sway and Foot. Other applications are not supported.' },
        guide: { ...sway.guide, title: 'Sway and Foot preview',
          summary: 'Temporary preview for compatible, trusted programs. Sway and Foot are the supported applications. '
            + (sway.guide?.summary ?? '') } },
    } };
    validateKandeloDemoConfig(preview);
    fs.writeFile(demoPath, new TextEncoder().encode(JSON.stringify(preview, null, 2) + '\n'));
    manifest.profiles = { supported: ['sway'], excluded: Object.keys(demo.profiles ?? {}).filter(id => id !== 'sway') };
    const policies: VfsWasmArtifactPolicy[] = [];
    const programs = [...SHARED_DESKTOP_PROGRAMS,
      ...(options.includeLoginSession ? SHARED_DESKTOP_LOGIN_PROGRAMS : [])];
    for (const requested of programs) {
      let path: string = requested;
      for (let count = 0; (fs.lstat(path).mode & 0o170000) === 0o120000; count++) {
        if (count > 16) throw Error('Executable symlink loop: ' + requested);
        path = posix.resolve(posix.dirname(path), fs.readlink(path));
      }
      const lazy = fs.lazyEntries().files.find(entry => entry.path === path);
      const identity = fs.lstat(path);
      let bytes: Uint8Array;
      if (lazy) {
        if (lazy.archiveId !== 0) throw Error('Executable in a lazy archive is unsupported: ' + path);
        bytes = options.readDeferredProgram?.(lazy) ?? new Uint8Array(readFileSync(resolveLazyAssetPath(lazy.uri)));
        if (bytes.length !== lazy.size || lazy.digest.some(byte => byte !== 0)
            && hash(bytes) !== Buffer.from(lazy.digest).toString('hex')) {
          throw Error('Deferred executable differs from its image declaration: ' + path);
        }
      } else bytes = fs.readFile(path);
      const source = join(stage, 'input.wasm'), prepared = join(stage, 'grouped.wasm');
      writeFileSync(source, bytes);
      const report = execFileSync(sdk, [source, '-o', prepared], { encoding: 'utf8' });
      const translated = readFileSync(prepared);
      writeVfsBinary(fs, path, translated);
      // Replacing a lazy or set-ID executable must preserve its installed
      // credentials. Runtime exec still applies the ordinary credential policy.
      fs.chown(path, identity.uid, identity.gid);
      fs.chmod(path, identity.mode & 0o7777);
      policies.push({ path, forkInstrumentation: 'auto', memoryGroup: 'trusted-v1' });
      manifest.programs.push({ requested, path, ordinarySha256: hash(bytes), groupedSha256: hash(translated),
        sourceUri: lazy?.uri, mode: identity.mode, uid: identity.uid, gid: identity.gid,
        translation: JSON.parse(report) });
      console.log('Prepared ' + path);
    }
    const bytes = await saveImage(fs, output, { metadata: { ...fs.getImageMetadata(), version: 1,
      createdBy: 'kandelo-trusted-desktop-preview' }, wasmArtifactPolicies: policies, normalizeTimestampsMs: 0 });
    manifest.output = { path: output, sha256: hash(bytes), bytes: bytes.length };
    writeFileSync(output + '.memory-group.json', JSON.stringify(manifest, null, 2) + '\n');
    succeeded = true;
    return manifest;
  } catch (error) {
    // Keep a failed preparation reviewable; an incomplete output is never a
    // successful image and the ordinary input is never modified.
    writeFileSync(output + '.failed.json', JSON.stringify({ ...manifest, staging: stage, error: String(error) }, null, 2) + '\n');
    throw error;
  } finally { fs.reset(); if (succeeded) rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [input, output, ...extra] = process.argv.slice(2);
  if (!input || !output || extra.length > 1 || extra.length === 1 && extra[0] !== '--login-session') {
    throw Error('Usage: prepare-shared-desktop-image.ts ORDINARY.vfs.zst GROUPED.vfs.zst [--login-session]');
  }
  await prepareSharedDesktopImage(input, output, { includeLoginSession: extra.length === 1 });
}
