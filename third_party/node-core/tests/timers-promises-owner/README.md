# Promise timers owner component

Use exact Node26.13.0 with --expose-internals through scripts/dev-shell.sh.
Set TIMER_OWNER_PHASE=native|after and TIMER_OWNER_REPO to an ordinary repo
containing the current generated core and actual host/test/fixtures/node-async-
platform.cjs, then execute control.cjs. Before additionally needs the preserved
TIMER_OWNER_CAPSULE before/bootstrap and baseline-core.js. Native reference,
baseline and candidate failures must stay distinct.

The fixture runs actual production bootstrap timers and complete pinned Promise
algorithms. It supplies explicit native Node scheduled tasks/ref controls,
EventTarget resistant listener semantics, actual native error/value/VM/Promise
capabilities and existing native AsyncResource/ALS component. Its typed timer
handles are fixture adapters over real native handles, not guest provider proof.
No guest JSAPI/loop/fatal/Promise activation/GC/Worker/four-host result follows.

Do not launch product setup or overall suites for this component. The sealed
agent drivers write commands/results/timeouts and actual partial stdout/stderr
before strict comparisons. Four unchanged focused upstream files additionally
run through a preload mapping only timers/timers-promises to these actual owners;
all other native loader/test-runner/OS dependencies remain explicit.
