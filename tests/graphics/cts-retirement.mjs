/** Validate cooperative guest-image retirement, independently of Playwright's
 * incomplete nested-worker inventory. This does not prove native closure. */
export function inspectCtsRetirement(events, pid, exitStatus) {
  const errors = [];
  if (!Array.isArray(events) || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isInteger(exitStatus)) {
    return { ok: false, errors: ["missing process identity, exit or pre-destroy events"], identity: null };
  }
  const own = events.filter(event => event && event.pid === pid);
  const admitted = own.filter(event => event.kind === "admitted");
  const exited = own.filter(event => event.kind === "exited");
  const retired = own.filter(event => event.kind === "retired");
  if (own.some(event => !["admitted","exited","retired"].includes(event.kind))) errors.push("unknown image event kind");
  if (admitted.length !== 1) errors.push("expected one admitted image");
  if (exited.length !== 1) errors.push("expected one semantic exit");
  if (retired.length !== 1) errors.push("expected one committed retirement");
  const first = admitted[0];
  const identity = first ? { pid, realmId: first.realmId, executionId: first.executionId } : null;
  if (!first || !Number.isSafeInteger(first.realmId) || first.realmId <= 0 ||
      !Number.isSafeInteger(first.executionId) || first.executionId <= 0) errors.push("invalid admitted realm/image identity");
  if (first && own.some(event => event.realmId !== first.realmId || event.executionId !== first.executionId)) {
    errors.push("exit or retirement belongs to another realm/image");
  }
  const exit = exited[0], retirement = retired[0];
  if (exit && exit.status !== exitStatus) errors.push("exit status differs from guest result");
  if (first && exit && retirement &&
      !(events.indexOf(first) < events.indexOf(exit) && events.indexOf(exit) < events.indexOf(retirement))) {
    errors.push("admission, exit and retirement are out of order");
  }
  if (retirement) {
    if (retirement.leaseDisposition !== "quiescent") errors.push("lease was not cooperatively retired");
    if (retirement.postCommitFailed !== false) errors.push("retirement has an unknown or failed post-commit state");
    if (retirement.registration !== "removed-or-absent") errors.push("original registration was superseded");
    if (retirement.mainFence !== "acknowledged" || retirement.threadFences !== "acknowledged") {
      errors.push("missing main or thread quiescence acknowledgment");
    }
    if (!Number.isSafeInteger(retirement.threads) || retirement.threads < 0 ||
        retirement.acknowledgedThreads !== retirement.threads) errors.push("thread acknowledgments are incomplete");
  }
  return { ok: errors.length === 0, errors, identity };
}
