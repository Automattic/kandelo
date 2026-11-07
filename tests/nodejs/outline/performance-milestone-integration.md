# Actual performance lifecycle milestones

Source238 extends the actual existing performance clock with native-entry,
environment-creation, final pre-user bootstrap and final natural-loop marks.
The clock remains per owning context/thread, idempotent, monotonic and truthful
about clock errors. Existing loopStart/idle accounting remains. bootstrapComplete
is marked at the actual final pre-entry/Worker LOAD seam, never after user code
returns. loopExit occurs only after beforeExit restart opportunities are exhausted;
explicit/fatal quitting does not synthesize a natural-loop exit event.

The guest executes SpiderMonkey, so no V8-initialization event exists: v8Start
remains physically unset(-1). Existing pinned public NodeTiming getters/toJSON
consume the actual fields. No GC observation activation, flags or O-009 Observer
queue/delivery behavior is provided merely by editing an observer-named adapter.

A concrete Worker ordering gap remains: existing native Worker loop entry occurs
before its bootstrap, so loopStart precedes the real bootstrapComplete mark.
Pinned Node references show bootstrapComplete before loopStart. Correcting this
requires actual Worker bootstrap/LOAD dispatch separation, not timestamp movement.

One reused actual portable clock program and four pinned-native lifecycle
reference subjects pass. Thirteen static helper assertion annotations are not
thirteen matched cases. Three source/input/staging checks and fourteen package-
input tests are separate. One historical helper compilation is counted once308
to309; root reuses the exact executable/header and compiles nothing. The original
raw open-prefix EOF harness failure and pre-execution authoring syntax failure
remain preserved; normal composed bootstrap/core parsing succeeds.

Normal0173 composes only actual reviewed lifecycle additions over the237engine,
retaining certificate, async, callback and key-generation guards. Genuine normal
core generation supplies the changed bundle. The deterministic integration tool
journals eight owned postimages and actual source-bound process/log receipts
before Node-specific metadata changes. New guest JSAPI/lifecycle/clock-error/realm/
GC/Worker execution remains unvalidated. All nineteen families remain partial.
No API/finding closure, accepted platform exclusion, full rebuild or overall suite
is established by this prerequisite.
