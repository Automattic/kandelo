# Focused nonisolated public runner controls

Use the declared development shell and exact audited native executable:

```sh
scripts/dev-shell.sh env NODE26_REFERENCE=/absolute/pinned/node \
  TEST_RUNNER_CONTROL_DIR=/fresh/evidence/directory \
  bash third_party/node-core/tests/testing-runner/run-controls.sh
```

The bundle must already match actual source; this command does not perform global
setup, compile an engine/dependency/product or run an overall suite. It checks11
native/candidate result pairs and separately records missing process/watch/coverage
owners as public implementation failures. Real load/test failures remain failure
records inside their reports. Private fixture directory names differ by process;
only those validated generated-root prefixes are normalized in comparisons, and
raw outputs retain complete paths. Assertions and upstream sources are unchanged.

Native process/async/timers/stream/fs/module dependencies are explicit. The
component routes real fixture imports through native loader hooks to the actual
candidate test tree; it does not synthesize results or stand in for a guest
transport/backend. Guest loader/realm/async/lifecycle and four-host runtime
conformance remain unproven. See testing-runner.md for complete remaining owners.
