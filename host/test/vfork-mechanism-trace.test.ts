import { describe, expect, it } from "vitest";
import {
  parseMechanismTraceRuns,
  partitionForkDispatches,
  requireCompleteVforkSequence,
  requireVforkStartFailureSequence,
} from "./vfork-mechanism-trace";

const preparation =
  "[vfork-mechanism] event=vfork_prepared mode=1 parent=100 child=101 "
  + "memory_identity=same live_memory_delta=0 alias_delta=1 "
  + "parent_channel=1000 child_channel=2000 owner_control=3000 "
  + "child_prefix=4000 scratch=5000 externref_parent=1 externref_child=2";

function run(name: string, events: readonly string[]): string {
  return [
    `[vfork-mechanism-run] begin=${name}`,
    ...events,
    `[vfork-mechanism-run] end=${name}`,
  ].join("\n");
}

const dispatch = "[vfork-mechanism] event=dispatch mode=1 parent=100 child=101";
const mayAccess =
  "[vfork-mechanism] event=child_may_access_memory parent=100 child=101";
const quiescent = "[vfork-mechanism] event=memory_quiescent child=101";
const teardown =
  "[vfork-mechanism] event=exact_teardown child_channel=2000 reason=exit";
const released =
  "[vfork-mechanism] event=parent_released parent=100 child=101";
const startFailed =
  "[vfork-mechanism] event=worker_start_failed parent=100 child=101";

describe("vfork mechanism trace correlation", () => {
  it("does not borrow reused pid/channel events from a later host run", () => {
    const output = [
      run("missing-quiescence", [dispatch, preparation, mayAccess]),
      run("later-reused-identifiers", [
        dispatch,
        preparation,
        mayAccess,
        quiescent,
        teardown,
        released,
      ]),
    ].join("\n");
    const runs = parseMechanismTraceRuns(output);
    const firstDispatch = partitionForkDispatches(runs[0])[0];

    expect(() => requireCompleteVforkSequence(firstDispatch)).toThrow(
      "missing memory_quiescent",
    );
  });

  it.each([
    {
      name: "missing child memory access",
      events: [dispatch, preparation, quiescent, teardown, released],
      message: "missing child_may_access_memory",
    },
    {
      name: "release reordered before exact teardown",
      events: [dispatch, preparation, mayAccess, released, quiescent, teardown],
      message: "parent_released is out of order",
    },
  ])("rejects $name", ({ events, message }) => {
    const [traceRun] = parseMechanismTraceRuns(run("mutated", events));
    const [forkDispatch] = partitionForkDispatches(traceRun);

    expect(() => requireCompleteVforkSequence(forkDispatch)).toThrow(message);
  });

  it("bounds startup failure evidence to its exact run", () => {
    const output = [
      run("missing-access", [dispatch, preparation]),
      run("later-reused-identifiers", [
        dispatch,
        preparation,
        mayAccess,
        startFailed,
      ]),
    ].join("\n");
    const [first] = parseMechanismTraceRuns(output);
    const [forkDispatch] = partitionForkDispatches(first);

    expect(() => requireVforkStartFailureSequence(forkDispatch)).toThrow(
      "missing child_may_access_memory",
    );
  });
});
