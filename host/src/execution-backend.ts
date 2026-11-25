import { PreparedExecTargetError } from './exec-target';
import { ERRNO } from './generated/abi';

export type ExecutionBackend = 'ordinary' | 'memory-group';
/** Check explicit selection before commit. Compatibility here only routes the
 * request; normal kernel admission still judges the executable itself. */
export function assertInitialExecutionBackend(requested: ExecutionBackend | undefined,
  compatible: boolean, configured: boolean): void {
  if (requested === 'memory-group' && !configured) {
    throw new PreparedExecTargetError('Memory-group backend is not configured', ERRNO.EOPNOTSUPP);
  }
  if ((requested === 'memory-group' && !compatible) || (requested === 'ordinary' && compatible)) {
    throw new PreparedExecTargetError('Executable does not support the requested execution backend; use spawnFromVfs for SDK source alternatives', ERRNO.ENOEXEC);
  }
}
