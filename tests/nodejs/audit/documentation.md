# Documentation and narrative requirements review

State: **source review complete with gaps**; see [complete contracts](documentation-contracts.md)
and `documentation-requirements.json`. This family provides requirements and applicability
rules rather than a builtin module. It must not become an artificial
module-pass count. The pinned documentation.md, synopsis.md, index.md and
deprecations.md have been reconciled, including all 207 current deprecation identifiers
and actual selected warning/alias/overload/CLI/environment/native owners.

## Governing findings

| ID | Requirement | Audit consequence |
|---|---|---|
| DOC-001 | Stability index describes change policy, not absence | documentation.md:16–70 includes deprecated, experimental stages, stable and legacy. Legacy/deprecated APIs still present in the target remain in scope; experimental activation must be recorded individually |
| DOC-002 | Distinguish documentation-only, application, runtime and end-of-life deprecations | deprecations.md:1–45 defines different warning/origin/flag effects. A doc-only alias must not gain runtime warnings; application deprecation depends on source location and pending-deprecation flags; removed APIs must not be reintroduced merely because old headings remain |
| DOC-003 | CLI/module/example narratives express behavior | synopsis.md:7 describes invocation forms and its HTTP server example requires actual request/listen behavior, not just exports. CLI, loading, HTTP and process families own those contracts; no new demo or probe is authorized |
| DOC-004 | Platform and system-call branches need actual applicability | documentation.md:87 explains syscall references and unavoidable OS differences. Guest Kandelo/wasm32 identity must stay truthful; embedding host OS is not guest platform. Missing implementation is not an OS exemption |
| DOC-005 | Narrative, inherited, symbol and gated APIs escape simple heading/descriptor discovery | 11,199 inventory obligations are not a unique API denominator. Saved Darwin capture does not evaluate getters or fully traverse inherited/gated APIs. Each obligation needs a canonical API/requirement or documented non-API disposition before inventory audit is complete |
| DOC-006 | Exact version governs renamed, added and removed behavior | Node 26 SQLite Database/Statement retain old Sync aliases (DEP0210/211); default erasable TypeScript support and removed transforms differ from older Node; tty raw/io mode is a newer target requirement. Review history metadata against the exact source, not a remembered older release |

The `index.md` navigation points into the API corpus rather than supplying
a runtime export list. Documentation JSON is a Node documentation output
format, not a missing guest runtime module. Examples may depend on actual
filesystem/network/process behavior and must be assigned to those owners.
The statement that native Node uses V8 does not justify wholesale
exclusion of portable behavior in Kandelo's SpiderMonkey implementation.

## Required crosswalk and evidence policy

For every discovery obligation retain its original identity and disposition:
canonical API, alias/overload/inherited member, narrative requirement,
version-inapplicable historical item, private implementation detail or
unresolved question. Link to source-owned findings and host applicability.
Do not infer compatibility from a name, an imported upstream source file,
a generated descriptor list or a deprecation label.

Family source reviews require their requirements and source owners to
be reviewed. Async, streams, network, HTTP, engine, loading, terminal, workers, compression, crypto, secure-network, native-integration, testing, observability, web, documentation, processes and filesystem
have completed source reviews with gaps; values remains in progress. A
finished audit may find implementation missing; it cannot call an
unreviewed API correct. No runtime test has been newly run in this audit.
Historical skips, unsupported launches, timeouts and harness errors retain
their classifications and exact artifact identity. Tests proposed by any
report remain subject to subsequent explicit authorization.

Current requirements and owner routes are retained in the complete ledger.
Open questions concern exact target warning/origin/stack/activation behavior,
Type/prose/source scope, optional sync-emission caller closure, native
environment/GC/ABI ownership and later fixture/flag/native applicability.
DOC-010 corrects the earlier L-032 environment-read conclusion: the getter
falls back to native getenv; seeding does not bound readable keys.
