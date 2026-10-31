/** Honest result accounting shared by every host. No runtime modifications. */
export type NodejsStatus = 'pass' | 'fail' | 'upstream-skip' | 'unsupported' | 'timeout' | 'harness-error';
export interface NodejsRun {
  exitCode: number | null; signal?: string | null; stdout: string; stderr: string;
  durationMs: number; stdoutChunks?: string[]; stderrChunks?: string[]; timeout?: boolean; error?: string; unsupported?: string;
}
export function classifyNodejsResult(raw: NodejsRun): NodejsStatus {
  if (raw.error) return 'harness-error';
  if (raw.unsupported) return 'unsupported';
  if (raw.timeout) return 'timeout';
  if (raw.exitCode !== 0 || raw.signal) return 'fail';
  // Even a broken native/guest test runner that forgets its exit code must not
  // turn TAP assertion failures into passes. Explicit zero-case skips differ
  // from suites that ran tests and skipped only individual subtests.
  if (/^\s*not ok\b/m.test(raw.stdout) || /^\s*#\s*fail\s+[1-9]/m.test(raw.stdout)) return 'fail';
  if (/^1\.\.0\s+#\s*(?:skip|skipped)\b/im.test(raw.stdout)) return 'upstream-skip';
  return 'pass';
}
