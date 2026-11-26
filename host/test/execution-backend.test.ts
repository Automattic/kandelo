import { expect, it } from 'vitest';
import { assertInitialExecutionBackend } from '../src/execution-backend';
import { PreparedExecTargetError } from '../src/exec-target';
import { ERRNO } from '../src/generated/abi';
it('preserves automatic compatibility selection only when no backend was requested', () => {
  for (const compatible of [true, false]) expect(() => assertInitialExecutionBackend(undefined, compatible, true)).not.toThrow();
  expect(() => assertInitialExecutionBackend('ordinary', false, true)).not.toThrow();
  expect(() => assertInitialExecutionBackend('memory-group', true, true)).not.toThrow();
});
it.each([['memory-group', false, true, ERRNO.ENOEXEC], ['ordinary', true, true, ERRNO.ENOEXEC], ['memory-group', true, false, ERRNO.EOPNOTSUPP]] as const)('refuses %s without silent fallback', (requested, compatible, configured, errno) => {
  try { assertInitialExecutionBackend(requested, compatible, configured); throw Error('accepted wrong backend'); }
  catch (error) { expect(error).toBeInstanceOf(PreparedExecTargetError); expect((error as PreparedExecTargetError).errno).toBe(errno); }
});
