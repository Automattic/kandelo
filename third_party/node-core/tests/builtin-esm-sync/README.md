# Builtin live binding component controls

Run handoff/root-controls.py --repo CURRENT_REPO --output FRESH_CONTEXT_DIR
using the declared dev shell. It records exact current source identities and
compares eleven isolated native/candidate subjects, including the complete
unchanged Node26.13.0 test/es-module/test-esm-live-binding.mjs. Native upstream
common executes normally; candidate main source executes unmodified through
actual V8 SourceTextModule and SyntheticModule dependencies. Candidate public
Module/require/policy/graph factories and sync algorithms are genuine produced
source; production never delegates to native Node.

This validates the JS algorithm and real V8 binding mutation component, not the
new SpiderMonkey owner class/checked unwrap/realm/root/GC/OOM/dispatch code.
The candidate fixture's current graph initialization is necessary: its earlier
stale metadata-comment selector failed all17 module-hooks candidate subjects
before setup. That original failure remains recorded. Initial scheme-only
control mistakenly asked native process.getBuiltinModule for test instead of
node:test; preserve that original10/11 result as well as the correction.

Zero helper/compiler attempts. Async loader Worker registration, builtin facade
initial evaluation phase, alternative cache-key/native registry identities,
first-load reentrant native builtin initialization and four-host conformance
remain separate implementation/validation obligations.
