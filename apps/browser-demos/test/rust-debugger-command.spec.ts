import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '../playwright-test';
import { KandeloImageFs } from '../../../images/vfs/lib/kandelo-image-fs';
import { resolveBinary } from '../../../host/src/binary-resolver';
import { buildRustBacktraceFixture } from '../../../host/test/fixtures/rust-backtrace-build';

const repo = resolve(import.meta.dirname, '../../..');
let directory: string, program: string, image: string, kernel: string;
test.describe('Chromium Rust debugger command', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'This command uses Chromium CDP; Firefox/WebKit stepping is not implemented');
  test.beforeAll(async () => {
    test.setTimeout(900_000);
    directory = mkdtempSync(join(process.env.KANDELO_AGENT_SCRATCH_DIR ?? tmpdir(),'rust-browser-debugger-'));
    kernel = resolveBinary('kernel.wasm');
    program = buildRustBacktraceFixture(directory);
    const fs = KandeloImageFs.create();
    fs.mkdir('/usr'); fs.mkdir('/usr/bin');
    fs.writeFile('/usr/bin/rust-backtrace',new Uint8Array(readFileSync(program)),0o755);
    image = join(directory,'debugger.vfs'); writeFileSync(image,await fs.saveImage());
  });
  test.afterAll(() => {
    if (directory && !process.env.KANDELO_AGENT_SCRATCH_DIR) rmSync(directory,{recursive:true,force:true});
  });
  for (const mode of ['capture','thread','quit']) {
    test(`source breakpoint and ${mode} through the public Chromium command`,async ({baseURL}) => {
      test.setTimeout(90_000);
      const result = spawnSync(process.execPath,['--import','tsx/esm','scripts/debug-rust-browser.ts',program,
        '--url',baseURL!,'--break','programs/rust/backtrace/src/main.rs:5',
        '--commands',mode === 'quit' ? 'quit' : 'next,where,continue',
        '--image',image,'--kernel',kernel,'--',mode === 'quit' ? 'capture' : mode],{
        cwd:repo,env:{...process.env,RUST_BACKTRACE:'0'},encoding:'utf8',timeout:60_000,maxBuffer:8*1024**2,
      });
      expect(result.error,result.stderr).toBeUndefined();
      expect(result.signal).toBeNull();
      expect(result.status,result.stderr).toBe(mode === 'quit' ? 130 : 0);
      expect(result.stderr).toMatch(/paused worker page\/.*user_inner.*main.rs":5:5/);
      expect(result.stderr).not.toMatch(/destroy drain timed out|force-terminating/);
      if (mode !== 'quit') {
        expect(result.stderr).toMatch(/paused worker page\/.*user_inner.*main.rs":6:2/);
        expect(result.stderr).toContain('guest exited 0');
        expect(result.stdout).toContain(mode === 'thread' ? 'THREAD_BACKTRACE' : 'CAPTURED_BACKTRACE');
      }
    });
  }
});
