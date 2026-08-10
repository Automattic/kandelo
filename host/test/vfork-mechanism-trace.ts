export interface MechanismTrace {
  readonly event: string;
  readonly fields: ReadonlyMap<string, string>;
  readonly line: string;
}

export interface MechanismTraceRun {
  readonly name: string;
  readonly traces: readonly MechanismTrace[];
}

export interface ForkDispatchTrace {
  readonly runName: string;
  readonly mode: string;
  readonly parent: string;
  readonly child: string;
  readonly traces: readonly MechanismTrace[];
}

export interface CompleteVforkSequence {
  readonly dispatch: MechanismTrace;
  readonly preparation: MechanismTrace;
  readonly childMayAccessMemory: MechanismTrace;
  readonly memoryQuiescent: MechanismTrace;
  readonly exactTeardown: MechanismTrace;
  readonly parentReleased: MechanismTrace;
}

function fieldsFromLine(prefix: string, line: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const token of line.slice(prefix.length).split(" ")) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      fields.set(token.slice(0, separator), token.slice(separator + 1));
    }
  }
  return fields;
}

export function parseMechanismTraceLine(line: string): MechanismTrace | undefined {
  const prefix = "[vfork-mechanism] ";
  if (!line.startsWith(prefix)) return undefined;
  const fields = fieldsFromLine(prefix, line);
  return { event: fields.get("event") ?? "", fields, line };
}

export function parseMechanismTraceRuns(output: string): MechanismTraceRun[] {
  const markerPrefix = "[vfork-mechanism-run] ";
  const runs: MechanismTraceRun[] = [];
  let active: { name: string; traces: MechanismTrace[] } | undefined;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith(markerPrefix)) {
      const fields = fieldsFromLine(markerPrefix, line);
      const begin = fields.get("begin");
      const end = fields.get("end");
      if (begin) {
        if (active) throw new Error(`nested trace run ${begin}`);
        if (runs.some((run) => run.name === begin)) {
          throw new Error(`duplicate trace run ${begin}`);
        }
        active = { name: begin, traces: [] };
      } else if (end) {
        if (!active || active.name !== end) {
          throw new Error(`mismatched trace run end ${end}`);
        }
        runs.push(active);
        active = undefined;
      } else {
        throw new Error(`invalid trace run marker: ${line}`);
      }
      continue;
    }
    const trace = parseMechanismTraceLine(line);
    if (!trace) continue;
    if (!active) throw new Error(`mechanism trace outside run: ${line}`);
    active.traces.push(trace);
  }
  if (active) throw new Error(`unterminated trace run ${active.name}`);
  return runs;
}

function requiredField(trace: MechanismTrace, field: string): string {
  const value = trace.fields.get(field);
  if (value === undefined) {
    throw new Error(`${trace.event} missing ${field}: ${trace.line}`);
  }
  return value;
}

export function partitionForkDispatches(
  run: MechanismTraceRun,
): ForkDispatchTrace[] {
  const dispatchIndexes = run.traces.flatMap((trace, index) =>
    trace.event === "dispatch" ? [index] : []
  );
  if (dispatchIndexes.length === 0 && run.traces.length > 0) {
    throw new Error(`trace run ${run.name} has no dispatch`);
  }
  if (dispatchIndexes[0] !== 0) {
    throw new Error(`trace run ${run.name} has events before its first dispatch`);
  }
  return dispatchIndexes.map((start, index) => {
    const dispatch = run.traces[start];
    const end = dispatchIndexes[index + 1] ?? run.traces.length;
    return {
      runName: run.name,
      mode: requiredField(dispatch, "mode"),
      parent: requiredField(dispatch, "parent"),
      child: requiredField(dispatch, "child"),
      traces: run.traces.slice(start, end),
    };
  });
}

function requireSingleEvent(
  dispatch: ForkDispatchTrace,
  event: string,
  matches: (trace: MechanismTrace) => boolean,
): { trace: MechanismTrace; index: number } {
  const matching = dispatch.traces.flatMap((trace, index) =>
    trace.event === event && matches(trace) ? [{ trace, index }] : []
  );
  if (matching.length === 0) {
    throw new Error(
      `${dispatch.runName} child=${dispatch.child} missing ${event}`,
    );
  }
  if (matching.length !== 1) {
    throw new Error(
      `${dispatch.runName} child=${dispatch.child} has ${matching.length} ${event} events`,
    );
  }
  return matching[0];
}

export function requireCompleteVforkSequence(
  dispatch: ForkDispatchTrace,
): CompleteVforkSequence {
  if (dispatch.mode !== "1") {
    throw new Error(`${dispatch.runName} child=${dispatch.child} is mode ${dispatch.mode}`);
  }
  const preparation = requireSingleEvent(
    dispatch,
    "vfork_prepared",
    (trace) => trace.fields.get("parent") === dispatch.parent
      && trace.fields.get("child") === dispatch.child,
  );
  const childMayAccessMemory = requireSingleEvent(
    dispatch,
    "child_may_access_memory",
    (trace) => trace.fields.get("parent") === dispatch.parent
      && trace.fields.get("child") === dispatch.child,
  );
  const memoryQuiescent = requireSingleEvent(
    dispatch,
    "memory_quiescent",
    (trace) => trace.fields.get("child") === dispatch.child,
  );
  const childChannel = requiredField(preparation.trace, "child_channel");
  const exactTeardown = requireSingleEvent(
    dispatch,
    "exact_teardown",
    (trace) => trace.fields.get("child_channel") === childChannel,
  );
  const parentReleased = requireSingleEvent(
    dispatch,
    "parent_released",
    (trace) => trace.fields.get("parent") === dispatch.parent
      && trace.fields.get("child") === dispatch.child,
  );
  const ordered = [
    preparation,
    childMayAccessMemory,
    memoryQuiescent,
    exactTeardown,
    parentReleased,
  ];
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index].index <= ordered[index - 1].index) {
      throw new Error(
        `${dispatch.runName} child=${dispatch.child} `
        + `${ordered[index].trace.event} is out of order`,
      );
    }
  }
  return {
    dispatch: dispatch.traces[0],
    preparation: preparation.trace,
    childMayAccessMemory: childMayAccessMemory.trace,
    memoryQuiescent: memoryQuiescent.trace,
    exactTeardown: exactTeardown.trace,
    parentReleased: parentReleased.trace,
  };
}

export function requireVforkStartFailureSequence(
  dispatch: ForkDispatchTrace,
): {
  readonly preparation: MechanismTrace;
  readonly childMayAccessMemory: MechanismTrace;
  readonly workerStartFailed: MechanismTrace;
} {
  if (dispatch.mode !== "1") {
    throw new Error(`${dispatch.runName} child=${dispatch.child} is mode ${dispatch.mode}`);
  }
  const preparation = requireSingleEvent(
    dispatch,
    "vfork_prepared",
    (trace) => trace.fields.get("parent") === dispatch.parent
      && trace.fields.get("child") === dispatch.child,
  );
  const childMayAccessMemory = requireSingleEvent(
    dispatch,
    "child_may_access_memory",
    (trace) => trace.fields.get("parent") === dispatch.parent
      && trace.fields.get("child") === dispatch.child,
  );
  const workerStartFailed = requireSingleEvent(
    dispatch,
    "worker_start_failed",
    (trace) => trace.fields.get("parent") === dispatch.parent
      && trace.fields.get("child") === dispatch.child,
  );
  if (childMayAccessMemory.index <= preparation.index) {
    throw new Error(
      `${dispatch.runName} child=${dispatch.child} child_may_access_memory is out of order`,
    );
  }
  if (workerStartFailed.index <= childMayAccessMemory.index) {
    throw new Error(
      `${dispatch.runName} child=${dispatch.child} worker_start_failed is out of order`,
    );
  }
  for (const forbidden of ["memory_quiescent", "parent_released"]) {
    if (dispatch.traces.some((trace) => trace.event === forbidden)) {
      throw new Error(
        `${dispatch.runName} child=${dispatch.child} unexpectedly emitted ${forbidden}`,
      );
    }
  }
  return {
    preparation: preparation.trace,
    childMayAccessMemory: childMayAccessMemory.trace,
    workerStartFailed: workerStartFailed.trace,
  };
}
