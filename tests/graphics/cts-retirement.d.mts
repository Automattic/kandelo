export function inspectCtsRetirement(events: unknown, pid: unknown, exitStatus: unknown): {
  ok: boolean;
  errors: string[];
  identity: { pid: number; realmId: number; executionId: number } | null;
};
