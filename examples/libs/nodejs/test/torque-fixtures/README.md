# Torque CC-Builtins Per-Instruction Fixtures

One `.tq` fixture per Phase-2 instruction. Each fixture defines a single
builtin named `TorqueCcTest_<InstructionName>` that exercises exactly
one instruction from the Phase-2 list. The `TorqueCcTest_` prefix
activates the `kCCBuiltins` whitelist in the patched torque binary — any
builtin whose external name starts with `TorqueCcTest_` gets real C++
body emission under the kCCBuiltins pass. All other builtins keep the
Phase 1 comment-stub form.

Golden files live in `golden/`. Diff is byte-exact. Update goldens when
an instruction's emission changes intentionally.

Run: `bash examples/libs/nodejs/test/run-torque-fixtures.sh`.
