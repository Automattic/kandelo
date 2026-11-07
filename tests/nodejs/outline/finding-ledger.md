# Finding-to-implementation ledger

This ledger reconciles the immutable audit with recorded implementation work.
It does not close findings or establish runtime compatibility.

[Machine-readable ledger](finding-ledger.json) ·
[Integrity record](finding-ledger-integrity.json) ·
[Current family status](status-by-family.md) ·
[Original implementation roadmap](../audit/roadmap.md)

## What the counts mean

| Record | Count | Meaning |
| --- | ---: | --- |
| Audited families | 19 | Includes cross-cutting documentation/activation requirements |
| Lexical finding IDs | 357 | Navigation labels; not unique APIs or independent bugs |
| Document-qualified definitions | 417 | Original document + label + line; collisions remain separate |
| Original ranges | 52 | Original grouped requirements; expansion is navigation only |
| Source-progress records | 94 | Scoped contributions, evidence and retained nonpasses |
| Dependency narratives | 66 | Shared owners and unresolved prerequisites |
| Findings lacking an exact source-slice link | 258 | Unknown disposition, not a count of missing implementations |
| Findings closed by this reconciliation | 0 | Source progress is separate from API closure |

The original 13,292 API observations and 11,199 obligations remain in the
audit by exact identity. They are not duplicated or converted to pass counts.
Thirty-four finding IDs have grouped/prose/range definitions rather than a
recovered standalone label. Their original references remain available.

## Reading the ledger

Use `definitionRecords` for the document-qualified requirement and
`findingGroups` for navigation. `sourceSliceRefs` links scoped source work;
`rowNavigationOnlySliceRefs` is a weaker matrix-navigation association.
Neither proves that every overload, error, lifecycle or host obligation is
implemented. Follow the linked source-progress record for its full evidence,
limitations and preserved failures.

The private proposal captured source171. Its recorded family prose and
source anchors retain that identity. `rootIntegration` supplies current172
family context, current anchor identities and the additional PKCS12 record.
The DNS-fixture record captured during171 is retained. The original audit is unchanged.

Engine171 compiled and linked, then failed the unchanged normal style check.
No current combined artifact was accepted;172 adds uncompiled native PKCS12
source. No current four-host runtime conformance is established. Private
unintegrated work is excluded from implementation credit.

## Next independent implementation work

The source-based priorities are real filesystem notifications; public TTY
constructors; HTTP servers/request parsing; module mocking over real loader
hooks and caller stacks; VM deadlines; Domain; ESM hook consumers and loader
workers; trace producers/output; public WASI lifecycle; and HTTP/2 sessions.
See `nextIndependentSourceTasks` for the original finding links and owner
anchors. Anchors must be rechecked before editing. Existing working owners
must be reused rather than rewritten from an older remaining-gap narrative.

VM deadlines and captured TTY input currently have private agents. Style
repair, SQLite backup and partial fs.watch owners are pending integration.
The fs.watch kernel notification prerequisite remains unimplemented;
propagating ENOSYS honestly does not implement notifications.

Complete per-finding implementation versus validation-debt classification
still requires explicit owner reconciliation. All families remain partial.
Overall suites and full product rebuilds remain deferred.

## Source176 progress overlay

The current overlay adds scoped VM deadline174, SQLite backup175 and HTTP
request/ServerResponse/catalog176 records. Their exact original audit labels,
source/evidence identities and retained nonpasses are linked individually.
The original171capture and172overlay retain their historical source scope;
later records are not projected backward into those captures.

Engine173has normal compilation/link/check/cache acceptance and static ABI55
contract evidence. It predates these three slices. Current176combined source
is uncompiled, no new product projection is materialized, and no guest or
four-host conformance is established. Public HTTP catalog controls match35
methods and47parser entries; the9live primitive comparisons still include
one failed server automatic400 admission case. VM wait-failure reentry and
SQLite malformed-source reference crash remain unresolved.

No finding/family is closed. Exact finding links remain navigation to scoped
contributions, not completed semantic obligations. A missing exact link remains
an unknown disposition, not proof of absent code.
