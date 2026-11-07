# Focused tracing controls

Enter the repository's declared dev shell. Set `NODE26_REFERENCE` to the exact
pinned Node 26.13.0 executable and `TRACING_EVIDENCE_DIR` to a fresh component
output directory, then run `bash run-controls.sh` from this directory. The script
compiles a tiny V8 wrapper over the actual portable process owner. It performs no
product setup, engine build or overall suite.

Run `compare-controls.py` with the same reference, `TRACING_COMPONENT` pointing
to that component, and a different fresh `TRACING_EVIDENCE_DIR`. Each selected
native/candidate child records its command and output before launch, including
its exact exit, timeout and file parse results. `TRACING_NATIVE_BASELINE` may
reuse a preserved report's native rows only after the exact native executable
and control program hashes match; these remain reused reference observations,
not new runs. A failed or timed-out subject fails its entire comparison group.

The controls use unchanged pinned public trace/console source. Native Node
supplies engine/inspection/streams/module loading/process dependencies; the
addon supplies the actual new native category/sink owner. Its stronger reference
handle rooting is not guest GC evidence. The candidate finalizer is registered
after the test's exit listeners; production uses a separate native post-join
teardown hunk, whose execution remains unvalidated.

`owner-control.cc` exercises the actual portable owner under real POSIX file
operations and threads, plus bounded EINTR/short-write/write-error injection.
Its checks include owned-fd cleanup, no double close of a reused numeric slot,
close-on-exec, shared category counts and real thread identities. It does not
compile the SpiderMonkey JSAPI bridge or establish guest filesystem semantics.

The failed-open native reference timeout stays a nonpass. No timeout extension,
assertion removal, fake trace field or formal upstream defect claim makes it a
successful compatibility result. See `../../tracing-owner.md` for remaining gaps.
