import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { compileSdkFixture } from '../../../host/test/support/compile-sdk-fixture';
import { makeHostScratchTempRoot } from '../../../host/test/centralized-test-helper';
import { sharedDesktopPackagePrograms } from '../../../images/vfs/scripts/shared-desktop-package-contract';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
export const fixtureDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export interface SdkImageFixture { ordinary: Uint8Array; grouped: Uint8Array; zip: Uint8Array }
/** These are real SDK artifacts for composition tests, not runnable substitute
 * shells or graphical programs. Product execution has its own consumer tests. */
export function prepareSharedDesktopSdkFixtures(): Map<string, SdkImageFixture> {
  const root = makeHostScratchTempRoot('shell-composition-sdk-');
  const result = new Map<string, SdkImageFixture>();
  try {
    for (const [index, row] of sharedDesktopPackagePrograms.entries()) {
      const source = join(root, row.id + '.c');
      writeFileSync(source, `int main(void) { return ${index + 1}; }\n`);
      const compiled = compileSdkFixture(pathToFileURL(source), ['-Wl,-z,stack-size=65536'], { forkInstrument: true });
      try {
        const output = join(root, row.id + '.grouped.wasm');
        execFileSync(fileURLToPath(new URL('../../../sdk/bin/wasm32posix-shared-memory', import.meta.url)), [compiled.programPath, '-o', output], { stdio: 'pipe' });
        const ordinary = new Uint8Array(readFileSync(compiled.programPath));
        const grouped = new Uint8Array(readFileSync(output));
        const zip = zipSync({ 'program.wasm': [grouped, { os: 3, attrs: 0o100644 << 16 }] }, { level: 1, mtime: new Date('2020-01-01T00:00:00Z') });
        result.set(row.id, { ordinary, grouped, zip });
      } finally { compiled.cleanup(); }
    }
    return result;
  } finally { rmSync(root, { recursive: true, force: true }); }
}
