# Dotenv parser and environment-file source ownership

The util.parseEnv and process.loadEnvFile observations now have public JS,
portable parser and guest file/environment source owners. Related V/PROC and
DOC-010 requirements remain partial; no finding or family closes. Target
Node 26.13.0 and all frozen audit evidence remain unchanged.

## Source ownership

generate-dotenv.py selects trim_spaces and Dotenv::ParseContent from the
complete pinned src/node_dotenv.cc. Full-file and selected-section hashes
are checked before generating dotenv-parser.h. Only inline declarations
and an equivalent C++17 prefix comparison replace target spelling; quote,
comment, whitespace, export, empty/malformed-line, CR removal, duplicate and
multiline behavior remain the retained algorithm. Parsed byte strings are
owned in an ordered map; this is not shell expansion or a regex substitute.

The unchanged lib/util.js parseEnv wrapper validates content before the
private native call. native-dotenv.cpp owns length-bearing UTF-8 conversion,
including embedded NULs; its returned object has null prototype and actual
writable/enumerable/configurable string properties. Public method name and
arity come from the retained wrapper. Raw file bytes stay raw while parsing;
invalid UTF-8 is replaced when converted to JS strings, not rejected or
silently truncated by strlen.

dotenv-file.h owns real open/read/close over guest libc and the existing
kernel filesystem. It retries interrupted open/read operations, reads to
EOF in 8192-byte chunks and closes its descriptor on normal and exceptional
paths. A released descriptor number is not retried after close failure.
There is no JS filesystem substitute, host path, fetched content, file-size
success shortcut or shadow environment store in the guest implementation.

The native bridge checks each raw C-string key in the real environment,
including existing empty values, before converting and setting a missing
entry. Conversion happens outside the environment mutex. The existing
process-state owner copies/get/sets real libc state under its own lock;
invalid-name/setenv return handling follows target RealEnvStore policy.
Embedded NUL and invalid UTF-8 raw-key versus converted-value behavior is
source-traced, but requires actual engine controls before closure.

The unchanged per_thread.js loadEnvFile wrapper validates string/Buffer/URL
paths and selects .env for null/undefined. dotenv-platform-adapter.js maps
the retained native API's open failure policy to ENOENT while preserving
actual errno in the private outcome. Read failure becomes its target
TypeError. Native src/api/exceptions.cc, rather than the distinct JS
UVException helper, defines diagnostics: a provided empty path remains
present in the message and path property. process.loadEnvFile does not
execute NODE_OPTIONS from the loaded file.

Patch 67 registers these private APIs; recipe revision 49 includes all
three native source/header inputs. All four hosts select the same guest
source. There are no kernel/libc/host imports or wire ABI changes. No engine,
package or full product build has run for this slice.

## Evidence and remaining boundaries

* Four focused dotenv controls plus fourteen existing public-util/process
  controls pass with the exact pinned native reference. They exercise the
  actual generated public wrappers and compiled portable parser/file owner.
  Record conversion and ordinary environment application are explicit native
  host control boundaries, not the guest JSAPI or libc environment bridge.
* The compiled C++17 parser/file helper matches 28 native-reference scenarios,
  including retained upstream fixture contents, malformed/quoted/multiline/
  NUL/Unicode inputs, a file exceeding two read buffers, invalid-byte value
  presentation, missing files and directory read errors. Expected errors
  remain errors; these are not 28 successful environment-file loads.
* One unchanged upstream util.parseEnv file passes over candidate and native
  modes. Native Node supplies assert/common/fs and the engine; candidate
  mode replaces only util.parseEnv with the actual wrapper/portable parser
  and explicit record conversion. This is not full public-core conformance.
* The initial empty-path error mismatch and exact inputs remain recorded.
  The intermediate pass before an added directory case is historical; the
  final identified inputs and controls provide the accepted scoped evidence.

The target aborts on unexpected close failure. This embedding currently
throws a visible close error instead; that remains an unresolved policy
deviation, not an accepted engine/platform boundary or compatibility pass.
No close-failure injection, allocation failure, raw-key collision, concurrent
native mutation, JSAPI UTF-8/realm/GC or guest four-host conformance follows
from these controls. The portable helper does not test environment application.

CLI --env-file/--env-file-if-exists precedence and startup NODE_OPTIONS,
permission-enabled access, worker/default-copied versus shared environments,
actual secure startup and native external mutation remain implementation
dependencies. Public process metadata, other env APIs and all process-family
requirements remain open. Later unchanged upstream dotenv/CLI/load-file tests
need the actual rebuilt guest engine across Node/Chromium/Firefox/WebKit;
native-only subprocesses must not count as guest passes. Continue independent
audited owners before an overall suite campaign.
