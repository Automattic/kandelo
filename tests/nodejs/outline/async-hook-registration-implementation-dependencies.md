# Public AsyncHook registration ownership

Source125 reuses the complete pinned AsyncHook/createHook selection and actual
source-private symbols. The callback registry now owns arrays and uint32 counts,
including temporary arrays/counts that defer mutation until outermost dispatch.
Inherited/borrowed receivers,getter/read order,callback symbol mutation,count
checks,re-enabled insertion order,empty hooks and callback receiver identity
follow the pinned public/internal source. Native IDs,frames,resource lifetime,
Promise records,tick/jobs and fatal entry remain actual existing owners.

The source selection is unchanged except two explicit native destroy-count
publications. Node writes aliased native count memory; Kandelo has an explicit
setter. Each completed enable/disable count change publishes its active destroy
count,including trackPromises=false while another callback type remains active.
The outermost temporary-registry restoration publishes again. Idempotent fast
returns remain. No Promise activation state is manufactured: actual native
Promise lifecycle installation/removal remains an implementation gap.

The root execution resource is stable,mutable and ordinary. The public namespace
uses ordinary functions and the pinned insertion order/lazy getter shape.
Positive-ID public destroy filtering precedes the actual numeric native queue.
Complete private registry source is reference evidence,not a claim that V8's
native async_wrap structures were imported into SpiderMonkey.

## Evidence and preserved nonpasses

Root integration passes11new+23affected=34frontend controls and12separate
package-contract controls. Two full unchanged upstream constructor files each
pass in candidate/native modes (4runs). The private agent's21focused controls
also passed. These denominator/scopes remain separate;none is a count of
complete public APIs. The full candidate registry/JS classes run over explicit
real native26ID/context/resource dependencies; native destroy queue,GC,Promise
activation and guest engine execution are not substituted or proven.

The new fixture rejects a stale generated adapter. Its provider assertions now
inspect the actual complete candidate object rather than a source-expression
slice. Private source-assembly/configuration and native-registry-contamination
failures remain in the agent handoff logs; their assertions were retained.

Root's initial combined run recorded33pass/1fail: the earlier utilization test
formed its expected denominator with different floating-point grouping from
pinned Node. The subject's unchanged arithmetic was correct. The assertion now
compares exact equality with the real native two-snapshot function; no epsilon
or relaxed assertion was added. Original report and test preimage are retained.

Current source guard covers617inputs. Full source/selector/archive identity and
bootstrap generation/syntax pass. No guest/package/engine/kernel compilation,
overall suite or full product rebuild ran for this slice. Accepted116is stale;
combined117–125source remains uncompiled and has no current four-host evidence.
Prior cipher/SQLite/Error/compression/environment and NodeTiming failures remain
open. Pins and the136frozen audit deliverables remain unchanged.

## Remaining dependencies

A-024 public registration/metadata and A-025 ordinary root identity advance;
these are partial findings,not whole async-family closure. A-022 Promise native
activation/removal,A-023 alternate ALS CLI behavior and A-025 startup/native
resource/default-trigger mapping remain open. GC/destroy/shutdown,workers,
Promise resolution,callback/fatal/exception recovery (A-014/A-021),loop ordering
and every underlying provider's actual owner still require implementation and
identified-artifact evidence across Node,Chromium,Firefox and WebKit.

Root continues reviewing pending JWK/copy patches while independent histogram,
datagram and worker-lock agents work in private checkouts. Those pending changes
are not included as source125support. Heavy builds/shared generation/commits
remain coordinated;overall suites/full product rebuild stay deferred.
