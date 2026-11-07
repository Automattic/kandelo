# Snapshot update activation

MockTracker and MockTimers already embed the full pinned implementations;
this slice leaves their algorithms and clock owners unchanged. It closes
a separate TEST-002 activation gap in the existing snapshot implementation.

The Node entry point now admits the actual CLI boolean
`--test-update-snapshots`, including normal negation, repeated-option order,
underscore spelling and boolean-presence suffix behavior. It stores the
value in the real process CLI owner, preserves original execArgv, forwards
it through the existing JS CLI object and reads that boolean in the testing
option owner. No test discovery/isolation runner or other CLI option is
silently activated. The flag is usable with an ordinary node:test script;
`--test` is not required for this option in the pinned target.

The pinned option is disallowed in NODE_OPTIONS even when negated. Admission
rejects it before boolean application, with exit9 and the original option
spelling/equals marker in the error. This is an argument policy, not a fake
snapshot capability or a replacement clock value.

The unchanged SnapshotManager, serializer, VM/file and Test/Suite lifecycle
owners perform the actual public snapshot and fileSnapshot operations.
Without the flag, missing/mismatched snapshots still fail tests and files
are not regenerated. With the flag, actual serialized file content is
written through fs. Path/serialization/write errors keep their real
filename/input/cause information. No file contents or successful result
streams are manufactured by the option reader.

Focused native controls compile the actual CLI parser bodies and exercise
the public candidate test/snapshot owners over explicit native filesystem,
VM, timer, async and caller-location boundaries. The CLI projection JSAPI
and product engine/main are uncompiled/unexecuted in this slice. Native
control flags such as --expose-internals are fixture dependencies; their
guest support is not implied. Worker/child flag selection/propagation and
full snapshot/runner behavior still need identified guest artifacts and
four-host validation. The original broader TEST-002/003/006 gaps remain.
