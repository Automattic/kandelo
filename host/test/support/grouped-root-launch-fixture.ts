import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { compileSdkFixture } from './compile-sdk-fixture';

/** Normal SDK program and image, composed only in the test runner/kernel realm. */
export async function groupedRootLaunchFixture(): Promise<Uint8Array> {
  const fixture = compileSdkFixture(new URL('../fixtures/grouped-sdk-fork.c', import.meta.url), [], { forkInstrument: true });
  const image = KandeloImageFs.create();
  try {
    const grouped = fixture.programPath + '.grouped.wasm';
    execFileSync(fileURLToPath(new URL('../../../sdk/bin/wasm32posix-shared-memory', import.meta.url)),
      [fixture.programPath, '-o', grouped], { stdio: 'pipe' });
    image.mkdir('/tmp', 0o1777); image.mkdir('/bin', 0o755);
    image.writeFile('/bin/fork-grouped', new Uint8Array(readFileSync(grouped)), 0o755);
    return await image.saveImage();
  } finally { image.reset(); fixture.cleanup(); }
}
