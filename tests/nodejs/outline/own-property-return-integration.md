# Shared property-helper return semantics

Source checkpoint141 fixes internal/util.setOwnProperty in the owning values
adapter. It already defined the real own property but discarded the stored
value. The pinned helper returns that value after definition. This one-line
correction preserves descriptors, inherited-setter exclusion and original
exceptions. The exact generated bundle changes by the same one line.

The public consequence is observable in unchanged pinned Stats algorithms:
first access to atime/mtime/ctime/birthtime returned undefined while storing a
Date for later reads. Both Number and BigInt constructors now return their
Date immediately, retain cached identity and expose the target own descriptor.
This was a post-audit shared dependency finding uncovered by real watcher work;
the frozen audit and prior failure evidence are unchanged.

The root regression reproduces the first Number Stats atime failure before
applying the fix. Its identical assertions pass afterward over actual candidate
values/Stats source with real native stat records: two Stats modes xfour first
reads, timestamp equivalence, cached identity and descriptors. Native/candidate
helper controls additionally check returned identity, inherited setters, proxy
exception identity and nonextensible throws. Thirty-seven affected/package
checks pass:23 pathname/util groups plus14 package source checks,zero skips.
Whole util/fs-utils reference files match the exact audited Node archive.

These are source/native-dependency controls,not guest filesystem metadata or
four-host evidence. Actual timestamps/precision/birthtime/Temporal,backend path
and permission behavior,watcher lifetime,byte-lease routing and broader util
contracts remain open. No upstream assertion or native source/reference pin
changed. Source140's backing capabilities and all existing native/engine owners
remain unchanged. No compilation,engine/package/kernel build,overall suite or
full product rebuild ran in this slice; all19families remain partial.

Exact source/evidence and original failure scopes:
[own-property-return-finding-progress.json](own-property-return-finding-progress.json).
