// WHY: `undefined` cannot distinguish the built-in one-shot transport from a
// malformed direct worker launch. This small workerData value contains no
// process memory but lets the public entry fail loudly when initialization is
// absent.
export const NODE_WORKER_INIT_BY_MESSAGE = {
  kind: "kandelo-node-worker-init-by-message",
  schema: 1,
} as const;

export function isNodeWorkerInitByMessage(
  value: unknown,
): value is typeof NODE_WORKER_INIT_BY_MESSAGE {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  // WHY: exact shape keeps unrelated custom workerData from accidentally
  // selecting Kandelo's built-in message transport.
  return (
    candidate.kind === NODE_WORKER_INIT_BY_MESSAGE.kind &&
    candidate.schema === NODE_WORKER_INIT_BY_MESSAGE.schema &&
    Object.keys(candidate).length === 2
  );
}
