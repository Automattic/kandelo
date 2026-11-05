# Shared warning ownership

Source121 replaces the custom process warning emitter/printer with the
complete pinned Node26.13.0 `internal/process/warning.js` owner. It consumes
the existing candidate error/validator, process scheduler/EventEmitter,
Console, path and filesystem owners. The values adapter supplies the same
owner to internal deprecators requesting synchronous emission (DOC-009).

The source retains warning overload/error ordering, next-tick emission and
delayed deprecation throwing; invalid event payloads are not printed. The
printer retains exact code/name filtering, detail/stack policy, one trace
hint, redirect-file append/fallback and exit-close ownership. Default printer
registration observes startup options and NODE_NO_WARNINGS once, rather than
suppressing already-registered output after later environment mutation.
Truthy options create the pinned nonwritable/configurable process aliases.

Patch0103 extends the existing real guest argument parser with deprecation,
throw/trace and warning flags, repeated disable filters, diagnostic and
redirect paths, NODE_REDIRECT_WARNINGS and environment/CLI precedence.
CLI-only execArgv is preserved. Actual booleans/strings/arrays are published
to the bootstrap and inherited worker option payload; guest publication and
worker activation remain uncompiled/unvalidated. DOC-008 is still partial:
pending-deprecation CLI consumers, origin/stack and broader startup policy
remain open. This is not full Node CLI support.

## Stack adaptation and remaining dependencies

Three checked substitutions guard optional native Error.captureStackTrace
and its temporary stack-limit suppression. Without recapture, the actual
Error-constructor stack is retained; it is not deleted by setting the limit
to zero. No synthetic V8 stack or constructor-frame filtering is supplied.
The generic engine stack/filtering/fatal/rejection gaps remain implementation
gaps. No engine/platform exclusion is accepted by this slice.

Warning behavior still depends on correct actual guest tick/fatal/exit and
async resource ownership, stdio/Console errors, filesystem append/fd lifetime,
GC, realms and worker transport/teardown. Origin-sensitive deprecation callers
and full flags/environment/permissions need individual reconciliation. Source
presence and native-boundary controls do not close those dependencies or the
19 partial families.

## Scoped evidence

* `.context/node26-warning-source-r1/report.json`: four complete references
  match the pinned canonical tar; bundle/bootstrap generation and syntax,
  all606 guarded source inputs and zero-fuzz0102/0103 patch composition pass.
  Forward/reverse composition restores the exact baseline; the compiled
  portable parser body equals the composed engine source. Guest C++ is
  uncompiled; there is no syscall/host-wire/ABI change.
* `.context/node26-warning-cli-r1/report.json`: one portable helper compile
  and14 actual-parser comparisons pass against the exact native reference.
  These cover booleans/negation/normalization, repeated filters, strings,
  environment/CLI ordering, execArgv and missing arguments; not guest JSAPI.
* `.context/node26-warning-affected-r2.json`:16 new frontend comparisons and
  47 affected controls pass. One environment clone control fails with the
  previously recorded native addon serialization limitation. Its assertion
  remains unchanged and does not count as passing compatibility. These are
  candidate JS owners over explicit native process/engine/fs/stream/options
  boundaries; they do not execute the new guest CLI publication or stack path.
* `.context/node26-warning-upstream-r2/report.json`: two unchanged parallel
  warning files pass in candidate/native modes (four runs). Upstream sources
  and assertions are unchanged. The surrounding native common harness and
  dependency owners are explicit; no guest/four-host/whole-fixture-closure or
  full-family result follows.

Retain the frontend config startup error, the initial1pass/15fail fixture
result caused by a test-only binding emitting an extra native warning, the
first unchanged-run2pass/2startup-failure preload-path error, and the affected
38pass/10fail fixture-extraction result. The latter selected unrelated Buffer
initialization; only its extraction endpoint changed, with assertions intact.
The corrected run preserves the known environment-clone nonpass. Earlier
cipher/SQLite/Error/compression nonpasses remain unresolved.

The selected runtime source117–121 remains uncompiled; accepted116 is not
current. No new guest cases, overall suites or full product rebuild ran.
Continue independent audited gaps across families; do not turn this into an
unbounded warning-only investigation. Later identified-artifact four-host
checks must cover these owners and all remaining API obligations.

The staged whitespace check reported patch context lines75and101. Both are
required single-space blank lines in unified-diff syntax; authored patch
additions have no trailing whitespace, and all other committed files pass
the whitespace check. Exact patch apply/reverse evidence remains unchanged.
The initial check failure is retained, not reported as a default-check pass.
