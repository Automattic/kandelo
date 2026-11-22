/** Explicit partial-image activation of normal SDK/package-owned lazy artifacts. */
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
  schema: 1; package: string; programs: { requested: string; path: string; ordinarySha256: string; groupedSha256: string; uri: string; bytes: number; artifactPath: string; aliases: string[] }[];
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
function regularAliases(fs: KandeloImageFs, inode: number | bigint): string[] {
  const aliases: string[] = [];
  const walk = (dir: string) => {
    const handle = fs.opendir(dir);
    try {
      for (let entry = fs.readdir(handle); entry; entry = fs.readdir(handle)) {
        if (entry.name === '.' || entry.name === '..') continue;
        const path = posix.join(dir, entry.name), stat = fs.lstat(path);
        if ((stat.mode & 0o170000) === 0o040000 && !stat.deferred) walk(path);
        else if ((stat.mode & 0o170000) === 0o100000 && BigInt(stat.ino) === BigInt(inode)) aliases.push(path);
      }
    } finally { fs.closedir(handle); }
  };
  walk('/');
  return aliases;
}

export function activateSharedDesktopPackage(fs: KandeloImageFs, resolveArtifact: ShellLazyArchiveResolver): SharedDesktopPackageActivation {
  const manifest = JSON.parse(readFileSync(resolveArtifact(`programs/${SHARED_DESKTOP_PACKAGE}/programs.json`, SHARED_DESKTOP_PACKAGE), 'utf8'));
  if (manifest.schema !== 1 || manifest.memoryGroup !== 'trusted-v1' || !Array.isArray(manifest.programs)
      || manifest.programs.length !== sharedDesktopPackagePrograms.length) throw Error('Invalid shared desktop SDK package manifest');
  const lazy = fs.lazyEntries();
  // Validate the complete closure before changing any executable or alias.
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
    const aliases = regularAliases(fs, stat.ino);
    if (!aliases.includes(path)) throw Error('Shared SDK target is not a regular file: ' + path);
    return { row, path, preparedPath, stat, backing, archive, aliases, ordinarySha256, groupedSha256: record.groupedSha256 as string };
  });
  for (const { path, preparedPath, stat, aliases } of plan) {
    for (const alias of aliases) fs.unlink(alias);
    // One real inode owns the prepared bytes, including the package path.
    // Separate deferred inodes could materialize the same program twice.
    fs.link(preparedPath, path);
    fs.chown(path, stat.uid, stat.gid);
    fs.chmod(path, stat.mode & 0o7777);
    for (const alias of aliases) if (alias !== path) fs.link(path, alias);
  }
  const activation: SharedDesktopPackageActivation = { schema: 1, package: SHARED_DESKTOP_PACKAGE, programs: plan.map(entry => ({
    requested: entry.row.requested ?? entry.row.guestPath, path: entry.path, ordinarySha256: entry.ordinarySha256, groupedSha256: entry.groupedSha256,
    uri: entry.archive.uri, bytes: entry.backing.size, artifactPath: entry.preparedPath, aliases: entry.aliases,
  })) };
  assertSharedDesktopPackageActivation(fs, activation);
  return activation;
}

export function assertSharedDesktopPackageActivation(fs: KandeloImageFs, activation: SharedDesktopPackageActivation): void {
  const lazy = fs.lazyEntries();
  for (const program of activation.programs) {
    const stat = fs.stat(program.path);
    if (fs.stat(program.artifactPath).ino !== stat.ino) throw Error("Shared SDK package path duplicates program storage: " + program.path);
    for (const path of program.aliases) {
      const alias = fs.stat(path), entry = lazy.files.find(file => file.path === path) ?? lazy.files.find(file => file.ino === BigInt(alias.ino));
      const archive = entry && lazy.archives.find(archive => archive.archiveId === entry.archiveId);
      if (!alias.deferred || BigInt(alias.ino) !== BigInt(stat.ino) || alias.mode !== stat.mode
          || alias.uid !== stat.uid || alias.gid !== stat.gid || entry?.size !== program.bytes || archive?.uri !== program.uri) {
        throw Error('Shared SDK program alias lost its lazy identity: ' + path);
      }
    }
  }
}

/** The opt-in partial preview advertises only the prepared graphical sessions. */
export function sharedDesktopPackageDemo(config: import('../../../web-libs/kandelo-session/src/demo-config').KandeloDemoConfig) {
  const profiles = Object.fromEntries(['cage', 'sway', 'sway-sfwbar'].map(id => {
    const original = config.profiles?.[id];
    if (!original) throw Error('Shared desktop package needs the normal ' + id + ' profile');
    const title = id === 'cage' ? 'Shared-memory Cage desktop' : id === 'sway' ? 'Shared-memory Sway desktop' : 'Shared-memory Sway with SFWBar';
    return [id, { ...original,
      requires: [...new Set([...(original.requires ?? []), SHARED_DESKTOP_PACKAGE, 'foot'])],
      ...(id === 'cage' ? { init: { ...original.init, shellCommand: 'LIBSEAT_BACKEND=noop XDG_RUNTIME_DIR=/tmp FONTCONFIG_FILE=/usr/share/kandelo/fonts/fonts.conf /usr/bin/cage -- /usr/bin/foot --config=/usr/share/kandelo/sway/foot.ini' } } : {}),
      ...(original.identity ? { identity: { ...original.identity, title, summary: 'Experimental trusted shared-memory desktop.' } } : {}),
      guide: { ...original.guide, title, summary: 'Experimental compatible, trusted participants. Run freeciv, scummvm-static or scummvm-static-play god-of-thunder from Foot. ' + (original.guide?.summary ?? '') },
    }];
  }));
  return { ...config, defaultProfile: 'cage', profiles };
}
