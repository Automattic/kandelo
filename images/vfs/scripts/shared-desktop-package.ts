/** Install validated SDK alternatives alongside ordinary image executables. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { KandeloImageFs } from '../lib/kandelo-image-fs';
import { readWasmCustomSectionNames, readWasmCustomSectionPayload, describeWasmArtifactPolicyFailures } from '../../../host/src/constants';
import { GROUPED_WORKER_EXTENSIONS } from '../../../host/src/grouped-worker-runtime';
import * as G from '../../../host/src/generated/program-extensions';
import { readTrustedDesktopProgram } from './trusted-desktop-program';
import { parseZipCentralDirectory, extractZipEntry } from '../../../host/src/vfs/zip';
import { sharedDesktopPackagePrograms, SHARED_DESKTOP_PACKAGE, SHARED_DESKTOP_PACKAGE_ROOT } from './shared-desktop-package-contract';
import type { ShellLazyArchiveResolver } from './shell-lazy-archives';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface SharedDesktopPackageActivation {
  programs: { path: string; ordinarySha256: string; artifactPath: string }[];
}

/** Resolve a file's actual path while retaining its original symlink topology. */
function realPath(fs: KandeloImageFs, requested: string): string {
  let path = requested;
  for (let count = 0; (fs.lstat(path).mode & 0o170000) === 0o120000; count++) {
    if (count >= 16) throw Error('Shared desktop executable symlink loop: ' + requested);
    path = posix.resolve(posix.dirname(path), fs.readlink(path));
  }
  return path;
}
export function activateSharedDesktopPackage(fs: KandeloImageFs, resolveArtifact: ShellLazyArchiveResolver): SharedDesktopPackageActivation {
  const manifest = JSON.parse(readFileSync(resolveArtifact(`programs/${SHARED_DESKTOP_PACKAGE}/programs.json`, SHARED_DESKTOP_PACKAGE), 'utf8'));
  if (manifest.schema !== 1 || manifest.memoryGroup !== 'trusted-v1' || !Array.isArray(manifest.programs)
      || manifest.programs.length !== sharedDesktopPackagePrograms.length) throw Error('Invalid shared desktop SDK package manifest');
  const lazy = fs.lazyEntries();
  // Validate the complete closure before granting variant execute permissions.
  const plan = sharedDesktopPackagePrograms.map(row => {
    const records = manifest.programs.filter((entry: { id: string }) => entry.id === row.id);
    if (records.length !== 1) throw Error('Missing or duplicate shared SDK program: ' + row.id);
    const record = records[0], path = realPath(fs, row.guestPath), stat = fs.lstat(path);
    if (record.guestPath !== row.guestPath || record.dependency !== row.dependency || record.artifact !== row.artifact) throw Error('Changed shared SDK program identity: ' + row.id);
    const source = lazy.files.find(entry => entry.path === path);
    let ordinarySha256: string;
    if (!source) ordinarySha256 = hash(fs.readFile(path));
    else if (source.archiveId === 0 && source.digest.some(Boolean)) ordinarySha256 = Buffer.from(source.digest).toString('hex');
    else ordinarySha256 = hash(readTrustedDesktopProgram(source, lazy.archives, uri => {
      if (!uri.startsWith('kandelo-lazy:programs/')) throw Error('Unexpected shared SDK source URI');
      return new Uint8Array(readFileSync(resolveArtifact(uri.slice('kandelo-lazy:'.length), row.imageDependency ?? row.dependency)));
    }));
    if (ordinarySha256 !== record.ordinarySha256) throw Error('Shared SDK program differs from ordinary image: ' + path);
    const preparedPath = `${SHARED_DESKTOP_PACKAGE_ROOT}${row.id}/program.wasm`;
    const backing = lazy.files.find(entry => entry.path === preparedPath);
    const archive = backing && lazy.archives.find(entry => entry.archiveId === backing.archiveId);
    if (!backing || !archive || backing.size !== record.bytes || archive.bytes !== record.archiveBytes
        || Buffer.from(archive.digest).toString('hex') !== record.archiveSha256) throw Error('Shared SDK archive binding differs: ' + row.id);
    const zip = new Uint8Array(readFileSync(resolveArtifact(`programs/${SHARED_DESKTOP_PACKAGE}/${row.id}.zip`, SHARED_DESKTOP_PACKAGE)));
    if (zip.length !== record.archiveBytes || hash(zip) !== record.archiveSha256) throw Error('Shared SDK archive changed: ' + row.id);
    const entries = parseZipCentralDirectory(zip);
    if (entries.length !== 1 || entries[0].fileName !== 'program.wasm' || entries[0].isDirectory || entries[0].isSymlink) throw Error('Shared SDK archive has unexpected members: ' + row.id);
    const program = extractZipEntry(zip, entries[0]);
    if (program.length !== record.bytes || hash(program) !== record.groupedSha256) throw Error('Shared SDK executable changed: ' + row.id);
    const bytes = Uint8Array.from(program).buffer;
    const failures = describeWasmArtifactPolicyFailures(bytes, { supportedProgramExtensions: GROUPED_WORKER_EXTENSIONS });
    const section = readWasmCustomSectionPayload(bytes, G.MEMORY_GROUP_SECTION);
    if (readWasmCustomSectionNames(bytes).filter(name => name === G.MEMORY_GROUP_SECTION).length !== 1 || !section || section.byteLength > 4096) throw Error('Shared SDK program has no unique group declaration: ' + row.id);
    const metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(section));
    if (failures.length || metadata.version !== G.MEMORY_GROUP_VERSION || metadata.layout !== G.MEMORY_GROUP_LAYOUT
        || metadata.sourceSha256 !== ordinarySha256) throw Error('Shared SDK artifact policy failed: ' + row.id + ': ' + failures.join('; '));
    if ((stat.mode & 0o170000) !== 0o100000) throw Error('Shared SDK target is not a regular file: ' + path);
    return { path, artifactPath: preparedPath, ordinarySha256 };
  });
  for (const { artifactPath } of plan) fs.chmod(artifactPath, 0o755);
  const activation: SharedDesktopPackageActivation = { programs: plan };
  assertSharedDesktopPackageActivation(fs, activation);
  return activation;
}

export function assertSharedDesktopPackageActivation(fs: KandeloImageFs, activation: SharedDesktopPackageActivation): void {
  const lazy = fs.lazyEntries();
  for (const program of activation.programs) {
    const stat = fs.stat(program.path);
    const variant = fs.stat(program.artifactPath);
    if (BigInt(variant.ino) === BigInt(stat.ino) || (variant.mode & 0o111) === 0) throw Error("SDK variant replaced or lost execute permission: " + program.path);
    const source = lazy.files.find(file => file.path === program.path) ?? lazy.files.find(file => file.ino === BigInt(stat.ino));
    if (source && source.archiveId === 0 && source.digest.some(Boolean) && Buffer.from(source.digest).toString("hex") !== program.ordinarySha256) throw Error("Ordinary program identity changed: " + program.path);
  }
}
