# Native CLI test filters and UTF-8 ownership

Source223 wires actual repeatable test-name/test-skip vectors through the
existing argument parser, rooted CLI arrays and persistent option reader into
unchanged pinned regexp/Test/Suite filtering. NODE_OPTIONS precedes CLI; original
execArgv and target empty/escaped-dash grammar remain observable.

The reviewed shared CLI correction uses the real SpiderMonkey lossy UTF8 decoder,
UniqueTwoByteChars adoption and JS string/list ownership, independently of locale.
Actual Node warning/condition/scalar/script metadata and eval material share that
policy. Generic shell narrow branches and raw parser/filesystem bytes remain.
Two normal additive engine patches retain the current public abort owner.

Fresh14parser/option cases,10successful real test-tree scenarios and1exact regexp
error comparison pass against pinned native26.13.0, using current generated
candidate test sources and explicit native dependencies. Separate immutable34
UTF8material groups/68children under C/POSIX are reused with their original
algorithm/scaffolding limits. The root performs no new compiler invocation.
Original2pattern and3correction tiny compiler attempts include3retained failures.
No new JSAPI/header/TU/guest compile or four-host runtime validation follows.

Original baseline divergence, negative errors, compiler/setup and Nix entry
failures remain. Root recorder initially sliced byte rather than text indexes;
that check failed after successful additive replay but before recipe/staging/
generation. Exact original text selection was then verified in combined source;
only the unexecuted tail resumed. No source algorithm or assertion was weakened.

Full CLI/negation/metadata, raw Unicode/malformed path execution, test launching,
default process isolation/IPC, watch/coverage and guest root/GC/Worker/lifecycle
remain open. Normal inputs/bootstrap/staging and14focused package checks pass.
No target/ABI change, full product rebuild, overall suite or API/family closure.
