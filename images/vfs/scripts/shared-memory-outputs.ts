/** Install ordinary producer-owned shared-memory outputs through normal lazy archives. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readBuildInputs } from './read-build-inputs';
import { parseZipCentralDirectory } from '../../../host/src/vfs/zip';
import { sharedMemoryProgramPath } from '../../../host/src/shared-memory-program';
import type { KandeloImageFs } from '../lib/kandelo-image-fs';

export interface SharedMemoryOutput {
  packageName: string;
  sourceSha256: string;
  archive: { path: string; resolverPath: string; bytes: number; sha256: string };
}
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function fields(value: unknown, names: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.sort().join(','))
    throw Error('Invalid shared-memory output metadata fields');
}
export function loadSharedMemoryOutputs(path: string, consumerPackage: string): readonly SharedMemoryOutput[] {
  const metadata = readBuildInputs(path);
  fields(metadata, ['schema', 'kind', 'consumerPackage', 'outputs']);
  if (metadata.schema !== 1 || metadata.kind !== 'kandelo-dependency-shared-memory-outputs'
      || metadata.consumerPackage !== consumerPackage || !Array.isArray(metadata.outputs) || metadata.outputs.length > 4096)
    throw Error('Invalid shared-memory dependency outputs');
  for (const output of metadata.outputs) {
    fields(output, ['packageName', 'sourceSha256', 'archive']);
    fields(output.archive, ['path', 'resolverPath', 'bytes', 'sha256']);
    const archive = output.archive;
    if (typeof output.packageName !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/.test(output.packageName) || !sha(output.sourceSha256)
        || typeof archive.path !== 'string' || !isAbsolute(archive.path) || resolve(archive.path) !== archive.path
        || realpathSync(archive.path) !== archive.path || !sha(archive.sha256)
        || typeof archive.resolverPath !== 'string' || !archive.resolverPath.startsWith('programs/wasm32/')
        || archive.resolverPath.includes('\\') || archive.resolverPath.split('/').some(part => !part || part === '.' || part === '..')
        || /[\u0000-\u001f\u007f]/.test(archive.resolverPath)
        || !Number.isSafeInteger(archive.bytes) || Number(archive.bytes) < 1 || Number(archive.bytes) > 512*1024*1024)
      throw Error('Invalid shared-memory dependency output');
  }
  return metadata.outputs as unknown as SharedMemoryOutput[];
}
export function installSharedMemoryOutputs(fs: KandeloImageFs, outputs: readonly SharedMemoryOutput[]): number {
  const installed = new Map<string, string>();
  for (const output of outputs) {
    const { archive, sourceSha256 } = output;
    const previous = installed.get(sourceSha256);
    if (previous !== undefined) {
      if (previous !== archive.sha256) throw Error('Conflicting shared-memory variants for one executable');
      continue;
    }
    const bytes = new Uint8Array(readFileSync(archive.path));
    if (bytes.length !== archive.bytes || createHash('sha256').update(bytes).digest('hex') !== archive.sha256)
      throw Error('Shared-memory package output changed');
    const entries = parseZipCentralDirectory(bytes);
    if (entries.length !== 1 || entries[0].fileName !== 'program.wasm' || entries[0].isDirectory || entries[0].isSymlink)
      throw Error('Invalid shared-memory package archive');
    const path = sharedMemoryProgramPath(sourceSha256);
    fs.registerLazyArchive({ url: 'kandelo-lazy:' + archive.resolverPath, entries,
      mountPrefix: path.slice(0, -'program.wasm'.length), integrity: { sha256: archive.sha256, bytes: archive.bytes } });
    fs.chmod(path, 0o755);
    installed.set(sourceSha256, archive.sha256);
  }
  return installed.size;
}
export function sharedMemoryOutputsFromEnvironment(env: NodeJS.ProcessEnv): readonly SharedMemoryOutput[] {
  const path = env.WASM_POSIX_DEP_SHARED_MEMORY_OUTPUTS;
  if (path === undefined) return [];
  if (!env.WASM_POSIX_DEP_NAME) throw Error('Shared-memory outputs require a resolver consumer identity');
  return loadSharedMemoryOutputs(path, env.WASM_POSIX_DEP_NAME);
}
