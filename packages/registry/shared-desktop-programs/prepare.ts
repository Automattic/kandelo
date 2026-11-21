/** Build-time SDK preparation only; each program keeps its own lazy archive. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const here = import.meta.dirname, repo = resolve(here, '../../..');
const work = process.env.WASM_POSIX_DEP_WORK_DIR;
const out = process.env.WASM_POSIX_DEP_OUT_DIR;
if (!work || !out) throw Error('SDK program preparation requires resolver-owned work/output roots');
const rows = JSON.parse(readFileSync(join(here, 'programs.json'), 'utf8')) as {
  id: string; dependency: string; artifact: string; guestPath: string;
}[];
const hash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const programs = [];
for (const row of rows) {
  const prefix = process.env['WASM_POSIX_DEP_' + row.dependency.replaceAll('-', '_').toUpperCase() + '_DIR'];
  if (!prefix) throw Error('Missing declared dependency ' + row.dependency);
  const input = join(prefix, row.artifact), stage = join(work, row.id);
  mkdirSync(stage);
  const source = readFileSync(input);
  const report = JSON.parse(execFileSync(join(repo, 'sdk/bin/wasm32posix-shared-memory'),
    [input, '-o', join(stage, 'program.wasm')], { encoding: 'utf8' }));
  const prepared = readFileSync(join(stage, 'program.wasm'));
  if (report.sourceSha256 !== hash(source)) throw Error('SDK source identity changed: ' + row.id);
  const archive = join(out, row.id + '.zip');
  execFileSync('bash', [join(repo, 'images/vfs/scripts/create-deterministic-zip.sh'), stage, archive], { stdio: 'inherit' });
  const zip = readFileSync(archive);
  programs.push({ ...row, ordinarySha256: hash(source), groupedSha256: hash(prepared),
    bytes: prepared.length, archiveSha256: hash(zip), archiveBytes: zip.length, translation: report });
  console.log('Prepared lazy SDK artifact ' + row.id);
}
writeFileSync(join(out, 'programs.json'), JSON.stringify({ schema: 1, memoryGroup: 'trusted-v1', programs }, null, 2) + '\n');
