import { spawn } from 'node:child_process';
import { openSync, closeSync, readFileSync } from 'node:fs';
import type { NodejsTestDescriptor } from './nodejs-source-helper';
import type { NodejsRun } from './nodejs-test-results';

export function testFlags(test: NodejsTestDescriptor) {
  // Same extra reporter used by Node testpy for node:test cases. These are
  // real CLI flags, never assignments to process.execArgv in a wrapper.
  return [...test.flags, ...(test.nodeTest ? ['--test-reporter=./test/common/test-error-reporter.js', '--test-reporter-destination=stdout'] : [])];
}

export async function runNativeNodejsCase(executable: string, sourceRoot: string,
  test: NodejsTestDescriptor, timeoutMs: number, logPrefix: string, tempRoot: string): Promise<NodejsRun> {
  const start = performance.now();
  if (test.rlimitAs !== undefined) return { exitCode: null, stdout: '', stderr: '', durationMs: 0,
    unsupported: 'Upstream RLIMIT_AS metadata requires a resource-limit launcher; not implemented by this runner' };
  const out = openSync(logPrefix + '.stdout', 'w'), err = openSync(logPrefix + '.stderr', 'w');
  try {
    return await new Promise(resolve => {
      let timeout = false, error: string | undefined;
      const child = spawn(executable, [...testFlags(test), test.hostPath], {
        cwd: sourceRoot, detached: true, stdio: ['ignore', out, err],
        env: { PATH: process.env.PATH, HOME: tempRoot, TMPDIR: tempRoot, NODE_TEST_DIR: tempRoot,
          TERM: 'dumb', TZ: 'UTC', LC_ALL: 'C', NODE_DISABLE_COLORS: '1', ...test.env },
      });
      const killGroup = () => {
        if (!child.pid) return;
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (failure: any) { if (failure.code !== 'ESRCH') error ??= String(failure); }
      };
      const timer = setTimeout(() => { timeout = true; killGroup(); }, timeoutMs);
      child.on('error', failure => { error = String(failure); });
      child.on('close', (exitCode, signal) => {
        clearTimeout(timer);
        // Children must not escape into the next test, including after a
        // successful parent exit. Logs use files so inherited pipes cannot
        // hold the harness open indefinitely.
        killGroup();
        resolve({ exitCode, signal, timeout, error, durationMs: Math.round(performance.now() - start),
          stdout: readFileSync(logPrefix + '.stdout', 'utf8'), stderr: readFileSync(logPrefix + '.stderr', 'utf8') });
      });
    });
  } finally { closeSync(out); closeSync(err); }
}
