# Original-request native module imports

The generic internal import bridge forwards the original converted specifier,
explicit parent URL and actual import-attribute record to the native module
loader. It does not pre-resolve then import a different URL, call require(),
construct wrapper source or delegate production imports to host Node.

The engine creates a rooted genuine ModuleRequest, retaining raw Node attributes
without syntax-only filtering, copying or early type getters. Existing graph
resolve/load/source transactions and native URL/type registry own hooks, mocks,
CommonJS/JSON/builtin translation, errors and cache identity. A completed import
uses the actual captured ModuleObject namespace; it does not resolve again after
evaluation. The same completion helper now serves ordinary syntax imports, retaining their
existing asynchronous delay and separate VM-specific handler. It replaces the
Kandelo host path that used FinishDynamicModuleImport to rebuild a
specifier/type-only request and resolve it again. Syntax-level attribute-key
validation before the host callback remains a separate engine integration gap. No upstream runtime defect
or production workaround is claimed.

Resolution/source/linking use actual current owners. Evaluation is deferred via a
native promise reaction; actual top-level-await completion then settles the
import promise. Traced native-function slots retain the real module/promise until
completion; no raw JS pointer, fabricated namespace or persistent dynamic-request
memo is introduced. Actual thrown values and namespace then-export assimilation
remain in the real promise path. Cached evaluating modules are not relinked.

This extends the public test runner's previously partial absolute-file-URL import
bridge to original specifier/referrer/attributes. General bare/relative custom
reporter/global-setup imports now reach the same genuine engine graph; module
mock resolution and synchronous resolver ownership remain distinct and intact.
Source imports/phases, async loader workers, permissions, complete cross-realm/
context/queue/error/lifecycle conformance and existing translator/provider gaps
remain implementation/validation work. Reentrant link failure and exact Node job
chronology still need current guest evidence. The complete default runner process
isolation/serializer/IPC/CLI/watch/coverage roadmap remains required.

Focused native controls explicitly depend on native Node's module loader; they
prove JS request forwarding and native-reference expectations, not execution of
the production SpiderMonkey request/completion owner. Source replay/staging/style
checks are not C++ compilation. This source candidate has no identified-artifact
four-host runtime validation, and performance was not measured.


## Native request identity owns resolve-to-record handoff

An additive source correction carries the same actual native ModuleRequest
through resolve and record callbacks. A weak request-keyed transaction retains
the actual resolve result, parent and hook-replaced attributes. It never keys a
native handoff by reading the original attributes.type after a resolve hook has
replaced that record, and same-URL pending requests do not overwrite each other's
hook result. Each record consumes/removes its transaction; no synthetic request
or persistent dynamic-resolution memo is created. Legacy requestless source
preparation keeps its existing URL/type path; this is not a claim of complete
cache/getter chronology. Native realm wrappers and GC lifetime remain unexecuted.

The bootstrap also forwards an empty primitive specifier to the actual Node
resolver/error owner instead of returning null and falling through to shell
path handling. Ordinary syntax's earlier empty-specifier/attribute admission,
full job/cache/linking/evaluation/frame/realm behavior and all four hosts remain
unvalidated or incomplete. No blanket loader compatibility is established.

Focused controls now execute actual candidate graph resolve/record/load with
genuine native Node resolve/load hooks and supplied source. Native ModuleWrap
request reports are held as explicit component key dependencies; the C++ bridge
uses the real SpiderMonkey ModuleRequest object, and is not executed by those
controls. Original failing graph and empty-forwarder assertions remain recorded.
A separate sticky dependency-resolve-error hypothesis was disproved: native Node
retries when the resolve hook changes. No error-cache workaround is introduced.
