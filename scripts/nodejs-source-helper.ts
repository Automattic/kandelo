/** Exact Node LTS inputs shared by the native oracle and guest suite. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, lstatSync, readlinkSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const repoRoot = resolve(new URL('..', import.meta.url).pathname);
export const targetPath = join(repoRoot, 'packages/registry/node-compat/target.json');
export const nodejsTarget = JSON.parse(readFileSync(targetPath, 'utf8')) as {
  schema: number; version: string; lts: string;
  source: { url: string; sha256: string; tag: string; commit: string };
  references: Record<string, { url: string; sha256: string }>;
};
if (nodejsTarget.schema !== 1 || !/^\d+\.\d+\.\d+$/.test(nodejsTarget.version)) throw Error('Invalid Node target pin');
export const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
export const fileHash = (path: string) => hash(readFileSync(path));
export const defaultNodejsTestVersion = () => nodejsTarget.version;
export const defaultCategories = ['parallel', 'sequential'];
export interface NodejsTestDescriptor {
  name: string; relPath: string; hostPath: string; vfsPath: string;
  sha256: string; flags: string[]; env: Record<string, string>;
  nodeTest: boolean; rlimitAs?: number;
}

// Match Node testpy's lexical Flags/Env convention, rather than inventing
// shell expansion. These directives are whitespace-separated, not shell code.
export function parseNodejsTestMetadata(source: string) {
  const flags = source.match(/\/\/\s+Flags:([^\n\r]*)/)?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
  const pairs = source.match(/\/\/\s+Env:([^\n\r]*)/)?.[1].trim().split(/\s+/).filter(Boolean) ?? [];
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equal = pair.indexOf('=');
    if (equal < 1) throw Error(`Invalid upstream Env metadata: ${pair}`);
    env[pair.slice(0, equal)] = pair.slice(equal + 1);
  }
  const limit = source.match(/\/\/\s+RLIMIT_AS:\s*(\d+)/)?.[1];
  return { flags, env, nodeTest: /(['"`])node:test\1/.test(source), ...(limit ? { rlimitAs: Number(limit) } : {}) };
}

export function collectNodejsLibraryTests(sourceRoot: string, selectors: string[] = []) {
  const all = defaultCategories.flatMap(category => {
    const directory = join(sourceRoot, 'test', category);
    return readdirSync(directory).filter(name => /^test-.*\.m?js$/.test(name))
      .map(name => `${category}/${name}`);
  }).sort();
  const clean = selectors.map(value => value.replace(/^test\//, ''));
  for (const value of clean) {
    if (value.includes('..') || value.startsWith('/')) throw Error(`Invalid selector: ${value}`);
    if (!all.some(name => name === value || name.startsWith(value + '/') || basename(name) === value)) {
      throw Error(`Selector does not match the parallel/sequential inventory: ${value}`);
    }
  }
  return all.filter(name => clean.length === 0 || clean.some(value => name === value || name.startsWith(value + '/') || basename(name) === value))
    .map(name => {
      const relPath = `test/${name}`, hostPath = join(sourceRoot, relPath);
      const source = readFileSync(hostPath, 'utf8');
      return { name, relPath, hostPath, vfsPath: `/node-src/${relPath}`, sha256: hash(source), ...parseNodejsTestMetadata(source) };
    });
}

/** Audit other categories without misreporting custom suites as standalone JS. */
export function auditNodejsCategories(sourceRoot: string) {
  return readdirSync(join(sourceRoot, 'test'), { withFileTypes: true }).filter(item => item.isDirectory()).map(item => {
    const files = sourceFiles(join(sourceRoot, 'test', item.name));
    return { category: item.name, standaloneCandidates: files.filter(file => /(^|\/)test-[^/]+\.m?js$/.test(file)).length,
      included: defaultCategories.includes(item.name),
      reason: defaultCategories.includes(item.name) ? 'Node testpy standalone JavaScript inventory'
        : 'Outside initial parallel/sequential scope; custom configuration, build, or fixture role needs review' };
  });
}

export function sourceFiles(root: string): string[] {
  const found: string[] = [];
  function walk(dir: string) {
    for (const name of readdirSync(dir).sort()) {
      const path = join(dir, name), stat = lstatSync(path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile() || stat.isSymbolicLink()) found.push(relative(root, path).split('\\').join('/'));
    }
  }
  walk(root);
  return found;
}

export function sourceTreeHash(root: string) {
  const digest = createHash('sha256');
  for (const name of sourceFiles(root)) {
    const path = join(root, name), stat = lstatSync(path);
    digest.update(name + '\0' + (stat.mode & 0o777).toString(8) + '\0');
    digest.update(stat.isSymbolicLink() ? 'link:' + readlinkSync(path) : readFileSync(path));
    digest.update('\0');
  }
  return digest.digest('hex');
}

/** Downloads are pinned; archive verification never follows host Node version. */
export function preparePinnedArchive(cache: string, artifact: { url: string; sha256: string }) {
  mkdirSync(cache, { recursive: true });
  const name = basename(new URL(artifact.url).pathname), archive = join(cache, name);
  if (!existsSync(archive) || fileHash(archive) !== artifact.sha256) {
    const work = mkdtempSync(join(cache, '.download-'));
    try {
      const download = join(work, name);
      execFileSync('curl', ['-fL', '--retry', '3', artifact.url, '-o', download], { stdio: 'inherit' });
      if (fileHash(download) !== artifact.sha256) throw Error(`Checksum mismatch: ${name}`);
      renameSync(download, archive);
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  const extracted = join(cache, name.replace(/\.tar\.gz$/, ''));
  const stamp = extracted + '.verified.json';
  if (!existsSync(stamp) || !existsSync(extracted)) {
    if (existsSync(extracted)) throw Error(`Unverified extraction exists: ${extracted}; use a fresh cache directory`);
    const work = mkdtempSync(join(cache, '.extract-'));
    try {
      execFileSync('tar', ['-xzf', archive, '--strip-components=1', '-C', work]);
      const treeHash = sourceTreeHash(work);
      renameSync(work, extracted);
      writeFileSync(stamp, JSON.stringify({ ...artifact, hashPolicy: 'all-source-files-v1', treeHash }, null, 2) + '\n');
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  const identity = JSON.parse(readFileSync(stamp, 'utf8'));
  if (identity.sha256 !== artifact.sha256 || identity.url !== artifact.url) {
    throw Error(`Pinned extraction identity differs: ${extracted}`);
  }
  if (identity.hashPolicy !== 'all-source-files-v1' || sourceTreeHash(extracted) !== identity.treeHash) {
    throw Error(`Pinned extraction changed or has an unknown hash policy: ${extracted}; use a fresh cache directory`);
  }
  return { directory: extracted, archiveSha256: artifact.sha256, treeHash: identity.treeHash as string };
}

export function ensureSourceModuleBoundary(cache: string) {
  // A cache beneath a type:module repository must behave like the standalone
  // upstream checkout. Own this package boundary outside the verified tree;
  // never insert or rewrite package.json inside Node's test sources.
  mkdirSync(cache, { recursive: true });
  const fence = join(cache, 'package.json');
  const contents = JSON.stringify({ private: true, type: 'commonjs' }) + '\n';
  if (existsSync(fence)) {
    if (readFileSync(fence, 'utf8') !== contents) throw Error(`Cache module boundary differs: ${fence}`);
  } else writeFileSync(fence, contents);
  return hash(contents);
}

export function prepareNodejsSource(cache: string) {
  const moduleBoundarySha256 = ensureSourceModuleBoundary(cache);
  return { ...preparePinnedArchive(cache, nodejsTarget.source), moduleBoundarySha256 };
}
export function prepareNodejsReference(cache: string) {
  const artifact = nodejsTarget.references[`${process.platform}-${process.arch}`];
  if (!artifact) throw Error(`No pinned native reference for ${process.platform}-${process.arch}`);
  const prepared = preparePinnedArchive(cache, artifact);
  const executable = join(prepared.directory, 'bin/node');
  if (execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim() !== `v${nodejsTarget.version}`) throw Error('Native reference version mismatch');
  return { ...prepared, executable, executableSha256: fileHash(executable) };
}
