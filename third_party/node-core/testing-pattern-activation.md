# Test name and skip pattern activation

The admitted --test-name-pattern and --test-skip-pattern options now own
repeatable native CLI string vectors. NODE_OPTIONS values precede CLI
values, with original CLI spelling retained in process.execArgv. Actual
arrays enter the existing test option reader and unchanged pinned regexp
conversion, Test/Suite hierarchy matching and TestsStream reporting.
This supplies real filtering for ordinary scripts importing node:test and
explicit programmatic isolation:none runs. It does not activate --test
file launching, default process isolation/IPC, watch or measured coverage.
Those missing owners retain their existing explicit failure paths.

The parser preserves pinned string-list behavior: an empty separate
argument is valid; an empty equals argument is missing; dash-prefixed
separate values are rejected, except a backslash-dash escape removes that
backslash from the parsed value and retains its original execArgv text.
Regular-expression validation remains in the actual pinned test runner,
with original errors. No string pattern is replaced by a synthetic test
outcome or a newly implemented alternative runner.

Focused evidence compiles the exact extracted CLI/tokenizer/state block,
then supplies its actual arrays to the real candidate test framework using
explicit native Node dependencies. It does not compile the new JSAPI array
publisher or run a guest artifact. Existing Worker startup captures native
string-array CLI fields; explicit Worker execArgv ownership remains an
independent missing feature. Four-host CLI/Worker/filter conformance,
complete CLI option metadata and broader runner behavior remain open.
