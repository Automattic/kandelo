# Node CLI UTF8 string ownership

Node CLI string/list publication consumes actual UTF8 byte spans independently
of LC_CTYPE, using existing SpiderMonkey maximal-subpart replacement conversion
and owned native UTF16 storage transferred to a JS string. A shared rooted list
publisher supplies pattern/warning/conditions/execArgv arrays and real string
fields. Node script arguments/path metadata and actual eval execution use that
same policy. Generic SpiderMonkey shell narrow-string conversion stays in its
existing non-Node branches; raw C++ parser/path bytes and filesystem operations
are not rewritten. Node eval conversion owns independent UTF8 bytes until the
actual SourceText/Evaluate call completes.

The control matches34native/portable material cases under actual C/POSIX
locales, including malformed UTF8/maximal-subpart replacement, NODE_OPTIONS,
actual argv/eval/pattern/condition/warning values. Its tiny component compiles
exact unchanged Mozilla decoder/Unicode selections with explicit byte-view/
bitcount/assert scaffolding. It does not compile JSAPI/header/object/GC or the
new publisher, execute a guest, or prove four-host/full CLI compatibility.

Original source-review/test-filter/verification seals and two initial tiny
compile failures are retained. The latter arise from copying Unicode header
code into a strict standalone TU (character-conversion warning, then unused
constant); component-only warning handling/constant use leave all original
algorithm/assertion bytes unchanged and do not alter production flags.
Negated nonboolean option validation, complete Node CLI metadata, native
Worker/default isolation/IPC/watch/coverage and engine/guest/realm/OOM/lifetime
validation remain implementation or conformance gaps.
