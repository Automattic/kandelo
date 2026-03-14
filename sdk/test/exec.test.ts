import { describe, it, expect } from 'vitest';
import { run, runPassthrough } from '../src/lib/exec.ts';

describe('run', () => {
  it('captures stdout from a command', async () => {
    const result = await run('echo', ['hello']);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.exitCode).toBe(0);
  });

  it('returns non-zero exit code on failure', async () => {
    const result = await run('false', []);
    expect(result.exitCode).not.toBe(0);
  });
});
